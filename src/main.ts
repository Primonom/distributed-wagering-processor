import 'reflect-metadata';
import { createApp } from './bootstrap';
import { loadConfig } from './infrastructure/config/app-config';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.PORT, '0.0.0.0');
console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.PORT, instance: config.INSTANCE_ID }));
