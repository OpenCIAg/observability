import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { metrics, trace, isSpanContextValid } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { REQUEST_ID_HEADER, isValidRequestId } from '../core/conventions';
import { redactUrl } from '../core/redact';
import { isIgnoredPath } from './config';
import { state } from './state';

/** Requisição Express mínima (o pacote não depende dos tipos do Express em runtime). */
export interface HttpRequestLike extends IncomingMessage {
  ip?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  user?: unknown;
}

export type UserIdExtractor = (req: HttpRequestLike) => string | undefined;

interface RequestInfo {
  requestId: string;
  traceId?: string;
  spanId?: string;
}

const infos = new WeakMap<object, RequestInfo>();

/** request id/trace da requisição (definidos pelo middleware). */
export function requestInfo(req: object): RequestInfo | undefined {
  return infos.get(req);
}

/** Padrão: `req.user.id`, `req.user.sub` ou `req.user.userId` (string/número). Nunca e-mail/nome. */
export const defaultUserId: UserIdExtractor = (req) => {
  const user = req.user;
  if (typeof user !== 'object' || user === null) return undefined;
  for (const key of ['id', 'sub', 'userId'] as const) {
    const value: unknown = Reflect.get(user, key);
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
};

/** Rota no padrão do framework (`/projects/:id`), nunca a URL com ids. `undefined` = nenhuma rota casou. */
export function routePattern(req: HttpRequestLike): string | undefined {
  const path = req.route?.path;
  if (typeof path !== 'string') return undefined;
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  return `${base}${path}` || '/';
}

export interface RequestLoggingOptions {
  logger: () => Logger;
  ignorePaths: readonly string[];
  userId: UserIdExtractor;
}

type Next = (err?: unknown) => void;

let authCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | undefined;

function countClientError(status: number, route: string): void {
  authCounter ??= metrics.getMeter('@openciag/observability').createCounter('ciag.http.server.rejected', {
    description: 'Respostas 401/403/429 (login falho, sem permissão, rate limit)',
  });
  authCounter.add(1, { 'http.response.status_code': status, 'http.route': route });
}

/**
 * Middleware: request id (aceita `X-Request-Id` válido da entrada, senão gera UUID), devolve no
 * cabeçalho, propaga por AsyncLocalStorage e escreve UMA linha de log por requisição ao terminar.
 */
export function createRequestMiddleware(options: RequestLoggingOptions) {
  return function ciagRequestMiddleware(req: HttpRequestLike, res: ServerResponse, next: Next): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = isValidRequestId(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const ctx = trace.getActiveSpan()?.spanContext();
    const info: RequestInfo =
      ctx !== undefined && isSpanContextValid(ctx)
        ? { requestId, traceId: ctx.traceId, spanId: ctx.spanId }
        : { requestId };
    infos.set(req, info);

    const path = req.originalUrl ?? req.url ?? '';
    if (!isIgnoredPath(path, options.ignorePaths)) {
      const start = process.hrtime.bigint();
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
        const route = routePattern(req);
        const status = res.writableFinished || res.headersSent ? res.statusCode : 499;
        const userId = options.userId(req);
        const line: Record<string, string | number> = {
          context: 'HTTP',
          requestId,
          method: req.method ?? '',
          route: route ?? '(sem rota)',
          status,
          duration_ms: durationMs,
          ip: req.ip ?? req.socket.remoteAddress ?? '',
        };
        if (route === undefined) line.path = redactUrl(path.split('?')[0] ?? path);
        if (userId !== undefined) line.userId = userId;
        if (info.traceId !== undefined && info.spanId !== undefined) {
          line.trace_id = info.traceId;
          line.span_id = info.spanId;
        }
        const msg = `${line.method} ${line.route} ${status} ${durationMs}ms`;
        if (status >= 500) options.logger().error(line, msg);
        else options.logger().info(line, msg);
        if (status === 401 || status === 403 || status === 429) {
          countClientError(status, String(line.route));
          state().errors?.breadcrumb(msg, { status, route: String(line.route) });
        }
      };
      res.once('finish', finish);
      res.once('close', finish);
    }
    state().als.run({ requestId }, () => next());
  };
}
