const assert = require('assert');
const {
  buildCasePresentationCases,
  buildCaseStreamPresentationManifest,
} = require('../lib/caseStreamPresentation');

const cases = buildCasePresentationCases([
  { index: 0, study_id: 11, label: 'Case 11 | DICOM', frame_count: 30, start_sec: 0, end_sec: 2 },
  { index: 1, study_id: 11, label: 'Case 11 | MP4', frame_count: 60, start_sec: 2, end_sec: 6 },
  { index: 2, study_id: 12, label: 'Case 12 | DICOM', frame_count: 45, start_sec: 6, end_sec: 9 },
]);

assert.deepStrictEqual(cases, [
  {
    index: 0,
    study_id: 11,
    label: 'Case 11 | DICOM',
    start_sec: 0,
    end_sec: 6,
    duration_sec: 6,
    frame_count: 90,
    start_frame: 0,
    end_frame: 90,
  },
  {
    index: 1,
    study_id: 12,
    label: 'Case 12 | DICOM',
    start_sec: 6,
    end_sec: 9,
    duration_sec: 3,
    frame_count: 45,
    start_frame: 90,
    end_frame: 135,
  },
]);

assert.deepStrictEqual(
  buildCasePresentationCases([
    { study_id: 20, label: 'Bad range', start_sec: 3, end_sec: 3 },
    { study_id: Number.NaN, label: 'Bad study', start_sec: 3, end_sec: 4 },
    { study_id: 21, label: 'Case 21', start_sec: 4, end_sec: 8 },
  ]).map((item) => item.study_id),
  [21]
);

const manifest = buildCaseStreamPresentationManifest(
  {
    id: 'stream-1',
    job_id: 'job-1',
    name: 'Morning list',
    fps: 15,
    requested_study_ids: [11, 12],
    timeline: [
      { study_id: 11, label: 'Case 11', start_sec: 0, end_sec: 4 },
      { study_id: 12, label: 'Case 12', start_sec: 4, end_sec: 7 },
    ],
  },
  { id: 'job-1', fps: 24 },
  { videoUrl: '/api/case-stream/jobs/job-1/download' }
);

assert.strictEqual(manifest.stream_id, 'stream-1');
assert.strictEqual(manifest.job_id, 'job-1');
assert.strictEqual(manifest.fps, 24);
assert.strictEqual(manifest.total_frames, 0);
assert.strictEqual(manifest.case_count, 2);
assert.strictEqual(manifest.video_url, '/api/case-stream/jobs/job-1/download');

const manifestFromJobTimeline = buildCaseStreamPresentationManifest(
  {
    id: 'stream-2',
    job_id: 'job-2',
    name: 'Recovered saved stream',
    fps: 15,
    requested_study_ids: [31],
    timeline: [],
  },
  {
    id: 'job-2',
    fps: 15,
    timeline: [{ study_id: 31, label: 'Case 31', start_sec: 0, end_sec: 5 }],
  }
);

assert.strictEqual(manifestFromJobTimeline.case_count, 1);
assert.strictEqual(manifestFromJobTimeline.cases[0].study_id, 31);

console.log('case-stream presentation regression passed');
