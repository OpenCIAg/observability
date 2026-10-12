# @openciag/observability

Observabilidade padrão CIAg para **NestJS** (`@openciag/observability/nest`) e **Angular**
(`@openciag/observability/angular`). O app fala só padrões abertos — **OpenTelemetry (OTLP)** para
traces/métricas/logs e **protocolo Sentry** para erros —, então trocar a plataforma
(Grafana ↔ SigNoz, GlitchTip ↔ Sentry) é configuração, nunca código do app.

- **Desligado sem configuração.** Sem `OTEL_EXPORTER_OTLP_ENDPOINT` nada é exportado (e o SDK do
  OpenTelemetry nem é carregado); sem `ERRORS_DSN` nenhum erro é enviado (o Sentry nem é carregado).
  Local = custo zero e zero aviso.
- **Nunca derruba o app.** Coletor/GlitchTip fora do ar, URL ou DSN inválidos: a API sobe e responde;
  só um aviso no log (no máximo 1 por minuto por motivo).
- **PII não sai do app (LGPD)** — ver [LGPD](#lgpd).

## Instalação em 10 minutos

### Back (NestJS 11)

```bash
npm i @openciag/observability \
  @opentelemetry/api @opentelemetry/api-logs @opentelemetry/core @opentelemetry/resources \
  @opentelemetry/semantic-conventions @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-metrics @opentelemetry/sdk-logs @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/instrumentation @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express \
  @opentelemetry/instrumentation-nestjs-core @opentelemetry/instrumentation-mysql2 \
  @prisma/instrumentation@<mesma versão do prisma> @sentry/nestjs pino
```

(As dependências de cada lado são `peerDependencies` opcionais: quem usa só o Nest não instala
Angular, e vice-versa. As versões testadas estão em `devDependencies` deste pacote.)

1. `src/instrumentation.ts` (arquivo próprio, carregado ANTES do Nest):

   ```ts
   import { initTelemetry } from '@openciag/observability/nest';
   // Padrões do código; OTEL_SERVICE_NAME / APP_RELEASE / DEPLOYMENT_ENVIRONMENT têm prioridade.
   initTelemetry({ serviceName: 'teatime-api', serviceVersion: pkg.version });
   ```

2. Primeira linha do `src/main.ts`: `import './instrumentation';` e o logger JSON no `create`:

   ```ts
   import './instrumentation';
   import { observabilityLogger } from '@openciag/observability/nest';
   const app = await NestFactory.create(AppModule, { logger: observabilityLogger() });
   ```

3. `AppModule`: `imports: [ObservabilityModule.forRoot(), ...]`.

4. CORS (front em outra origem): permita os cabeçalhos de trace e exponha o request id:

   ```ts
   allowedHeaders: [...os atuais, 'traceparent', 'tracestate', 'baggage', 'sentry-trace', 'X-Request-Id'],
   exposedHeaders: ['X-Request-Id'],
   ```

### Front (Angular 19–22, standalone)

```bash
npm i @openciag/observability @sentry/angular
```

```ts
// app.config.ts
provideObservability({
  serviceName: 'teatime-web',
  release: VERSION,
  environment: environment.DEPLOYMENT_ENVIRONMENT, // 'prod' | 'hml' | 'local'
  errorsDsn: environment.ERRORS_DSN,               // '' = desligado
  apiOrigins: [environment.API_URL],               // SÓ estes recebem traceparent
  tracesSampleRate: 0.2,
}),
```

- Mensagem de erro de API: `errorReference(err)` devolve o `errorId` (ou o `X-Request-Id`) para
  mostrar "Código do erro: …".
- Login: `setObservabilityUser(userId)`; logout: `clearObservabilityUser()`.

Sem DSN, `provideObservability` devolve uma lista vazia de providers (o app fica idêntico). Com DSN, o
SDK do Sentry vem num **chunk separado carregado depois do bootstrap** — não pesa no JS inicial. Erros
anteriores ao carregamento ficam numa fila (até 20) e são enviados quando o SDK chega.

## O que cada lado faz

### `@openciag/observability/nest`

| API | Faz |
| --- | --- |
| `initTelemetry(opts?)` | OTel: traces (http, express, nestjs-core, mysql2, Prisma), métrica `http.server.request.duration` por `http.route`/status, logs por OTLP/HTTP; erros por `@sentry/nestjs` (release = versão, environment). Shutdown com flush em SIGTERM/SIGINT (só quando algo está ligado). |
| `ObservabilityModule.forRoot({ userId?, ignorePaths? })` | Middleware de request id (aceita `X-Request-Id` válido, senão UUID; devolve no cabeçalho); UMA linha de log por requisição (`method`, `route` padrão `/projects/:id`, `status`, `duration_ms`, `userId`, `ip` respeitando `trust proxy`, `requestId`, `trace_id`); filtro global de exceções. |
| `observabilityLogger()` | `LoggerService` do Nest sobre pino: todos os `Logger` existentes (`[SharepointService]`, `ExceptionsHandler`…) saem em JSON com `requestId`/`trace_id`/`span_id`. |
| Filtro de exceções | Delega ao `BaseExceptionFilter` do próprio Nest (mesmo corpo, mesmo status, mesmo log) e só **acrescenta** `errorId` (= request id) ao JSON. 5xx e erros inesperados vão ao GlitchTip com as tags `errorId`, `route`, `method`, `status`, `trace_id`. 4xx não são erro; 401/403/429 viram contador `ciag.http.server.rejected` + breadcrumb. |

Exemplo de linha:

```json
{"level":"info","time":"2026-10-12T18:28:12.327Z","context":"HTTP","requestId":"9c02…","method":"GET","route":"/projects/:id","status":200,"duration_ms":12.4,"ip":"10.0.0.7","userId":"6f1c…","trace_id":"a228…","span_id":"c3c0…","msg":"GET /projects/:id 200 12.4ms"}
```

### `@openciag/observability/angular`

| API | Faz |
| --- | --- |
| `provideObservability(cfg)` | `@sentry/angular`: ErrorHandler (mantém o `console.error` padrão), tracing do roteador (nomes de rota parametrizados) e das chamadas HTTP com `traceparent` **só** para `apiOrigins` (`tracePropagationTargets` com regex exata + `propagateTraceparent: true`), sem replay, sem sessões, `dataCollection` restritivo, `beforeSend` com redação. |
| `errorReference(err)` | `errorId` do corpo de erro ou `X-Request-Id`; `null` se não houver. |
| `setObservabilityUser(id)` / `clearObservabilityUser()` | Usuário só por id. |
| `observabilityInterceptor` / `ObservabilityHttpInterceptor` | Breadcrumb `HTTP <status>` com `errorId` e URL redigida (já incluído por `provideObservability`). |

## Variáveis

| Variável | Lado | Padrão | Uso |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | back | vazio = desligado | URL base OTLP/HTTP do coletor (Grafana Alloy), ex. `http://alloy:4318`. |
| `OTEL_SERVICE_NAME` | back | opção `serviceName` | `service.name` (ex. `teatime-api`). Variáveis têm prioridade sobre as opções do código. |
| `APP_RELEASE` | back | opção `serviceVersion`, senão `npm_package_version` | `service.version` e release do GlitchTip. |
| `DEPLOYMENT_ENVIRONMENT` | back | opção `environment`, senão `local` | `prod` \| `hml` \| `local` (aceita `production`, `staging`). |
| `ERRORS_DSN` | back/front | vazio = desligado | DSN do projeto no GlitchTip. No front entra no build (build-arg). |
| `OTEL_TRACES_SAMPLER_ARG` | back | `1` | Fração de traces iniciados no back (os que vêm do front seguem a decisão do front). |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | back | `otlp` | `none` desliga um sinal (ex.: logs já coletados do stdout pelo Alloy). |
| `OTEL_METRIC_EXPORT_INTERVAL` | back | `60000` | ms entre envios de métricas. |
| `OTEL_SDK_DISABLED` | back | — | `true` desliga toda a telemetria mesmo com endpoint. |
| `ERRORS_SAMPLE_RATE` | back | `1` | Fração de erros enviados. |
| `LOG_LEVEL` | back | `info` | `fatal`…`trace`. |

Os exportadores também respeitam as variáveis padrão `OTEL_EXPORTER_OTLP_HEADERS` (ex.: token do coletor).

## Convenções CIAg

- Recurso: `service.name`, `service.version`, `deployment.environment` (`prod`|`hml`|`local`),
  `service.namespace = ciag` — iguais em todos os projetos, para dashboards/alertas comuns.
- Correlação: cabeçalho `X-Request-Id` em toda resposta; `errorId` (= request id) no corpo de erro;
  `trace_id`/`span_id` em cada linha de log; W3C `traceparent` do front para a API.
- Rotas sempre no padrão do framework (`/projects/:id`), nunca a URL com ids.
- `/health` não gera trace nem linha de log (opção `ignorePaths`).

## LGPD

Nunca saem do app (logs, atributos de span, eventos de erro e breadcrumbs):

- valores das chaves `authorization`, `cookie`, `set-cookie`, `senha`, `password`, `newPassword`,
  `confirmedNewPassword`, `currentPassword`, `token`, `accessToken`, `refreshToken`,
  `verificationToken`, `secret`, `clientSecret`, `apiKey` (qualquer profundidade, sem diferenciar
  caixa, `-` ou `_`);
- `Bearer …`/`Basic …` e JWTs soltos em texto; parâmetros de query sensíveis (`?token=`);
- e-mails em texto são mascarados: `ana.souza@ciag.org.br` → `a***@ciag.org.br`;
- usuário identificado **só por id**; corpo de requisição **não** é logado nem enviado; cookies e
  cabeçalhos HTTP não são coletados pelo Sentry (`dataCollection`).

Retenção e acesso ficam na plataforma (GlitchTip/Loki/Tempo: 15–30 dias, acesso restrito).

## Distribuição

Até a publicação no npm, os apps consomem o tarball versionado no próprio repositório:

```bash
npm run build && npm pack            # gera ciag-observability-0.1.0.tgz
cp ciag-observability-0.1.0.tgz <app>/vendor/
# package.json do app: "@openciag/observability": "file:vendor/ciag-observability-0.1.0.tgz"
```

Funciona no Docker/CI sem credencial de registry. Depois de publicado (`npm publish --access public`):
`npm i @openciag/observability@0.1.0 --save-exact`, apague `vendor/ciag-observability-*.tgz` e confira que o
lockfile resolve para `registry.npmjs.org`.

## Desenvolvimento

```bash
npm run check   # typecheck + testes (vitest) + build (tsup) + teste de contrato
```

- `test/*.test.ts`: redação com corpos reais (login, troca de senha), módulo Nest real (supertest),
  lado Angular sem navegador (injector do Angular em Node).
- `scripts/contract-test.cjs`: app Nest real (CommonJS, a partir de `dist/`) contra receptores em memória
  de OTLP/HTTP e do protocolo Sentry. Prova recurso, `traceparent` de entrada, `http.route`, métrica,
  log OTLP com o mesmo `trace_id`, evento de erro com `errorId`, ausência de PII, endpoint fora do ar,
  URL/DSN inválidos e modo desligado.

Decisões:

- **Sem NodeSDK (`@opentelemetry/sdk-node`)**: os mesmos componentes (TracerProvider, MeterProvider,
  LoggerProvider, exportadores OTLP/HTTP) montados à mão, carregados só quando há endpoint — o sdk-node
  puxaria gRPC, Zipkin, Prometheus e Jaeger para dentro de todo app.
- **ESM + CJS no lado Node**: apps Nest compilam para CommonJS; `require` do pacote precisa funcionar
  sem `require(esm)`.
- **Angular sem decorators** (`makeEnvironmentProviders`, `inject()`, providers por factory): build com
  tsup, sem ng-packagr.
- **`traceLifecycle: 'static'` no front**: o `@sentry/*` 11 envia spans em streaming por padrão, formato que o
  GlitchTip 6.2.6 aceita (HTTP 200) mas descarta; com `static` as navegações chegam como transações
  (conferido no E2E: `/projects/project-list/ ; navigation`).
- **CSP só com `report-uri`** (sem `report-to`): o endpoint de segurança do GlitchTip 6.2.6 aceita o formato
  `application/csp-report` (201) e recusa o da Reporting API `application/reports+json` (422); com `report-to`
  o Chrome passaria a usar só o formato recusado. O DSN serve de base: `<origem>/api/<projeto>/security/?sentry_key=<chave>`
  (aceito pelo GlitchTip e pelo Sentry).
- **Sentry só para erros no back**: `enableOpenTelemetrySetup: false`, sem integrações automáticas de
  http/express (traces são do OTel; não há instrumentação dupla).
