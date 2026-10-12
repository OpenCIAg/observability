import { createRequire } from 'node:module';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { AbstractHttpAdapter, BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { ERROR_ID_FIELD } from '../core/conventions';
import { requestInfo, routePattern, type HttpRequestLike, type UserIdExtractor } from './request-context';
import { state } from './state';

type NestCore = typeof import('@nestjs/core');

const requireFromHere = createRequire(import.meta.url);

interface HttpExceptionLike {
  getStatus(): number;
  getResponse(): unknown;
}

function isHttpExceptionLike(value: unknown): value is HttpExceptionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getStatus') === 'function' &&
    typeof Reflect.get(value, 'getResponse') === 'function'
  );
}

/** Status que o filtro padrão do Nest devolveria para a exceção. */
export function statusOf(exception: unknown): number {
  if (isHttpExceptionLike(exception)) return exception.getStatus();
  if (typeof exception === 'object' && exception !== null) {
    const statusCode: unknown = Reflect.get(exception, 'statusCode');
    const message: unknown = Reflect.get(exception, 'message');
    if (typeof statusCode === 'number' && statusCode > 0 && typeof message === 'string' && message !== '') {
      return statusCode;
    }
  }
  return 500;
}

/** Acrescenta `errorId` a um corpo JSON de erro (só objetos simples; nada é removido ou alterado). */
export function withErrorId(body: unknown, errorId: string | undefined): unknown {
  if (errorId === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  if (Object.prototype.hasOwnProperty.call(body, ERROR_ID_FIELD)) return body;
  return { ...(body as Record<string, unknown>), [ERROR_ID_FIELD]: errorId };
}

/**
 * Filtro global: delega ao `BaseExceptionFilter` do próprio Nest (mesmo corpo, mesmo status, mesmo log
 * do `ExceptionsHandler`) e só (1) acrescenta `errorId` ao JSON e (2) reporta 5xx/erros inesperados
 * ao GlitchTip/Sentry com o mesmo id. 4xx não são reportados como erro.
 */
export class ObservabilityExceptionFilter implements ExceptionFilter {
  private readonly delegate: BaseExceptionFilter;

  constructor(
    adapterHost: HttpAdapterHost,
    private readonly userId: UserIdExtractor,
    core: NestCore = requireFromHere('@nestjs/core') as NestCore,
  ) {
    const adapter = adapterHost.httpAdapter;
    const proxy: AbstractHttpAdapter = Object.create(adapter) as AbstractHttpAdapter;
    proxy.reply = (response: unknown, body: unknown, statusCode?: number): unknown => {
      const info = typeof response === 'object' && response !== null ? replyIds.get(response) : undefined;
      return adapter.reply(response, withErrorId(body, info), statusCode);
    };
    this.delegate = new core.BaseExceptionFilter(proxy);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.delegate.catch(exception, host);
      return;
    }
    const req = host.getArgByIndex<HttpRequestLike>(0);
    const res = host.getArgByIndex<object>(1);
    const info = requestInfo(req);
    const status = statusOf(exception);
    if (status >= 500) {
      const route = routePattern(req) ?? '(sem rota)';
      const tags: Record<string, string> = { route, method: req.method ?? '', status: String(status) };
      if (info !== undefined) tags[ERROR_ID_FIELD] = info.requestId;
      state().errors?.captureServerError(exception, {
        tags,
        userId: this.userId(req),
        trace:
          info?.traceId !== undefined && info.spanId !== undefined
            ? { traceId: info.traceId, spanId: info.spanId }
            : undefined,
      });
    }
    if (info !== undefined) replyIds.set(res, info.requestId);
    this.delegate.catch(exception, host);
  }
}

const replyIds = new WeakMap<object, string>();
