import { describe, expect, it } from 'vitest';
import { buildStreamLayoutPayload, defaultStreamLayout, normalizeStreamLayout } from '@/lib/caseStreamLayout';

describe('case stream layout normalization', () => {
  it('keeps manual crop bounds inside the source frame', () => {
    const layout = normalizeStreamLayout({
      mode: 'manual',
      crop: {
        x: 0.8,
        y: 0.9,
        width: 0.5,
        height: 0.25,
      },
    });

    expect(layout).toEqual({
      mode: 'manual',
      crop: {
        x: 0.5,
        y: 0.75,
        width: 0.5,
        height: 0.25,
      },
    });
  });

  it('normalizes invalid values to the backend-supported range', () => {
    expect(
      normalizeStreamLayout({
        mode: 'manual',
        crop: {
          x: -1,
          y: 2,
          width: 0,
          height: 9,
        },
      })
    ).toEqual({
      mode: 'manual',
      crop: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    });
  });

  it('defaults unknown or missing layout state to fit full-frame', () => {
    expect(normalizeStreamLayout(null)).toEqual(defaultStreamLayout());
    expect(normalizeStreamLayout({ mode: 'fit' })).toEqual(defaultStreamLayout());
  });

  it('applies the active crop to later selected studies that were never cropped individually', () => {
    const payload = buildStreamLayoutPayload([101, 102, 103], {
      101: {
        mode: 'manual',
        crop: {
          x: 0.2,
          y: 0.1,
          width: 0.6,
          height: 0.7,
        },
      },
    });

    expect(payload['101']).toEqual(payload['102']);
    expect(payload['102']).toEqual(payload['103']);
    expect(payload['102']).toEqual({
      mode: 'manual',
      crop: {
        x: 0.2,
        y: 0.1,
        width: 0.6,
        height: 0.7,
      },
    });
  });

  it('keeps explicit crops for later selected studies', () => {
    const payload = buildStreamLayoutPayload([101, 102], {
      101: {
        mode: 'manual',
        crop: {
          x: 0.2,
          y: 0.1,
          width: 0.6,
          height: 0.7,
        },
      },
      102: {
        mode: 'fill',
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      },
    });

    expect(payload['102']).toEqual({
      mode: 'fill',
      crop: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    });
  });
});
