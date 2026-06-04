# Enterprise Migration Scaffold

This folder contains initial scaffolding for enterprise hardening:

1. Postgres schema bootstrap (`postgres/001_initial_schema.sql`)
2. Async finalize worker skeleton (`queue/live-finalize-worker.js`)

## Recommended phased rollout

1. Deploy schema alongside existing JSON/file-based persistence.
2. Enable dual-write behind feature flag:
   - `ENABLE_PG_DUAL_WRITE=true`
   - `DATABASE_URL=postgres://...`
3. Shift live finalize to queue mode:
   - `ENABLE_LIVE_FINALIZE_QUEUE=true`
4. Cut over reads to Postgres:
   - `ENABLE_PG_READS=true`
5. Remove JSON persistence paths.

## Required future work

- Add `pg` pool wiring and migrations runner.
- Implement row-level authz checks from JWT/session identity.
- Replace in-process queue semantics with durable queue backend.
- Add integration tests around live session lifecycle and retries.

## Auth rollout

- `AUTH_JWT_SECRET=...` enables JWT bearer validation (HS256).
- `ALLOW_HEADER_AUTH=true` keeps legacy header auth fallback.
- Set `ALLOW_HEADER_AUTH=false` after clients fully migrate to JWT.
