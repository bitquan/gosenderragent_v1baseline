#!/usr/bin/env bash
set -euo pipefail

# Bootstrap Alembic metadata for legacy databases that already have app tables.
python - <<'PY'
from sqlalchemy import create_engine, inspect, text
from app.core.config import settings
from app.models.token import TokenBalance, TokenTransaction

engine = create_engine(settings.database_url)

with engine.begin() as conn:
    insp = inspect(conn)
    tables = set(insp.get_table_names())
    has_legacy_tables = any(t in tables for t in {"users", "jobs", "senderr_profiles"})

    if not has_legacy_tables:
        raise SystemExit(0)

    has_alembic_relation = conn.execute(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname = 'alembic_version'
                  AND n.nspname = current_schema()
            )
            """
        )
    ).scalar()

    if not has_alembic_relation:
        conn.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"))
        print("[dev_start] Created alembic_version table for legacy schema")

    current = conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).fetchone()
    if current is None:
        conn.execute(text("INSERT INTO alembic_version (version_num) VALUES ('0001_initial_schema')"))
        print("[dev_start] Seeded alembic_version=0001_initial_schema")

    # Some legacy local DBs predate token tables but are stamped at/after 0001.
    # Create these tables if they are missing so token endpoints do not 500.
    tables = set(insp.get_table_names())
    created_missing = False
    if "token_balances" not in tables:
        TokenBalance.__table__.create(bind=conn, checkfirst=True)
        created_missing = True
        print("[dev_start] Created missing table token_balances")
    if "token_transactions" not in tables:
        TokenTransaction.__table__.create(bind=conn, checkfirst=True)
        created_missing = True
        print("[dev_start] Created missing table token_transactions")
    if created_missing:
        print("[dev_start] Legacy token table backfill applied")
PY

alembic upgrade head

if [[ "${DEV_START_NO_SERVER:-0}" == "1" ]]; then
  exit 0
fi

exec uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
