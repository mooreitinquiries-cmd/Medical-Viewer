export type CaseStreamTimelineItem = {
  index?: number;
  study_id: number;
  label?: string;
  frame_count?: number;
  start_sec: number;
  end_sec: number;
};

export type CasePresentationSegment = {
  index: number;
  studyId: number;
  label: string;
  startSec: number;
  endSec: number;
};

function isValidTimelineItem(item: CaseStreamTimelineItem): boolean {
  return (
    Number.isFinite(Number(item.study_id)) &&
    Number.isFinite(Number(item.start_sec)) &&
    Number.isFinite(Number(item.end_sec)) &&
    Number(item.end_sec) > Number(item.start_sec)
  );
}

export function buildCasePresentationSegments(
  timeline?: CaseStreamTimelineItem[] | null
): CasePresentationSegment[] {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return [];
  }

  const segments: CasePresentationSegment[] = [];

  timeline.filter(isValidTimelineItem).forEach((item) => {
    const studyId = Number(item.study_id);
    const startSec = Number(item.start_sec);
    const endSec = Number(item.end_sec);
    const label = String(item.label || `Case ${studyId}`).trim() || `Case ${studyId}`;
    const activeSegment = segments[segments.length - 1];

    if (activeSegment && activeSegment.studyId === studyId) {
      activeSegment.endSec = Math.max(activeSegment.endSec, endSec);
      if (!activeSegment.label || activeSegment.label === `Case ${studyId}`) {
        activeSegment.label = label;
      }
      return;
    }

    segments.push({
      index: segments.length,
      studyId,
      label,
      startSec,
      endSec,
    });
  });

  return segments;
}

export function getNextCasePresentationIndex(currentIndex: number, segments: CasePresentationSegment[]): number {
  if (segments.length === 0) return 0;
  return Math.min(Math.max(currentIndex + 1, 0), segments.length - 1);
}

export function getPreviousCasePresentationIndex(currentIndex: number, segments: CasePresentationSegment[]): number {
  if (segments.length === 0) return 0;
  return Math.min(Math.max(currentIndex - 1, 0), segments.length - 1);
}
