/**
 * @file bootstrap.ts
 * @author Pablo Reis Rebonato
 * @description Builds the NestJS application with pino logging, hardened Express settings and optional shutdown hooks.
 */

import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './infrastructure/config/app-config';

export async function createApp(config: AppConfig, opts: { shutdownHooks?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  app.set('etag', false);
  if (opts.shutdownHooks ?? true) app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
