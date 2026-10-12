import { describe, expect, it, vi } from 'vitest';

const calls: { init: Array<Record<string, unknown>>; injected: unknown[] } = { init: [], injected: [] };

vi.mock('@sentry/angular', () => ({
  init: (opts: Record<string, unknown>) => calls.init.push(opts),
  browserTracingIntegration: () => ({ name: 'BrowserTracing' }),
  TraceService: class TraceService {},
  captureException: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import { startSentry } from '../src/angular/sentry-loader';

describe('startSentry (opções do @sentry/angular)', () => {
  it('configuração CIAg: GlitchTip-compatível, sem PII, traceparent só para a API', () => {
    const injector = { get: (token: unknown) => calls.injected.push(token) };
    startSentry(
      {
        serviceName: 'teatime-web',
        release: '2.5.1',
        environment: 'hml',
        errorsDsn: 'https://k@glitchtip/2',
        apiOrigins: ['https://api-teatime.ciag.org.br'],
        tracesSampleRate: 0.5,
      },
      injector as never,
    );
    const o = calls.init[0]!;
    expect(o).toMatchObject({
      dsn: 'https://k@glitchtip/2',
      release: '2.5.1',
      environment: 'hml',
      tracesSampleRate: 0.5,
      propagateTraceparent: true,
      // GlitchTip 6 não ingere span streaming (padrão do SDK 11)
      traceLifecycle: 'static',
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] },
    });
    const targets = o.tracePropagationTargets as RegExp[];
    expect(targets.some((t) => t.test('https://api-teatime.ciag.org.br/api/x'))).toBe(true);
    expect(targets.some((t) => t.test('https://graph.microsoft.com/v1.0/me'))).toBe(false);
    const integrations = (o.integrations as (d: Array<{ name: string }>) => Array<{ name: string }>)([
      { name: 'BrowserSession' },
      { name: 'GlobalHandlers' },
      { name: 'Replay' },
    ]);
    expect(integrations.map((i) => i.name)).toEqual(['GlobalHandlers', 'BrowserTracing']);
    const beforeSend = o.beforeSend as (e: Record<string, unknown>) => Record<string, unknown>;
    expect(beforeSend({ user: { id: 'u1', email: 'a@b.com' }, message: 'x de ana@ciag.org.br' })).toEqual({
      user: { id: 'u1' },
      message: 'x de a***@ciag.org.br',
    });
    expect(calls.injected).toHaveLength(1);
  });
});
