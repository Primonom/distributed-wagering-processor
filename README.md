# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores via **HTTP** e **AWS SQS**. Ele se mantém correto com mensagens duplicadas, fora de ordem e simultâneas, e com várias instâncias rodando ao mesmo tempo.

- Stack: **Bun 1.x · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 16 · SQS (LocalStack) · Docker Compose**
- Enunciado original: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Teste de carga: [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md)
- Estado do trabalho e matriz requisito → teste: [`PROGRESS.md`](PROGRESS.md)

## Pré-requisitos

- **Docker Desktop** (ou Docker Engine + Compose v2)
- **Bun 1.x**: Windows `powershell -c "irm bun.sh/install.ps1 | iex"`; Linux/macOS `curl -fsSL https://bun.sh/install | bash`
- Portas livres: `5432` (Postgres), `4566` (LocalStack), `3000` (app local) e `3001-3003` (cluster). Todas são configuráveis por env (`POSTGRES_HOST_PORT`, `LOCALSTACK_HOST_PORT`, `APP_HOST_PORTS`, `PORT`).

Todos os scripts são cross-platform: não há bash nos `scripts` do `package.json`, e os utilitários são TypeScript executados pelo Bun.

## Setup rápido

```bash
bun install
bun run infra:up          # postgres + localstack (filas criadas pelo init hook), espera ficarem healthy
bun run migration:up      # aplica as migrations no banco "wallet"
bun run dev               # app em http://localhost:3000 (watch); ou: bun run start
```

O Postgres cria também o banco `wallet_test`, usado pelas suítes automatizadas (os testes aplicam as migrations nele sozinhos).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run infra:up` / `bun run infra:down` | sobe/derruba Postgres + LocalStack (`down` remove volumes) |
| `bun run migration:up` | aplica migrations pendentes |
| `bun run migration:down` | reverte **a última** migration (`bun scripts/migrate.ts down --all` reverte todas) |
| `bun run migration:status` | lista executadas/pendentes |
| `bun run dev` / `bun run start` | app local (porta `PORT`, default 3000) |
| `bun run cluster:up` | build da imagem + migrations + **3 instâncias** (`docker compose --scale app=3`) em `localhost:3001-3003` |
| `bun run cluster:down` | derruba o cluster |
| `bun run typecheck` | `tsc --noEmit` (strict + `noUncheckedIndexedAccess`) |
| `bun run test:unit` | domínio, sem infraestrutura |
| `bun run test:integration` | Postgres + LocalStack reais (precisa de `infra:up`) |
| `bun run test:concurrency` | 3+ processos reais da app, crashes, restart (precisa de `infra:up`) |
| `bun run test` | unit → integration → concurrency em sequência (use os scripts; `bun test` puro usaria o timeout default de 5 s) |
| `bun run test:load` | teste de carga contra 3 instâncias (ver abaixo) |

### Rodando 3 instâncias

Com Docker (imagem `oven/bun`):

```bash
bun run infra:up
bun run cluster:up                       # app em :3001, :3002, :3003 (todas com HTTP, consumer SQS, relay da outbox e worker)
docker compose --profile app logs -f app # logs JSON
```

Sem Docker para a app (3 processos locais):

```bash
# bash
PORT=3001 bun run start & PORT=3002 bun run start & PORT=3003 bun run start &
```

```powershell
# PowerShell
1..3 | ForEach-Object { Start-Process bun -ArgumentList "run","start" -Environment @{ PORT = "300$_" } }
# (Windows PowerShell 5: $env:PORT="3001"; Start-Process bun "run start"  — repita por porta)
```

### Teste de carga

```bash
bun run infra:up && bun run migration:up
bun run test:load                        # sobe 3 instâncias locais em :3101-3103 e roda os cenários
LOAD_TARGETS=http://localhost:3001,http://localhost:3002,http://localhost:3003 bun run test:load   # contra o cluster docker
```

Parâmetros: `LOAD_DURATION_S` (default 20), `LOAD_CONCURRENCY` (default 64), `LOAD_WALLETS` (default 200). O resultado fica em `docs/LOAD_TEST.md` (gerado) e o JSON bruto em `.load-test/`.

## API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/wallets` | cria wallet (saldo inicial > 0 gera OPENING + CREDIT na mesma transação) |
| GET | `/wallets/:walletId` | saldo e versão |
| GET | `/wallets/:walletId/ledger?cursor=&limit=` | ledger paginado por cursor opaco (`limit` ≤ 100, default 50) |
| POST | `/wallets/:walletId/reconciliation` | recalcula o saldo pelo ledger e compara (não corrige) |
| POST | `/wagering/transactions` | submete operação (header `Idempotency-Key` obrigatório) |
| GET | `/wagering/transactions/:transactionId` | consulta por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| GET | `/health/live`, `/health/ready` | liveness / readiness (Postgres + SQS) |
| GET | `/metrics` | Prometheus |

