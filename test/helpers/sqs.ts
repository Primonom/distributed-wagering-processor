import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs';
import type { WagerPayload } from './api';

export function testSqs(): SQSClient {
  return createSqsClient(loadConfig({}));
}

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!res.QueueUrl) throw new Error(`queue ${name} missing`);
  return res.QueueUrl;
}

/** Receives (and deletes) every message currently available, until `until` is satisfied or timeout. */
export async function drain(sqs: SQSClient, url: string, opts: { until?: (all: Message[]) => boolean; timeoutMs?: number } = {}): Promise<Message[]> {
  const all: Message[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] }));
    const msgs = res.Messages ?? [];
    if (msgs.length > 0) {
      all.push(...msgs);
      await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })) }));
    }
    if (opts.until ? opts.until(all) : msgs.length === 0) break;
  }
  return all;
}

export async function approximateCount(sqs: SQSClient, url: string): Promise<{ visible: number; inFlight: number }> {
  const res = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
  return {
    visible: Number.parseInt(res.Attributes?.ApproximateNumberOfMessages ?? '0', 10),
    inFlight: Number.parseInt(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
  };
}

/** Sends a WagerTransactionRequested message exactly like a provider would. */
export async function sendWager(
  sqs: SQSClient,
  url: string,
  payload: WagerPayload,
  opts: { messageId?: string; idempotencyKey?: string; dedupId?: string; body?: string } = {},
): Promise<string> {
  const messageId = opts.messageId ?? `msg-${randomUUID()}`;
  const body =
    opts.body ??
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...payload, idempotencyKey: opts.idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}` },
    });
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: payload.walletId,
      MessageDeduplicationId: opts.dedupId ?? randomUUID(),
    }),
  );
  return messageId;
}
