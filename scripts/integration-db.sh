#!/usr/bin/env bash
# Run the end-to-end integration suite (src/__integration__) against the local Postgres.
#
#   scripts/integration-db.sh            # start Postgres if needed, run every flow
#   scripts/integration-db.sh billing    # only files matching "billing"
#
# The suite calls the real Next.js route handlers with auth mocked to a synthetic
# owner scope; every file creates its own org/data id and deletes its rows afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PG_DATA="${PG_DATA:-/opt/homebrew/var/postgresql@17}"

if ! pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
  echo "[integration] local Postgres is down — starting it"
  LC_ALL=en_US.UTF-8 "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_DATA/server.log" start
  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null && break
    sleep 1
  done
  pg_isready -h 127.0.0.1 -p 5432 -q || { echo "[integration] Postgres did not come up"; exit 1; }
fi

if [ ! -f .env.local ]; then
  echo "[integration] .env.local is missing (needs DSQL_ENDPOINT=127.0.0.1, DB_USER, optional DB_NAME/DB_PASSWORD)"; exit 1
fi

export DB_INTEGRATION=1
exec npx vitest run src/__integration__ "$@"
