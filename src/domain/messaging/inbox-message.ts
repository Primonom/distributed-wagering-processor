/**
 * @file inbox-message.ts
 * @author Pablo Reis Rebonato
 * @description Inbox record that de-duplicates consumed queue messages per consumer.
 */

import { assertNonEmpty, InvalidTransactionStateError } from '../shared/errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Persistent de-duplication record for messages consumed from a queue. The primary key
 * (consumer_name, message_id) makes "processed twice" impossible at the database level.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  /** New, unprocessed inbox record for a message just received. */
  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'messageId');
    assertNonEmpty(props.consumerName, 'consumerName');
    assertNonEmpty(props.payloadHash, 'payloadHash');
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  /** Reconstruction from persistence without validation. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /**
   * Marks the message as handled in the same transaction as its business effect.
   * @throws InvalidTransactionStateError when it was already processed.
   */
  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InvalidTransactionStateError(`inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
