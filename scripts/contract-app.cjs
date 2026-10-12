// App Nest mínimo para o teste de contrato (CommonJS, como o TeaTime compila).
// initTelemetry ANTES de carregar o Nest/Express — igual ao src/instrumentation.ts dos apps.
'use strict';
const { initTelemetry } = require('../dist/nest/index.cjs');
initTelemetry({ serviceName: 'contract-api', serviceVersion: '9.9.9', environment: 'hml' });

require('reflect-metadata');
const { Controller, Get, Module, Req, NotFoundException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ObservabilityModule, observabilityLogger } = require('../dist/nest/index.cjs');

class ItemsController {
  get(req) {
    req.user = { sub: 'user-77', email: 'ana@ciag.org.br' };
    if (req.params.id === 'missing') throw new NotFoundException('Item não encontrado');
    if (req.params.id === 'boom') throw new Error('falha inesperada para ana@ciag.org.br');
    return { id: req.params.id };
  }
}
Req()(ItemsController.prototype, 'get', 0);
Get(':id')(ItemsController.prototype, 'get', Object.getOwnPropertyDescriptor(ItemsController.prototype, 'get'));
Controller('items')(ItemsController);

class AppModule {}
Module({ imports: [ObservabilityModule.forRoot()], controllers: [ItemsController] })(AppModule);

(async () => {
  const app = await NestFactory.create(AppModule, { logger: observabilityLogger() });
  await app.listen(Number(process.env.PORT), '127.0.0.1');
  process.stderr.write('READY\n');
})();
