# PROGRESS

> Working log. If context is lost: re-read this file, `docs/CHALLENGE.md` and `ARCHITECTURE.md`.

## Final state (2026-11-16)

**Status: all phases done and verified.** From a clean state (`docker compose --profile app down -v`): `bun install` → `typecheck` (0 errors) → `infra:up` → `migration:up` / `migration:down` / `migration:up` → **81 unit, 77 integration, 13 concurrency tests green**. The concurrency suite (3 real OS processes, SIGKILL/SIGTERM, restart) also passed **3 times in a row** before that. Docker cluster (`--scale app=3`) smoke-tested with curl (BET, WIN, replay, 409, ROLLBACK, reconciliation `consistent: true`, `/health/ready`, `/metrics`) and an SQS message processed by the containerised consumers. Load test: `docs/LOAD_TEST.md`.

### How to validate (≈ 5 min + 3 min concurrency)
```bash
bun install
bun run typecheck
bun run infra:up
bun run migration:up && bun run migration:down && bun run migration:up
bun run test:unit
bun run test:integration
bun run test:concurrency          # ~2.5 min: spawns real app processes
bun run cluster:up                # 3 replicas on :3001-3003 (README has curl / PowerShell examples)
bun scripts/send-sqs-message.ts <walletId> <playerId> BET 10.00
bun run test:load                 # optional, ~2 min, rewrites the results block of docs/LOAD_TEST.md
```

### Honest limitations / open points
- Verified on **WSL2 (Ubuntu) + Docker Engine**, not on native Windows PowerShell. The scripts are cross-platform (no bash in `package.json`; helpers are TS run by Bun). On native Windows the graceful-SIGTERM concurrency test is skipped, because POSIX signals don't exist there (`proc.kill('SIGTERM')` is a hard kill).
- Outbox relay throughput is the bottleneck under sustained load: ~15 s max lag at ~850 events/s on a laptop, with no loss (see `docs/LOAD_TEST.md`, improvements listed there).
- A single hot wallet tops out at ~100 ops/s in this environment (row-lock serialisation, by design).
- No real authentication (explicit no-op `ProviderIdentityPort` + guard; Keycloak design in ARCHITECTURE §16).
- No retention job for `outbox_messages` / `inbox_messages`.
- `WALLET_NOT_FOUND` rejections are not persisted (FK); FAILED transactions are terminal and block their idempotency key.
- Startup of each app process takes ~8-10 s when the code is served from `/mnt/c` (WSL 9p filesystem); much faster on a native FS / inside the Docker image.

### Safety greps (last run)
- `parseFloat|Number(|parseInt` in `src/`: only config/timeouts (`DB_STATEMENT_TIMEOUT_MS`), the ledger page `limit` and the SQS `ApproximateReceiveCount`, no monetary value. No `amount|balance|money…: number` declarations.
- SQS sends in `src/`: `SendMessageBatchCommand` only in `SqsEventPublisher` (used only by `PublishOutbox`); `SendMessageCommand` only in the consumer's DLQ move (transport of the received message, not an event; documented).
- No UPDATE/DELETE of `wallet_ledger_entries` anywhere in `src/` (only the triggers that block them).


## Phases
- [x] 1. Scaffold (Bun 1.4.4, NestJS 11, MikroORM 6, docker compose postgres + localstack 3.8 + app)
- [x] 2. Domain + unit tests
- [x] 3. Persistence (MikroORM EntitySchema, 3 reversible migrations, DB-enforced invariants, repositories, UoW)
- [x] 4. Use cases + HTTP
- [x] 5. Outbox publisher + PENDING_REFERENCE worker
- [x] 6. SQS consumer (inbox, retry, DLQ, FAILED audit, graceful shutdown)
- [x] 7. Observability (pino JSON logs w/ correlationId, prom-client /metrics, /health/live + /health/ready)
- [x] 8. Concurrency & failure tests (multi-process)
- [x] 9. Documentation (README, ARCHITECTURE)
- [x] 10. Load test (docs/LOAD_TEST.md)

