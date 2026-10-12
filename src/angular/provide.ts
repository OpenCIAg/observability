import {
  ErrorHandler,
  Injector,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import {
  HTTP_INTERCEPTORS,
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
  type HttpHandlerFn,
  type HttpInterceptor,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { redactUrl } from '../core/redact';
import { isEnabled, type ObservabilityConfig } from './config';
import { errorReference } from './error-reference';
import type { SentryFacade } from './sentry-loader';

/** Carregador do chunk do Sentry (substituível em testes). */
export type SentryLoader = () => Promise<{
  startSentry: (config: ObservabilityConfig, injector: Injector) => SentryFacade;
}>;

const defaultLoader: SentryLoader = () => import('./sentry-loader');

const MAX_QUEUE = 20;

/** Estado do lado navegador: fila até o SDK carregar. */
class BrowserState {
  sentry: SentryFacade | undefined;
  pendingErrors: unknown[] = [];
  pendingUser: string | null | undefined;

  report(error: unknown): void {
    if (this.sentry !== undefined) this.sentry.captureException(error);
    else if (this.pendingErrors.length < MAX_QUEUE) this.pendingErrors.push(error);
  }

  attach(sentry: SentryFacade): void {
    this.sentry = sentry;
    if (this.pendingUser !== undefined) sentry.setUserId(this.pendingUser);
    for (const error of this.pendingErrors.splice(0)) sentry.captureException(error);
  }
}

let browserState = new BrowserState();

/** Só para testes. */
export function resetObservabilityForTests(): void {
  browserState = new BrowserState();
}

/**
 * Identifica o usuário SÓ pelo id (LGPD). Chame após o login; `null` no logout.
 * Sem DSN não faz nada.
 */
export function setObservabilityUser(id: string | null): void {
  if (browserState.sentry !== undefined) browserState.sentry.setUserId(id);
  else browserState.pendingUser = id;
}

/** Limpa o usuário (logout). */
export function clearObservabilityUser(): void {
  setObservabilityUser(null);
}

/**
 * ErrorHandler: mantém o comportamento padrão do Angular (console.error) e reporta ao GlitchTip.
 * Erros antes do SDK carregar ficam numa fila curta (até 20).
 */
export class ObservabilityErrorHandler implements ErrorHandler {
  private readonly fallback = new ErrorHandler();

  handleError(error: unknown): void {
    this.fallback.handleError(error);
    browserState.report(error);
  }
}

function onHttpError(err: unknown, req: HttpRequest<unknown>): void {
  if (!(err instanceof HttpErrorResponse) || browserState.sentry === undefined) return;
  const data: Record<string, string | number> = {
    status: err.status,
    method: req.method,
    url: redactUrl(req.urlWithParams),
  };
  const ref = errorReference(err);
  if (ref !== null) data.errorId = ref;
  browserState.sentry.breadcrumb(`HTTP ${err.status}`, data);
}

/** Interceptor funcional (para `withInterceptors([...])`): breadcrumb com status e errorId. */
export const observabilityInterceptor: HttpInterceptorFn = (req, next: HttpHandlerFn) =>
  next(req).pipe(tap({ error: (err: unknown) => onHttpError(err, req) }));

/** Mesmo interceptor no formato de classe (para `withInterceptorsFromDi()`). */
export class ObservabilityHttpInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    return next.handle(req).pipe(tap({ error: (err: unknown) => onHttpError(err, req) }));
  }
}

/**
 * Observabilidade do front: ErrorHandler + tracing do roteador e das chamadas HTTP com
 * `traceparent` só para `apiOrigins`, redação no beforeSend, usuário só por id.
 *
 * Sem `errorsDsn`: devolve providers vazios (nada muda no app, nenhum byte do Sentry é baixado).
 * Com DSN: o SDK vem num chunk separado, carregado depois do bootstrap (não pesa no JS inicial).
 */
export function provideObservability(
  config: ObservabilityConfig,
  loader: SentryLoader = defaultLoader,
): EnvironmentProviders {
  if (!isEnabled(config)) return makeEnvironmentProviders([]);
  return makeEnvironmentProviders([
    { provide: ErrorHandler, useFactory: () => new ObservabilityErrorHandler() },
    { provide: HTTP_INTERCEPTORS, useFactory: () => new ObservabilityHttpInterceptor(), multi: true },
    provideAppInitializer(() => {
      const injector = inject(Injector);
      // Não bloqueia o bootstrap: carrega em segundo plano; falha de rede = segue sem envio.
      void loader()
        .then((m) => browserState.attach(m.startSentry(config, injector)))
        .catch(() => undefined);
    }),
  ]);
}
