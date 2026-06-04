# Auth API

Minimal backend session service for the portal.

## Features

- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/session`
- `GET /auth/users`
- `POST /auth/users`
- `PATCH /auth/users/:email/status`
- `POST /auth/users/:email/reset-password`
- `POST /auth/change-password`

## Notes

- Passwords are stored using Node's built-in `scrypt`.
- Sessions are stored server-side and sent to the browser as `HttpOnly` cookies.
- Data is persisted to `server/auth-api/data/store.json`.

## Run it

```bash
cp server/auth-api/.env.example server/auth-api/.env
set -a
source server/auth-api/.env
set +a
npm run auth:server
```
