# Video Gateway

This service issues short-lived LiveKit participant tokens for the frontend in this repo.

## What it does

- `POST /video/rooms`
  - Creates a room slug for a consult session.
- `POST /video/token`
  - Returns a LiveKit JWT for a participant to join a room.
- `GET /healthz`
  - Health and config check.

## Run it

```bash
cp server/video-gateway/.env.example server/video-gateway/.env
set -a
source server/video-gateway/.env
set +a
npm run video:gateway
```

## Important

This gateway is intentionally minimal and matches the current app, which uses browser-local demo auth.

Before using this in production, replace the trust model with your real backend auth/session layer. The token endpoint must derive user identity and room permissions from authenticated server-side context, not directly from request body fields.
