import { describe, expect, it } from 'vitest';
import {
  buildCasePresentationSegments,
  getNextCasePresentationIndex,
  getPreviousCasePresentationIndex,
} from '@/lib/caseStreamPresentation';

describe('case stream presentation partitions', () => {
  it('groups consecutive timeline entries into one repeating segment per case', () => {
    const segments = buildCasePresentationSegments([
      { index: 0, study_id: 11, label: 'Case 11 | DICOM', frame_count: 30, start_sec: 0, end_sec: 2 },
      { index: 1, study_id: 11, label: 'Case 11 | MP4', frame_count: 60, start_sec: 2, end_sec: 6 },
      { index: 2, study_id: 12, label: 'Case 12 | DICOM', frame_count: 45, start_sec: 6, end_sec: 9 },
    ]);

    expect(segments).toEqual([
      {
        index: 0,
        studyId: 11,
        label: 'Case 11 | DICOM',
        startSec: 0,
        endSec: 6,
      },
      {
        index: 1,
        studyId: 12,
        label: 'Case 12 | DICOM',
        startSec: 6,
        endSec: 9,
      },
    ]);
  });

  it('drops invalid timeline entries that cannot be presented', () => {
    const segments = buildCasePresentationSegments([
      { study_id: 20, label: 'Bad range', start_sec: 3, end_sec: 3 },
      { study_id: Number.NaN, label: 'Bad study', start_sec: 3, end_sec: 4 },
      { study_id: 21, label: 'Case 21', start_sec: 4, end_sec: 8 },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].studyId).toBe(21);
  });

  it('keeps previous and next controls within the available cases', () => {
    const segments = buildCasePresentationSegments([
      { study_id: 1, start_sec: 0, end_sec: 1 },
      { study_id: 2, start_sec: 1, end_sec: 2 },
    ]);

    expect(getPreviousCasePresentationIndex(0, segments)).toBe(0);
    expect(getNextCasePresentationIndex(0, segments)).toBe(1);
    expect(getNextCasePresentationIndex(1, segments)).toBe(1);
  });
});
