import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // NestJS bootstrap with rawBody: true per FR-013 / F7-CRYPTO-3
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // Enable graceful shutdown hooks per FR-022
  app.enableShutdownHooks();

  // Global exception filter enforcing canonical error response envelope
  app.useGlobalFilters(new ApiExceptionFilter());

  // Global validation pipe enforcing whitelist & forbidNonWhitelisted per FR-020
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // OpenAPI 3.0 / Swagger documentation at /api/docs per T034
  const swaggerConfig = new DocumentBuilder()
    .setTitle('OmniStock API')
    .setDescription(
      'OmniStock MVP - Multi-tenant SaaS Inventory & Order Management API. ' +
        'Includes multi-tenant onboarding, catalog, inventory ledger, split order allocation, ' +
        'authenticated channel webhook synchronization, and operational dashboard reporting.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter your JWT access token obtained from POST /auth/login',
      },
      'bearer-jwt',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Sync-Tenant-Slug',
        description: 'Active tenant slug for webhook routing',
      },
      'x-sync-tenant-slug',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Sync-External-Id',
        description: 'Unique external channel event ID for idempotency',
      },
      'x-sync-external-id',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Sync-Timestamp',
        description: 'UNIX epoch seconds within ±300s replay window',
      },
      'x-sync-timestamp',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Sync-Signature',
        description: 'HMAC-SHA256 signature in v1=<64-hex-chars> format',
      },
      'x-sync-signature',
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`OmniStock application listening on port ${port}`);
  logger.log(`Swagger documentation available at http://localhost:${port}/api/docs`);
}

bootstrap();
