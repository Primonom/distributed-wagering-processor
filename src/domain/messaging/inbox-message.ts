import { InvalidTransactionStateError, assertNonEmpty } from '../shared/errors';

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

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'messageId');
    assertNonEmpty(props.consumerName, 'consumerName');
    assertNonEmpty(props.payloadHash, 'payloadHash');
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InvalidTransactionStateError(`inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
