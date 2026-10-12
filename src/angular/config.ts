import type { DeploymentEnvironment } from '../core/conventions';

export interface ObservabilityConfig {
  /** `service.name` do front (ex.: `teatime-web`). */
  serviceName: string;
  /** Versão publicada (release no GlitchTip; casar com os source maps). */
  release: string;
  /** prod | hml | local. */
  environment: DeploymentEnvironment;
  /** DSN do GlitchTip/Sentry. Vazio/ausente = nada é carregado nem enviado (custo zero). */
  errorsDsn?: string | null;
  /**
   * Origens da PRÓPRIA API que recebem `traceparent` (ex.: `https://api-teatime.ciag.org.br`).
   * Caminhos começando com `/` valem para a mesma origem (ex.: `/api`). Nenhum outro host recebe.
   */
  apiOrigins: readonly string[];
  /** Fração de navegações com trace (0..1, padrão 0.1). */
  tracesSampleRate?: number;
  /** Fração de erros enviados (0..1, padrão 1). */
  errorsSampleRate?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Alvos de propagação EXATOS: `https://api.x` casa `https://api.x` e `https://api.x/...`,
 * nunca `https://api.x.evil.com`. `/api` casa só caminhos da mesma origem.
 */
export function propagationTargets(apiOrigins: readonly string[]): RegExp[] {
  return apiOrigins
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o !== '')
    .map((o) => new RegExp(`^${escapeRegExp(o)}(?:[/?#]|$)`, 'i'));
}

export function isEnabled(config: ObservabilityConfig): boolean {
  return typeof config.errorsDsn === 'string' && config.errorsDsn.trim() !== '';
}
