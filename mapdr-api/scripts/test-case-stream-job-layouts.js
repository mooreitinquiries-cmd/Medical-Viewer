const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert.match(
  serverSource,
  /study_layouts:\s*context\.parsedBody\.studyLayouts/,
  'case-stream job creation must persist normalized study layouts'
);

assert.match(
  serverSource,
  /resolveCaseStreamContext\(\{\s*study_ids:\s*job\.requested_study_ids,\s*max_frames:\s*job\.max_frames,\s*fps:\s*job\.fps,\s*study_layouts:\s*job\.study_layouts,\s*\}\)/,
  'case-stream worker must render queued jobs with persisted study layouts'
);

assert.match(
  serverSource,
  /study_layouts:\s*job\.study_layouts\s*&&\s*typeof job\.study_layouts === 'object'\s*\?\s*job\.study_layouts\s*:\s*\{\}/,
  'case-stream job persistence must save study layouts to disk'
);

assert.match(
  serverSource,
  /study_layouts:\s*item\.study_layouts\s*&&\s*typeof item\.study_layouts === 'object'\s*\?\s*item\.study_layouts\s*:\s*\{\}/,
  'case-stream job hydration must restore study layouts from disk'
);

console.log('case-stream job layout regression passed');
