const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const imageUint8Position = source.indexOf(
  '`/instances/${instanceId}/frames/${frameNumber}/image-uint8`'
);
const previewPosition = source.indexOf(
  '`/instances/${instanceId}/frames/${frameNumber}/preview`'
);

assert(imageUint8Position >= 0, 'native-resolution Orthanc image endpoint must be configured');
assert(previewPosition >= 0, 'Orthanc preview fallback must remain configured');
assert(
  imageUint8Position < previewPosition,
  'native-resolution Orthanc images must be requested before lower-quality previews'
);
assert(
  source.includes("String(CASE_STREAM_X264_CRF)"),
  'case stream encoding must apply the configured x264 CRF'
);

console.log('case-stream image quality regression passed');
