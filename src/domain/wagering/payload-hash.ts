import { canonicalJson, sha256Hex } from '../shared/canonical-json';
import { MoneyProps } from '../shared/money';

/** Business fields that define "the same operation". Transport metadata is excluded. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = lowercase hex SHA-256 of the canonical JSON (keys sorted recursively,
 * no whitespace, absent optional fields omitted) of the business fields above.
 * `money.amount` must already be normalised to scale 2 ("25" and "25.00" hash equally).
 * Not included: Idempotency-Key, correlation ids, messageId, occurredAt, headers.
 */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  });
  return sha256Hex(canonical);
}
