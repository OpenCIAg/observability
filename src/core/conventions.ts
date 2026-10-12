/** Convenções CIAg compartilhadas (mesmos nomes em todos os projetos). */

export type DeploymentEnvironment = 'prod' | 'hml' | 'local';

export const SERVICE_NAMESPACE = 'ciag';

/** Cabeçalho de correlação devolvido em toda resposta e aceito na entrada. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Campo ADITIVO no corpo JSON de erro da API (= request id). */
export const ERROR_ID_FIELD = 'errorId';

/** Request id aceito da entrada: 8–128 caracteres seguros (letras, dígitos, `-`, `_`, `.`, `:`). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * Normaliza o ambiente: aceita os nomes CIAg e sinônimos comuns.
 * `production`→`prod`, `homolog`/`staging`→`hml`, qualquer outro/vazio→`local`.
 */
export function normalizeEnvironment(value: string | undefined | null): DeploymentEnvironment {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'prod' || v === 'production' || v === 'producao' || v === 'produção') return 'prod';
  if (v === 'hml' || v === 'homolog' || v === 'homologacao' || v === 'homologação' || v === 'staging') {
    return 'hml';
  }
  return 'local';
}

/** Taxa de amostragem 0..1 (texto inválido = padrão). */
export function parseSampleRate(value: string | undefined | null, fallback: number): number {
  if (value === undefined || value === null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
