import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports';
import type { IntegrationEventEnvelope } from '../../domain';
import type { AppConfig } from '../config/app-config';

export function createSqsClient(config: Pick<AppConfig, 'AWS_REGION' | 'SQS_ENDPOINT' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'>): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

type QueueConfig = Pick<AppConfig, 'SQS_WAGER_QUEUE' | 'SQS_WAGER_DLQ' | 'SQS_EVENTS_QUEUE' | 'SQS_MAX_RECEIVE_COUNT' | 'SQS_VISIBILITY_TIMEOUT_S' | 'SQS_BOOTSTRAP'>;

/**
 * Resolves (and, when SQS_BOOTSTRAP=true, idempotently creates) the queues:
 *   wager-transactions.fifo  --redrive(maxReceiveCount)-->  wager-transactions-dlq.fifo
 *   wallet-events.fifo       (integration events published by the outbox relay)
 */
export class QueueRegistry {
  private urls: QueueUrls | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: QueueConfig,
  ) {}

  async resolve(): Promise<QueueUrls> {
    if (this.urls) return this.urls;
    this.urls = this.config.SQS_BOOTSTRAP ? await this.bootstrap() : await this.lookup();
    return this.urls;
  }

  get current(): QueueUrls | undefined {
    return this.urls;
  }

  private async lookup(): Promise<QueueUrls> {
    const url = async (name: string) => {
      const res = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      if (!res.QueueUrl) throw new Error(`queue ${name} not found`);
      return res.QueueUrl;
    };
    return { wager: await url(this.config.SQS_WAGER_QUEUE), dlq: await url(this.config.SQS_WAGER_DLQ), events: await url(this.config.SQS_EVENTS_QUEUE) };
  }

  private async bootstrap(): Promise<QueueUrls> {
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const create = async (name: string, attributes: Record<string, string>) => {
      const res = await this.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
      if (!res.QueueUrl) throw new Error(`could not create ${name}`);
      return res.QueueUrl;
    };
    const dlq = await create(this.config.SQS_WAGER_DLQ, { ...fifo, MessageRetentionPeriod: '1209600' });
    const attrs = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
    const dlqArn = attrs.Attributes?.QueueArn;
    if (!dlqArn) throw new Error('DLQ ARN not available');
    let wager: string;
    const wagerAttributes = {
      ...fifo,
      VisibilityTimeout: String(this.config.SQS_VISIBILITY_TIMEOUT_S),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(this.config.SQS_MAX_RECEIVE_COUNT) }),
    };
    try {
      wager = await create(this.config.SQS_WAGER_QUEUE, wagerAttributes);
    } catch (error) {
      // Queue already exists with other attributes (e.g. created by the LocalStack init hook).
      if ((error as { name?: string }).name !== 'QueueAlreadyExists' && (error as { name?: string }).name !== 'QueueNameExists') throw error;
      wager = (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.SQS_WAGER_QUEUE }))).QueueUrl ?? '';
    }
    const events = await create(this.config.SQS_EVENTS_QUEUE, this.config.SQS_EVENTS_QUEUE.endsWith('.fifo') ? fifo : {});
    return { wager, dlq, events };
  }
}

/**
 * Publishes outbox events to the events FIFO queue.
 * MessageGroupId = aggregateId (walletId) → per-wallet ordering on the broker side;
 * MessageDeduplicationId = eventId → the broker drops re-publications inside its 5-minute
 * window (an optimisation only: consumers must still de-duplicate by eventId).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
  ) {}

  async publishBatch(events: Array<{ id: string; groupId: string; envelope: IntegrationEventEnvelope<unknown> }>): Promise<PublishResult[]> {
    const { events: queueUrl } = await this.queues.resolve();
    // A standard queue (no .fifo suffix) is supported too; then there is no broker-side dedup at all.
    const fifo = queueUrl.endsWith('.fifo');
    const results: PublishResult[] = [];
    for (let i = 0; i < events.length; i += 10) {
      const chunk = events.slice(i, i + 10);
      const res = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((e, idx) => ({
            Id: String(idx),
            MessageBody: JSON.stringify(e.envelope),
            ...(fifo ? { MessageGroupId: e.groupId, MessageDeduplicationId: e.id } : {}),
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: e.envelope.eventType },
              eventId: { DataType: 'String', StringValue: e.envelope.eventId },
              correlationId: { DataType: 'String', StringValue: e.envelope.correlationId },
            },
          })),
        }),
      );
      const failed = new Map((res.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? 'failed']));
      chunk.forEach((e, idx) => {
        const error = failed.get(String(idx));
        results.push(error === undefined ? { id: e.id, ok: true } : { id: e.id, ok: false, error });
      });
    }
    return results;
  }
}
