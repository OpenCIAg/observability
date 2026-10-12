import { createRequire } from 'node:module';
import { ROOT_CONTEXT, context as otelContext } from '@opentelemetry/api';
import type { IncomingMessage } from 'node:http';
import { SERVICE_NAMESPACE } from '../core/conventions';
import { isIgnoredPath, resolveConfig, type ResolvedConfig, type TelemetryOptions } from './config';
import { initErrors } from './errors';
import { getRootLogger } from './logger';
import { RedactingSpanExporter } from './redacting-exporter';
import { state, type LogRecordInput } from './state';

type Api = typeof import('@opentelemetry/api');
type ApiLogs = typeof import('@opentelemetry/api-logs');
type Core = typeof import('@opentelemetry/core');
type Resources = typeof import('@opentelemetry/resources');
type TraceNode = typeof import('@opentelemetry/sdk-trace-node');
type Metrics = typeof import('@opentelemetry/sdk-metrics');
type Logs = typeof import('@opentelemetry/sdk-logs');
type TraceExp = typeof import('@opentelemetry/exporter-trace-otlp-http');
type MetricExp = typeof import('@opentelemetry/exporter-metrics-otlp-http');
type LogExp = typeof import('@opentelemetry/exporter-logs-otlp-http');
type Instr = typeof import('@opentelemetry/instrumentation');
type HttpInstr = typeof import('@opentelemetry/instrumentation-http');
type ExpressInstr = typeof import('@opentelemetry/instrumentation-express');
type NestInstr = typeof import('@opentelemetry/instrumentation-nestjs-core');
type Mysql2Instr = typeof import('@opentelemetry/instrumentation-mysql2');
type PrismaInstr = typeof import('@prisma/instrumentation');
type Instrumentation = InstanceType<Instr['InstrumentationBase']>;

const requireFromHere = createRequire(import.meta.url);

function load<T>(id: string): T {
  return requireFromHere(id) as T;
}

function tryLoad<T>(id: string): T | undefined {
  try {
    return load<T>(id);
  } catch {
    return undefined;
  }
}

export interface TelemetryHandle {
  /** Configuração efetiva (variáveis + opções). */
  config: ResolvedConfig;
  /** Exporta traces/métricas/logs por OTLP? */
  telemetryEnabled: boolean;
  /** Envia erros ao GlitchTip/Sentry? */
  errorsEnabled: boolean;
  /** Descarrega e encerra exportadores (idempotente). */
  shutdown(): Promise<void>;
}

const SEVERITY: Record<string, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

/** Avisos do OTel/exportadores: no máximo 1 linha por minuto por mensagem, nunca lança. */
function makeWarn(): (msg: string) => void {
  const last = new Map<string, number>();
  return (msg: string) => {
    const now = Date.now();
    const prev = last.get(msg);
    if (prev !== undefined && now - prev < 60_000) return;
    last.set(msg, now);
    try {
      // Fora de qualquer span: o aviso não é atribuído à requisição/trace em curso.
      otelContext.with(ROOT_CONTEXT, () => getRootLogger().warn({ context: 'Observability' }, msg));
    } catch {
      // logging nunca derruba o app
    }
  };
}

function signalUrl(base: string, signal: 'traces' | 'metrics' | 'logs'): string {
  return `${base.replace(/\/+$/, '')}/v1/${signal}`;
}

