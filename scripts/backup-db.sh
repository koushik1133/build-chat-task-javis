#!/usr/bin/env bash
# KernelHub — plain-Postgres backup (pg_dump, custom format, dated file).
#
#   scripts/backup-db.sh                 # writes backups/kernelhub-YYYYMMDD-HHMMSS.dump
#   BACKUP_DIR=/mnt/backups scripts/backup-db.sh
#   KEEP_DAYS=14 scripts/backup-db.sh    # prune dumps older than 14 days (default 30)
#
# Connection comes from .env.local / the environment: DSQL_ENDPOINT (host),
# DB_USER, DB_PASSWORD, DB_NAME, PGPORT (default 5432). In Docker Compose run it
# as `docker compose exec postgres pg_dump …` or point DSQL_ENDPOINT at the
# published port.
#
# Aurora DSQL has no pg_dump endpoint with IAM tokens in this script; use the
# AWS console / `aws dsql` snapshot tooling there (see docs/DEPLOY.md).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(DSQL_ENDPOINT|DB_USER|DB_PASSWORD|DB_NAME)=' .env.local | sed 's/#.*//' | xargs) >/dev/null 2>&1 || true
fi

HOST="${DSQL_ENDPOINT:-127.0.0.1}"
case "$HOST" in
  localhost|127.0.0.1|postgres|db) ;;
  *) echo "backup-db: DSQL_ENDPOINT=$HOST is not a plain Postgres host; use Aurora DSQL snapshots instead." >&2; exit 2 ;;
esac

export PGPASSWORD="${DB_PASSWORD:-}"
USER="${DB_USER:-postgres}"
DB="${DB_NAME:-postgres}"
PORT="${PGPORT:-5432}"
OUT_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/kernelhub-$STAMP.dump"

mkdir -p "$OUT_DIR"
echo "backup-db: dumping $DB@$HOST:$PORT as $USER → $OUT"
pg_dump -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" --format=custom --no-owner --no-privileges --file "$OUT"
ls -lh "$OUT"

if [ "$KEEP_DAYS" -gt 0 ]; then
  find "$OUT_DIR" -name 'kernelhub-*.dump' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/backup-db: pruned /'
fi
echo "backup-db: done. Restore with: pg_restore -h HOST -U USER -d DB --clean --if-exists $OUT"
