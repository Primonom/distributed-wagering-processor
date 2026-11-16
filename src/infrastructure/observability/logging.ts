import pino, { type Logger } from 'pino';
import type { LoggerPort } from '../../application/ports';

/**
 * JSON logs (pino). Financial payloads are never logged: amounts and balances are
 * redacted defensively even if a caller passes them by mistake.
 */
export function createRootLogger(level: string, instanceId: string): Logger {
  return pino({
    level,
    base: { service: 'wagering', instance: instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    redact: {
      paths: [
        'money', '*.money', 'amount', '*.amount', 'balance', '*.balance', 'initialBalance', '*.initialBalance',
        'req.headers.authorization', 'req.body', 'res.body', 'payload', '*.payload',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export class PinoLoggerAdapter implements LoggerPort {
  constructor(private readonly logger: Logger) {}

  child(component: string): PinoLoggerAdapter {
    return new PinoLoggerAdapter(this.logger.child({ component }));
  }
  info(obj: Record<string, unknown>, msg: string): void {
    this.logger.info(obj, msg);
  }
  warn(obj: Record<string, unknown>, msg: string): void {
    this.logger.warn(obj, msg);
  }
  error(obj: Record<string, unknown>, msg: string): void {
    this.logger.error(obj, msg);
  }
  debug(obj: Record<string, unknown>, msg: string): void {
    this.logger.debug(obj, msg);
  }
}
