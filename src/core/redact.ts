/**
 * Redação de PII (LGPD) compartilhada por Node e navegador. Sem dependências.
 *
 * Regras CIAg:
 * - Chaves sensíveis (cabeçalhos de autenticação, senhas, tokens, segredos) têm o VALOR trocado por
 *   `[REDACTED]` em qualquer profundidade de objeto/array.
 * - E-mails em texto livre são mascarados: `ana.souza@ciag.org.br` -> `a***@ciag.org.br`.
 * - Parâmetros de query sensíveis em URLs (`?token=...`) também são trocados.
 */

export const REDACTED = '[REDACTED]';

/** Chaves cujo valor nunca sai do app (comparação sem caixa e sem `-`/`_`). */
export const SENSITIVE_KEYS: readonly string[] = [
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'cookies',
  'senha',
  'password',
  'newpassword',
  'confirmednewpassword',
  'currentpassword',
  'oldpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'verificationtoken',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
];

const SENSITIVE = new Set(SENSITIVE_KEYS);

/** Normaliza o nome da chave: `Set-Cookie`, `set_cookie` e `setCookie` viram `setcookie`. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(normalizeKey(key));
}

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Mascara todos os e-mails de um texto: `ana@ciag.org.br` -> `a***@ciag.org.br`. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, '$1***@$2');
}

/** Bearer/Basic soltos em texto (ex.: mensagem de erro que repete o cabeçalho). */
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** JWT solto em texto (três segmentos base64url começando por `eyJ`). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

/** Redação de texto livre: e-mails mascarados, credenciais Bearer/Basic e JWTs removidos. */
export function redactString(text: string): string {
  return maskEmails(text.replace(AUTH_SCHEME_RE, `$1 ${REDACTED}`).replace(JWT_RE, REDACTED));
}

/** Troca o valor de parâmetros de query sensíveis (`token`, `password`…) e mascara e-mails da URL. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return redactString(url);
  const hashAt = url.indexOf('#', q);
  const base = url.slice(0, q);
  const query = url.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      // chave malformada: compara como veio
    }
    return isSensitiveKey(decoded) ? `${key}=${REDACTED}` : pair;
  });
  return redactString(`${base}?${parts.join('&')}${hash}`);
}

export type Redactable =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Redactable[]
  | { [key: string]: Redactable };

const MAX_DEPTH = 12;

/**
 * Copia profunda com redação: chaves sensíveis viram `[REDACTED]`, strings passam por
 * {@link redactString}. Não altera o objeto original. Ciclos e profundidade excessiva viram `[Circular]`/`[Truncated]`.
 */
export function redactValue<T>(value: T): T {
  return redactInner(value, 0, new WeakSet<object>()) as T;
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (value instanceof Date) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item: unknown) => redactInner(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (value instanceof Error) {
    const err = new Error(redactString(value.message));
    Object.defineProperty(err, 'name', { value: value.name, enumerable: false, writable: true, configurable: true });
    if (value.stack !== undefined) err.stack = redactString(value.stack);
    // Campos próprios (code, statusCode…) seguem com redação.
    for (const [key, inner] of Object.entries(value)) {
      Reflect.set(err, key, isSensitiveKey(key) ? REDACTED : redactInner(inner, depth + 1, seen));
    }
    seen.delete(value);
    return err;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactInner(inner, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

/** Cabeçalhos HTTP (objeto simples) com valores sensíveis trocados. */
export function redactHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveKey(key) ? REDACTED : value;
  }
  return out;
}
