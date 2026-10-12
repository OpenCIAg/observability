import type { Injector } from '@angular/core';
import { TraceService, browserTracingIntegration, init, type BrowserOptions } from '@sentry/angular';
import * as Sentry from '@sentry/angular';
import { redactErrorEvent, type ErrorEventLike } from '../core/error-event';
import { redactValue } from '../core/redact';
import type { ObservabilityConfig } from './config';
import { propagationTargets } from './config';

/** O que o resto do pacote usa do Sentry (carregado sob demanda). */
export interface SentryFacade {
  captureException(error: unknown): void;
  setUserId(id: string | null): void;
  breadcrumb(message: string, data: Record<string, string | number>): void;
}

type BeforeSend = NonNullable<BrowserOptions['beforeSend']>;
type ErrorEvent = Parameters<BeforeSend>[0];

/** Inicia o @sentry/angular (chunk separado, carregado só quando há DSN). */
export function startSentry(config: ObservabilityConfig, injector: Injector): SentryFacade {
  init({
    dsn: config.errorsDsn ?? undefined,
    release: config.release,
    environment: config.environment,
    // v11 trocou `sendDefaultPii` por `dataCollection`: tudo que pode carregar PII desligado.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: true,
      databaseQueryData: false,
      stackFrameVariables: false,
      queues: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    sampleRate: config.errorsSampleRate ?? 1,
    tracesSampleRate: config.tracesSampleRate ?? 0.1,
    tracePropagationTargets: propagationTargets(config.apiOrigins),
    propagateTraceparent: true,
    // Sem replay; sem sessões de release health (o GlitchTip não usa).
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== 'BrowserSession'),
      browserTracingIntegration(),
    ],
    initialScope: { tags: { 'service.name': config.serviceName } },
    beforeSend: (event: ErrorEvent) => redactErrorEvent(event as ErrorEvent & ErrorEventLike),
    beforeSendTransaction: (event) => redactValue(event),
    beforeBreadcrumb: (breadcrumb) => redactValue(breadcrumb),
  });
  // Nomes de transação pela rota parametrizada (/projects/:id), como no @sentry/angular.
  injector.get(TraceService);
  return {
    captureException: (error) => {
      Sentry.captureException(error, { mechanism: { type: 'angular', handled: false } });
    },
    setUserId: (id) => {
      Sentry.setUser(id === null ? null : { id });
    },
    breadcrumb: (message, data) => {
      Sentry.addBreadcrumb({ category: 'http', level: 'warning', message, data });
    },
  };
}
