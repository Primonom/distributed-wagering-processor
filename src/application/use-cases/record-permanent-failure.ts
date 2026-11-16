import {
  FailureCode,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  computeWagerPayloadHash,
} from '../../domain';
import type { Clock, IdGenerator, LoggerPort, UnitOfWork } from '../ports';
import type { SubmitWagerCommand } from './submit-wager-transaction';

/**
 * Best-effort audit record for an operation that could not be processed because of a
 * persistent infrastructure failure (retries exhausted). Creates a terminal FAILED row
 * when the wallet exists and the idempotency key is unused; otherwise does nothing.
 * Returns the transaction id when a row was written.
 */
export class RecordPermanentFailure {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: LoggerPort,
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<string | undefined> {
    let money: Money;
    try {
      money = Money.from(cmd.money);
    } catch (error) {
      if (error instanceof InvalidMoneyError) return undefined;
      throw error;
    }
    return this.uow.run({ name: 'record-permanent-failure' }, async (repos) => {
      const wallet = await repos.wallets.findById(cmd.walletId);
      if (!wallet) return undefined;
      if (await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey)) return undefined;
      if (await repos.transactions.findByProviderAndExternalId(cmd.providerId, cmd.externalTransactionId)) return undefined;
      const now = this.clock.now();
      let tx: WagerTransaction;
      try {
        tx = WagerTransaction.create({
          id: this.ids.next(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash: computeWagerPayloadHash({ ...cmd, kind: cmd.kind, money: money.toJSON() }),
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind as WagerTransactionKind,
          money,
          referenceExternalTransactionId: cmd.referenceExternalTransactionId,
          correlationId: cmd.correlationId,
          createdAt: now,
        });
      } catch (error) {
        if (error instanceof InvalidWagerTransactionError) return undefined;
        throw error;
      }
      tx.fail(FailureCode.InfrastructurePermanentFailure, now);
      await repos.transactions.insert(tx);
      this.logger.error(
        { correlationId: cmd.correlationId, transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, failureCode: tx.failureCode },
        'transaction recorded as FAILED after exhausting retries',
      );
      return tx.id;
    });
  }
}
