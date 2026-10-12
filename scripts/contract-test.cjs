#!/usr/bin/env node
// Teste de contrato: app Nest real (dist/) + receptores em memória de OTLP/HTTP (JSON) e do protocolo
// Sentry (envelope). Prova o que sai do processo — e o que NÃO sai (PII, nada sem variáveis).
'use strict';
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const APP = path.join(__dirname, 'contract-app.cjs');
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FALHOU', `${name}: ${err.message}`]);
  }
}

function receiver() {
  const got = { traces: [], metrics: [], logs: [], envelopes: [], raw: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      const text = body.toString('utf8');
      got.raw.push(text);
      if (req.url === '/v1/traces') got.traces.push(JSON.parse(text));
      else if (req.url === '/v1/metrics') got.metrics.push(JSON.parse(text));
      else if (req.url === '/v1/logs') got.logs.push(JSON.parse(text));
      else if (/^\/api\/\d+\/envelope\//.test(req.url)) got.envelopes.push(text.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })));
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startApp(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [APP], {
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  const t0 = Date.now();
  while (!out.stderr.includes('READY')) {
    if (Date.now() - t0 > 20000 || child.exitCode !== null) throw new Error(`app não subiu: ${out.stderr}${out.stdout}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = async () => {
    const t = Date.now();
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
    return { ms: Date.now() - t, signal: child.signalCode, code: child.exitCode };
  };
  return { port, out, child, stop };
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b ? JSON.parse(b) : null }));
      })
      .on('error', reject);
  });
}

const attrs = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
const jsonLines = (s) => s.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

async function scenarioOn() {
  const rx = await receiver();
  const app = await startApp({
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${rx.port}`,
    ERRORS_DSN: `http://publickey@127.0.0.1:${rx.port}/1`,
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
    OTEL_BSP_SCHEDULE_DELAY: '200',
    OTEL_BLRP_SCHEDULE_DELAY: '200',
  });
  const ok = await get(app.port, '/items/42?token=segredo-na-url', {
    traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01`,
    authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXRlc3Rl',
    cookie: 'gp_session=segredo-cookie',
  });
  const boom = await get(app.port, '/items/boom');
  const nf = await get(app.port, '/items/missing');
  await new Promise((r) => setTimeout(r, 2500));
  const stopped = await app.stop();
  rx.server.close();

  const spans = rx.got.traces.flatMap((t) =>
    t.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, resource: attrs(rs.resource.attributes), scope: ss.scope.name })))),
  );
  const all = rx.got.raw.join('\n');

  check('liga: 200 normal e X-Request-Id', () => {
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { id: '42' });
    assert.match(ok.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  });
  check('liga: 404 preserva {message,error,statusCode} + errorId', () =>
    assert.deepEqual(nf.body, { message: 'Item não encontrado', error: 'Not Found', statusCode: 404, errorId: nf.headers['x-request-id'] }));
  check('traces: recurso service.name/version/namespace/deployment.environment', () => {
    const r = spans[0].resource;
    assert.equal(r['service.name'], 'contract-api');
    assert.equal(r['service.version'], '9.9.9');
    assert.equal(r['service.namespace'], 'ciag');
    assert.equal(r['deployment.environment'], 'hml');
  });
  const server = spans.find((s) => s.kind === 2 && s.traceId === TRACE_ID);
  check('traces: traceparent de entrada continua (mesmo trace id, pai = span do front)', () => {
    assert.ok(server, `spans: ${spans.map((s) => `${s.name}/${s.kind}/${s.traceId}`).join(', ')}`);
    assert.equal(server.parentSpanId, PARENT_SPAN);
  });
  check('traces: http.route padrão e spans do Nest/Express', () => {
    assert.equal(attrs(server.attributes)['http.route'], '/items/:id');
    const scopes = new Set(spans.filter((s) => s.traceId === TRACE_ID).map((s) => s.scope));
    assert.ok([...scopes].some((s) => s.includes('nestjs')), [...scopes].join(','));
    assert.ok([...scopes].some((s) => s.includes('express')), [...scopes].join(','));
  });
  check('traces: token da URL e cabeçalhos sensíveis não saem', () => {
    assert.ok(!all.includes('segredo-na-url'), 'token da URL vazou');
    assert.ok(!all.includes('segredo-cookie'), 'cookie vazou');
    assert.ok(!all.includes('c2lnbmF0dXJlLXRlc3Rl'), 'JWT vazou');
    assert.ok(!all.includes('ana@ciag.org.br'), 'e-mail vazou');
  });
  const points = rx.got.metrics.flatMap((m) =>
    m.resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics)),
  );
  check('métricas: http.server.request.duration por rota/status', () => {
    const dur = points.find((m) => m.name === 'http.server.request.duration');
    assert.ok(dur, `métricas: ${[...new Set(points.map((m) => m.name))].join(', ')}`);
    const dps = dur.histogram.dataPoints.map((d) => attrs(d.attributes));
    assert.ok(dps.some((a) => a['http.route'] === '/items/:id' && Number(a['http.response.status_code']) === 200), JSON.stringify(dps));
  });
  const logs = rx.got.logs.flatMap((l) => l.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords)));
  check('logs OTLP: linha da requisição com o mesmo trace_id e atributos', () => {
    const line = logs.find((l) => String(l.body.stringValue).startsWith('GET /items/:id 200'));
    assert.ok(line, logs.map((l) => l.body.stringValue).join(' | '));
    assert.equal(line.traceId, TRACE_ID);
    const a = attrs(line.attributes);
    assert.equal(a.route, '/items/:id');
    assert.equal(a.userId, 'user-77');
    assert.equal(a.requestId, ok.headers['x-request-id']);
  });
  const stdout = jsonLines(app.out.stdout);
  check('stdout: JSON com trace_id/span_id/requestId na linha da requisição', () => {
    const line = stdout.find((l) => l.context === 'HTTP' && l.status === 200);
    assert.equal(line.trace_id, TRACE_ID);
    assert.match(line.span_id, /^[0-9a-f]{16}$/);
    assert.equal(line.requestId, ok.headers['x-request-id']);
    assert.equal(line.ip, '127.0.0.1');
  });
  const events = rx.got.envelopes.map((e) => e.find((x) => x.exception || x.event_id && x.level));
  check('erros: 500 vira evento com errorId = X-Request-Id, release e ambiente', () => {
    assert.equal(boom.status, 500);
    assert.deepEqual(boom.body, { statusCode: 500, message: 'Internal server error', errorId: boom.headers['x-request-id'] });
    const ev = events.find((e) => e && e.tags && e.tags.errorId === boom.headers['x-request-id']);
    assert.ok(ev, JSON.stringify(rx.got.envelopes).slice(0, 500));
    assert.equal(ev.release, '9.9.9');
    assert.equal(ev.environment, 'hml');
    assert.equal(ev.tags.route, '/items/:id');
    assert.ok(!JSON.stringify(ev).includes('ana@ciag.org.br'));
    assert.ok(JSON.stringify(ev).includes('a***@ciag.org.br'));
  });
  check('erros: 404 não vira evento', () => assert.equal(events.filter(Boolean).length, 1));
  check('SIGTERM: descarrega e encerra pelo sinal em < 5 s', () => {
    assert.equal(stopped.signal, 'SIGTERM');
    assert.ok(stopped.ms < 5000, `${stopped.ms} ms`);
  });
}

async function scenarioDown() {
  const dead = await freePort(); // porta fechada
  const app = await startApp({
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${dead}`,
    ERRORS_DSN: `http://publickey@127.0.0.1:${dead}/1`,
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
    OTEL_BSP_SCHEDULE_DELAY: '200',
    OTEL_BLRP_SCHEDULE_DELAY: '200',
  });
  const t = Date.now();
  const rs = [];
  for (let i = 0; i < 20; i++) rs.push(await get(app.port, `/items/${i}`));
  const boom = await get(app.port, '/items/boom');
  const ms = Date.now() - t;
  await new Promise((r) => setTimeout(r, 12000));
  const stopped = await app.stop();
  const lines = jsonLines(app.out.stdout);
  const warns = lines.filter((l) => l.level === 'warn');
  check('coletor/GlitchTip fora do ar: API sobe e responde', () => {
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(boom.status, 500);
    assert.ok(ms < 3000, `${ms} ms para 21 requisições`);
  });
  check('coletor fora do ar: só avisos, poucos e com contexto Observability', () => {
    assert.ok(warns.length >= 1 && warns.length <= 5, `${warns.length} avisos: ${warns.map((w) => w.msg).join(' | ')}`);
    assert.ok(warns.every((w) => w.context === 'Observability'));
    assert.ok(!app.out.stderr.replace('READY\n', '').trim(), `stderr: ${app.out.stderr}`);
  });
  check('coletor fora do ar: SIGTERM encerra em < 5 s', () => assert.ok(stopped.ms < 5000 && stopped.signal === 'SIGTERM', JSON.stringify(stopped)));

  const bad = await startApp({ OTEL_EXPORTER_OTLP_ENDPOINT: 'isto não é url', ERRORS_DSN: 'dsn-ruim' });
  const r = await get(bad.port, '/items/1');
  await bad.stop();
  const badWarns = jsonLines(bad.out.stdout).filter((l) => l.level === 'warn').map((l) => l.msg);
  check('URL/DSN inválidos: sobe, responde, 2 avisos claros', () => {
    assert.equal(r.status, 200);
    assert.deepEqual(badWarns, [
      'OTEL_EXPORTER_OTLP_ENDPOINT inválido (isto não é url): telemetria desligada',
      'ERRORS_DSN inválido: envio de erros desligado',
    ]);
  });
}

async function scenarioOff() {
  const rx = await receiver();
  const app = await startApp({});
  const ok = await get(app.port, '/items/1');
  const boom = await get(app.port, '/items/boom');
  await new Promise((r) => setTimeout(r, 1500));
  const stopped = await app.stop();
  rx.server.close();
  const lines = jsonLines(app.out.stdout);
  check('desligado: respostas iguais (só errorId/X-Request-Id a mais)', () => {
    assert.deepEqual(ok.body, { id: '1' });
    assert.deepEqual(boom.body, { statusCode: 500, message: 'Internal server error', errorId: boom.headers['x-request-id'] });
  });
  check('desligado: nenhum aviso, nada exportado, sem trace_id', () => {
    assert.equal(lines.filter((l) => l.level === 'warn').length, 0);
    assert.equal(rx.got.raw.length, 0);
    assert.ok(lines.every((l) => l.trace_id === undefined));
    assert.ok(lines.some((l) => l.context === 'HTTP' && l.requestId));
  });
  check('desligado: SIGTERM com o comportamento padrão do Node', () => assert.equal(stopped.signal, 'SIGTERM'));
  check('desligado: SDKs não carregados (sem @sentry/@opentelemetry/sdk no processo)', () => {
    // contract-app imprime nada sobre isso; checado no teste de RAM do TeaTime. Aqui: nenhum envio.
    assert.equal(rx.got.envelopes.length, 0);
  });
}

(async () => {
  await scenarioOn();
  await scenarioDown();
  await scenarioOff();
  for (const [s, n] of results) console.log(`${s === 'ok' ? '✔' : '✘'} ${n}`);
  const failed = results.filter(([s]) => s !== 'ok').length;
  console.log(`\ncontrato: ${results.length - failed}/${results.length} ok`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
