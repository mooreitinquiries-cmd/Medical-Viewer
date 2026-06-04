#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

if [ ! -f deploy/env ]; then
  echo "Missing deploy/env. Copy deploy/env.example to deploy/env and edit it first." >&2
  exit 1
fi

set -a
. deploy/env
set +a

APP_DIR="${APP_DIR:-/opt/mapdr-project}"
APP_USER="${APP_USER:-root}"
PUBLIC_HOST="${PUBLIC_HOST:-pacs.example.com}"
PUBLIC_SCHEME="${PUBLIC_SCHEME:-https}"
NGINX_LISTEN="${NGINX_LISTEN:-80}"
FRONTEND_PORT="${FRONTEND_PORT:-8081}"
API_PORT="${API_PORT:-3001}"
AUTH_API_PORT="${AUTH_API_PORT:-8788}"
VIDEO_GATEWAY_PORT="${VIDEO_GATEWAY_PORT:-8787}"
ORTHANC_HTTP_PORT="${ORTHANC_HTTP_PORT:-8042}"
OHIF_PORT="${OHIF_PORT:-3000}"
DICOM_BIND_IP="${DICOM_BIND_IP:-0.0.0.0}"
DICOM_PORT="${DICOM_PORT:-4242}"

missing_commands=()
for command_name in npm node systemctl nginx; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing_commands+=("$command_name")
  fi
done

if [ "${#missing_commands[@]}" -gt 0 ]; then
  echo "Missing required commands: ${missing_commands[*]}" >&2
  echo "Install Node.js, npm, nginx, Docker, and the Docker Compose plugin, then rerun this script." >&2
  exit 1
fi

if [ "$(pwd)" != "$APP_DIR" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  if [ ! -e "$APP_DIR" ]; then
    ln -s "$(pwd)" "$APP_DIR"
  fi
fi

render_template() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|{{APP_DIR}}|${APP_DIR}|g" \
    -e "s|{{APP_USER}}|${APP_USER}|g" \
    -e "s|{{PUBLIC_HOST}}|${PUBLIC_HOST}|g" \
    -e "s|{{PUBLIC_SCHEME}}|${PUBLIC_SCHEME}|g" \
    -e "s|{{NGINX_LISTEN}}|${NGINX_LISTEN}|g" \
    -e "s|{{FRONTEND_PORT}}|${FRONTEND_PORT}|g" \
    -e "s|{{API_PORT}}|${API_PORT}|g" \
    -e "s|{{AUTH_API_PORT}}|${AUTH_API_PORT}|g" \
    -e "s|{{VIDEO_GATEWAY_PORT}}|${VIDEO_GATEWAY_PORT}|g" \
    -e "s|{{OHIF_PORT}}|${OHIF_PORT}|g" \
    -e "s|{{ORTHANC_PASSWORD}}|${ORTHANC_PASSWORD}|g" \
    -e "s|{{LIVEKIT_API_KEY}}|${LIVEKIT_API_KEY}|g" \
    -e "s|{{LIVEKIT_API_SECRET}}|${LIVEKIT_API_SECRET}|g" \
    "$src" > "$dst"
}

mkdir -p \
  docker/ohif-orthanc/orthanc_db \
  mapdr-api/tmp \
  mapdr-api/media \
  frontend/mediview-portal/server/auth-api/data

npm --prefix mapdr-api install
npm --prefix frontend/mediview-portal install

cat > frontend/mediview-portal/.env <<EOF
VITE_API=/api
VITE_AUTH_API=/auth-api
VITE_VIDEO_API=/video-api
VITE_DICOM_UPLOAD_BATCH_SIZE=${VITE_DICOM_UPLOAD_BATCH_SIZE:-500}
VITE_DICOM_UPLOAD_BATCH_MAX_MB=${VITE_DICOM_UPLOAD_BATCH_MAX_MB:-75}
VITE_DICOM_UPLOAD_TIMEOUT_MS=${VITE_DICOM_UPLOAD_TIMEOUT_MS:-600000}
EOF

