/**
 * @file polling-worker.ts
 * @author Pablo Reis Rebonato
 * @description Polling loop for background tasks with idle backoff and graceful stop.
 */

import type { LoggerPort } from '../../application/ports';

/**
 * Minimal scheduler for background loops (outbox relay, pending-reference worker,
 * gauges). When a run did work it polls again immediately; when idle it sleeps
 * `intervalMs`. stop() waits for the current run to finish (graceful shutdown).
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    /** Resolves to the number of items handled; any other value counts as idle. */
    private readonly task: () => Promise<unknown>,
    private readonly logger: LoggerPort,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let didWork = false;
      try {
        const n = await this.task();
        didWork = typeof n === 'number' && n > 0;
        failures = 0;
      } catch (error) {
        failures++;
        this.logger.warn({ worker: this.name, err: error, consecutiveFailures: failures }, 'background worker iteration failed');
      }
      if (!this.running) break;
      if (!didWork) {
        const delay = failures > 0 ? Math.min(this.intervalMs * 2 ** Math.min(failures, 6), 30_000) : this.intervalMs;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }
}
