import { normalizeEnvironment, parseSampleRate, type DeploymentEnvironment } from '../core/conventions';

/** Opções de `initTelemetry`. Tudo opcional: o que faltar vem das variáveis de ambiente. */
export interface TelemetryOptions {
  /** `service.name` padrão (a variável `OTEL_SERVICE_NAME` tem prioridade). Ex.: `teatime-api`. */
  serviceName?: string;
  /** `service.version` / release dos erros (`APP_RELEASE` tem prioridade; por último `npm_package_version`). */
  serviceVersion?: string;
  /** `deployment.environment`: prod | hml | local (`DEPLOYMENT_ENVIRONMENT` tem prioridade). */
  environment?: string;
  /** Caminhos de entrada que não geram trace nem linha de log (padrão: `/health`). */
  ignorePaths?: readonly string[];
  /** Variáveis de ambiente (testes). Padrão: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedConfig {
  serviceName: string;
  serviceVersion: string;
  environment: DeploymentEnvironment;
  /** URL base OTLP/HTTP (sem `/v1/...`). Vazio = nada é exportado. */
  otlpEndpoint: string | undefined;
  tracesEnabled: boolean;
  metricsEnabled: boolean;
  logsEnabled: boolean;
  tracesSampleRate: number;
  metricExportIntervalMs: number;
  /** DSN do GlitchTip/Sentry. Vazio = nenhum erro é enviado. */
  errorsDsn: string | undefined;
  errorsSampleRate: number;
  logLevel: string;
  ignorePaths: readonly string[];
}

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function exporterOn(value: string | undefined): boolean {
  const v = clean(value)?.toLowerCase();
  return v === undefined || v.split(',').map((s) => s.trim()).includes('otlp');
}

/** Lê opções + ambiente. Pura (testável). */
export function resolveConfig(options: TelemetryOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const sdkDisabled = clean(env.OTEL_SDK_DISABLED)?.toLowerCase() === 'true';
  const otlpEndpoint = sdkDisabled ? undefined : clean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const logLevel = clean(env.LOG_LEVEL)?.toLowerCase();
  const interval = Number(clean(env.OTEL_METRIC_EXPORT_INTERVAL));
  return {
    // Variável de ambiente > opção do código (configuração vence código, como no padrão OTel).
    serviceName: clean(env.OTEL_SERVICE_NAME) ?? clean(options.serviceName) ?? 'unknown_service',
    serviceVersion:
      clean(env.APP_RELEASE) ?? clean(options.serviceVersion) ?? clean(env.npm_package_version) ?? '0.0.0',
    environment: normalizeEnvironment(clean(env.DEPLOYMENT_ENVIRONMENT) ?? clean(options.environment)),
    otlpEndpoint,
    tracesEnabled: otlpEndpoint !== undefined && exporterOn(env.OTEL_TRACES_EXPORTER),
    metricsEnabled: otlpEndpoint !== undefined && exporterOn(env.OTEL_METRICS_EXPORTER),
    logsEnabled: otlpEndpoint !== undefined && exporterOn(env.OTEL_LOGS_EXPORTER),
    tracesSampleRate: parseSampleRate(env.OTEL_TRACES_SAMPLER_ARG, 1),
    metricExportIntervalMs: Number.isFinite(interval) && interval >= 1000 ? interval : 60_000,
    errorsDsn: clean(env.ERRORS_DSN),
    errorsSampleRate: parseSampleRate(env.ERRORS_SAMPLE_RATE, 1),
    logLevel: logLevel !== undefined && LOG_LEVELS.has(logLevel) ? logLevel : 'info',
    ignorePaths: options.ignorePaths ?? ['/health'],
  };
}

/** `true` se o caminho (sem query) é um dos ignorados ou está abaixo dele (`/health/ready`). */
export function isIgnoredPath(path: string, ignorePaths: readonly string[]): boolean {
  const p = path.split('?')[0] ?? path;
  return ignorePaths.some((ignored) => p === ignored || p.startsWith(`${ignored}/`));
}
