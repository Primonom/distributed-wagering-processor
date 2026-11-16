import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidRequestError,
} from '../../application/errors/application-errors';
import type { LoggerPort, MetricsPort } from '../../application/ports';
import type { RecordPermanentFailure } from '../../application/use-cases/record-permanent-failure';
import type { SubmitWagerCommand, SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import type { QueueRegistry } from '../../infrastructure/messaging/sqs';
import { WagerMessageSchema, formatZodError } from '../contracts/wager-contracts';

export interface ConsumerSettings {
  consumerName: string;
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  faultInjection: string;
}

type Classification = 'ack' | 'retry' | 'dlq';

/**
 * Driving adapter for wager-transactions.fifo. Reuses the HTTP use case.
 *
 *  - business outcome (PROCESSED / REJECTED / PENDING_REFERENCE / inbox duplicate) → commit, then DeleteMessage
 *  - transient failure (DB/SQS down, retries exhausted on locks) → no ack, ChangeMessageVisibility(backoff);
 *    on the last allowed receive the operation is recorded as FAILED (best effort) and moved to the DLQ
 *  - permanent failure (invalid payload, idempotency conflict) → sent to the DLQ and deleted
 *
 * Messages of one MessageGroupId (walletId) are processed sequentially, groups in parallel.
 * Correctness never depends on that ordering: the wallet row lock and the inbox do.
 */
export class WagerQueueConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private released = 0;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly submit: SubmitWagerTransaction,
    private readonly recordFailure: RecordPermanentFailure,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly settings: ConsumerSettings,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.poll();
  }

  /** Graceful stop: no more polling, finish in-flight work (bounded), release unstarted messages. */
  async stop(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const drained = Promise.allSettled([...this.inFlight]).then(() => 'drained' as const);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs).unref?.());
    const outcome = await Promise.race([drained, timeout]);
    await this.loop?.catch(() => undefined);
    this.logger.info({ outcome, releasedMessages: this.released }, 'wager queue consumer stopped');
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let messages: Message[] = [];
      try {
        const { wager } = await this.queues.resolve();
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: wager,
            MaxNumberOfMessages: Math.min(10, Math.max(1, this.settings.maxMessages)),
            WaitTimeSeconds: this.settings.waitTimeSeconds,
            VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
            ReceiveRequestAttemptId: randomUUID(),
          }),
          { abortSignal: this.abort.signal },
        );
        messages = res.Messages ?? [];
        failures = 0;
      } catch (error) {
        if (!this.running) break;
        failures++;
        this.logger.warn({ err: error, consecutiveFailures: failures }, 'SQS receive failed');
        await Bun.sleep(Math.min(250 * 2 ** Math.min(failures, 6), 10_000));
        continue;
      }
      if (messages.length === 0) continue;
      const batch = this.processBatch(messages);
      this.inFlight.add(batch);
      try {
        await batch;
      } finally {
        this.inFlight.delete(batch);
      }
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const key = m.Attributes?.MessageGroupId ?? m.MessageId ?? randomUUID();
      const list = groups.get(key) ?? [];
      list.push(m);
      groups.set(key, list);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) {
            await this.release(message);
            continue;
          }
          await this.handle(message);
        }
      }),
    );
  }

  /** Handles one message; never throws. Exposed for tests. */
  async handle(message: Message): Promise<Classification> {
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10) || 1;
    const sqsMessageId = message.MessageId ?? 'unknown';
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(message.Body ?? '');
    } catch {
      await this.moveToDlq(message, 'INVALID_JSON', receiveCount);
      return 'dlq';
    }
    const parsed = WagerMessageSchema.safeParse(parsedBody);
    if (!parsed.success) {
      this.logger.warn({ sqsMessageId, issues: formatZodError(parsed.error) }, 'invalid wager message');
      await this.moveToDlq(message, 'INVALID_PAYLOAD', receiveCount);
      return 'dlq';
    }
    const envelope = parsed.data;
    const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? envelope.correlationId ?? envelope.messageId;
    const cmd: SubmitWagerCommand = {
      ...envelope.data,
      correlationId,
      source: { channel: 'sqs', consumerName: this.settings.consumerName, messageId: envelope.messageId },
    };
    const logCtx = { correlationId, messageId: envelope.messageId, sqsMessageId, providerId: cmd.providerId, walletId: cmd.walletId, receiveCount };

    try {
      const result = await this.submit.execute(cmd);
      if (this.settings.faultInjection === 'crash_after_commit') {
        this.logger.error(logCtx, 'FAULT INJECTION: crashing after commit, before ack');
        process.kill(process.pid, 'SIGKILL');
        await Bun.sleep(10_000);
      }
      await this.ack(message);
      this.logger.info({ ...logCtx, transactionId: result.transactionId, status: result.status, failureCode: result.failureCode, duplicate: result.duplicateMessage || result.idempotentReplay }, 'wager message processed');
      return 'ack';
    } catch (error) {
      if (error instanceof InvalidRequestError || error instanceof IdempotencyKeyConflictError || error instanceof ExternalTransactionConflictError) {
        this.logger.warn({ ...logCtx, code: error.code }, 'permanent failure for wager message');
        await this.moveToDlq(message, error.code, receiveCount);
        return 'dlq';
      }
      if (receiveCount >= this.settings.maxReceiveCount) {
        this.logger.error({ ...logCtx, err: error }, 'retries exhausted for wager message');
        try {
          await this.recordFailure.execute(cmd);
        } catch (recordError) {
          this.logger.error({ ...logCtx, err: recordError }, 'could not record FAILED transaction');
        }
        await this.moveToDlq(message, 'RETRIES_EXHAUSTED', receiveCount);
        return 'dlq';
      }
      const delay = Math.min(this.settings.retryMaxSeconds, this.settings.retryBaseSeconds * 2 ** (receiveCount - 1));
      this.metrics.retry('sqs_transient');
      this.logger.warn({ ...logCtx, err: error, retryInSeconds: delay }, 'transient failure, message will be retried');
      await this.changeVisibility(message, delay);
      return 'retry';
    }
  }

  private async ack(message: Message): Promise<void> {
    const { wager } = await this.queues.resolve();
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: message.ReceiptHandle }));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      const { wager } = await this.queues.resolve();
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: wager, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }));
    } catch (error) {
      this.logger.warn({ sqsMessageId: message.MessageId, err: error }, 'could not change message visibility');
    }
  }

  private async release(message: Message): Promise<void> {
    this.released++;
    await this.changeVisibility(message, 0);
  }

  /**
   * Explicit DLQ move for permanent failures (the redrive policy remains as a safety net
   * for messages that keep failing before reaching this code, e.g. crashes).
   */
  private async moveToDlq(message: Message, reason: string, receiveCount: number): Promise<void> {
    try {
      const { wager, dlq } = await this.queues.resolve();
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: dlq,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
          MessageDeduplicationId: message.MessageId ?? randomUUID(),
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
            receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: message.ReceiptHandle }));
      this.metrics.dlqMessage(reason);
      this.logger.warn({ sqsMessageId: message.MessageId, reason, receiveCount }, 'message moved to DLQ');
    } catch (error) {
      this.logger.error({ sqsMessageId: message.MessageId, err: error }, 'could not move message to DLQ; it will be redelivered');
    }
  }
}
