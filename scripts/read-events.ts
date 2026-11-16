/**
 * @file read-events.ts
 * @author Pablo Reis Rebonato
 * @description Drains the integration events queue and prints one line per event for manual inspection.
 */

import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/app-config';
import { createSqsClient } from '../src/infrastructure/messaging/sqs';

const config = loadConfig();
const sqs = createSqsClient(config);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.SQS_EVENTS_QUEUE }));
let total = 0;
for (;;) {
  const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
  const messages = res.Messages ?? [];
  if (messages.length === 0) break;
  for (const m of messages) {
    const e = JSON.parse(m.Body ?? '{}');
    console.log(`${e.occurredAt} ${e.eventType.padEnd(34)} aggregate=${e.aggregateId} eventId=${e.eventId}`);
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
    total++;
  }
}
console.log(`${total} event(s)`);
sqs.destroy();
