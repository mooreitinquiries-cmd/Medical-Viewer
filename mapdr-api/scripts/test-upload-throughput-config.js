const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

if (!/DICOM_UPLOAD_CONCURRENCY[\s\S]*process\.env\.DICOM_UPLOAD_CONCURRENCY \|\| 12[\s\S]*,\s*1\)[\s\S]*,\s*16\s*\)/.test(serverSource)) {
  throw new Error('Expected default DICOM upload concurrency to stay at 12 with the existing cap of 16.');
}

for (const expected of [
  'dicom.upload.received',
  'dicom.upload.orthanc_completed',
  'dicom_upload_timings',
  'upload.tmp_stale_cleanup_completed',
]) {
  if (!serverSource.includes(expected)) {
    throw new Error(`Expected upload telemetry marker to exist: ${expected}`);
  }
}

if (/code === 'ECONNRESET' \|\| code === 'ECONNABORTED' \|\| code === 'ETIMEDOUT'/.test(serverSource)) {
  throw new Error('Orthanc timeout errors must not be retried for the same stalled DICOM file.');
}

if (!serverSource.includes('Timed out while Orthanc was reading the DICOM file')) {
  throw new Error('Expected a readable per-file Orthanc timeout reason.');
}

console.log('Upload throughput config regression passed.');
