import { trace, isSpanContextValid } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger, type LevelWithSilent } from 'pino';
import type { LoggerService, LogLevel } from '@nestjs/common';
import { redactString, redactValue } from '../core/redact';
import { resolveConfig } from './config';
import { state, type LogRecordInput } from './state';

/** Campos de correlação de cada linha: requestId (sempre que houver requisição) e trace/span do OTel. */
export function correlationFields(): Record<string, string> {
  const out: Record<string, string> = {};
  const requestId = state().als.getStore()?.requestId;
  if (requestId !== undefined) out.requestId = requestId;
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx !== undefined && isSpanContextValid(ctx)) {
    out.trace_id = ctx.traceId;
    out.span_id = ctx.spanId;
  }
  return out;
}

function toAttributes(obj: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'msg' || key === 'level' || key === 'time' || key === 'trace_id' || key === 'span_id') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (value !== null && value !== undefined) out[key] = JSON.stringify(value);
  }
  return out;
}

/** Linha JSON já serializada (e redigida) -> registro OTLP. Linha inválida é ignorada. */
export function lineToLogRecord(line: string): LogRecordInput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const time = typeof obj.time === 'string' ? Date.parse(obj.time) : Date.now();
  return {
    level: typeof obj.level === 'string' ? obj.level : 'info',
    message: typeof obj.msg === 'string' ? obj.msg : '',
    attributes: toAttributes(obj),
    traceId: typeof obj.trace_id === 'string' ? obj.trace_id : undefined,
    spanId: typeof obj.span_id === 'string' ? obj.span_id : undefined,
    timeMs: Number.isFinite(time) ? time : Date.now(),
  };
}

/** stdout (síncrono, como o console) + cópia OTLP quando a exportação de logs está ligada. */
function createDestination(): DestinationStream {
  const stdout = pino.destination({ dest: 1, sync: true });
  return {
    write(line: string): void {
      stdout.write(line);
      const emit = state().emitLog;
      if (emit !== undefined) {
        const record = lineToLogRecord(line);
        if (record !== undefined) emit(record);
      }
    },
  };
}

let rootLogger: Logger | undefined;

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

/**
 * Logger JSON (pino) com redação de PII e correlação. Uma linha por evento:
 * `{"level":"info","time":"…","msg":"…","context":"…","requestId":"…","trace_id":"…","span_id":"…"}`.
 */
export function createJsonLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? state().config?.logLevel ?? resolveConfig().logLevel;
  return pino(
    {
      level,
      base: undefined,
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: correlationFields,
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redactValue(obj),
      },
      hooks: {
        logMethod(args, method) {
          const redacted = args.map((arg: unknown) => (typeof arg === 'string' ? redactString(arg) : arg));
          method.apply(this, redacted as Parameters<typeof method>);
        },
      },
    },
    options.destination ?? createDestination(),
  );
}

/** Logger raiz do processo (criado na primeira chamada). */
export function getRootLogger(): Logger {
  rootLogger ??= createJsonLogger();
  return rootLogger;
}

/** Só para testes. */
export function setRootLoggerForTests(logger: Logger | undefined): void {
  rootLogger = logger;
}

const STACK_RE = /\n\s*at /;

type PinoMethod = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const NEST_TO_PINO: Record<LogLevel, PinoMethod> = {
  fatal: 'fatal',
  error: 'error',
  warn: 'warn',
  log: 'info',
  debug: 'debug',
  verbose: 'trace',
};

/**
 * `LoggerService` do Nest sobre o pino: `app.useLogger(...)` / `NestFactory.create(..., { logger })`.
 * Mantém a semântica do ConsoleLogger: último parâmetro string = contexto; em `error`, o
 * parâmetro anterior com cara de stack vira `stack`.
 */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: Logger = getRootLogger()) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
    const lowest = order.find((l) => levels.includes(l));
    this.logger.level = (lowest === undefined ? 'silent' : NEST_TO_PINO[lowest]) satisfies LevelWithSilent;
  }

  private write(level: LogLevel, message: unknown, params: unknown[]): void {
    // Logger de instância do Nest repassa `stack` ausente como `undefined`: descarta.
    const rest = params.filter((p) => p !== undefined);
    const fields: Record<string, unknown> = {};
    if (rest.length > 0 && typeof rest[rest.length - 1] === 'string') {
      const last = rest[rest.length - 1] as string;
      if (!(level === 'error' && rest.length === 1 && STACK_RE.test(last))) {
        fields.context = last;
        rest.pop();
      }
    }
    if (level === 'error' || level === 'fatal') {
      const stack = rest[0];
      if (typeof stack === 'string' && stack !== '') {
        fields.stack = stack;
        rest.shift();
      }
    }
    // `logger.error('msg', error)` (padrão do app): o Error vira `err` (pino serializa type/message/stack).
    const errIndex = rest.findIndex((p) => p instanceof Error);
    if (errIndex >= 0 && !(message instanceof Error)) {
      fields.err = rest[errIndex];
      rest.splice(errIndex, 1);
    }
    if (rest.length > 0) fields.params = rest;
    const method = NEST_TO_PINO[level];
    if (message instanceof Error) {
      this.logger[method]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[method]({ ...fields, ...(message as Record<string, unknown>) });
    } else {
      this.logger[method](fields, String(message));
    }
  }
}
