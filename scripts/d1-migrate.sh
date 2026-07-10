#!/usr/bin/env bash
#
# Apply the D1 migration chain to the remote database.
#
# `wrangler d1 migrations apply` cannot be used: Prisma stores each migration as
# <name>/migration.sql, while wrangler only reads flat .sql files in
# migrations_dir. The 2024_* migrations are also Postgres (BIGSERIAL, from before
# the D1 port) and must never be applied here.
#
# Applying twice fails on "table already exists" — that is intentional. These
# statements are not idempotent, so a second run should be loud rather than
# silently partially-applied.
#
# Usage:  npm run d1-migrate            (remote)
#         D1_LOCAL=1 npm run d1-migrate (local wrangler state)
set -euo pipefail

DB_NAME="${D1_DATABASE_NAME:-jetkvm-cloud-api}"
TARGET="--remote"
[ "${D1_LOCAL:-}" = "1" ] && TARGET="--local"

# Ordered: the chain must be applied in sequence.
MIGRATIONS=(
  "prisma/migrations/20250101000000_d1_init/migration.sql"
  "prisma/migrations/20250101000001_rename_google_id_to_oidc_id/migration.sql"
)

for sql in "${MIGRATIONS[@]}"; do
  [ -f "$sql" ] || { echo "missing migration: $sql" >&2; exit 1; }
  echo "==> applying $sql"
  npx wrangler d1 execute "$DB_NAME" "$TARGET" --yes --file "$sql"
done

echo "==> schema"
npx wrangler d1 execute "$DB_NAME" "$TARGET" --yes \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;"
