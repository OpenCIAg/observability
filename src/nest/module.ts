import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { createRequire } from 'node:module';
import { resolveConfig } from './config';
import { ObservabilityExceptionFilter } from './exception-filter';
import { NestJsonLogger, getRootLogger } from './logger';
import { createRequestMiddleware, defaultUserId, type UserIdExtractor } from './request-context';
import { state } from './state';

type NestCore = typeof import('@nestjs/core');

const requireFromHere = createRequire(import.meta.url);

export interface ObservabilityModuleOptions {
  /** Caminhos sem linha de log de requisição (padrão: o de `initTelemetry`, ou `/health`). */
  ignorePaths?: readonly string[];
  /** Como obter o id do usuário autenticado (padrão: `req.user.id|sub|userId`). Nunca e-mail/nome. */
  userId?: UserIdExtractor;
}

/** Token de injeção do `NestJsonLogger`. */
export const OBSERVABILITY_LOGGER = Symbol.for('@openciag/observability/nest/logger');

/** Logger JSON do Nest (o mesmo em todo o processo). Use em `NestFactory.create(App, { logger: observabilityLogger() })`. */
export function observabilityLogger(): NestJsonLogger {
  return new NestJsonLogger(getRootLogger());
}

/**
 * Módulo Nest: middleware de request id + linha de log por requisição, filtro global de exceções
 * (errorId aditivo + envio de 5xx ao GlitchTip) e o logger JSON injetável.
 *
 * Sem decorators: é uma classe simples usada como módulo dinâmico (`forRoot`).
 */
export class ObservabilityModule implements NestModule {
  private static userId: UserIdExtractor = defaultUserId;
  private static ignorePaths: readonly string[] | undefined;

  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    ObservabilityModule.userId = options.userId ?? defaultUserId;
    ObservabilityModule.ignorePaths = options.ignorePaths;
    // Carregado aqui (depois de initTelemetry) para o @nestjs/core já sair instrumentado.
    const core = requireFromHere('@nestjs/core') as NestCore;
    const userId = ObservabilityModule.userId;
    return {
      module: ObservabilityModule,
      global: true,
      providers: [
        { provide: OBSERVABILITY_LOGGER, useFactory: observabilityLogger },
        {
          provide: core.APP_FILTER,
          useFactory: (host: HttpAdapterHost) => new ObservabilityExceptionFilter(host, userId, core),
          inject: [core.HttpAdapterHost],
        },
      ],
      exports: [OBSERVABILITY_LOGGER],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    const ignorePaths = ObservabilityModule.ignorePaths ?? state().config?.ignorePaths ?? resolveConfig().ignorePaths;
    consumer
      .apply(createRequestMiddleware({ logger: getRootLogger, ignorePaths, userId: ObservabilityModule.userId }))
      .forRoutes('{*path}');
  }
}
