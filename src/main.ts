import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`OmniStock application listening on port ${port}`);
}

bootstrap();
