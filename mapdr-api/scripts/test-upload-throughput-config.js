const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

if (!/DICOM_UPLOAD_CONCURRENCY[\s\S]*process\.env\.DICOM_UPLOAD_CONCURRENCY \|\| 2[\s\S]*,\s*1\)[\s\S]*,\s*16\s*\)/.test(serverSource)) {
  throw new Error('Expected default DICOM upload concurrency to stay at 2 with the existing cap of 16.');
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

if (!serverSource.includes('DICOM_UPLOAD_INCOMPLETE')) {
  throw new Error('Partial DICOM upload failures must fail the whole batch so streams cannot miss images.');
}

if (!serverSource.includes('DICOM_JPEG2000_TRANSCODE_FAILED')) {
  throw new Error('JPEG2000 transcode failures must fail clearly instead of uploading an unreadable original.');
}

if (serverSource.includes('dicom.transcode_failed_fallback_original')) {
  throw new Error('JPEG2000 transcode failures must not silently fall back to the original file.');
}

if (!/failedFiles\.length > 0[\s\S]*safeDeleteOrthancInstance[\s\S]*DICOM_UPLOAD_INCOMPLETE/.test(serverSource)) {
  throw new Error('Incomplete DICOM batches must clean up uploaded Orthanc instances before returning an error.');
}

console.log('Upload throughput config regression passed.');
