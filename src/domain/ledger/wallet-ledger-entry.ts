/**
 * @file wallet-ledger-entry.ts
 * @author Pablo Reis Rebonato
 * @description Immutable ledger line whose arithmetic and version chain are validated on creation.
 */

import { assertNonEmpty, InvariantViolationError } from '../shared/errors';
import { Money } from '../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/** Direction that undoes a movement (used by ROLLBACK). */
export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version after applying this entry; forms a gap-free chain per wallet. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable ledger line. There are no setters and no transition methods: once created
 * an entry can only be read. The database enforces the same with a trigger that blocks
 * UPDATE/DELETE/TRUNCATE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /**
   * Validates ids, positive amount, version >= 1, arithmetic and non-negative result.
   * @throws InvariantViolationError on any violation.
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.transactionId, 'transactionId');
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvariantViolationError('invalid ledger direction');
    }
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('ledger amount must be positive');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError('walletVersion must be a positive integer');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `ledger arithmetic mismatch: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger balanceAfter cannot be negative');
    }
    return entry;
  }

  /** Reconstruction from persistence without validation (the database already enforces it). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter (also enforced by a CHECK constraint). */
  isBalanced(): boolean {
    if (!this.money.hasSameCurrency(this.balanceBefore) || !this.money.hasSameCurrency(this.balanceAfter)) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the balance: +money for credits, -money for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
