/**
 * @file wager-contracts.ts
 * @author Pablo Reis Rebonato
 * @description Zod wire contracts shared by the HTTP API and the SQS consumer.
 */

import { z } from 'zod';

/**
 * Wire contracts shared by the HTTP API and the SQS consumer. Monetary amounts are
 * strings only — a JSON number is a validation error (400 / DLQ), never coerced.
 */
const text = (max = 128) => z.string().trim().min(1).max(max);

export const MoneySchema = z
  .object({
    amount: z.string({ invalid_type_error: 'amount must be a decimal string' }),
    currency: z.string(),
  })
  .strict();

export const WagerPayloadSchema = z
  .object({
    providerId: text(),
    externalTransactionId: text(),
    playerId: text(),
    walletId: z.string().uuid(),
    roundId: text(),
    gameId: text(),
    kind: z.string(),
    money: MoneySchema,
    referenceExternalTransactionId: text().optional(),
  })
  .strict();

export const CreateWalletSchema = z
  .object({
    playerId: text(),
    initialBalance: MoneySchema,
  })
  .strict();

export const WagerMessageSchema = z.object({
  messageId: text(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: text(256).optional(),
  data: WagerPayloadSchema.extend({ idempotencyKey: text(255) }).strict(),
});

export type WagerPayload = z.infer<typeof WagerPayloadSchema>;
export type WagerMessage = z.infer<typeof WagerMessageSchema>;

export function formatZodError(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
