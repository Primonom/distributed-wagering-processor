/**
 * @file api.ts
 * @author Pablo Reis Rebonato
 * @description Typed HTTP test client and wager payload builder.
 */

import { randomUUID } from 'node:crypto';

/** Parsed JSON response body; tests narrow it with expectations or explicit casts. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface HttpResult<T = JsonObject> {
  status: number;
  body: T;
  headers: Headers;
}

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  async request<T = JsonObject>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON (metrics) */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  async createWallet(amount = '100.00', currency = 'BRL', playerId = `player-${randomUUID()}`) {
    const res = await this.request('POST', '/wallets', { playerId, initialBalance: { amount, currency } });
    if (res.status !== 201) throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { walletId: res.body.id as string, playerId };
  }

  submit(payload: WagerPayload, idempotencyKey: string | null = `${payload.providerId}:${payload.externalTransactionId}`) {
    return this.request('POST', '/wagering/transactions', payload, idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey });
  }
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  overrides: Partial<WagerPayload> = {},
): WagerPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: `${kind.toLowerCase()}-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}
