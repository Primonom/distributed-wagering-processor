import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PORTS, type ProviderIdentity, type ProviderIdentityPort } from '../../../application/ports';

export type RequestWithIdentity = Request & { id?: string; providerIdentity?: ProviderIdentity };

/**
 * Authentication extension point (see ARCHITECTURE.md → Authentication).
 * With the default NoopProviderIdentity it is an explicit no-op: every request passes
 * and no identity is attached. With an OIDC adapter it would reject requests without a
 * valid token (401) and controllers already reject payloads whose providerId differs
 * from the authenticated one (403).
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PORTS.ProviderIdentity) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithIdentity>();
    const identity = await this.identity.resolve({ authorization: req.headers.authorization });
    if (identity) req.providerIdentity = identity;
    return true;
  }
}
