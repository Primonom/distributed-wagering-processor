/**
 * @file cluster.ts
 * @author Pablo Reis Rebonato
 * @description Spawns and controls real application processes for multi-instance tests.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { ensureMigrated, TEST_DATABASE_URL } from './db';

/**
 * Real multi-process cluster for concurrency tests: every instance is a separate
 * `bun src/main.ts` OS process with its own connection pool, workers and SQS consumer,
 * all sharing the same PostgreSQL database and LocalStack queues.
 */
export interface Instance {
  name: string;
  port: number;
  baseUrl: string;
  proc: Subprocess;
  env: Record<string, string>;
  logFile: string;
}

const ROOT = join(import.meta.dir, '..', '..');
const LOG_DIR = join(tmpdir(), 'wagering-test-logs');
mkdirSync(LOG_DIR, { recursive: true });

/** Asks the OS for a free port (fixed ranges collide with ephemeral client ports). */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error('could not allocate a port');
  return port;
}

export const FAST_ENV: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL,
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'warn',
  DB_POOL_MAX: '20',
  CONSUMER_ENABLED: 'false',
  OUTBOX_ENABLED: 'false',
  PENDING_WORKER_ENABLED: 'false',
  SQS_WAIT_TIME_S: '1',
  SQS_VISIBILITY_TIMEOUT_S: '3',
  SQS_RETRY_BASE_S: '1',
  SQS_RETRY_MAX_S: '2',
  OUTBOX_POLL_MS: '50',
  PENDING_POLL_MS: '50',
  PENDING_RETRY_BASE_MS: '50',
  PENDING_RETRY_MAX_MS: '200',
  PENDING_MAX_ATTEMPTS: '50',
  PENDING_LEASE_MS: '3000',
  SHUTDOWN_TIMEOUT_MS: '5000',
};

export function queueEnv(tag = randomUUID().slice(0, 8)): { SQS_WAGER_QUEUE: string; SQS_WAGER_DLQ: string; SQS_EVENTS_QUEUE: string } {
  return {
    SQS_WAGER_QUEUE: `c-${tag}-wager.fifo`,
    SQS_WAGER_DLQ: `c-${tag}-wager-dlq.fifo`,
    SQS_EVENTS_QUEUE: `c-${tag}-events.fifo`,
  };
}

export async function spawnInstance(name: string, env: Record<string, string>, opts: { waitReady?: boolean } = {}): Promise<Instance> {
  await ensureMigrated();
  for (let attempt = 1; ; attempt++) {
    try {
      return await spawnOnce(name, env, opts);
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('EADDRINUSE')) throw error;
    }
  }
}

async function spawnOnce(name: string, env: Record<string, string>, opts: { waitReady?: boolean }): Promise<Instance> {
  const port = freePort();
  const logFile = join(LOG_DIR, `${name}-${port}.log`);
  const fullEnv = { ...process.env, ...FAST_ENV, ...env, PORT: String(port), INSTANCE_ID: `${name}-${port}` } as Record<string, string>;
  const proc = Bun.spawn({
    cmd: [process.execPath, 'src/main.ts'],
    cwd: ROOT,
    env: fullEnv,
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
  const instance: Instance = { name, port, baseUrl: `http://127.0.0.1:${port}`, proc, env: fullEnv, logFile };
  if (opts.waitReady ?? true) await waitReady(instance);
  return instance;
}

export async function waitReady(instance: Instance, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.proc.exitCode !== null) {
      const stderr = await Bun.file(`${instance.logFile}.err`)
        .text()
        .catch(() => '');
      throw new Error(
        `${instance.name} exited early with ${instance.proc.exitCode}${stderr.includes('EADDRINUSE') ? ' (EADDRINUSE)' : ''}; see ${instance.logFile}.err`,
      );
    }
    try {
      const res = await fetch(`${instance.baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(200);
  }
  throw new Error(`${instance.name} not ready after ${timeoutMs}ms`);
}

export async function spawnCluster(size: number, env: Record<string, string>, prefix = 'node'): Promise<Instance[]> {
  return Promise.all(Array.from({ length: size }, (_, i) => spawnInstance(`${prefix}${i + 1}`, env)));
}

/** SIGKILL: no shutdown hooks, connections dropped — simulates a crash. */
export async function crash(instance: Instance): Promise<void> {
  instance.proc.kill('SIGKILL');
  await instance.proc.exited;
}

/** SIGTERM: graceful shutdown path. Returns the exit code. */
export async function terminate(instance: Instance): Promise<number> {
  instance.proc.kill('SIGTERM');
  return instance.proc.exited;
}

export async function stopAll(instances: Instance[]): Promise<void> {
  await Promise.all(
    instances.map(async (i) => {
      if (i.proc.exitCode === null && !i.proc.killed) {
        i.proc.kill('SIGTERM');
        const timer = setTimeout(() => i.proc.kill('SIGKILL'), 10_000);
        await i.proc.exited;
        clearTimeout(timer);
      }
    }),
  );
}
