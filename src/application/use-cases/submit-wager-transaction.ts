import {
  FailureCode,
  InboxMessage,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  Money,
  MoneyProps,
  SUBMITTABLE_KINDS,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  computeWagerPayloadHash,
} from '../../domain';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidRequestError,
  UniqueConstraintError,
} from '../errors/application-errors';
import type { Clock, IdGenerator, LoggerPort, MetricsPort, TransactionalRepositories, UnitOfWork } from '../ports';
import type { WagerSettlement } from './wager-settlement';

export type SubmissionSource =
  | { channel: 'http' }
  | { channel: 'sqs'; consumerName: string; messageId: string };

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  source: SubmissionSource;
}

export interface SubmitWagerResult {
  /** null only when nothing could be persisted (WALLET_NOT_FOUND). */
  transactionId: string | null;
  status: WagerTransactionStatus;
  failureCode?: FailureCode | undefined;
  /** Balance observed when the transaction reached its current state. */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  /** SQS only: this exact message was already processed (inbox hit). */
  duplicateMessage: boolean;
}

const TX_UNIQUE_CONSTRAINTS = new Set(['wager_tx_idempotency_key_uq', 'wager_tx_provider_external_uq']);

/**
 * Submits a provider operation. Same code path for HTTP and SQS.
 *
 * Inside ONE SQL transaction:
 *   [inbox insert (SQS)] → idempotency lookup → SELECT wallet FOR UPDATE → idempotency
 *   re-check (now serialised per wallet) → domain decision → tx + wallet(version-checked)
 *   + ledger + outbox → COMMIT.
 * A race between identical requests on *different* wallets ends in a unique violation
 * on idempotency_key: the transaction is rolled back and the lookup is replayed.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const started = performance.now();
    const { money, kind } = this.validate(cmd);
    const payloadHash = computeWagerPayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });
    let outcome = 'error';
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.uow.run({ name: 'submit-wager' }, (repos) => this.process(repos, cmd, kind, money, payloadHash));
          outcome = result.idempotentReplay || result.duplicateMessage ? 'replay' : result.status;
          return result;
        } catch (error) {
          if (attempt === 0 && error instanceof UniqueConstraintError && TX_UNIQUE_CONSTRAINTS.has(error.constraint ?? '')) {
            this.metrics.retry('idempotency_race');
            continue; // the other request committed first: the next attempt replays or conflicts
          }
          throw error;
        }
      }
    } finally {
      this.metrics.processingDuration(`submit_${cmd.source.channel}`, (performance.now() - started) / 1000, outcome);
    }
  }

  private validate(cmd: SubmitWagerCommand): { money: Money; kind: WagerTransactionKind } {
    if (typeof cmd.idempotencyKey !== 'string' || cmd.idempotencyKey.trim() === '' || cmd.idempotencyKey.length > 255) {
      throw new InvalidRequestError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required (1-255 chars)');
    }
    if (cmd.kind === WagerTransactionKind.Opening) {
      throw new InvalidRequestError(FailureCode.OpeningNotAllowed, 'OPENING is internal and cannot be submitted');
    }
    if (!(SUBMITTABLE_KINDS as readonly string[]).includes(cmd.kind)) {
      throw new InvalidRequestError('INVALID_PAYLOAD', `kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
    }
    try {
      return { money: Money.from(cmd.money), kind: cmd.kind as WagerTransactionKind };
    } catch (error) {
      if (error instanceof InvalidMoneyError) throw new InvalidRequestError('INVALID_MONEY', error.message);
      throw error;
    }
  }

  private async process(
    repos: TransactionalRepositories,
    cmd: SubmitWagerCommand,
    kind: WagerTransactionKind,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const now = this.clock.now();

    if (cmd.source.channel === 'sqs') {
      const inserted = await repos.inbox.tryInsert(
        InboxMessage.rehydrate({
          messageId: cmd.source.messageId,
          consumerName: cmd.source.consumerName,
          payloadHash,
          receivedAt: now,
          processedAt: now,
        }),
      );
      if (!inserted) {
        this.metrics.idempotentDuplicate('inbox');
        const existing = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
        return existing
          ? { ...this.toResult(existing, true), duplicateMessage: true }
          : { transactionId: null, status: WagerTransactionStatus.Rejected, failureCode: FailureCode.WalletNotFound, balance: null, idempotentReplay: true, duplicateMessage: true };
      }
    }

    const early = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (early) return this.replay(early, payloadHash, cmd);

    const wallet = await repos.wallets.findByIdForUpdate(cmd.walletId);
    if (!wallet) {
      // Nothing to attach a row to (FK): answer with a stable rejection, persist nothing but the inbox.
      this.metrics.transactionOutcome(WagerTransactionStatus.Rejected, kind);
      this.logger.info(this.logContext(cmd, { failureCode: FailureCode.WalletNotFound }), 'wager transaction rejected: wallet not found');
      return { transactionId: null, status: WagerTransactionStatus.Rejected, failureCode: FailureCode.WalletNotFound, balance: null, idempotentReplay: false, duplicateMessage: false };
    }

    // Re-check under the wallet lock: a concurrent identical request has either committed (visible now) or not started.
    const existing = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (existing) return this.replay(existing, payloadHash, cmd);
    const sameExternal = await repos.transactions.findByProviderAndExternalId(cmd.providerId, cmd.externalTransactionId);
    if (sameExternal) {
      throw new ExternalTransactionConflictError(cmd.providerId, cmd.externalTransactionId, sameExternal.id);
    }

    let tx: WagerTransaction;
    try {
      tx = WagerTransaction.create({
        id: this.ids.next(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind,
        money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        correlationId: cmd.correlationId,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof InvalidWagerTransactionError) throw new InvalidRequestError(error.code, error.message);
      throw error;
    }

    const ctx = {
      nextId: () => this.ids.next(),
      correlationId: cmd.correlationId,
      causationId: cmd.source.channel === 'sqs' ? cmd.source.messageId : cmd.idempotencyKey,
      occurredAt: now,
    };
    await this.settlement.settle(
      repos,
      tx,
      wallet,
      ctx,
      (t) => repos.transactions.insert(t),
      (t) => this.settlement.parkNew(t, wallet, now),
    );

    this.metrics.transactionOutcome(tx.status, tx.kind);
    this.logger.info(
      this.logContext(cmd, { transactionId: tx.id, status: tx.status, failureCode: tx.failureCode }),
      'wager transaction settled',
    );
    return this.toResult(tx, false);
  }

  private replay(existing: WagerTransaction, payloadHash: string, cmd: SubmitWagerCommand): SubmitWagerResult {
    if (!existing.matchesPayload(payloadHash)) {
      this.logger.warn(this.logContext(cmd, { transactionId: existing.id }), 'idempotency key reused with a different payload');
      throw new IdempotencyKeyConflictError(cmd.idempotencyKey, existing.id);
    }
    this.metrics.idempotentDuplicate(cmd.source.channel);
    this.logger.debug(this.logContext(cmd, { transactionId: existing.id, status: existing.status }), 'idempotent replay');
    return this.toResult(existing, true);
  }

  private toResult(tx: WagerTransaction, replay: boolean): SubmitWagerResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      failureCode: tx.failureCode,
      balance: tx.balanceSnapshot?.toJSON() ?? null,
      idempotentReplay: replay,
      duplicateMessage: false,
    };
  }

  private logContext(cmd: SubmitWagerCommand, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      correlationId: cmd.correlationId,
      providerId: cmd.providerId,
      walletId: cmd.walletId,
      kind: cmd.kind,
      externalTransactionId: cmd.externalTransactionId,
      messageId: cmd.source.channel === 'sqs' ? cmd.source.messageId : undefined,
      ...extra,
    };
  }
}
