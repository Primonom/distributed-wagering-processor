/**
 * Sends a WagerTransactionRequested message to the wager queue.
 *   bun scripts/send-sqs-message.ts <walletId> <playerId> <KIND> <amount> [referenceExternalTransactionId]
 */
import { randomUUID } from 'node:crypto';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/app-config';
import { createSqsClient } from '../src/infrastructure/messaging/sqs';

const [walletId, playerId, kind = 'BET', amount = '10.00', reference] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('usage: bun scripts/send-sqs-message.ts <walletId> <playerId> <KIND> <amount> [referenceExternalTransactionId]');
  process.exit(1);
}
const config = loadConfig();
const sqs = createSqsClient(config);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.SQS_WAGER_QUEUE }));
const externalTransactionId = `sqs-${randomUUID()}`;
const messageId = `msg-${randomUUID()}`;
const body = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-sqs',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  },
};
await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(body), MessageGroupId: walletId, MessageDeduplicationId: messageId }));
console.log(JSON.stringify({ messageId, externalTransactionId }));
sqs.destroy();