function setupOtel(config: ResolvedConfig, warn: (msg: string) => void): Array<() => Promise<void>> {
  const endpoint = config.otlpEndpoint;
  if (endpoint === undefined) return [];
  try {
    new URL(endpoint);
  } catch {
    warn(`OTEL_EXPORTER_OTLP_ENDPOINT inválido (${endpoint}): telemetria desligada`);
    return [];
  }
  // Métricas HTTP no padrão estável (http.server.request.duration com http.route).
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

  const api = load<Api>('@opentelemetry/api');
  const core = load<Core>('@opentelemetry/core');
  const resources = load<Resources>('@opentelemetry/resources');
  const traceNode = load<TraceNode>('@opentelemetry/sdk-trace-node');
  const instr = load<Instr>('@opentelemetry/instrumentation');

  core.setGlobalErrorHandler((err) => {
    const text = err instanceof Error ? err.message : String(err);
    warn(`telemetria: falha ao exportar (${text.slice(0, 200)})`);
  });

  const resource = resources.resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'service.namespace': SERVICE_NAMESPACE,
    'deployment.environment': config.environment,
    'deployment.environment.name': config.environment,
  });

  const shutdowns: Array<() => Promise<void>> = [];

  if (config.tracesEnabled) {
    const traceExp = load<TraceExp>('@opentelemetry/exporter-trace-otlp-http');
    const exporter = new RedactingSpanExporter(
      new traceExp.OTLPTraceExporter({ url: signalUrl(endpoint, 'traces') }),
    );
    const provider = new traceNode.NodeTracerProvider({
      resource,
      sampler: new traceNode.ParentBasedSampler({
        root: new traceNode.TraceIdRatioBasedSampler(config.tracesSampleRate),
      }),
      spanProcessors: [new traceNode.BatchSpanProcessor(exporter)],
    });
    provider.register();
    shutdowns.push(() => provider.shutdown());
  }

  if (config.metricsEnabled) {
    const metrics = load<Metrics>('@opentelemetry/sdk-metrics');
    const metricExp = load<MetricExp>('@opentelemetry/exporter-metrics-otlp-http');
    const meterProvider = new metrics.MeterProvider({
      resource,
      readers: [
        new metrics.PeriodicExportingMetricReader({
          exporter: new metricExp.OTLPMetricExporter({ url: signalUrl(endpoint, 'metrics') }),
          exportIntervalMillis: config.metricExportIntervalMs,
        }),
      ],
    });
    api.metrics.setGlobalMeterProvider(meterProvider);
    shutdowns.push(() => meterProvider.shutdown());
  }

  if (config.logsEnabled) {
    const logs = load<Logs>('@opentelemetry/sdk-logs');
    const apiLogs = load<ApiLogs>('@opentelemetry/api-logs');
    const logExp = load<LogExp>('@opentelemetry/exporter-logs-otlp-http');
    const loggerProvider = new logs.LoggerProvider({
      resource,
      processors: [
        new logs.BatchLogRecordProcessor({
          exporter: new logExp.OTLPLogExporter({ url: signalUrl(endpoint, 'logs') }),
        }),
      ],
    });
    const otelLogger = loggerProvider.getLogger('@ciag/observability');
    state().emitLog = (record: LogRecordInput) => {
      const context =
        record.traceId !== undefined && record.spanId !== undefined
          ? api.trace.setSpanContext(api.ROOT_CONTEXT, {
              traceId: record.traceId,
              spanId: record.spanId,
              traceFlags: api.TraceFlags.SAMPLED,
            })
          : api.ROOT_CONTEXT;
      otelLogger.emit({
        timestamp: record.timeMs,
        severityNumber: (SEVERITY[record.level] ?? 9) as ApiLogs['SeverityNumber'][keyof ApiLogs['SeverityNumber']],
        severityText: record.level.toUpperCase(),
        body: record.message,
        attributes: record.attributes,
        context,
      });
    };
    shutdowns.push(async () => {
      state().emitLog = undefined;
      await loggerProvider.shutdown();
    });
  }

  if (config.tracesEnabled || config.metricsEnabled) {
    const http = load<HttpInstr>('@opentelemetry/instrumentation-http');
    const express = load<ExpressInstr>('@opentelemetry/instrumentation-express');
    const nest = load<NestInstr>('@opentelemetry/instrumentation-nestjs-core');
    const mysql2 = tryLoad<Mysql2Instr>('@opentelemetry/instrumentation-mysql2');
    const prisma = tryLoad<PrismaInstr>('@prisma/instrumentation');
    const list: Instrumentation[] = [
      new http.HttpInstrumentation({
        ignoreIncomingRequestHook: (req: IncomingMessage) => isIgnoredPath(req.url ?? '', config.ignorePaths),
        // Saídas para o próprio coletor/GlitchTip não viram spans.
        ignoreOutgoingRequestHook: (opts) => {
          const host = typeof opts.hostname === 'string' ? opts.hostname : opts.host;
          try {
            return host !== undefined && host !== null && new URL(endpoint).hostname === host;
          } catch {
            return false;
          }
        },
      }),
      new express.ExpressInstrumentation(),
      new nest.NestInstrumentation(),
    ];
    if (mysql2 !== undefined) list.push(new mysql2.MySQL2Instrumentation());
    if (prisma !== undefined) list.push(new prisma.PrismaInstrumentation());
    instr.registerInstrumentations({ instrumentations: list });
  }

  return shutdowns;
}

/**
 * Liga a telemetria do processo Node. Chame ANTES de importar o Nest/Express/Prisma
 * (ex.: primeira linha do `main.ts`: `import './instrumentation';`).
 *
 * - Sem `OTEL_EXPORTER_OTLP_ENDPOINT`: nenhum SDK é carregado, nada é exportado.
 * - Sem `ERRORS_DSN`: o Sentry nem é carregado.
 * - Endpoint/DSN inválido ou fora do ar: o app sobe normalmente e só registra aviso (no máximo 1/min).
 */
export function initTelemetry(options: TelemetryOptions = {}): TelemetryHandle {
  const s = state();
  const config = resolveConfig(options);
  if (s.initialized && s.config !== undefined) {
    return makeHandle(s.config, s.shutdowns.length > 0, s.errors !== undefined);
  }
  s.config = config;
  s.initialized = true;
  const warn = makeWarn();

  let otelShutdowns: Array<() => Promise<void>> = [];
  try {
    otelShutdowns = setupOtel(config, warn);
  } catch (err) {
    warn(`telemetria desligada: ${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = initErrors(config, warn);
  if (errors !== undefined) s.errors = errors.sink;
  s.shutdowns.push(...otelShutdowns);
  if (errors !== undefined) s.shutdowns.push(errors.close);

  if (s.shutdowns.length > 0) installSignalHandlers();
  return makeHandle(config, otelShutdowns.length > 0, errors !== undefined);
}

let shuttingDown: Promise<void> | undefined;

function shutdownAll(): Promise<void> {
  shuttingDown ??= (async () => {
    const tasks = state().shutdowns.map((fn) => fn().catch(() => undefined));
    await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, 3000).unref())]);
  })();
  return shuttingDown;
}

function makeHandle(config: ResolvedConfig, telemetryEnabled: boolean, errorsEnabled: boolean): TelemetryHandle {
  return { config, telemetryEnabled, errorsEnabled, shutdown: shutdownAll };
}

/**
 * SIGTERM/SIGINT: descarrega a telemetria e depois devolve o sinal ao processo. Só instalado
 * quando algo está ligado (sem variáveis, o processo trata sinais exatamente como antes).
 */
function installSignalHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = (): void => {
      // `once` já removeu este listener; sem outros, o sinal reenviado encerra como o padrão do Node.
      void shutdownAll().finally(() => {
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    process.once(signal, handler);
  }
}
