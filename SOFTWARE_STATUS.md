# MapDR Software Status and Maintenance Notes

Last updated: June 4, 2026 UTC

## Current Position

- The active product is a MediView/MapDR medical-case platform.
- The frontend is React, TypeScript, and Vite under `frontend/mediview-portal`.
- The main backend is an Express/Node API under `mapdr-api`.
- Orthanc stores and renders DICOM studies.
- OHIF is the primary DICOM viewer. External PACS viewer links are also supported by configuration.
- Nginx and Cloudflare provide the public routing layer.
- Case features currently include DICOM upload/viewing, screenshots, case streams, screen recordings, reports, sharing, and cloud export.

## Production Services

- `mapdr-api.service`: main API, normally bound to `127.0.0.1:3001`.
- `mediview-vite.service`: frontend Vite server, normally bound to `127.0.0.1:8081`.
- `auth-api` and `video-gateway`: managed through PM2.
- Orthanc HTTP API: normally available at `127.0.0.1:8042`.
- API health endpoint: `GET /api/health`.

The API and Orthanc health endpoint were successfully verified after the June 4 image-quality deployment.

## June 4, 2026 Work Log

- Fixed low-quality case images by requesting Orthanc's native `image-uint8` rendering before its lower-detail `preview` rendering.
- Improved generated case-stream video quality by adding an explicit x264 CRF setting with a high-quality default of `16`.
- Documented `CASE_STREAM_X264_CRF` and `CASE_STREAM_X264_PRESET` environment controls.
- Added `test:case-stream-image-quality` regression coverage.
- Restarted `mapdr-api.service` to activate the quality fix.
- Installed the backend's missing PostgreSQL dependency and resolved backend package-audit findings.
- Removed runtime data, generated files, dependencies, and secrets from source control.
- Replaced exposed Git history with a single sanitized production baseline.
- Published the sanitized baseline as the only branch and reachable commit on remote `main`.
- Rotated locally controlled Orthanc, LiveKit, and bootstrap administrator credentials.
- Rotated the external Nextcloud administrator password and switched MapDR to a dedicated Nextcloud app password.
- Revoked an unused legacy Nextcloud app password and redacted retired Nextcloud credentials from local history files.
- Restored the requested PACS frontend administrator login and verified it through the public authentication route.
- Standardized the production portal on `pacs.octelerad.com` and repaired stale Cloudflare-facing PACS CORS and DICOM authentication settings.
- Safely increased DICOM browser batches from 25 MB to 75 MB and upload timeout from 5 to 10 minutes while keeping backend concurrency at 8.
- Restarted only `mediview-vite.service` for the upload tuning; API, Orthanc, Nginx, and Cloudflare services remained running.
- Isolated large DICOM files into their own requests and added filename-specific timeout/rejection messages so one unreadable file cannot silently hold the rest of a batch.
- Restarted only `mapdr-api.service` and `mediview-vite.service` for the stall mitigation.
- Changed LiveKit's default configuration so TURN remains disabled until valid TLS certificates are mounted.
- Recreated and verified the LiveKit container after applying the corrected runtime configuration.
- Verified:
  - API syntax check.
  - Case-stream image-quality regression.
  - Existing case-stream layout regression.
  - Existing case-stream presentation regression.
  - API health and Orthanc connectivity.
  - A real case screenshot returned successfully as a PNG.
  - Large-file batch regression, all 44 frontend tests, frontend production build, backend upload-throughput regression, and API smoke checks.
  - Live Cloudflare-served frontend contains the 75 MB batch and 10-minute timeout defaults.
  - Unreadable-DICOM integration test returned the exact test filename and rejection reason; the temporary test study was deleted.
  - All 46 frontend tests, frontend production build, backend regressions, API smoke checks, and public PACS routes passed after deployment.

Important: existing saved case-stream videos retain their old encoding. Rebuild or regenerate them to receive the improved quality.

## Current Risks

- Runtime data, secrets, generated media, Orthanc storage, and dependency directories must not be treated as normal source-code changes.
- Do not run destructive Git commands such as `git reset --hard` or broad cleanup commands against this repository.
- Orthanc runtime configuration and bootstrap administrator credentials must be generated from local environment secrets, never committed.
- The root-readable pre-sanitization Git bundle contains old sensitive history and must never be published.

## Maintenance Guidelines

1. Check service and data health before and after every deployment.

   ```bash
   systemctl status mapdr-api.service --no-pager
   systemctl status mediview-vite.service --no-pager
   curl -fsS http://127.0.0.1:3001/api/health
   ```

2. Validate backend changes before restarting production.

   ```bash
   cd /root/mapdr-project/mapdr-api
   npm run check
   npm run test:case-stream-image-quality
   npm run test:case-stream-layouts
   npm run test:case-stream-presentation
   ```

3. Restart only the service affected by the change, then inspect its logs.

   ```bash
   systemctl restart mapdr-api.service
   journalctl -u mapdr-api.service --since "5 minutes ago" --no-pager
   ```

4. Keep medical-image quality controlled:

   - Request native-resolution DICOM renders before preview fallbacks.
   - Keep `CASE_STREAM_X264_CRF=16` unless file-size testing justifies another value.
   - Lower CRF means higher quality and larger files.
   - Test screenshots and regenerated case streams using real cases after pipeline changes.

5. Protect medical data:

   - Never expose `.env` files, patient data, Orthanc storage, reports, or recordings in source control.
   - Back up Orthanc and application data before migrations or cleanup.
   - Verify case isolation so one case cannot display another case's DICOM images.

6. Keep a daily operational log containing:

   - Exact date and UTC time.
   - Files and behavior changed.
   - Commands/tests run and their result.
   - Services restarted.
   - Health checks performed.
   - Known risks and unfinished work.

7. Keep large DICOM uploads within the Cloudflare boundary:

   - Use `VITE_DICOM_UPLOAD_BATCH_MAX_MB=75` to reduce request overhead while leaving multipart headroom.
   - Use `VITE_DICOM_UPLOAD_TIMEOUT_MS=600000` for slower large-study connections.
   - Keep `DICOM_UPLOAD_CONCURRENCY=8` unless a measured benchmark proves a higher value is stable.
   - A single DICOM larger than the batch target is uploaded alone; do not lower the backend per-file limit below expected source-file sizes.
   - Files using at least half the batch target are isolated automatically. Orthanc read timeouts are reported once with the filename instead of retrying the same stalled file.

## Recommended Near-Term Work

- Rebuild representative existing case streams and compare quality and file size.
- Add an automated integration test that verifies screenshot dimensions and case-stream encoding settings.
- Establish backups and a tested restore procedure before any database or Orthanc storage cleanup.
- Configure and test TURN only after a public TURN domain and valid TLS certificate files are available.

## Repository Cleanup Plan

Completed on June 4, 2026:

- Stopped tracking runtime data, secrets, Orthanc storage, temporary files, auth data, and `node_modules`.
- Committed and tested backend dependency/security, export, and image-quality work.
- Committed and tested frontend case workflow and stream presentation work.
- Rotated locally controlled Orthanc, LiveKit, and administrator credentials.
- Replaced exposed repository history with a single sanitized production baseline.
- Live runtime files remained on disk and production health checks continued to pass.

The pre-sanitization history is retained only in a root-readable local bundle for emergency recovery. Do not publish that bundle.
