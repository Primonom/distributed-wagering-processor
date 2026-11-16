import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvariantViolationError,
  assertNonEmpty,
} from '../shared/errors';
import { Money } from '../shared/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when initialBalance > 0: identifiers of the internal OPENING transaction and its ledger entry. */
  opening?: { transactionId: string; entryId: string };
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate root. Balance and version are only changed through debit/credit, which
 * always return the ledger entry describing the movement, so balance and ledger can
 * never drift apart inside the domain.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.playerId, 'playerId');
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 1, props.at, props.at);
    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvariantViolationError('a positive initial balance requires an OPENING transaction');
    }
    // The opening credit is part of the creation itself: version stays at 1.
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: wallet._balance,
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    wallet._balance = props.initialBalance;
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.isGreaterThanOrEqual(money);
  }

  debit(money: Money, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!this.canDebit(money)) {
      throw new InsufficientBalanceError(`cannot debit ${money} from balance ${this._balance}`);
    }
    return this.apply(LedgerDirection.Debit, money, props);
  }

  credit(money: Money, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, props);
  }

  move(direction: LedgerDirection, money: Money, props: MovementProps): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(money, props) : this.credit(money, props);
  }

  private apply(direction: LedgerDirection, money: Money, props: MovementProps): WalletLedgerEntry {
    if (!money.isPositive()) {
      throw new InvariantViolationError('movement amount must be positive');
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const nextVersion = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: props.at,
    });
    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
