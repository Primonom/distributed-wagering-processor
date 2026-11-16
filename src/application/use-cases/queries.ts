/**
 * @file queries.ts
 * @author Pablo Reis Rebonato
 * @description Read-side use cases: wallet, ledger pagination with a keyset cursor, transaction lookup and balance reconciliation.
 */

import { Money, MoneyProps, WagerTransaction, Wallet, WalletLedgerEntry } from '../../domain';
import { InvalidRequestError, ResourceNotFoundError } from '../errors/application-errors';
import type { LedgerCursor, LoggerPort, MetricsPort, UnitOfWork } from '../ports';

export const LEDGER_MAX_PAGE = 100;

/** Opaque, stable keyset cursor: base64url(JSON {createdAt, id}) of the last returned line. */
export const LedgerCursorCodec = {
  encode(entry: { createdAt: Date; id: string }): string {
    return Buffer.from(JSON.stringify({ c: entry.createdAt.toISOString(), i: entry.id }), 'utf8').toString('base64url');
  },
  /** @throws InvalidRequestError (INVALID_CURSOR) when the cursor was not produced by `encode`. */
  decode(cursor: string): LedgerCursor {
    const malformed = new InvalidRequestError('INVALID_CURSOR', 'cursor is malformed');
    let parsed: { c?: unknown; i?: unknown } | null;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw malformed;
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.c !== 'string' || typeof parsed.i !== 'string') throw malformed;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) throw malformed;
    return { createdAt, id: parsed.i };
  },
};

/** Read-only queries; they never take locks. */
export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  /** @throws ResourceNotFoundError when the wallet does not exist. */
  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (!wallet) throw new ResourceNotFoundError('wallet', walletId);
    return wallet;
  }

  /**
   * Ledger page in (createdAt, id) order with an opaque cursor to the next page.
   * @throws InvalidRequestError for an invalid limit or cursor.
   * @throws ResourceNotFoundError when the wallet does not exist.
   */
  async getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: WalletLedgerEntry[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_PAGE) {
      throw new InvalidRequestError('INVALID_PAYLOAD', `limit must be an integer between 1 and ${LEDGER_MAX_PAGE}`);
    }
    const after = cursor ? LedgerCursorCodec.decode(cursor) : undefined;
    return this.uow.read(async (r) => {
      const wallet = await r.wallets.findById(walletId);
      if (!wallet) throw new ResourceNotFoundError('wallet', walletId);
      const rows = await r.ledger.page(walletId, after, limit + 1);
      const entries = rows.slice(0, limit);
      const last = entries[entries.length - 1];
      return { entries, nextCursor: rows.length > limit && last ? LedgerCursorCodec.encode(last) : null };
    });
  }

  /** @throws ResourceNotFoundError when the transaction does not exist. */
  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (!tx) throw new ResourceNotFoundError('transaction', transactionId);
    return tx;
  }

  /** @throws ResourceNotFoundError when no transaction has that provider id and external id. */
  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findByProviderAndExternalId(providerId, externalTransactionId));
    if (!tx) throw new ResourceNotFoundError('transaction', `${providerId}/${externalTransactionId}`);
    return tx;
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
}

/**
 * Recomputes the balance from the ledger (SUM in SQL over NUMERIC) and compares it with
 * the materialised balance. Takes FOR SHARE on the wallet so no writer can commit to it
 * between the two reads. Divergences are logged, counted and reported — never fixed.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  /** @throws ResourceNotFoundError when the wallet does not exist. */
  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run({ name: 'reconcile' }, async (r) => {
      const wallet = await r.wallets.findByIdForShare(walletId);
      if (!wallet) throw new ResourceNotFoundError('wallet', walletId);
      const { balance, entries } = await r.ledger.sumForWallet(walletId, wallet.currency);
      const difference: Money = wallet.balance.subtract(balance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: balance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries,
        walletVersion: wallet.version,
      };
    });
    if (!report.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error(
        {
          correlationId,
          walletId,
          walletVersion: report.walletVersion,
          checkedEntries: report.checkedEntries,
          alert: 'RECONCILIATION_DIVERGENCE',
        },
        'wallet balance diverges from ledger',
      );
    }
    return report;
  }
}
