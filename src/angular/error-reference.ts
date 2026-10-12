import { ERROR_ID_FIELD, isValidRequestId } from '../core/conventions';

function get(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null ? Reflect.get(obj, key) : undefined;
}

/**
 * Código do erro para mostrar ao usuário ("Código do erro: abc123"): `errorId` do corpo JSON
 * de erro da API ou, na falta dele, o cabeçalho `X-Request-Id` da resposta. `null` se não houver.
 * Aceita qualquer valor (ex.: `HttpErrorResponse`).
 */
export function errorReference(error: unknown): string | null {
  const fromBody = get(get(error, 'error'), ERROR_ID_FIELD);
  if (isValidRequestId(fromBody)) return fromBody;
  const headers = get(error, 'headers');
  const getter = get(headers, 'get');
  if (typeof getter === 'function') {
    const value: unknown = Reflect.apply(getter, headers, ['X-Request-Id']);
    if (isValidRequestId(value)) return value;
  }
  return null;
}

/** Forma curta (8 primeiros caracteres) para exibir; o id completo segue no log/GlitchTip. */
export function shortErrorReference(error: unknown): string | null {
  const ref = errorReference(error);
  return ref === null ? null : ref.slice(0, 8);
}