cat > mapdr-api/.env <<EOF
NODE_ENV=${NODE_ENV:-production}
PORT=${API_PORT}
JSON_LIMIT=${JSON_LIMIT:-2mb}
HTTP_TIMEOUT_MS=${HTTP_TIMEOUT_MS:-15000}
ORTHANC_UPLOAD_TIMEOUT_MS=${ORTHANC_UPLOAD_TIMEOUT_MS:-300000}
ORTHANC_UPLOAD_RETRIES=${ORTHANC_UPLOAD_RETRIES:-2}
UPLOAD_MAX_MB=${UPLOAD_MAX_MB:-5120}
UPLOAD_MAX_FILES=${UPLOAD_MAX_FILES:-2000}
DICOM_IN_MEMORY_MAX_MB=${DICOM_IN_MEMORY_MAX_MB:-64}
DICOM_UPLOAD_CONCURRENCY=${DICOM_UPLOAD_CONCURRENCY:-8}
SHARE_TTL_DAYS=${SHARE_TTL_DAYS:-7}
APP_BASE_URL=${APP_BASE_URL:-${PUBLIC_SCHEME}://${PUBLIC_HOST}}
OHIF_HOST=${OHIF_HOST:-${PUBLIC_SCHEME}://${PUBLIC_HOST}}
SERVER_IP=${SERVER_IP:-127.0.0.1}
EXTERNAL_PACS_BASE_URL=${EXTERNAL_PACS_BASE_URL:-}
EXTERNAL_PACS_WATCH_PATH=${EXTERNAL_PACS_WATCH_PATH:-}
CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS:-${PUBLIC_SCHEME}://${PUBLIC_HOST}}
ORTHANC_URL=http://127.0.0.1:${ORTHANC_HTTP_PORT}
ORTHANC_USERNAME=${ORTHANC_USERNAME:-admin}
ORTHANC_PASSWORD=${ORTHANC_PASSWORD:-change-me}
NEXTCLOUD_URL=${NEXTCLOUD_URL:-}
NEXTCLOUD_USERNAME=${NEXTCLOUD_USERNAME:-}
NEXTCLOUD_PASSWORD=${NEXTCLOUD_PASSWORD:-}
EOF

cat > frontend/mediview-portal/server/auth-api/.env <<EOF
AUTH_API_HOST=127.0.0.1
AUTH_API_PORT=${AUTH_API_PORT}
AUTH_API_CORS_ORIGIN=${PUBLIC_SCHEME}://${PUBLIC_HOST}
AUTH_PORTAL_ORIGIN=${PUBLIC_SCHEME}://${PUBLIC_HOST}
AUTH_SESSION_COOKIE=${AUTH_SESSION_COOKIE:-mediview_session}
AUTH_SESSION_TTL_HOURS=${AUTH_SESSION_TTL_HOURS:-24}
AUTH_COOKIE_SECURE=${AUTH_COOKIE_SECURE:-true}
AUTH_BOOTSTRAP_ADMIN_PASSWORD=${AUTH_BOOTSTRAP_ADMIN_PASSWORD:-}
EOF

cat > frontend/mediview-portal/server/video-gateway/.env <<EOF
PORT=${VIDEO_GATEWAY_PORT}
CORS_ORIGIN=${PUBLIC_SCHEME}://${PUBLIC_HOST}
LIVEKIT_URL=${LIVEKIT_URL:-auto}
LIVEKIT_API_KEY=${LIVEKIT_API_KEY:-mediviewkey}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET:-replace-with-a-long-random-secret}
TOKEN_TTL_SECONDS=${TOKEN_TTL_SECONDS:-3600}
EOF

for service in mapdr-api mediview-vite mediview-auth-api mediview-video-gateway; do
  render_template "deploy/systemd/${service}.service.template" "/etc/systemd/system/${service}.service"
done

render_template deploy/nginx-mapdr.conf.template /etc/nginx/sites-available/mapdr.conf
ln -sf /etc/nginx/sites-available/mapdr.conf /etc/nginx/sites-enabled/mapdr.conf

if command -v docker >/dev/null 2>&1; then
  render_template docker/ohif-orthanc/orthanc.json.example docker/ohif-orthanc/orthanc.json
  chmod 600 docker/ohif-orthanc/orthanc.json
  render_template frontend/mediview-portal/infra/video/livekit.yaml.example frontend/mediview-portal/infra/video/livekit.yaml
  chmod 600 frontend/mediview-portal/infra/video/livekit.yaml
  docker network inspect pacs >/dev/null 2>&1 || docker network create pacs
  if docker compose version >/dev/null 2>&1; then
    DICOM_BIND_IP="${DICOM_BIND_IP}" DICOM_PORT="${DICOM_PORT}" ORTHANC_HTTP_PORT="${ORTHANC_HTTP_PORT}" OHIF_PORT="${OHIF_PORT}" \
      docker compose -f docker/ohif-orthanc/docker-compose.yml up -d
  elif command -v docker-compose >/dev/null 2>&1; then
    DICOM_BIND_IP="${DICOM_BIND_IP}" DICOM_PORT="${DICOM_PORT}" ORTHANC_HTTP_PORT="${ORTHANC_HTTP_PORT}" OHIF_PORT="${OHIF_PORT}" \
      docker-compose -f docker/ohif-orthanc/docker-compose.yml up -d
  else
    echo "Docker is installed, but Docker Compose is missing." >&2
    exit 1
  fi
else
  echo "Docker is not installed; skipping Orthanc/OHIF startup." >&2
fi

systemctl daemon-reload
systemctl enable --now mapdr-api mediview-vite mediview-auth-api mediview-video-gateway

nginx -t
systemctl reload nginx

echo "Installed MapDR/MediView for ${PUBLIC_HOST}."
echo "Check: curl -fsS http://127.0.0.1:${API_PORT}/api/health"
