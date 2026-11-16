# PROGRESS

> Working log. If context is lost: re-read this file, `docs/CHALLENGE.md` and `ARCHITECTURE.md`.

<!-- FINAL-SUMMARY -->

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
