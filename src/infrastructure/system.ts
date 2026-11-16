/**
 * @file system.ts
 * @author Pablo Reis Rebonato
 * @description System adapters: wall clock, UUID v7 generator and the no-op provider identity.
 */

import { v7 as uuidv7 } from 'uuid';
import type { Clock, IdGenerator, ProviderIdentity, ProviderIdentityPort } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}

/**
 * Explicit no-op identity adapter: authentication is out of scope (see ARCHITECTURE.md,
 * "Authentication"). Returning `undefined` means "identity not established" and the
 * guard lets the request through. An OIDC adapter would verify the bearer token
 * (client-credentials, one client per provider) and return the providerId claim.
 */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}
