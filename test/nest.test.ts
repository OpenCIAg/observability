import 'reflect-metadata';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Controller, Get, HttpException, NotFoundException, Req, type INestApplication } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import pino from 'pino';
import { ObservabilityModule } from '../src/nest/module';
import { state, resetStateForTests, type CaptureInfo } from '../src/nest/state';
import { createJsonLogger, NestJsonLogger, setRootLoggerForTests } from '../src/nest/logger';
import { resolveConfig, isIgnoredPath } from '../src/nest/config';
import { initTelemetry } from '../src/nest/telemetry';
import { redactSpan } from '../src/nest/redacting-exporter';
import { REDACTED } from '../src/core/redact';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/** Destino pino em memória. */
function memory(): { stream: Writable & { write(s: string): boolean }; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Mesmo formato do ThrottlerException do @nestjs/throttler. */
class ThrottlerException extends HttpException {
  constructor() {
    super('ThrottlerException: Too Many Requests', 429);
  }
}

// ---- app de teste (decorators aplicados como funções: sem emitDecoratorMetadata) ----
class ItemsController {
  get(req: { params: { id: string } }): { id: string } {
    if (req.params.id === 'boom') throw new Error('falha interna para ana@ciag.org.br');
    if (req.params.id === 'missing') throw new NotFoundException('Item não encontrado');
    if (req.params.id === 'str') throw new HttpException('texto simples', 400);
    if (req.params.id === 'obj') throw new HttpException({ message: ['campo inválido'], custom: true }, 422);
    if (req.params.id === 'limit') throw new ThrottlerException();
    if (req.params.id === 'gateway') throw new HttpException('upstream', 502);
    return { id: req.params.id };
  }
}
Req()(ItemsController.prototype, 'get', 0);
Get(':id')(ItemsController.prototype, 'get', Object.getOwnPropertyDescriptor(ItemsController.prototype, 'get')!);
Controller('items')(ItemsController);

class HealthController {
  get(): { ok: boolean } {
    return { ok: true };
  }
}
Get()(HealthController.prototype, 'get', Object.getOwnPropertyDescriptor(HealthController.prototype, 'get')!);
Controller('health')(HealthController);

class AppModule {}
Module({
  imports: [
    ObservabilityModule.forRoot({
      userId: (req) => (req.headers['x-test-user'] as string | undefined) ?? undefined,
    }),
  ],
  controllers: [ItemsController, HealthController],
})(AppModule);

describe('ObservabilityModule (Nest real + supertest)', () => {
  let app: INestApplication;
  let mem: ReturnType<typeof memory>;
  const captured: Array<{ error: unknown; info: CaptureInfo }> = [];
  const crumbs: string[] = [];

  beforeEach(async () => {
    resetStateForTests();
    captured.length = 0;
    crumbs.length = 0;
    mem = memory();
    setRootLoggerForTests(createJsonLogger({ level: 'info', destination: mem.stream }));
    state().errors = {
      captureServerError: (error, info) => captured.push({ error, info }),
      breadcrumb: (m) => crumbs.push(m),
    };
    app = await NestFactory.create(AppModule, { logger: new NestJsonLogger() });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    setRootLoggerForTests(undefined);
  });

  it('gera X-Request-Id e aceita um válido da entrada; inválido é trocado', async () => {
    const r1 = await request(app.getHttpServer()).get('/items/1');
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ id: '1' });
    expect(r1.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const r2 = await request(app.getHttpServer()).get('/items/1').set('X-Request-Id', 'abc12345-entrada');
    expect(r2.headers['x-request-id']).toBe('abc12345-entrada');
    const r3 = await request(app.getHttpServer()).get('/items/1').set('X-Request-Id', 'x y<script>');
    expect(r3.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('corpo de erro do Nest preservado + errorId aditivo (= X-Request-Id)', async () => {
    const nf = await request(app.getHttpServer()).get('/items/missing');
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({
      message: 'Item não encontrado',
      error: 'Not Found',
      statusCode: 404,
      errorId: nf.headers['x-request-id'],
    });
    const str = await request(app.getHttpServer()).get('/items/str');
    expect(str.body).toEqual({ statusCode: 400, message: 'texto simples', errorId: str.headers['x-request-id'] });
    const obj = await request(app.getHttpServer()).get('/items/obj');
    expect(obj.status).toBe(422);
    expect(obj.body).toEqual({ message: ['campo inválido'], custom: true, errorId: obj.headers['x-request-id'] });
    const boom = await request(app.getHttpServer()).get('/items/boom');
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      errorId: boom.headers['x-request-id'],
    });
    const unmatched = await request(app.getHttpServer()).get('/nada/aqui');
    expect(unmatched.status).toBe(404);
    expect(unmatched.body).toEqual({
      message: 'Cannot GET /nada/aqui',
      error: 'Not Found',
      statusCode: 404,
      errorId: unmatched.headers['x-request-id'],
    });
  });

  it('5xx vão ao GlitchTip com errorId/rota/usuário; 4xx não', async () => {
    const boom = await request(app.getHttpServer()).get('/items/boom').set('x-test-user', 'u-1');
    await request(app.getHttpServer()).get('/items/missing');
    await request(app.getHttpServer()).get('/items/gateway');
    expect(captured).toHaveLength(2);
    expect(captured[0]!.info.tags).toEqual({
      route: '/items/:id',
      method: 'GET',
      status: '500',
      errorId: boom.headers['x-request-id'],
    });
    expect(captured[0]!.info.userId).toBe('u-1');
    expect(captured[1]!.info.tags.status).toBe('502');
  });

  it('uma linha JSON por requisição: rota padrão, status, duração, userId, ip; /health ignorado', async () => {
    const r = await request(app.getHttpServer()).get('/items/123').set('x-test-user', 'u-9');
    await request(app.getHttpServer()).get('/health');
    const lines = mem.lines().filter((l) => l.context === 'HTTP');
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatchObject({
      level: 'info',
      method: 'GET',
      route: '/items/:id',
      status: 200,
      userId: 'u-9',
      requestId: r.headers['x-request-id'],
      msg: expect.stringMatching(/^GET \/items\/:id 200 [\d.]+ms$/) as string,
    });
    expect(typeof line.duration_ms).toBe('number');
    expect(typeof line.ip).toBe('string');
    expect(JSON.stringify(line)).not.toContain('/items/123');
  });

  it('429 vira linha com status/rota/ip + breadcrumb, sem evento de erro', async () => {
    await request(app.getHttpServer()).get('/items/limit');
    const line = mem.lines().find((l) => l.context === 'HTTP');
    expect(line).toMatchObject({ status: 429, route: '/items/:id' });
    expect(crumbs).toEqual(['GET /items/:id 429 ' + String(line!.duration_ms) + 'ms']);
    expect(captured).toHaveLength(0);
  });

  it('erro 500 sai no log do ExceptionsHandler em JSON com requestId e e-mail mascarado', async () => {
    const r = await request(app.getHttpServer()).get('/items/boom');
    const err = mem.lines().find((l) => l.context === 'ExceptionsHandler');
    expect(err).toBeDefined();
    expect(err!.level).toBe('error');
    expect(err!.requestId).toBe(r.headers['x-request-id']);
    expect(err!.params).toBeUndefined();
    expect((err!.err as { message: string }).message).toBe('falha interna para a***@ciag.org.br');
    expect(JSON.stringify(err)).toContain('a***@ciag.org.br');
    expect(JSON.stringify(err)).not.toContain('ana@ciag.org.br');
  });
});

describe('NestJsonLogger (semântica do ConsoleLogger)', () => {
  it('contexto, stack e objetos', () => {
    const mem = memory();
    const logger = new NestJsonLogger(createJsonLogger({ level: 'trace', destination: mem.stream }));
    logger.log('subiu', 'NestApplication');
    logger.error('falhou', 'Error: x\n    at y (z.js:1:1)', 'SharepointService');
    logger.error('só stack', 'Error: x\n    at y (z.js:1:1)');
    logger.warn({ msg: 'objeto', password: 'x' }, 'Ctx');
    logger.verbose('detalhe');
    const [a, b, c, d, e] = mem.lines();
    expect(a).toMatchObject({ level: 'info', msg: 'subiu', context: 'NestApplication' });
    expect(b).toMatchObject({ level: 'error', msg: 'falhou', context: 'SharepointService' });
    expect(b!.stack).toContain('at y');
    expect(c!.context).toBeUndefined();
    expect(c!.stack).toContain('at y');
    expect(d).toMatchObject({ level: 'warn', msg: 'objeto', password: REDACTED, context: 'Ctx' });
    expect(e).toMatchObject({ level: 'trace', msg: 'detalhe' });
    expect(typeof a!.time).toBe('string');
  });

  it('mensagem com e-mail e JWT sai redigida', () => {
    const mem = memory();
    const logger = createJsonLogger({ level: 'info', destination: mem.stream });
    logger.info('login de ana@ciag.org.br com Bearer abcdefghijklmnop');
    expect(mem.lines()[0]!.msg).toBe(`login de a***@ciag.org.br com Bearer ${REDACTED}`);
  });

  it('pino é a base (formato estável)', () => {
    expect(typeof pino.stdTimeFunctions.isoTime).toBe('function');
  });
});

describe('configuração e modo desligado', () => {
  it('sem variáveis: nada ligado, ambiente local', () => {
    const c = resolveConfig({ env: {} });
    expect(c).toMatchObject({
      otlpEndpoint: undefined,
      tracesEnabled: false,
      metricsEnabled: false,
      logsEnabled: false,
      errorsDsn: undefined,
      environment: 'local',
      logLevel: 'info',
    });
  });
  it('com endpoint: sinais ligados (OTEL_*_EXPORTER=none desliga um a um)', () => {
    const c = resolveConfig({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4318',
        OTEL_LOGS_EXPORTER: 'none',
        DEPLOYMENT_ENVIRONMENT: 'production',
        OTEL_SERVICE_NAME: 'teatime-api',
        APP_RELEASE: '1.9.1',
      },
    });
    expect(c).toMatchObject({
      tracesEnabled: true,
      metricsEnabled: true,
      logsEnabled: false,
      environment: 'prod',
      serviceName: 'teatime-api',
      serviceVersion: '1.9.1',
    });
    expect(resolveConfig({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_SDK_DISABLED: 'true' } }).tracesEnabled).toBe(false);
  });
  it('ignora /health e subcaminhos', () => {
    expect(isIgnoredPath('/health', ['/health'])).toBe(true);
    expect(isIgnoredPath('/health/ready?x=1', ['/health'])).toBe(true);
    expect(isIgnoredPath('/healthy', ['/health'])).toBe(false);
  });
  it('initTelemetry sem variáveis: não liga nada e não instala handlers de sinal', () => {
    resetStateForTests();
    const before = process.listenerCount('SIGTERM');
    const h = initTelemetry({ env: {} });
    expect(h.telemetryEnabled).toBe(false);
    expect(h.errorsEnabled).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    resetStateForTests();
  });
  it('initTelemetry com DSN inválido: não lança, só desliga erros', () => {
    resetStateForTests();
    const mem = memory();
    setRootLoggerForTests(createJsonLogger({ level: 'info', destination: mem.stream }));
    const h = initTelemetry({ env: { ERRORS_DSN: 'não é dsn' } });
    expect(h.errorsEnabled).toBe(false);
    expect(mem.lines()[0]).toMatchObject({ level: 'warn', msg: 'ERRORS_DSN inválido: envio de erros desligado' });
    setRootLoggerForTests(undefined);
    resetStateForTests();
  });
});

