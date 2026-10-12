import { createRequire } from 'node:module';
import { redactErrorEvent, type ErrorEventLike } from '../core/error-event';
import { redactValue } from '../core/redact';
import type { ResolvedConfig } from './config';
import type { ErrorSink } from './state';

type SentryNest = typeof import('@sentry/nestjs');
type SentryEvent = Parameters<NonNullable<Parameters<SentryNest['init']>[0]>['beforeSend'] & object>[0];

const requireFromHere = createRequire(import.meta.url);

/** Valida o formato do DSN sem rede: `https://<chave>@<host>/<projeto>`. */
export function isValidDsn(dsn: string): boolean {
  try {
    const u = new URL(dsn);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username !== '' && /\/\d+$|\/[\w-]+$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Liga o envio de erros (protocolo Sentry → GlitchTip) quando há DSN. Só erros: sem tracing do Sentry
 * (os traces vão por OpenTelemetry), sem setup de OTel pelo Sentry, sem PII padrão, com redação no beforeSend.
 * Retorna `undefined` sem DSN ou com DSN inválido (aviso) — nunca lança.
 */
export function initErrors(
  config: ResolvedConfig,
  warn: (msg: string) => void,
  load: () => SentryNest = () => requireFromHere('@sentry/nestjs') as SentryNest,
): { sink: ErrorSink; close: () => Promise<void> } | undefined {
  const dsn = config.errorsDsn;
  if (dsn === undefined) return undefined;
  if (!isValidDsn(dsn)) {
    warn('ERRORS_DSN inválido: envio de erros desligado');
    return undefined;
  }
  let Sentry: SentryNest;
  try {
    Sentry = load();
  } catch {
    warn('@sentry/nestjs não instalado: envio de erros desligado');
    return undefined;
  }
  try {
    Sentry.init({
      dsn,
      release: config.serviceVersion,
      environment: config.environment,
      sampleRate: config.errorsSampleRate,
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
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      defaultIntegrations: false,
      integrations: [
        Sentry.eventFiltersIntegration(),
        Sentry.functionToStringIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.dedupeIntegration(),
        Sentry.nodeContextIntegration(),
        Sentry.contextLinesIntegration(),
        // Mesmo comportamento do Node sem listeners: exceção não tratada encerra o processo.
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
      ],
      initialScope: { tags: { 'service.name': config.serviceName } },
      beforeSend: (event: SentryEvent) => redactErrorEvent(event as SentryEvent & ErrorEventLike),
      beforeBreadcrumb: (breadcrumb) => redactValue(breadcrumb),
    });
  } catch {
    warn('falha ao iniciar o envio de erros: desligado');
    return undefined;
  }
  const sink: ErrorSink = {
    captureServerError(error, { tags, userId, trace }) {
      Sentry.withScope((scope) => {
        scope.setTags(tags);
        if (userId !== undefined) scope.setUser({ id: userId });
        if (trace !== undefined) {
          scope.setTag('trace_id', trace.traceId);
          scope.setContext('otel', { trace_id: trace.traceId, span_id: trace.spanId });
        }
        Sentry.captureException(error);
      });
    },
    breadcrumb(message, data) {
      Sentry.addBreadcrumb({ category: 'http', level: 'warning', message, data });
    },
  };
  return {
    sink,
    close: async () => {
      await Sentry.close(2000);
    },
  };
}
