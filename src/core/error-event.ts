import { redactUrl, redactValue } from './redact';

/** Formato mínimo de um evento do protocolo Sentry que a redação precisa conhecer. */
export interface ErrorEventLike {
  user?: { id?: string | number; [key: string]: unknown } | undefined;
  request?:
    | {
        url?: string;
        query_string?: unknown;
        data?: unknown;
        cookies?: unknown;
        headers?: Record<string, string> | undefined;
        [key: string]: unknown;
      }
    | undefined;
  [key: string]: unknown;
}

/**
 * `beforeSend` comum de Node e navegador:
 * - usuário só por `id` (sem e-mail, nome, IP);
 * - corpo da requisição e cookies descartados; URL/query/cabeçalhos com redação;
 * - todo o resto (mensagem, exceções, breadcrumbs, extra, contexts, tags) passa por `redactValue`.
 */
export function redactErrorEvent<E extends ErrorEventLike>(event: E): E {
  const out = redactValue(event);
  if (event.user !== undefined) {
    const id = event.user.id;
    out.user = id === undefined || id === null ? undefined : { id: String(id) };
  }
  if (event.request !== undefined && out.request !== undefined) {
    const request = out.request;
    delete request.data;
    delete request.cookies;
    if (typeof event.request.url === 'string') request.url = redactUrl(event.request.url);
    if (typeof event.request.query_string === 'string') {
      request.query_string = redactUrl(`?${event.request.query_string}`).slice(1);
    }
  }
  return out;
}
