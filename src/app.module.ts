import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  BeforeApplicationShutdown,
  DynamicModule,
  Inject,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { PORTS, type Clock, type IdGenerator, type LoggerPort, type MetricsPort, type UnitOfWork } from './application/ports';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ProcessPendingReferences } from './application/use-cases/process-pending-references';
import { PublishOutbox } from './application/use-cases/publish-outbox';
import { ReconcileWallet, WalletQueries } from './application/use-cases/queries';
import { RecordPermanentFailure } from './application/use-cases/record-permanent-failure';
import { SubmitWagerTransaction } from './application/use-cases/submit-wager-transaction';
import { WagerSettlement } from './application/use-cases/wager-settlement';
import { BackoffPolicy } from './domain';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config';
import { QueueRegistry, SqsEventPublisher, createSqsClient } from './infrastructure/messaging/sqs';
import { PinoLoggerAdapter, createRootLogger } from './infrastructure/observability/logging';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { createOrm } from './infrastructure/persistence/mikro-orm';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { NoopProviderIdentity, SystemClock, UuidV7Generator } from './infrastructure/system';
import { TOKENS } from './infrastructure/tokens';
import { Lifecycle } from './infrastructure/workers/lifecycle';
import { PollingWorker } from './infrastructure/workers/polling-worker';
import { BusinessControllers } from './interfaces/http/controllers';
import { HealthController, MetricsController } from './interfaces/http/controllers/ops.controllers';
import { HttpExceptionFilter } from './interfaces/http/filters/http-exception.filter';
import { ProviderAuthGuard } from './interfaces/http/guards/provider-auth.guard';
import { WagerQueueConsumer } from './interfaces/messaging/wager-queue-consumer';

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

