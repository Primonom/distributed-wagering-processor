/**
 * @file create-wallet.ts
 * @author Pablo Reis Rebonato
 * @description Use case that opens a wallet and, for a positive initial balance, records its OPENING transaction and ledger line atomically.
 */

import {
  computeWagerPayloadHash,
  INTERNAL_PROVIDER_ID,
  InvalidMoneyError,
  InvariantViolationError,
  Money,
  MoneyProps,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionProcessed,
  Wallet,
  WalletBalanceChanged,
} from '../../domain';
import { InvalidRequestError, UniqueConstraintError, WalletAlreadyExistsError } from '../errors/application-errors';
import type { Clock, IdGenerator, LoggerPort, UnitOfWork } from '../ports';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Opens a wallet. A positive initial balance creates the internal OPENING transaction
 * and its CREDIT ledger line in the same SQL transaction as the wallet row.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * @throws InvalidRequestError for an invalid player id or initial balance.
   * @throws WalletAlreadyExistsError when the player already has a wallet in that currency.
   */
  async execute(cmd: CreateWalletCommand): Promise<Wallet> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(cmd.initialBalance);
    } catch (error) {
      if (error instanceof InvalidMoneyError) throw new InvalidRequestError('INVALID_MONEY', error.message);
      throw error;
    }
    if (typeof cmd.playerId !== 'string' || cmd.playerId.trim() === '' || cmd.playerId.length > 128) {
      throw new InvalidRequestError('INVALID_PAYLOAD', 'playerId must be a non-empty string (max 128 chars)');
    }

    try {
      const wallet = await this.uow.run({ name: 'create-wallet' }, async (repos) => {
        const existing = await repos.wallets.findByPlayerAndCurrency(cmd.playerId, initialBalance.currency);
        if (existing) throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency, existing.id);

        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTxId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance,
          at: now,
          opening: initialBalance.isPositive() ? { transactionId: openingTxId, entryId: this.ids.next() } : undefined,
        });
        await repos.wallets.insert(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTxId,
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${walletId}`,
            payloadHash: computeWagerPayloadHash({
              providerId: INTERNAL_PROVIDER_ID,
              externalTransactionId: `opening:${walletId}`,
              playerId: cmd.playerId,
              walletId,
              roundId: 'opening',
              gameId: 'internal',
              kind: WagerTransactionKind.Opening,
              money: initialBalance.toJSON(),
            }),
            walletId,
            playerId: cmd.playerId,
            roundId: 'opening',
            gameId: 'internal',
            money: initialBalance,
            correlationId: cmd.correlationId,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance);
          if (!openingEntry.balanceAfter.equals(wallet.balance)) {
            throw new InvariantViolationError('opening entry does not match the wallet balance');
          }
          await repos.transactions.insert(opening);
          await repos.ledger.insert(openingEntry);
          const ctx = { nextId: () => this.ids.next(), correlationId: cmd.correlationId, causationId: undefined, occurredAt: now };
          await repos.outbox.insertMany([
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, ctx)),
          ]);
        }
        return wallet;
      });
      this.logger.info({ correlationId: cmd.correlationId, walletId: wallet.id }, 'wallet created');
      return wallet;
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.constraint === 'wallets_player_currency_uq') {
        throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
