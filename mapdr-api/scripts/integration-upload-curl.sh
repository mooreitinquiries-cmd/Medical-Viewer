#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${INTEGRATION_BASE_URL:-http://127.0.0.1:3001/api}"
AUTH_EMAIL="${INTEGRATION_AUTH_EMAIL:-doctor@example.com}"
AUTH_ROLE="${INTEGRATION_AUTH_ROLE:-doctor}"
AUTH_NAME="${INTEGRATION_AUTH_NAME:-Integration Tester}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

headers=(
  -H "x-user-email: ${AUTH_EMAIL}"
  -H "x-user-role: ${AUTH_ROLE}"
  -H "x-user-name: ${AUTH_NAME}"
)

read_json_field() {
  local file="$1"
  local path="$2"
  node -e '
const fs = require("fs");
const obj = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const parts = process.argv[2].split(".");
let cur = obj;
for (const key of parts) {
  if (!key) continue;
  cur = cur == null ? undefined : cur[key];
}
if (cur == null) process.exit(2);
process.stdout.write(String(cur));
' "$file" "$path"
}

echo "integration-upload-curl: checking API reachability at ${BASE_URL}"
curl -sS "${headers[@]}" "${BASE_URL}/studies" >/dev/null

echo "integration-upload-curl: create study (mp4-only)"
cat >"${TMP_DIR}/study-create.json" <<'JSON'
{"patient_name":"integration-mp4-only","study_date":"2026-05-14","modality":"CT","notes":"curl integration"}
JSON
curl -sS "${headers[@]}" -H "content-type: application/json" \
  -d @"${TMP_DIR}/study-create.json" \
  "${BASE_URL}/studies" >"${TMP_DIR}/study1.json"
study1_id="$(read_json_field "${TMP_DIR}/study1.json" "id")"

echo "integration-upload-curl: upload mp4 without dicom"
printf 'fake-mp4-a' >"${TMP_DIR}/a.mp4"
curl -sS "${headers[@]}" \
  -F "mp4_file=@${TMP_DIR}/a.mp4;type=video/mp4;filename=a.mp4" \
  "${BASE_URL}/upload-mp4/${study1_id}" >"${TMP_DIR}/mp4a.json"
mp4_url_1="$(read_json_field "${TMP_DIR}/mp4a.json" "mp4_url")"

echo "integration-upload-curl: repeat mp4 upload (retry-safe replace)"
printf 'fake-mp4-b' >"${TMP_DIR}/b.mp4"
curl -sS "${headers[@]}" \
  -F "mp4_file=@${TMP_DIR}/b.mp4;type=video/mp4;filename=b.mp4" \
  "${BASE_URL}/upload-mp4/${study1_id}" >"${TMP_DIR}/mp4b.json"
mp4_url_2="$(read_json_field "${TMP_DIR}/mp4b.json" "mp4_url")"
if [[ "$mp4_url_1" == "$mp4_url_2" ]]; then
  echo "integration-upload-curl: ERROR mp4 url did not change on second upload"
  exit 1
fi

echo "integration-upload-curl: create study (recording-only)"
cat >"${TMP_DIR}/study2-create.json" <<'JSON'
{"patient_name":"integration-recording-only","study_date":"2026-05-14","modality":"MR","notes":"curl integration"}
JSON
curl -sS "${headers[@]}" -H "content-type: application/json" \
  -d @"${TMP_DIR}/study2-create.json" \
  "${BASE_URL}/studies" >"${TMP_DIR}/study2.json"
study2_id="$(read_json_field "${TMP_DIR}/study2.json" "id")"

echo "integration-upload-curl: upload case recording without dicom"
printf 'fake-webm' >"${TMP_DIR}/rec.webm"
recording_size="$(wc -c <"${TMP_DIR}/rec.webm" | tr -d '[:space:]')"
recording_sha256="$(sha256sum "${TMP_DIR}/rec.webm" | awk '{print $1}')"
curl -sS "${headers[@]}" \
  -F "recording_file=@${TMP_DIR}/rec.webm;type=video/webm;filename=rec.webm" \
  -F "recording_size=${recording_size}" \
  -F "recording_sha256=${recording_sha256}" \
  -F "studyId=${study2_id}" \
  -F "caseId=case-${study2_id}" \
  -F "uploadedBy=${AUTH_EMAIL}" \
  "${BASE_URL}/case-recordings/upload" >"${TMP_DIR}/recording.json"
recording_id="$(read_json_field "${TMP_DIR}/recording.json" "recording.id")"

echo "integration-upload-curl: validate missing mp4 media returns 400"
status_code="$(curl -sS -o "${TMP_DIR}/missing-mp4.json" -w "%{http_code}" "${headers[@]}" -X POST "${BASE_URL}/upload-mp4/${study2_id}")"
if [[ "$status_code" != "400" ]]; then
  echo "integration-upload-curl: ERROR expected 400 for missing mp4, got ${status_code}"
  exit 1
fi

echo "integration-upload-curl: cleanup studies"
curl -sS "${headers[@]}" -X DELETE "${BASE_URL}/studies/${study1_id}" >/dev/null
curl -sS "${headers[@]}" -X DELETE "${BASE_URL}/studies/${study2_id}" >/dev/null

echo "integration-upload-curl: cleanup recording ${recording_id} from json store"
node -e '
const fs = require("fs");
const file = process.argv[1];
const id = process.argv[2];
const rows = JSON.parse(fs.readFileSync(file, "utf8"));
const next = Array.isArray(rows) ? rows.filter((r) => String(r.id) !== String(id)) : rows;
fs.writeFileSync(file, JSON.stringify(next, null, 2));
' "$(cd "$(dirname "$0")/.." && pwd)/case-recordings.json" "$recording_id"

echo "integration-upload-curl: all scenarios passed"
