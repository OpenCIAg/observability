import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResolvedConfig } from './config';

/** Dados da requisição corrente (propagados por AsyncLocalStorage). */
export interface RequestContext {
  requestId: string;
}

/** Registro de log entregue ao exportador OTLP (já redigido). */
export interface LogRecordInput {
  level: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
  traceId?: string;
  spanId?: string;
  timeMs: number;
}

export interface CaptureInfo {
  tags: Record<string, string>;
  /** Usuário só por id (LGPD). */
  userId?: string;
  trace?: { traceId: string; spanId: string };
}

/** Captura mínima de erro (implementada pelo Sentry quando há DSN). */
export interface ErrorSink {
  captureServerError(error: unknown, info: CaptureInfo): void;
  breadcrumb(message: string, data: Record<string, string | number>): void;
}

interface State {
  config?: ResolvedConfig;
  emitLog?: (record: LogRecordInput) => void;
  errors?: ErrorSink;
  shutdowns: Array<() => Promise<void>>;
  als: AsyncLocalStorage<RequestContext>;
  initialized: boolean;
}

const KEY = Symbol.for('@openciag/observability/nest/state');

type GlobalWithState = typeof globalThis & { [KEY]?: State };

/** Estado único por processo (sobrevive a cópias ESM/CJS do pacote). */
export function state(): State {
  const g = globalThis as GlobalWithState;
  let s = g[KEY];
  if (s === undefined) {
    s = { shutdowns: [], als: new AsyncLocalStorage<RequestContext>(), initialized: false };
    g[KEY] = s;
  }
  return s;
}

/** Só para testes: zera o estado global. */
export function resetStateForTests(): void {
  const g = globalThis as GlobalWithState;
  delete g[KEY];
}

export function currentRequestId(): string | undefined {
  return state().als.getStore()?.requestId;
}
