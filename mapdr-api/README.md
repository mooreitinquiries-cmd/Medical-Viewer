# MapDR API

Production-hardened Express API for case/study management, DICOM ingestion via Orthanc, media uploads, sharing, and Nextcloud export.

## What Was Tuned

- Centralized env-based config and removal of hardcoded service passwords.
- Structured JSON request logs with request IDs.
- Consistent API error payloads with codes.
- Upload hardening (file type checks + limits).
- Atomic writes for `studies.json` to reduce corruption risk.
- Secure headers, configurable CORS allowlist.
- Readiness/health probes for orchestration.
- Graceful shutdown on SIGTERM/SIGINT.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# edit .env values
```

3. Run in development:

```bash
npm run dev
```

4. Run in production mode:

```bash
npm start
```

5. Optional PM2 run:

```bash
pm2 start ecosystem.config.js --env production
```

## Validation

```bash
npm run check
npm run smoke
```

If your server is not on `http://127.0.0.1:3001`, set `SMOKE_BASE_URL`.

## Key Endpoints

- `GET /api/health`
- `GET /api/ready`
- `GET /api/studies`
- `POST /api/studies`
- `POST /api/studies/:id/dicom`
- `POST /api/studies/:id/mp4`
- `POST /api/studies/:id/pdf`
- `POST /api/studies/:id/share`
- `GET /api/shared/:token`
- `POST /api/studies/:id/export-nextcloud`
- `GET /api/viewer-link/:id`
- `GET /api/auth/2fa/status`
- `POST /api/auth/2fa/setup/start`
- `POST /api/auth/2fa/setup/verify`
- `POST /api/auth/2fa/disable/start`
- `POST /api/auth/2fa/disable`
- `POST /api/auth/2fa/challenge/start`
- `POST /api/auth/2fa/challenge/verify`

## Two-Factor Auth Framework

2FA is scaffolded but disabled by default. Set `TWO_FACTOR_AUTH_ENABLED=true`, `TWO_FACTOR_CODE_SECRET`, `TWO_FACTOR_RESEND_API_KEY`, and `TWO_FACTOR_RESEND_FROM` when you are ready to connect the existing Resend account and enforce the login flow.

The framework stores 2FA settings and hashed one-time challenges in the existing auth session store. It supports end-user email setup, login challenge verification, and disabling 2FA, but it does not currently enforce 2FA during login because login/session creation lives outside this API boundary.

## Startup Deployment Notes

- Put this service behind a reverse proxy (Nginx/Caddy) with TLS.
- Restrict `CORS_ALLOWED_ORIGINS` in production.
- Set strong service credentials in environment variables.
- Rotate share tokens periodically by policy.
- Monitor logs and alert on repeated `ORTHANC_*` and `NEXTCLOUD_*` error codes.
