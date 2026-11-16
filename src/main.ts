/**
 * @file main.ts
 * @author Pablo Reis Rebonato
 * @description Process entry point that loads configuration and starts the HTTP server.
 */

import 'reflect-metadata';
import type { Logger } from 'pino';
import { createApp } from './bootstrap';
import { loadConfig } from './infrastructure/config/app-config';
import { TOKENS } from './infrastructure/tokens';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.PORT, '0.0.0.0');
app.get<symbol, Logger>(TOKENS.RootLogger).info({ port: config.PORT }, 'listening');