class LifecycleHooks implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(@Inject(Lifecycle) private readonly lifecycle: Lifecycle) {}
  async onApplicationBootstrap(): Promise<void> {
    await this.lifecycle.start();
  }
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    await this.lifecycle.drain(signal);
  }
  async onApplicationShutdown(): Promise<void> {
    await this.lifecycle.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const rootLogger = createRootLogger(config.LOG_LEVEL, config.INSTANCE_ID);
    const loggerFor = (component: string) => new PinoLoggerAdapter(rootLogger).child(component);

    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: TOKENS.RootLogger, useValue: rootLogger },
      { provide: PORTS.Logger, useValue: loggerFor('app') },
      { provide: TOKENS.Metrics, useValue: new PrometheusMetrics(config.INSTANCE_ID) },
      { provide: PORTS.Metrics, useExisting: TOKENS.Metrics },
      { provide: PORTS.Clock, useClass: SystemClock },
      { provide: PORTS.IdGenerator, useClass: UuidV7Generator },
      { provide: PORTS.ProviderIdentity, useClass: NoopProviderIdentity },
      { provide: TOKENS.Orm, useFactory: () => createOrm(config) },
      { provide: TOKENS.Sqs, useFactory: () => createSqsClient(config) },
      { provide: TOKENS.Queues, inject: [TOKENS.Sqs], useFactory: (sqs: SQSClient) => new QueueRegistry(sqs, config) },
      {
        provide: PORTS.EventPublisher,
        inject: [TOKENS.Sqs, TOKENS.Queues],
        useFactory: (sqs: SQSClient, queues: QueueRegistry) => new SqsEventPublisher(sqs, queues),
      },
      {
        provide: PORTS.UnitOfWork,
        inject: [TOKENS.Orm, PORTS.Metrics],
        useFactory: (orm: MikroORM<PostgreSqlDriver>, metrics: MetricsPort) =>
          new MikroOrmUnitOfWork(
            orm,
            { lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS, maxRetries: config.TX_MAX_RETRIES, retryBaseMs: config.TX_RETRY_BASE_MS },
            metrics,
            loggerFor('uow'),
          ),
      },
      {
        provide: WagerSettlement,
        inject: [PORTS.IdGenerator],
        useFactory: (ids: IdGenerator) =>
          new WagerSettlement(ids, {
            backoff: BackoffPolicy.create({ baseMs: config.PENDING_RETRY_BASE_MS, factor: 2, maxMs: Math.max(config.PENDING_RETRY_BASE_MS, config.PENDING_RETRY_MAX_MS), jitter: true }),
            maxAttempts: config.PENDING_MAX_ATTEMPTS,
          }),
      },
      {
        provide: SubmitWagerTransaction,
        inject: [PORTS.UnitOfWork, WagerSettlement, PORTS.Clock, PORTS.IdGenerator, PORTS.Metrics],
        useFactory: (uow: UnitOfWork, s: WagerSettlement, clock: Clock, ids: IdGenerator, m: MetricsPort) =>
          new SubmitWagerTransaction(uow, s, clock, ids, m, loggerFor('submit-wager')),
      },
      {
        provide: CreateWallet,
        inject: [PORTS.UnitOfWork, PORTS.Clock, PORTS.IdGenerator],
        useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids, loggerFor('create-wallet')),
      },
      { provide: WalletQueries, inject: [PORTS.UnitOfWork], useFactory: (uow: UnitOfWork) => new WalletQueries(uow) },
      {
        provide: ReconcileWallet,
        inject: [PORTS.UnitOfWork, PORTS.Metrics],
        useFactory: (uow: UnitOfWork, m: MetricsPort) => new ReconcileWallet(uow, m, loggerFor('reconciliation')),
      },
      {
        provide: RecordPermanentFailure,
        inject: [PORTS.UnitOfWork, PORTS.Clock, PORTS.IdGenerator],
        useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new RecordPermanentFailure(uow, clock, ids, loggerFor('record-failure')),
      },
      {
        provide: ProcessPendingReferences,
        inject: [PORTS.UnitOfWork, WagerSettlement, PORTS.Clock, PORTS.IdGenerator, PORTS.Metrics],
        useFactory: (uow: UnitOfWork, s: WagerSettlement, clock: Clock, ids: IdGenerator, m: MetricsPort) =>
          new ProcessPendingReferences(uow, s, clock, ids, m, loggerFor('pending-references'), {
            batchSize: config.PENDING_BATCH_SIZE,
            leaseMs: config.PENDING_LEASE_MS,
          }),
      },
      {
        provide: PublishOutbox,
        inject: [PORTS.UnitOfWork, PORTS.EventPublisher, PORTS.Clock, PORTS.Metrics],
        useFactory: (uow: UnitOfWork, publisher: SqsEventPublisher, clock: Clock, m: MetricsPort) =>
          new PublishOutbox(uow, publisher, clock, m, loggerFor('outbox'), {
            batchSize: config.OUTBOX_BATCH_SIZE,
            retryPolicy: BackoffPolicy.create({ baseMs: config.OUTBOX_RETRY_BASE_MS, factor: 2, maxMs: Math.max(config.OUTBOX_RETRY_BASE_MS, config.OUTBOX_RETRY_MAX_MS), jitter: true }),
            afterPublish:
              config.FAULT_INJECTION === 'crash_after_publish'
                ? () => {
                    rootLogger.error({}, 'FAULT INJECTION: crashing after publish, before marking published');
                    process.kill(process.pid, 'SIGKILL');
                  }
                : undefined,
          }),
      },
      {
        provide: WagerQueueConsumer,
        inject: [TOKENS.Sqs, TOKENS.Queues, SubmitWagerTransaction, RecordPermanentFailure, PORTS.Metrics],
        useFactory: (sqs: SQSClient, queues: QueueRegistry, submit: SubmitWagerTransaction, record: RecordPermanentFailure, m: MetricsPort) =>
          new WagerQueueConsumer(sqs, queues, submit, record, m, loggerFor('sqs-consumer'), {
            consumerName: config.CONSUMER_NAME,
            maxMessages: config.CONSUMER_CONCURRENCY,
            waitTimeSeconds: config.SQS_WAIT_TIME_S,
            visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_S,
            maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
            retryBaseSeconds: config.SQS_RETRY_BASE_S,
            retryMaxSeconds: config.SQS_RETRY_MAX_S,
            faultInjection: config.FAULT_INJECTION,
          }),
      },
      {
        provide: Lifecycle,
        inject: [TOKENS.Orm, TOKENS.Sqs, TOKENS.Queues, WagerQueueConsumer, PublishOutbox, ProcessPendingReferences],
        useFactory: (orm: MikroORM, sqs: SQSClient, queues: QueueRegistry, consumer: WagerQueueConsumer, outbox: PublishOutbox, pending: ProcessPendingReferences) => {
          const workerLogger: LoggerPort = loggerFor('workers');
          const workers: PollingWorker[] = [
            new PollingWorker('outbox-gauges', config.METRICS_GAUGE_INTERVAL_MS, () => outbox.refreshGauges(), workerLogger),
          ];
          if (config.OUTBOX_ENABLED) workers.push(new PollingWorker('outbox-relay', config.OUTBOX_POLL_MS, () => outbox.runOnce(), workerLogger));
          if (config.PENDING_WORKER_ENABLED) workers.push(new PollingWorker('pending-references', config.PENDING_POLL_MS, () => pending.runOnce(), workerLogger));
          return new Lifecycle(config, orm, sqs, queues, consumer, workers, loggerFor('lifecycle'));
        },
      },
      LifecycleHooks,
      ProviderAuthGuard,
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ];

    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            logger: rootLogger,
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const incoming = req.headers[CORRELATION_HEADER];
              const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
              res.setHeader('X-Correlation-Id', id);
              return id;
            },
            customProps: (req: IncomingMessage) => ({ correlationId: (req as IncomingMessage & { id?: string }).id }),
            autoLogging: { ignore: (req: IncomingMessage) => /^\/(health|metrics)/.test(req.url ?? '') },
            serializers: {
              req: (req: { id?: string; method?: string; url?: string }) => ({ id: req.id, method: req.method, url: req.url }),
              res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
            },
          },
        }),
      ],
      controllers: [...BusinessControllers, HealthController, MetricsController],
      providers,
    };
  }
}