## Decisions log (details in ARCHITECTURE.md)
- Environment: WSL2 Ubuntu + native docker; bun installed from the official zip (no unzip available).
- LocalStack pinned to 3.8 (newer images require an auth token).
- Money input accepts 0–2 decimal places and normalises to scale 2 ("25" == "25.00", same hash).
- LOSS may carry amount 0.00; every other kind requires amount > 0.
- WIN/LOSS may optionally reference the BET of the same round; a missing reference parks them in PENDING_REFERENCE too.
- A transaction may be reversed at most once in total (REFUND *or* ROLLBACK), enforced by a partial unique index.
- All events use walletId as aggregateId (MessageGroupId on the events FIFO queue).
- Ledger entries carry `wallet_version` (UNIQUE per wallet) → gap-free chain checked by DB triggers; deferred constraint triggers check wallet ⇄ ledger at COMMIT.
- WALLET_NOT_FOUND is answered (422, transactionId null) but not persisted (FK); inbox still recorded for SQS.
- FAILED (INFRASTRUCTURE_PERMANENT_FAILURE) is written best-effort when an SQS message exhausts its receives because of transient failures; it is terminal.
- SQS consumer lives in `interfaces/messaging` (driving adapter); SQS client/publisher in `infrastructure`.
- Nest `enableShutdownHooks` re-raises SIGTERM after the graceful drain → exit code 143 (documented, tested via logs).
- Publisher supports a standard (non-FIFO) events queue so the crash test can observe duplicates the FIFO dedup would hide.

## Requirement → implementation → proof

