import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidRequestError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../../../application/errors/application-errors';
import { PORTS, type LoggerPort } from '../../../application/ports';
import { DomainError, InvalidMoneyError, InvalidWagerTransactionError } from '../../../domain';

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  correlationId?: string;
  details?: unknown;
  [key: string]: unknown;
}

/**
 * Single mapping from errors to HTTP, used by every endpoint:
 *   400 invalid payload / missing header | 404 unknown resource | 409 idempotency or
 *   uniqueness conflict | 503 transient infrastructure failure (+ Retry-After) | 500 bug.
 * (422 and 202 are not errors: they are produced by the controller from the outcome.)
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PORTS.Logger) private readonly logger: LoggerPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const correlationId = typeof req.id === 'string' ? req.id : undefined;
    const [status, body] = this.map(exception);
    body.correlationId = correlationId;

    if (status >= 500) {
      this.logger.error({ correlationId, err: exception, path: req.path, status }, 'request failed');
    }
    if (status === 503) res.setHeader('Retry-After', '1');
    res.status(status).json(body);
  }

  private map(e: unknown): [number, ErrorBody] {
    if (e instanceof InvalidRequestError) {
      return [400, { code: e.code, message: e.message, retryable: false, details: e.details }];
    }
    if (e instanceof InvalidMoneyError || e instanceof InvalidWagerTransactionError) {
      return [400, { code: e.code === 'INVALID_MONEY' ? 'INVALID_MONEY' : e.code, message: e.message, retryable: false }];
    }
    if (e instanceof ResourceNotFoundError) {
      return [404, { code: e.code, message: e.message, retryable: false }];
    }
    if (e instanceof IdempotencyKeyConflictError) {
      return [409, { code: e.code, message: e.message, retryable: false, existingTransactionId: e.existingTransactionId }];
    }
    if (e instanceof ExternalTransactionConflictError) {
      return [409, { code: e.code, message: e.message, retryable: false, existingTransactionId: e.existingTransactionId }];
    }
    if (e instanceof WalletAlreadyExistsError) {
      return [409, { code: e.code, message: e.message, retryable: false, existingWalletId: e.existingWalletId }];
    }
    if (e instanceof TransientInfrastructureError) {
      return [503, { code: e.code, message: 'temporarily unavailable, retry with the same Idempotency-Key', retryable: true }];
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 400 || status === 413 || status === 415 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
      return [status, { code, message: e.message, retryable: status >= 500 }];
    }
    if (e instanceof ApplicationError || e instanceof DomainError) {
      return [500, { code: 'INTERNAL_ERROR', message: 'internal error', retryable: false }];
    }
    return [500, { code: 'INTERNAL_ERROR', message: 'internal error', retryable: false }];
  }
}
