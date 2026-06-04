# MediView Portal

## Self-hosted video calling

This repo now includes a working self-hosted video path based on LiveKit:

- Frontend room UI in [src/pages/VideoCalls.tsx](/root/frontend/mediview-portal/src/pages/VideoCalls.tsx)
- Token gateway scaffold in [server/video-gateway/server.mjs](/root/frontend/mediview-portal/server/video-gateway/server.mjs)
- Deployment scaffold in [infra/video/docker-compose.yml](/root/frontend/mediview-portal/infra/video/docker-compose.yml)

### Local wiring

```bash
cp server/video-gateway/.env.example server/video-gateway/.env
set -a
source server/video-gateway/.env
set +a
npm run video:gateway
npm run dev
```

### Frontend env

Set this in your frontend env if the video gateway is not reverse-proxied at `/video-api`:

```bash
VITE_VIDEO_API=http://127.0.0.1:8787
```

### External PACS integration

To hand study viewing off to an external PACS while keeping this app for the surrounding workflow:

```bash
# frontend dev proxy
PACS_NATIVE_PROXY_TARGET=http://192.168.4.150

# backend viewer-link handoff
EXTERNAL_PACS_BASE_URL=/external-pacs
# optional: EXTERNAL_PACS_WATCH_PATH=watch/seat-123
```

With `EXTERNAL_PACS_BASE_URL` set, the backend `GET /api/viewer-link/:id` route returns an external PACS URL instead of the local OHIF route. The generated URL includes:

- `mode=viewer`
- `embedded=1`
- `studyId`
- `orthancStudyId`
- `studyInstanceUid`
- `active_study_id`
- `active_accession`
- `patientId`
- `active_patient_token`
- `patientName`
- `modality`
- `studyDate`
- `active_case_label`

The frontend dev server now proxies `/external-pacs` to `PACS_NATIVE_PROXY_TARGET`. Production reverse proxy still needs a matching `/external-pacs/` nginx location.

### Production warning

The current app authentication is browser-local demo auth. The included token gateway works for local integration, but production deployment must move token issuance behind a real authenticated backend session.
