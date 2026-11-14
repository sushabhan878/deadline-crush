import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from '@dc/shared';
import { AllExceptions } from './common';
import { AuthController, MeController } from './auth.controller';
import { TimeController, MetadataController } from './time.metadata.controller';
import { StartController, VersionsController } from './uploads.controller';
import { EventsController } from './events.controller';
import { OrganizerController, StatusController } from './organizer.controller';

@Module({
  controllers: [AuthController, MeController, TimeController, MetadataController, StartController,
    VersionsController, EventsController, OrganizerController, StatusController],
})
class AppModule {}

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('Set JWT_SECRET to a random secret of at least 32 characters');
}
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
app.use(helmet({ contentSecurityPolicy: { directives: {
  'img-src': ["'self'", 'data:', new URL(config.s3.publicEndpoint).origin],
  'connect-src': ["'self'", new URL(config.s3.publicEndpoint).origin],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
} } }));
app.enableCors({ origin: config.webOrigin, exposedHeaders: ['ETag'] });
app.useGlobalFilters(new AllExceptions());
if (process.env.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY));
if (process.env.SERVE_WEB === '1') {
  app.setGlobalPrefix('api');
  app.use(express.static(fileURLToPath(new URL('../../web/dist/', import.meta.url))));
}
await app.listen(config.port);
console.log(JSON.stringify({ msg: 'api listening', port: config.port }));
