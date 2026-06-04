# MapDR / MediView PACS

This repository contains the MapDR API, MediView portal, Orthanc, OHIF, auth API, and video gateway pieces needed to run the PACS web app on a new Linux machine.

## Clone and Deploy

On a fresh Ubuntu/Debian server:

```bash
git clone <repo-url> /opt/mapdr-project
cd /opt/mapdr-project
cp deploy/env.example deploy/env
```

Edit `deploy/env` for the new machine: domain, install path, Orthanc password, Nextcloud credentials, and LiveKit secret.
Also set a unique `AUTH_BOOTSTRAP_ADMIN_PASSWORD`; it is only used when initializing a new auth store.

Prerequisites: Node.js, npm, Docker with Compose, nginx, and systemd.

Then run:

```bash
sudo bash deploy/install.sh
```

The installer:

- installs npm dependencies for the API and portal
- creates runtime data directories
- writes `.env` files from `deploy/env`
- starts Orthanc and OHIF with Docker Compose
- installs systemd services for the API, portal, auth API, and video gateway
- installs an nginx reverse proxy config

After setup:

```bash
sudo systemctl status mapdr-api mediview-vite mediview-auth-api mediview-video-gateway
curl -fsS http://127.0.0.1:3001/api/health
```

## Runtime Layout

Default install path is `/opt/mapdr-project`. Runtime data is intentionally not part of the clone:

- `docker/ohif-orthanc/orthanc_db/` - Orthanc DICOM database
- `mapdr-api/media/` - exported recordings/media
- `mapdr-api/tmp/` - temporary upload/processing files
- `mapdr-api/*.json` - local API JSON state
- `frontend/mediview-portal/server/auth-api/data/` - local auth users/sessions

Back these up separately if you want to move patient data or local users to another machine.

## Local Development

```bash
npm --prefix mapdr-api install
npm --prefix frontend/mediview-portal install
npm --prefix mapdr-api run dev
npm --prefix frontend/mediview-portal run dev
```

Use `.env.example` files as starting points. Do not commit real `.env` files or runtime data.