Status: **200** processada (e replay), **201** wallet criada, **202** `PENDING_REFERENCE`, **400** payload inválido/header ausente, **404** inexistente, **409** conflito de idempotência / wallet duplicada, **422** rejeição de negócio (`failureCode`), **503** falha transitória (`Retry-After`). Detalhes e taxonomia de `failureCode` em [`ARCHITECTURE.md`](ARCHITECTURE.md#10-taxonomia-de-failurecode).

### Exemplos (bash)

```bash
API=http://localhost:3000
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

# criar wallet
curl -s -X POST $API/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
WALLET=<id retornado>

# BET
curl -s -X POST $API/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# repetir o mesmo comando → 200 com "idempotentReplay": true; trocar o amount mantendo a key → 409

# WIN referenciando a BET
curl -s -X POST $API/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-124' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-124\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"WIN\",\"referenceExternalTransactionId\":\"transaction-123\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}"

# ROLLBACK da BET (crédito de 25.00)
curl -s -X POST $API/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-125' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-125\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"ROLLBACK\",\"referenceExternalTransactionId\":\"transaction-123\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

curl -s $API/wallets/$WALLET
curl -s "$API/wallets/$WALLET/ledger?limit=2"            # use nextCursor na próxima página
curl -s -X POST $API/wallets/$WALLET/reconciliation
curl -s $API/providers/provider-a/wagering/transactions/transaction-123
curl -s $API/health/ready
curl -s $API/metrics | grep wager_transactions_total
```

### Exemplos (PowerShell)

```powershell
$API = "http://localhost:3000"
$player = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1"

$wallet = Invoke-RestMethod -Method Post "$API/wallets" -ContentType "application/json" `
  -Body (@{ playerId = $player; initialBalance = @{ amount = "1000.00"; currency = "BRL" } } | ConvertTo-Json)

$bet = @{ providerId = "provider-a"; externalTransactionId = "transaction-123"; playerId = $player; walletId = $wallet.id
          roundId = "round-987"; gameId = "fortune-chimp"; kind = "BET"; money = @{ amount = "25.00"; currency = "BRL" } } | ConvertTo-Json
Invoke-RestMethod -Method Post "$API/wagering/transactions" -ContentType "application/json" `
  -Headers @{ "Idempotency-Key" = "provider-a:transaction-123" } -Body $bet

# respostas 4xx/5xx: use Invoke-WebRequest -SkipHttpErrorCheck (PowerShell 7) para ver status e corpo
Invoke-WebRequest -Method Post "$API/wagering/transactions" -ContentType "application/json" -SkipHttpErrorCheck `
  -Headers @{ "Idempotency-Key" = "provider-a:transaction-123" } -Body ($bet -replace '25.00','26.00') | Select-Object StatusCode, Content

Invoke-RestMethod "$API/wallets/$($wallet.id)"
Invoke-RestMethod -Method Post "$API/wallets/$($wallet.id)/reconciliation"
Invoke-RestMethod "$API/health/ready"
```

### Enviando uma mensagem pela fila

```bash
bun scripts/send-sqs-message.ts <walletId> <playerId> BET 10.00      # imprime o messageId
# equivalente com awslocal (dentro do container):
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"tx-sqs-1","idempotencyKey":"provider-a:tx-sqs-1","playerId":"<playerId>","walletId":"<walletId>","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Eventos publicados pela outbox vão para `wallet-events.fifo`; para lê-los: `bun scripts/read-events.ts`.

## Variáveis de ambiente

Veja [`.env.example`](.env.example) (o Bun carrega `.env` automaticamente). As principais:

| Variável | Default | |
|---|---|---|
| `PORT` | 3000 | porta HTTP |
| `DATABASE_URL` | `postgres://wallet:wallet@localhost:5432/wallet` | |
| `DB_POOL_MAX` | 20 | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | 2000 | `SET LOCAL lock_timeout` por transação |
| `TX_MAX_RETRIES` | 5 | retries por conflito de lock/deadlock/versão |
| `SQS_ENDPOINT` / `AWS_REGION` | `http://localhost:4566` / `us-east-1` | |
| `SQS_WAGER_QUEUE` / `SQS_WAGER_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wallet-events.fifo` | |
| `SQS_BOOTSTRAP` | true | cria as filas (idempotente) no startup |
| `SQS_MAX_RECEIVE_COUNT` | 5 | tentativas antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_S` / `SQS_WAIT_TIME_S` | 30 / 10 | |
| `SQS_RETRY_BASE_S` / `SQS_RETRY_MAX_S` | 2 / 60 | backoff de visibilidade em falha transitória |
| `CONSUMER_ENABLED` / `OUTBOX_ENABLED` / `PENDING_WORKER_ENABLED` | true | liga/desliga cada processo de fundo |
| `OUTBOX_POLL_MS` / `OUTBOX_BATCH_SIZE` | 250 / 10 | |
| `PENDING_RETRY_BASE_MS` / `PENDING_RETRY_MAX_MS` / `PENDING_MAX_ATTEMPTS` | 1000 / 120000 / 8 | política de `PENDING_REFERENCE` |
| `SHUTDOWN_TIMEOUT_MS` | 15000 | tempo máximo para drenar mensagens no SIGTERM |
| `LOG_LEVEL` | info | |
| `FAULT_INJECTION` | vazio | **somente testes**: `crash_after_commit`, `crash_after_publish` |

## Estrutura

```
src/domain           regras e invariantes (sem Nest/ORM)
src/application      use cases e portas
src/infrastructure   MikroORM, migrations, SQS, workers, métricas, logs, config
src/interfaces       HTTP (controllers, filtro de erros, guard) e consumer SQS
scripts/             migrate, load-test, utilitários SQS
test/unit | integration | concurrency
```