| # | Requirement (docs/CHALLENGE.md) | Where | Test that proves it |
|---|---|---|---|
| 5.1 | no `number`/float for money | `src/domain/shared/money.ts` (decimal.js, string I/O), `NUMERIC(20,2)` + `decimal` (string) mapping in `infrastructure/persistence` | `test/unit/money.test.ts`; HTTP rejects numeric amounts (`http-wagering` "invalid initial balance", "numeric amounts"); grep audit below |
| 5.2 | idempotency not in memory | `wager_tx_idempotency_key_uq`, lookup in `SubmitWagerTransaction`, inbox table | `http-wagering` replay/409 tests; `concurrency/http-races` 50× across 3 processes; `crash-recovery` restart replays |
| 5.3 | do not rely on SQS FIFO | wallet `FOR UPDATE` + version + DB constraints; inbox | `crash-recovery` (same op 50× with broker dedup bypassed), `sqs-consumer` redelivery |
| 5.4 | no publication before commit | outbox rows in the same UoW; only `PublishOutbox` publishes | `atomicity.test.ts` (rollback ⇒ no outbox row), `crash-recovery` outbox scenarios |
| 5.5 | ledger never updated/deleted | triggers `ledger_no_update/delete/truncate`; `WalletLedgerEntry` frozen, no setters | `schema-constraints` "UPDATE, DELETE and TRUNCATE are blocked"; `wallet.test.ts` immutability |
| 5.6 | no global lock | row lock on `wallets` only | `http-races` "40 wallets × 10 ops" (parallel wallets) |
| 5.7 | no unguarded read→calc→update | `FOR UPDATE` + `UPDATE … WHERE version = $old` | `http-races` hot wallet (90 BETs → exactly 50), mandatory scenario ×20; `atomicity` stale version |
| 5.8 | correct with multiple instances | stateless instances, DB coordination (`SKIP LOCKED`, leases) | `test/concurrency/*` (3 OS processes) |
| 5.9 | uniqueness / immutability / non-negativity in the schema | migrations 1–3 (UNIQUE, CHECK, partial unique, FKs, triggers, deferred constraint triggers) | `schema-constraints.test.ts` (one test per constraint, raw SQL) |
| 6.0 | private ctor + factories; `rehydrate` w/o validation | all domain classes | unit tests use `rehydrate` with states that `create` would refuse |
| 6.1 | Money rules (scale 2, invalid inputs, currency conflict, immutable) | `Money` | `money.test.ts` |
| 6.2 | Wallet invariants (unique per player+currency, ≥0, ledger per change, version from 1, +1 only on balance change) | `Wallet`, `wallets_player_currency_uq`, `wallets_guard`, `wallets_balance_matches_ledger` | `wallet.test.ts`, `schema-constraints` wallets block, `http-wagering` LOSS keeps version |
| 6.3 | WagerTransaction state machine, terminal states, OPENING internal, key+different payload = conflict | `WagerTransaction`, `wager_tx_guard` | `wager-rules.test.ts` state machine; `schema-constraints` terminal frozen; `http-wagering` 409 / OPENING 400 |
| 6.4 | immutable ledger entry, arithmetic validated, ≤1 entry per wallet per tx, none for LOSS/REJECTED | `WalletLedgerEntry`, `ledger_arithmetic`, `ledger_one_entry_per_transaction_wallet`, `ledger_matches_transaction` | `wallet.test.ts`, `schema-constraints` ledger block, `http-wagering` LOSS/REJECTED ledger counts |
| 6.5 | inbox/outbox classes; same SQL transaction | `InboxMessage`, `OutboxMessage`, `SubmitWagerTransaction` | `messaging-and-events.test.ts`, `atomicity.test.ts` |
| 7 | BET/WIN/LOSS/REFUND/ROLLBACK table + rules 1–9 | `WagerProcessor`, `WagerSettlement` | `wager-rules.test.ts`, `http-wagering` rules block |
| 7.1 | out-of-order: PENDING_REFERENCE, backoff worker, limit → REJECTED + event | `ProcessPendingReferences`, lease claim, `retryOrGiveUp` | `outbox-and-pending` (resolve + REFERENCE_NOT_FOUND + event), `http-races` REFUND/BET simultaneous, `sqs-consumer` REFUND before BET |
| 7.2 | stable failure codes | `FailureCode` + `FAILURE_CODE_ACTION` | all rejection tests assert the code |
| 8 | mandatory 100/80/80 scenario | — | `http-races` "mandatory scenario ×20" (two instances) + unit version |
| 9 | API endpoints, idempotency header, status distinction, reconciliation, health | `interfaces/http` | `http-wagering.test.ts` |
| 10 | SQS consumer: same use case, inbox, ack after commit, business/transient/permanent, attempt limit, SIGTERM, redelivery | `interfaces/messaging/wager-queue-consumer.ts`, `Lifecycle` | `sqs-consumer.test.ts` (inbox, DLQ, retries → FAILED + DLQ, graceful shutdown), `crash-recovery` (kill after commit, SIGTERM) |
| 11 | atomic outbox, concurrent publishers, crash before publish, duplicate-safe, 4 events, abstract envelope | `PublishOutbox`, `SqsEventPublisher`, `IntegrationEvent` + 4 subclasses | `outbox-and-pending` (publish, SQS down, 2 publishers), `crash-recovery` (crash before publish, crash after publish ⇒ duplicate deduped by eventId, 2 publisher processes) |
| 12 | JSON logs w/ ids, no financial payloads, metrics, health | `observability/*`, `nestjs-pino` config, `redact` | `http-wagering` "ops endpoints" (metrics names, correlation id), reconciliation metric |
| 13 unit | Money, Wallet, rules, currency conflict, payload divergence | `test/unit/*` | 81 tests |
| 13 integration | migrations, constraints, atomicity, inbox/redelivery, concurrent publishers, retry/DLQ, restart | `test/integration/*` | 77 tests |
| 13 concurrency 1–8 | 50× same bet; same-wallet race; parallel wallets; ≥3 processes; kill after commit before ack; 2 publishers; reversal before reference; restart consistency | `test/concurrency/*` | 13 tests; each ends with `assertWalletConsistent` |
| Elim. | number for money / negative balance / duplicate debit-credit / memory idempotency / single instance only / publish before commit / no auditable ledger / mocked PG+SQS | see rows above | no mocks: every integration/concurrency test uses real PostgreSQL + LocalStack |
