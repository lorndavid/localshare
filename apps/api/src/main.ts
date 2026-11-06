import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadApiConfig } from './common/config';
import { GlobalApiExceptionFilter } from './common/error.filter';
import { requestIdMiddleware } from './common/request-id.middleware';
import { LocalShareTunnelRelay } from './relay/tunnel-relay';

export function configureNestApp(app: INestApplication): void {
  const cfg = loadApiConfig();
  app.setGlobalPrefix('api/v1');
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: cfg.corsOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalApiExceptionFilter());
  app.enableShutdownHooks();

  const swaggerCfg = new DocumentBuilder()
    .setTitle('LocalShare Cloud API')
    .setDescription(
      'Optional control-plane API for LocalShare organizations, workspaces, tunnel metadata, custom domains and access policies. Never proxies customer application traffic.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerCfg);
  SwaggerModule.setup('api/docs', app, document);
}

async function bootstrap(): Promise<void> {
  const cfg = loadApiConfig();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  configureNestApp(app);
  await app.init();
  const relay = new LocalShareTunnelRelay(process.env.TUNNEL_BASE_DOMAIN || 'lorndavid.online');
  relay.attach(app.getHttpServer());
  await app.listen(cfg.port, '0.0.0.0');
}

if (require.main === module) {
  void bootstrap();
}