describe('redação de atributos de span', () => {
  it('URL com token, cabeçalho authorization e e-mail em atributo', () => {
    const span = {
      name: 'GET /auth/verify',
      kind: 1,
      spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 2, message: 'falha de ana@ciag.org.br' },
      attributes: {
        'url.full': 'http://api/auth/verify?token=abc&x=1',
        'url.query': 'token=abc&x=1',
        'http.request.header.authorization': ['Bearer x'],
        'http.request.header.cookie': ['a=1'],
        'enduser.id': 'u1',
        'db.statement': "select * from user where email = 'ana@ciag.org.br'",
        'http.route': '/auth/verify',
      },
      links: [],
      events: [{ name: 'exception', time: [0, 0], attributes: { 'exception.message': 'x de bob@ciag.org.br' } }],
      duration: [0, 1],
      ended: true,
      resource: {},
      instrumentationScope: { name: 'x' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
    const out = redactSpan(span);
    expect(out.attributes).toEqual({
      'url.full': `http://api/auth/verify?token=${REDACTED}&x=1`,
      'url.query': `token=${REDACTED}&x=1`,
      'http.request.header.authorization': REDACTED,
      'http.request.header.cookie': REDACTED,
      'enduser.id': 'u1',
      'db.statement': "select * from user where email = 'a***@ciag.org.br'",
      'http.route': '/auth/verify',
    });
    expect(out.status.message).toBe('falha de a***@ciag.org.br');
    expect(out.events[0]!.attributes).toEqual({ 'exception.message': 'x de b***@ciag.org.br' });
    expect(out.spanContext().traceId).toBe('t');
  });
});
