import '@angular/compiler';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  APP_INITIALIZER,
  ErrorHandler,
  createEnvironmentInjector,
  runInInjectionContext,
  type EnvironmentInjector,
  type Injector,
} from '@angular/core';
import { HTTP_INTERCEPTORS, HttpErrorResponse, HttpHeaders, HttpRequest, type HttpEvent } from '@angular/common/http';
import { throwError, type Observable } from 'rxjs';
import {
  ObservabilityErrorHandler,
  errorReference,
  isEnabled,
  propagationTargets,
  provideObservability,
  resetObservabilityForTests,
  setObservabilityUser,
  clearObservabilityUser,
  type ObservabilityConfig,
  type SentryFacade,
  type SentryLoader,
} from '../src/angular/index';
import { ObservabilityHttpInterceptor } from '../src/angular/provide';
import { Injector as NgInjector } from '@angular/core';

const base: ObservabilityConfig = {
  serviceName: 'teatime-web',
  release: '2.5.1',
  environment: 'local',
  apiOrigins: ['https://api-teatime.ciag.org.br'],
};

function rootInjector(providers: Parameters<typeof createEnvironmentInjector>[0]): EnvironmentInjector {
  const parent = NgInjector.create({ providers: [] }) as unknown as EnvironmentInjector;
  return createEnvironmentInjector(providers, parent);
}

function fakeSentry() {
  const calls = { errors: [] as unknown[], users: [] as Array<string | null>, crumbs: [] as Array<Record<string, string | number>> };
  const facade: SentryFacade = {
    captureException: (e) => calls.errors.push(e),
    setUserId: (id) => calls.users.push(id),
    breadcrumb: (_m, data) => calls.crumbs.push(data),
  };
  return { calls, facade };
}

describe('errorReference', () => {
  it('lê errorId do corpo de erro da API', () => {
    const err = new HttpErrorResponse({
      status: 500,
      error: { statusCode: 500, message: 'Internal server error', errorId: '3f2a9c1e-1111-4222-8333-444455556666' },
    });
    expect(errorReference(err)).toBe('3f2a9c1e-1111-4222-8333-444455556666');
  });
  it('cai para o cabeçalho X-Request-Id', () => {
    const err = new HttpErrorResponse({ status: 502, error: 'Bad gateway', headers: new HttpHeaders({ 'X-Request-Id': 'abc12345-req' }) });
    expect(errorReference(err)).toBe('abc12345-req');
  });
  it('null quando não há id (ou id inválido)', () => {
    expect(errorReference(new HttpErrorResponse({ status: 0 }))).toBeNull();
    expect(errorReference({ error: { errorId: '<script>' } })).toBeNull();
    expect(errorReference(undefined)).toBeNull();
    expect(errorReference('x')).toBeNull();
  });
});

describe('propagação de traceparent só para a própria API', () => {
  const [re] = propagationTargets(['https://api-teatime.ciag.org.br/']);
  it.each([
    ['https://api-teatime.ciag.org.br/projects/1', true],
    ['https://api-teatime.ciag.org.br', true],
    ['https://api-teatime.ciag.org.br?x=1', true],
    ['https://api-teatime.ciag.org.br.evil.com/x', false],
    ['https://graph.microsoft.com/v1.0/me', false],
    ['https://login.microsoftonline.com/x', false],
    ['http://api-teatime.ciag.org.br/x', false],
  ])('%s -> %s', (url, expected) => {
    expect(re!.test(url)).toBe(expected);
  });
  it('caminho relativo /api', () => {
    const [rel] = propagationTargets(['/api']);
    expect(rel!.test('/api/projects')).toBe(true);
    expect(rel!.test('/apix')).toBe(false);
  });
});

describe('provideObservability', () => {
  beforeEach(() => resetObservabilityForTests());

  it('sem DSN: nenhum provider (ErrorHandler e interceptors do app intactos)', () => {
    expect(isEnabled(base)).toBe(false);
    expect(isEnabled({ ...base, errorsDsn: '  ' })).toBe(false);
    let loaded = false;
    const injector = rootInjector([provideObservability(base, () => {
      loaded = true;
      return Promise.reject(new Error('não deveria carregar'));
    })]);
    expect(injector.get(ErrorHandler, null)).toBeNull();
    expect(injector.get(HTTP_INTERCEPTORS, null)).toBeNull();
    expect(injector.get(APP_INITIALIZER, null)).toBeNull();
    expect(loaded).toBe(false);
  });

  it('com DSN: ErrorHandler enfileira até o SDK carregar e depois envia; usuário pendente aplicado', async () => {
    const { calls, facade } = fakeSentry();
    let resolveLoad: (() => void) | undefined;
    const loader: SentryLoader = () =>
      new Promise((resolve) => {
        resolveLoad = () => resolve({ startSentry: (_c: ObservabilityConfig, _i: Injector) => facade });
      });
    const injector = rootInjector([provideObservability({ ...base, errorsDsn: 'https://k@glitchtip/1' }, loader)]);
    const handler = injector.get(ErrorHandler);
    expect(handler).toBeInstanceOf(ObservabilityErrorHandler);
    runInInjectionContext(injector, () => {
      for (const init of injector.get(APP_INITIALIZER)) void init();
    });
    const original = console.error;
    console.error = () => undefined;
    try {
      handler.handleError(new Error('antes do SDK'));
    } finally {
      console.error = original;
    }
    setObservabilityUser('user-42');
    expect(calls.errors).toHaveLength(0);
    resolveLoad!();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.errors).toHaveLength(1);
    expect(calls.users).toEqual(['user-42']);
    clearObservabilityUser();
    expect(calls.users).toEqual(['user-42', null]);
  });

  it('falha ao baixar o chunk do SDK não quebra o app', async () => {
    const injector = rootInjector([
      provideObservability({ ...base, errorsDsn: 'https://k@glitchtip/1' }, () => Promise.reject(new Error('offline'))),
    ]);
    runInInjectionContext(injector, () => {
      for (const init of injector.get(APP_INITIALIZER)) void init();
    });
    await new Promise((r) => setTimeout(r, 0));
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(() => injector.get(ErrorHandler).handleError(new Error('x'))).not.toThrow();
    } finally {
      console.error = original;
    }
  });

  it('interceptor: breadcrumb com status, errorId e URL redigida', async () => {
    const { calls, facade } = fakeSentry();
    const injector = rootInjector([
      provideObservability({ ...base, errorsDsn: 'https://k@glitchtip/1' }, () =>
        Promise.resolve({ startSentry: () => facade }),
      ),
    ]);
    runInInjectionContext(injector, () => {
      for (const init of injector.get(APP_INITIALIZER)) void init();
    });
    await new Promise((r) => setTimeout(r, 0));
    const [interceptor] = injector.get(HTTP_INTERCEPTORS);
    expect(interceptor).toBeInstanceOf(ObservabilityHttpInterceptor);
    const req = new HttpRequest('GET', 'https://api-teatime.ciag.org.br/auth/verify?token=abc');
    const err = new HttpErrorResponse({ status: 500, error: { errorId: 'abc12345-err' } });
    const next = { handle: (): Observable<HttpEvent<unknown>> => throwError(() => err) };
    await new Promise<void>((resolve) => interceptor!.intercept(req, next).subscribe({ error: () => resolve() }));
    expect(calls.crumbs).toEqual([
      { status: 500, method: 'GET', url: 'https://api-teatime.ciag.org.br/auth/verify?token=[REDACTED]', errorId: 'abc12345-err' },
    ]);
  });
});
