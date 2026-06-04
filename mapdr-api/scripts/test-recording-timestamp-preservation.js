const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert.match(
  serverSource,
  /'-fflags',\s*'\+genpts',\s*'-i',\s*job\.source_path,\s*'-vf',\s*'setpts=PTS-STARTPTS'/,
  'live finalize jobs must regenerate input timestamps before converting WebM recordings'
);

assert.match(
  serverSource,
  /'-fflags',\s*'\+genpts',\s*'-i',\s*localPath,\s*'-vf',\s*`setpts=PTS-STARTPTS,\$\{buildCaseStreamLabelFilter/,
  'case stream recording renders must reset media timestamps before applying labels'
);

assert.match(
  serverSource,
  /async function normalizeWebmRecordingTimestamps\(filePath\)[\s\S]*'-fflags',\s*'\+genpts',\s*'-i',\s*sourcePath,[\s\S]*'-vf',\s*'setpts=PTS-STARTPTS',[\s\S]*'-af',\s*'asetpts=PTS-STARTPTS'/,
  'uploaded case recordings must reset WebM audio/video timestamps before being saved'
);

assert.match(
  serverSource,
  /const normalized = await normalizeWebmRecordingTimestamps\(moved\.path\);/,
  'case recording upload must normalize timestamps before saving recording metadata'
);

assert.match(
  serverSource,
  /'-fflags',\s*'\+genpts',\s*'-i',\s*req\.file\.path,\s*'-vf',\s*'setpts=PTS-STARTPTS'/,
  'synchronous live recording finalization must reset WebM timestamps before MP4 conversion'
);

assert.match(
  serverSource,
  /if \(!study \|\| !session \|\| !job\.source_path \|\| !fs\.existsSync\(job\.source_path\)\) \{\s*if \(session\) \{\s*session\.upload_in_progress = false;/,
  'missing live finalize sources must clear upload_in_progress so sessions are not stuck'
);

assert.match(
  serverSource,
  /if \(isTerminal\) \{\s*session\.upload_in_progress = false;/,
  'terminal live finalize failures must clear upload_in_progress so sessions are not stuck'
);

console.log('recording timestamp preservation regression passed');
