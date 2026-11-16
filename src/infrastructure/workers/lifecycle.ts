import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import type { LoggerPort } from '../../application/ports';
import type { WagerQueueConsumer } from '../../interfaces/messaging/wager-queue-consumer';
import type { AppConfig } from '../config/app-config';
import type { QueueRegistry } from '../messaging/sqs';
import type { PollingWorker } from './polling-worker';

/**
 * Owns background processing and the shutdown sequence (driven by Nest shutdown hooks,
 * i.e. SIGTERM/SIGINT when app.enableShutdownHooks() is on):
 *   1. mark draining (readiness → 503, so load balancers stop routing);
 *   2. stop SQS polling, finish in-flight messages (bounded), release unstarted ones;
 *   3. stop the outbox relay / pending-reference worker after their current iteration;
 *   4. close the SQS client and the database pool.
 */
export class Lifecycle {
  private shuttingDown = false;

  constructor(
    private readonly config: AppConfig,
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly consumer: WagerQueueConsumer,
    private readonly workers: PollingWorker[],
    private readonly logger: LoggerPort,
  ) {}

  async start(): Promise<void> {
    if (this.config.CONSUMER_ENABLED || this.config.OUTBOX_ENABLED || this.config.SQS_BOOTSTRAP) {
      try {
        await this.queues.resolve();
      } catch (error) {
        // Not fatal: workers keep retrying and readiness reports SQS as down.
        this.logger.warn({ err: error }, 'SQS queues not available at startup');
      }
    }
    for (const worker of this.workers) worker.start();
    if (this.config.CONSUMER_ENABLED) this.consumer.start();
    this.logger.info(
      {
        consumer: this.config.CONSUMER_ENABLED,
        outbox: this.config.OUTBOX_ENABLED,
        pendingWorker: this.config.PENDING_WORKER_ENABLED,
        faultInjection: this.config.FAULT_INJECTION || undefined,
      },
      'background processing started',
    );
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async drain(signal?: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info({ signal }, 'shutting down: draining background processing');
    await this.consumer.stop(this.config.SHUTDOWN_TIMEOUT_MS);
    await Promise.all(this.workers.map((w) => w.stop()));
  }

  async close(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
    this.logger.info({}, 'connections closed');
  }
}
