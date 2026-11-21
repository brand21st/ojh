#!/usr/bin/env bash
# Races the wallet functions on a throwaway local Postgres cluster.
# Usage: PG_BIN="/c/Program Files/PostgreSQL/17/bin" scripts/wallet/concurrency-check.sh
# PGlite runs one connection at a time, so lock behaviour is only proven here.
set -euo pipefail
PG_BIN="${PG_BIN:?set PG_BIN to a Postgres bin directory}"
PORT="${WALLET_PG_PORT:-55439}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$(mktemp -d)/pgdata"
export PGPORT="$PORT" PGHOST=127.0.0.1 PGUSER=postgres

cleanup() { "$PG_BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -c max_connections=120 -c listen_addresses=127.0.0.1" -w start >/dev/null

PSQL=("$PG_BIN/psql" -v ON_ERROR_STOP=1 -q -X -d postgres)
"${PSQL[@]}" -f "$ROOT/scripts/wallet/concurrency-stub.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261008120000_ai_credits.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261008180000_ai_credit_wallet.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261121120000_tenant_wallet.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261121140000_wallet_recharge.sql"
"${PSQL[@]}" -f "$ROOT/scripts/wallet/concurrency-seed.sql" >/dev/null

CLIENTS="${CLIENTS:-50}"; TX="${TX:-200}"
BENCH="$("$PG_BIN/pgbench" -n -c "$CLIENTS" -j 8 -t "$TX" -f "$ROOT/scripts/wallet/concurrency-bench.sql" postgres 2>&1 || true)"
echo "$BENCH" | grep -E "transactions actually processed|failed transactions|tps|aborted|error" | head -8
EXPECTED="$((CLIENTS * TX))/$((CLIENTS * TX))"
echo "$BENCH" | grep -q "actually processed: $EXPECTED" \
  || { echo "WALLET CONCURRENCY CHECK FAILED: pgbench did not finish every transaction"; exit 1; }

"$PG_BIN/psql" -X -d postgres -f "$ROOT/scripts/wallet/concurrency-verify.sql"
"$PG_BIN/psql" -X -At -d postgres -f "$ROOT/scripts/wallet/concurrency-verify.sql" | head -8 | grep -q "|f$" && { echo "WALLET CONCURRENCY CHECK FAILED"; exit 1; }
# Drain: race charges against a balance that cannot cover them all.
START="$("$PG_BIN/psql" -X -At -d postgres -c "select balance_micros from wallets")"
"$PG_BIN/pgbench" -n -c "$CLIENTS" -j 8 -t 20 -f "$ROOT/scripts/wallet/concurrency-drain.sql" postgres >/dev/null 2>&1 || true
DRAIN="$("$PG_BIN/psql" -X -At -d postgres -c "select (select balance_micros from wallets) >= 0 and (select balance_micros from wallets) < 500000 and (select count(*) from wallet_ledger where idempotency_key like 'debit:drain:%') = $START / 500000 and (select balance_micros from wallets) = (select sum(amount_micros) from wallet_ledger)")"
echo "drain from $START micros: exact stop at zero = $DRAIN"
[ "$DRAIN" = "t" ] || { echo "WALLET CONCURRENCY CHECK FAILED: drain overspent or underspent"; exit 1; }

echo "WALLET CONCURRENCY CHECK PASSED"
