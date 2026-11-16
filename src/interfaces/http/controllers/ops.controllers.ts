/**
 * @file ops.controllers.ts
 * @author Pablo Reis Rebonato
 * @description Operational HTTP endpoints: liveness, readiness and Prometheus metrics.
 */

import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../../infrastructure/config/app-config';
import { PrometheusMetrics } from '../../../infrastructure/observability/metrics';
import { TOKENS } from '../../../infrastructure/tokens';
import { Lifecycle } from '../../../infrastructure/workers/lifecycle';

/** Health endpoints are public (no guard). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(TOKENS.Orm) private readonly orm: MikroORM,
    @Inject(TOKENS.Sqs) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Lifecycle) private readonly lifecycle: Lifecycle,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      this.check(async () => {
        await this.orm.em.fork().getConnection().execute('SELECT 1');
      }),
      this.check(async () => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.SQS_WAGER_QUEUE }));
      }),
    ]);
    const draining = this.lifecycle.isShuttingDown();
    const ok = postgres.ok && sqs.ok && !draining;
    res.status(ok ? 200 : 503);
    if (!ok) res.setHeader('Retry-After', '1');
    return { status: ok ? 'ok' : draining ? 'draining' : 'unavailable', checks: { postgres, sqs } };
  }

  private async check(fn: () => Promise<void>): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = performance.now();
    try {
      await Promise.race([fn(), Bun.sleep(2000).then(() => Promise.reject(new Error('timeout')))]);
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(TOKENS.Metrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
