#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STUDIES_FILE = path.join(ROOT, 'studies.json');
const CASE_RECORDINGS_FILE = path.join(ROOT, 'case-recordings.json');
const BASE_URL = sanitizeBaseUrl(process.env.INTEGRATION_BASE_URL || '');
const PORT = Number(process.env.TEST_API_PORT || 3900 + Math.floor(Math.random() * 500));
const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}/api`;
let API_BASE = BASE_URL || LOCAL_BASE_URL;

const AUTH_HEADERS = {
  'x-user-email': 'doctor@example.com',
  'x-user-role': 'doctor',
  'x-user-name': 'Integration Tester',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

async function waitForServerReady(timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${API_BASE}/studies`, { headers: AUTH_HEADERS });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`Server did not become ready: ${lastError ? lastError.message : 'unknown error'}`);
}

async function createStudy(overrides = {}) {
  const payload = {
    patient_name: `integration-${Date.now()}`,
    study_date: '2026-05-14',
    modality: 'CT',
    notes: 'integration upload test',
    ...overrides,
  };
  const res = await fetch(`${API_BASE}/studies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(res.status, 200, `create study failed: ${res.status}`);
  return res.json();
}

async function uploadMp4(studyId, fileName = 'test.mp4', content = 'fake-mp4-bytes') {
  const form = new FormData();
  form.append('mp4_file', new Blob([content], { type: 'video/mp4' }), fileName);
  const res = await fetch(`${API_BASE}/upload-mp4/${encodeURIComponent(String(studyId))}`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function uploadCaseRecording(studyId, caseId) {
  const recordingContent = 'fake-webm';
  const form = new FormData();
  form.append('recording_file', new Blob([recordingContent], { type: 'video/webm' }), 'recording.webm');
  form.append('recording_size', String(Buffer.byteLength(recordingContent)));
  form.append('recording_sha256', crypto.createHash('sha256').update(recordingContent).digest('hex'));
  form.append('studyId', String(studyId));
  form.append('caseId', caseId);
  form.append('uploadedBy', 'doctor@example.com');

  const res = await fetch(`${API_BASE}/case-recordings/upload`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function deleteStudy(studyId) {
  const res = await fetch(`${API_BASE}/studies/${encodeURIComponent(String(studyId))}`, {
    method: 'DELETE',
    headers: { ...AUTH_HEADERS },
  });
  return res.status;
}

async function run() {
  const targetBase = BASE_URL || LOCAL_BASE_URL;
  API_BASE = targetBase;
  const shouldSpawnLocalServer = !BASE_URL;
  const studiesBackup = shouldSpawnLocalServer ? await fsp.readFile(STUDIES_FILE, 'utf8') : null;
  const recordingsBackup = shouldSpawnLocalServer ? await fsp.readFile(CASE_RECORDINGS_FILE, 'utf8') : null;
  const createdMediaPaths = [];
  const createdStudyIds = [];
  const createdRecordingIds = [];

  let child = null;
  if (shouldSpawnLocalServer) {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  let childOut = '';
  let childErr = '';
  if (child) {
    child.stdout.on('data', (chunk) => {
      childOut += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      childErr += String(chunk);
    });
  }

  try {
    if (shouldSpawnLocalServer) {
      await waitForServerReady();
    } else {
      const health = await fetch(`${targetBase}/studies`, { headers: AUTH_HEADERS });
      assert.strictEqual(health.status, 200, `target API not reachable: ${targetBase}`);
    }

    // Scenario 1: MP4-only upload without DICOM
    const study1 = await createStudy({ patient_name: 'integration-mp4-only' });
    createdStudyIds.push(study1.id);
    const mp4Only = await uploadMp4(study1.id, 'mp4-only.mp4');
    assert.strictEqual(mp4Only.status, 200, `mp4-only upload failed: ${mp4Only.status}`);
    assert.ok(mp4Only.body && mp4Only.body.mp4_url, 'mp4-only upload did not return mp4_url');
    createdMediaPaths.push(path.join(ROOT, mp4Only.body.mp4_url.replace(/^\//, '')));

    // Scenario 2: Retry-safe repeated MP4 upload (replace same study mp4)
    const firstUrl = mp4Only.body.mp4_url;
    const mp4Second = await uploadMp4(study1.id, 'mp4-second.mp4', 'second-fake-mp4');
    assert.strictEqual(mp4Second.status, 200, `second mp4 upload failed: ${mp4Second.status}`);
    assert.ok(mp4Second.body && mp4Second.body.mp4_url, 'second mp4 upload did not return mp4_url');
    assert.notStrictEqual(mp4Second.body.mp4_url, firstUrl, 'mp4 retry should replace with a new media path');
    createdMediaPaths.push(path.join(ROOT, mp4Second.body.mp4_url.replace(/^\//, '')));

    // Scenario 3: screen-recording-style upload path works without DICOM
    const study2 = await createStudy({ patient_name: 'integration-recording-only' });
    createdStudyIds.push(study2.id);
    const recording = await uploadCaseRecording(study2.id, `case-${study2.id}`);
    assert.strictEqual(recording.status, 200, `case recording upload failed: ${recording.status}`);
    assert.ok(recording.body && recording.body.recording && recording.body.recording.recording_url, 'recording upload missing recording_url');
    createdRecordingIds.push(recording.body.recording.id);
    createdMediaPaths.push(path.join(ROOT, recording.body.recording.recording_url.replace(/^\//, '')));

    // Scenario 4: validation when media missing
    const missingMedia = await fetch(`${API_BASE}/upload-mp4/${encodeURIComponent(String(study2.id))}`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS },
    });
    assert.strictEqual(missingMedia.status, 400, 'missing mp4 media should return 400');

    console.log('integration-upload: all scenarios passed');
  } catch (err) {
    const detail = [err && err.message ? err.message : String(err), childOut.trim(), childErr.trim()]
      .filter(Boolean)
      .join('\n');
    throw new Error(detail);
  } finally {
    for (const studyId of createdStudyIds) {
      try {
        await deleteStudy(studyId);
      } catch (_) {}
    }

    if (createdRecordingIds.length > 0) {
      try {
        const current = JSON.parse(await fsp.readFile(CASE_RECORDINGS_FILE, 'utf8'));
        const next = Array.isArray(current)
          ? current.filter((item) => !createdRecordingIds.includes(String(item && item.id)))
          : current;
        await fsp.writeFile(CASE_RECORDINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
      } catch (_) {}
    }

    for (const mediaPath of createdMediaPaths) {
      try {
        await fsp.unlink(mediaPath);
      } catch (_) {}
    }

    if (shouldSpawnLocalServer) {
      await fsp.writeFile(STUDIES_FILE, studiesBackup, 'utf8');
      await fsp.writeFile(CASE_RECORDINGS_FILE, recordingsBackup, 'utf8');
    }

    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 4000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

run().catch((err) => {
  console.error(`integration-upload: failed - ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
