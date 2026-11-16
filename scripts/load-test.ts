/**
 * Load test: `bun run test:load`
 *
 * Closed-loop HTTP clients (LOAD_CONCURRENCY workers, each waits for its response before
 * sending the next request) spread round-robin across 3 application instances.
 * Without LOAD_TARGETS it spawns 3 local instances (ports 3101-3103) against the dev DB.
 *
 * Scenarios (LOAD_DURATION_S each):
 *   distributed  — BET/WIN on LOAD_WALLETS random wallets (no contention between requests)
 *   hot-wallet   — every request on ONE wallet (worst case: serialised by the row lock)
 *   retry-storm  — distributed traffic where 30% of requests are retries of earlier ones
 *
 * Output: docs/LOAD_TEST.md (results block between markers) and .load-test/<timestamp>.json
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Subprocess } from 'bun';

const ROOT = join(import.meta.dir, '..');
const DURATION_S = Number.parseInt(process.env.LOAD_DURATION_S ?? '20', 10);
const CONCURRENCY = Number.parseInt(process.env.LOAD_CONCURRENCY ?? '64', 10);
const WALLETS = Number.parseInt(process.env.LOAD_WALLETS ?? '200', 10);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet';

interface Sample { latencyMs: number; status: number; kind: string }
interface ScenarioResult {
  name: string;
  description: string;
  requests: number;
  durationS: number;
  throughput: number;
  p50: number; p95: number; p99: number; max: number;
  statusCounts: Record<string, number>;
  errorRate: number;
  lockConflicts: number;
  retries: number;
  maxOutboxLagS: number;
  outboxDrainS: number;
}

// ------------------------------------------------------------------ instances

const spawned: Subprocess[] = [];

async function ensureTargets(): Promise<string[]> {
  if (process.env.LOAD_TARGETS) return process.env.LOAD_TARGETS.split(',').map((s) => s.trim());
  const ports = [3101, 3102, 3103];
  for (const port of ports) {
    spawned.push(
      Bun.spawn({
        cmd: [process.execPath, 'src/main.ts'],
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), INSTANCE_ID: `load-${port}`, LOG_LEVEL: 'warn', DATABASE_URL, METRICS_GAUGE_INTERVAL_MS: '1000', DB_POOL_MAX: '20' },
        stdout: 'ignore',
        stderr: 'inherit',
      }),
    );
  }
  const urls = ports.map((p) => `http://127.0.0.1:${p}`);
  const deadline = Date.now() + 90_000;
  for (const url of urls) {
    for (;;) {
      try {
        if ((await fetch(`${url}/health/ready`)).ok) break;
      } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error(`${url} not ready`);
      await Bun.sleep(300);
    }
  }
  return urls;
}

async function shutdown() {
  for (const p of spawned) p.kill('SIGTERM');
  await Promise.all(spawned.map((p) => p.exited));
}

// ------------------------------------------------------------------ helpers

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

async function metricSum(targets: string[], name: string): Promise<number> {
  let total = 0;
  for (const t of targets) {
    const text = await (await fetch(`${t}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(`${name}{`) || line.startsWith(`${name} `)) total += Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1)) || 0;
    }
  }
  return total;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

type Op = { payload: Record<string, unknown>; key: string; kind: string };

async function runScenario(name: string, description: string, targets: string[], db: pg.Pool, nextOp: () => Op): Promise<ScenarioResult> {
  const samples: Sample[] = [];
  const lockBefore = await metricSum(targets, 'lock_conflicts_total');
  const retriesBefore = await metricSum(targets, 'retries_total');
  let maxLag = 0;
  const stopAt = Date.now() + DURATION_S * 1000;
  let rr = 0;
  const lagSampler = (async () => {
    while (Date.now() < stopAt) {
      const { rows } = await db.query<{ age: string | null }>(`SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS age FROM outbox_messages WHERE published_at IS NULL`);
      maxLag = Math.max(maxLag, Number.parseFloat(rows[0]?.age ?? '0') || 0);
      await Bun.sleep(500);
    }
  })();
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < stopAt) {
        const op = nextOp();
        const target = targets[rr++ % targets.length];
        const t0 = performance.now();
        let status = 0;
        try {
          status = (await post(`${target}/wagering/transactions`, op.payload, { 'Idempotency-Key': op.key })).status;
        } catch {
          status = 0;
        }
        samples.push({ latencyMs: performance.now() - t0, status, kind: op.kind });
      }
    }),
  );
  const elapsedS = (performance.now() - started) / 1000;
  await lagSampler;
  // time for the outbox to catch up after the load stops
  const drainStart = performance.now();
  for (;;) {
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
    if ((rows[0]?.n ?? 0) === 0 || performance.now() - drainStart > 120_000) break;
    await Bun.sleep(100);
  }
  const outboxDrainS = (performance.now() - drainStart) / 1000;
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const statusCounts: Record<string, number> = {};
  for (const s of samples) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
  return {
    name, description,
    requests: samples.length,
    durationS: Number(elapsedS.toFixed(1)),
    throughput: Number((samples.length / elapsedS).toFixed(1)),
    p50: Number(percentile(latencies, 50).toFixed(1)),
    p95: Number(percentile(latencies, 95).toFixed(1)),
    p99: Number(percentile(latencies, 99).toFixed(1)),
    max: Number((latencies[latencies.length - 1] ?? 0).toFixed(1)),
    statusCounts,
    errorRate: Number(((errors / Math.max(1, samples.length)) * 100).toFixed(3)),
    lockConflicts: (await metricSum(targets, 'lock_conflicts_total')) - lockBefore,
    retries: (await metricSum(targets, 'retries_total')) - retriesBefore,
    maxOutboxLagS: Number(maxLag.toFixed(2)),
    outboxDrainS: Number(outboxDrainS.toFixed(2)),
  };
}

// ------------------------------------------------------------------ main

const targets = await ensureTargets();
const db = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
try {
  console.log(`targets: ${targets.join(', ')} | duration ${DURATION_S}s | concurrency ${CONCURRENCY} | wallets ${WALLETS}`);
  const runId = randomUUID().slice(0, 8);
  const wallets: Array<{ walletId: string; playerId: string }> = [];
  for (let i = 0; i < WALLETS; i++) {
    const playerId = `load-${runId}-${i}`;
    const res = await post(`${targets[i % targets.length]}/wallets`, { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } });
    wallets.push({ walletId: res.json.id, playerId });
  }
  const hotPlayer = `load-${runId}-hot`;
  const hot = { walletId: (await post(`${targets[0]}/wallets`, { playerId: hotPlayer, initialBalance: { amount: '1000000.00', currency: 'BRL' } })).json.id as string, playerId: hotPlayer };

  const makeOp = (w: { walletId: string; playerId: string }): Op => {
    const kind = Math.random() < 0.8 ? 'BET' : 'WIN';
    const ext = `${kind.toLowerCase()}-${randomUUID()}`;
    return {
      kind,
      key: `load:${ext}`,
      payload: { providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId, roundId: `r-${ext.slice(-6)}`, gameId: 'load-game', kind, money: { amount: '1.00', currency: 'BRL' } },
    };
  };
  const random = () => wallets[Math.floor(Math.random() * wallets.length)] as { walletId: string; playerId: string };
  const history: Op[] = [];

  const results: ScenarioResult[] = [];
  results.push(await runScenario('distributed', `${WALLETS} wallets, 80% BET / 20% WIN of 1.00, unique operations`, targets, db, () => makeOp(random())));
  results.push(await runScenario('hot-wallet', 'every request on the same wallet (row-lock serialised)', targets, db, () => makeOp(hot)));
  results.push(
    await runScenario('retry-storm', 'distributed, 30% of requests are retries of already-sent operations (idempotent replays)', targets, db, () => {
      if (history.length > 100 && Math.random() < 0.3) return { ...(history[Math.floor(Math.random() * history.length)] as Op), kind: 'REPLAY' };
      const op = makeOp(random());
      if (history.length < 5000) history.push(op);
      return op;
    }),
  );

  // consistency proof for every wallet touched
  const ids = [...wallets.map((w) => w.walletId), hot.walletId];
  const { rows: inconsistent } = await db.query(
    `SELECT w.id FROM wallets w
      WHERE w.id = ANY($1::uuid[])
        AND w.balance <> COALESCE((SELECT SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)`,
    [ids],
  );
  const { rows: env } = await db.query<{ v: string; mc: string; sb: string }>(`SELECT version() AS v, current_setting('max_connections') AS mc, current_setting('shared_buffers') AS sb`);

  console.table(results.map(({ statusCounts, description, ...r }) => ({ ...r, statuses: JSON.stringify(statusCounts) })));
  console.log(`inconsistent wallets after load: ${inconsistent.length}`);

  const report = {
    date: new Date().toISOString(),
    environment: {
      os: `${platform()} ${release()}`,
      cpus: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
      memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
      bun: Bun.version,
      postgres: env[0]?.v.split(' on ')[0],
      postgresSettings: { max_connections: env[0]?.mc, shared_buffers: env[0]?.sb },
      targets,
      spawnedLocally: spawned.length > 0,
    },
    parameters: { durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS },
    results,
    inconsistentWallets: inconsistent.length,
  };
  mkdirSync(join(ROOT, '.load-test'), { recursive: true });
  writeFileSync(join(ROOT, '.load-test', `${report.date.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  writeReport(report);
} finally {
  await db.end();
  await shutdown();
}

function writeReport(report: { date: string; environment: Record<string, unknown>; parameters: Record<string, number>; results: ScenarioResult[]; inconsistentWallets: number }) {
  const env = report.environment as Record<string, unknown>;
  const block = [
    '<!-- results:start (generated by `bun run test:load`) -->',
    `**Run:** ${report.date} · duration ${report.parameters.durationS}s per scenario · ${report.parameters.concurrency} concurrent closed-loop clients · ${report.parameters.wallets} wallets`,
    '',
    `**Environment:** ${env.os} · ${env.cpus} · ${env.memoryGiB} GiB RAM · Bun ${env.bun} · ${env.postgres} (max_connections=${(env.postgresSettings as Record<string, string>).max_connections}, shared_buffers=${(env.postgresSettings as Record<string, string>).shared_buffers}) · targets: ${(env.targets as string[]).join(', ')}${env.spawnedLocally ? ' (spawned by the script, same host)' : ''}`,
    '',
    '| Scenario | Requests | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Error rate (5xx/network) | Status codes | Lock conflicts | Retries | Max outbox lag (s) | Outbox drain after load (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.results.map((r) => `| **${r.name}** — ${r.description} | ${r.requests} | ${r.throughput} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errorRate}% | ${Object.entries(r.statusCounts).map(([k, v]) => `${k}: ${v}`).join(', ')} | ${r.lockConflicts} | ${r.retries} | ${r.maxOutboxLagS} | ${r.outboxDrainS} |`),
    '',
    `**Consistency after load:** ${report.inconsistentWallets} wallet(s) with \`balance ≠ Σ ledger\` (expected 0).`,
    '<!-- results:end -->',
  ].join('\n');
  const path = join(ROOT, 'docs', 'LOAD_TEST.md');
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    const replaced = current.replace(/<!-- results:start[\s\S]*?<!-- results:end -->/, block);
    writeFileSync(path, replaced.includes('results:start') ? replaced : `${current}\n\n${block}\n`);
  } else {
    writeFileSync(path, `# Load test\n\n${block}\n`);
  }
  console.log(`report written to ${path}`);
}
