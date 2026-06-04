function toSafeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

function isValidTimelineItem(item) {
  return Boolean(
    item &&
      Number.isFinite(Number(item.study_id)) &&
      Number.isFinite(Number(item.start_sec)) &&
      Number.isFinite(Number(item.end_sec)) &&
      Number(item.end_sec) > Number(item.start_sec)
  );
}

function buildCasePresentationCases(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return [];
  }

  const cases = [];

  timeline.filter(isValidTimelineItem).forEach(function (item) {
    const studyId = Number(item.study_id);
    const startSec = Number(item.start_sec);
    const endSec = Number(item.end_sec);
    const defaultLabel = `Case ${studyId}`;
    const label = toSafeText(item.label) || defaultLabel;
    const activeCase = cases[cases.length - 1];

    if (activeCase && activeCase.study_id === studyId) {
      activeCase.end_sec = Number(Math.max(activeCase.end_sec, endSec).toFixed(3));
      activeCase.duration_sec = Number((activeCase.end_sec - activeCase.start_sec).toFixed(3));
      if (!activeCase.label || activeCase.label === defaultLabel) {
        activeCase.label = label;
      }
      return;
    }

    cases.push({
      index: cases.length,
      study_id: studyId,
      label: label,
      start_sec: Number(startSec.toFixed(3)),
      end_sec: Number(endSec.toFixed(3)),
      duration_sec: Number((endSec - startSec).toFixed(3)),
    });
  });

  return cases;
}

function buildCaseStreamPresentationManifest(stream, job, options) {
  const opts = options || {};
  const streamTimeline = Array.isArray(stream && stream.timeline) ? stream.timeline : [];
  const jobTimeline = Array.isArray(job && job.timeline) ? job.timeline : [];
  const cases = buildCasePresentationCases(streamTimeline.length > 0 ? streamTimeline : jobTimeline);
  const jobId = toSafeText((job && job.id) || (stream && stream.job_id));

  return {
    stream_id: toSafeText(stream && stream.id),
    job_id: jobId,
    name: toSafeText(stream && stream.name),
    video_url: opts.videoUrl || (jobId ? `/api/case-stream/jobs/${encodeURIComponent(jobId)}/download` : null),
    fps: Number((job && job.fps) || (stream && stream.fps)) || 0,
    requested_study_ids: Array.isArray(stream && stream.requested_study_ids) ? stream.requested_study_ids : [],
    case_count: cases.length,
    cases: cases,
  };
}

module.exports = {
  buildCasePresentationCases,
  buildCaseStreamPresentationManifest,
};
