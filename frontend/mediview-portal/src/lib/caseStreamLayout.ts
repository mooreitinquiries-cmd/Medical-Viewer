export type StreamLayoutMode = 'fit' | 'fill' | 'manual';

export type StreamLayout = {
  mode: StreamLayoutMode;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const defaultStreamLayout = (): StreamLayout => ({
  mode: 'fit',
  crop: {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  },
});

export function normalizeStreamLayout(layout?: Partial<StreamLayout> | null): StreamLayout {
  const rawCrop = layout?.crop || {};
  const mode = layout?.mode === 'fill' || layout?.mode === 'manual' ? layout.mode : 'fit';
  const width = clamp(Number(rawCrop.width) || 1, 0.05, 1);
  const height = clamp(Number(rawCrop.height) || 1, 0.05, 1);

  return {
    mode,
    crop: {
      x: clamp(Number(rawCrop.x) || 0, 0, 1 - width),
      y: clamp(Number(rawCrop.y) || 0, 0, 1 - height),
      width,
      height,
    },
  };
}

export function buildStreamLayoutPayload(
  selectedStudyIds: number[],
  layouts: Record<number, StreamLayout>
): Record<string, StreamLayout> {
  const normalizedLayouts = selectedStudyIds.reduce<Record<number, StreamLayout>>((acc, studyId) => {
    acc[studyId] = normalizeStreamLayout(layouts[studyId] || defaultStreamLayout());
    return acc;
  }, {});
  const firstCroppedLayout = selectedStudyIds
    .map((studyId) => normalizedLayouts[studyId])
    .find((layout) => layout && layout.mode !== 'fit');

  return selectedStudyIds.reduce<Record<string, StreamLayout>>((acc, studyId) => {
    const layout = normalizedLayouts[studyId] || defaultStreamLayout();
    acc[String(studyId)] = layout.mode === 'fit' && firstCroppedLayout
      ? firstCroppedLayout
      : layout;
    return acc;
  }, {});
}
