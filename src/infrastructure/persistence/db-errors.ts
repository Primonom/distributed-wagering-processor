import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
  UniqueConstraintError,
} from '../../application/errors/application-errors';

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
  name?: string;
  cause?: unknown;
}

const TRANSIENT_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '57014', // query_canceled (statement_timeout)
  '08000', '08003', '08006', '08001', '08004',
]);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** Maps driver/ORM errors to application errors that drive retry and HTTP decisions. */
export function translateDbError(error: unknown): unknown {
  if (
    error instanceof ConcurrencyConflictError ||
    error instanceof TransientInfrastructureError ||
    error instanceof UniqueConstraintError
  ) {
    return error;
  }
  const e = (error ?? {}) as PgLikeError;
  const code = e.code;
  switch (code) {
    case '40P01':
      return new ConcurrencyConflictError('deadlock', e.message ?? 'deadlock detected');
    case '40001':
      return new ConcurrencyConflictError('serialization', e.message ?? 'serialization failure');
    case '55P03':
      return new ConcurrencyConflictError('lock_timeout', e.message ?? 'lock timeout');
    case '23505':
      return new UniqueConstraintError(e.constraint, e.message ?? 'unique violation');
  }
  if ((code && (TRANSIENT_CODES.has(code) || TRANSIENT_NODE_CODES.has(code))) || isConnectionFailure(e)) {
    return new TransientInfrastructureError(`database unavailable: ${e.message ?? code}`, error);
  }
  return error;
}

function isConnectionFailure(e: PgLikeError): boolean {
  const msg = e.message ?? '';
  return (
    e.name === 'ConnectionException' ||
    /Timeout acquiring a connection|Connection terminated|connect ECONNREFUSED|Client has encountered a connection error|terminating connection/i.test(msg)
  );
}
