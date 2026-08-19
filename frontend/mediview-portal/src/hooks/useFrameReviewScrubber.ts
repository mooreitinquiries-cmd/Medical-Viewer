import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';

export interface FrameReviewSegment {
  index: number;
  studyId: number;
  label: string;
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
}

interface UseFrameReviewScrubberOptions {
  enabled: boolean;
  totalFrames: number;
  fps: number;
  initialFrame?: number;
  segments?: FrameReviewSegment[];
  getFrameUrl: (frameIndex: number) => string;
  prewarmFrames?: (frameIndex: number, radius: number) => void;
  onFrameChange?: (frameIndex: number) => void;
}

function clampFrame(frameIndex: number, totalFrames: number) {
  const maxFrame = Math.max(0, Math.floor(totalFrames) - 1);
  return Math.min(maxFrame, Math.max(0, Math.floor(frameIndex) || 0));
}

export function useFrameReviewScrubber({
  enabled,
  totalFrames,
  fps,
  initialFrame = 0,
  segments = [],
  getFrameUrl,
  prewarmFrames,
  onFrameChange,
}: UseFrameReviewScrubberOptions) {
  const [frameIndex, setFrameIndex] = useState(() => clampFrame(initialFrame, totalFrames));
  const lastPrewarmFrameRef = useRef<number | null>(null);

  const setClampedFrame = useCallback(
    (nextFrame: number) => {
      const clamped = clampFrame(nextFrame, totalFrames);
      setFrameIndex(clamped);
      onFrameChange?.(clamped);
      return clamped;
    },
    [onFrameChange, totalFrames]
  );

  useEffect(() => {
    if (!enabled) return;
    setClampedFrame(initialFrame);
  }, [enabled, initialFrame, setClampedFrame]);

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      setFrameIndex((currentFrame) => {
        const clamped = clampFrame(currentFrame + direction, totalFrames);
        onFrameChange?.(clamped);
        return clamped;
      });
    },
    [onFrameChange, totalFrames]
  );

  const activeSegment = useMemo(
    () =>
      segments.find((segment) => frameIndex >= segment.startFrame && frameIndex < segment.endFrame) ||
      segments[segments.length - 1] ||
      null,
    [frameIndex, segments]
  );

  const frameUrl = enabled && totalFrames > 0 ? getFrameUrl(frameIndex) : '';
  const frameTimeSec = fps > 0 ? frameIndex / fps : 0;

  useEffect(() => {
    if (!enabled || totalFrames <= 0 || !prewarmFrames) return;
    const lastPrewarmFrame = lastPrewarmFrameRef.current;
    if (lastPrewarmFrame !== null && Math.abs(frameIndex - lastPrewarmFrame) < 48) return;

    const timeoutId = window.setTimeout(() => {
      lastPrewarmFrameRef.current = frameIndex;
      prewarmFrames(frameIndex, 48);
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [enabled, frameIndex, prewarmFrames, totalFrames]);

  const onWheel = useCallback(
    (event: WheelEvent) => {
      if (!enabled || totalFrames <= 0) return;
      event.preventDefault();
      stepFrame(event.deltaY > 0 ? 1 : -1);
    },
    [enabled, stepFrame, totalFrames]
  );

  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      if (!enabled || totalFrames <= 0) return;
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      stepFrame(event.button === 2 ? 1 : -1);
    },
    [enabled, stepFrame, totalFrames]
  );

  const onContextMenu = useCallback((event: MouseEvent) => {
    if (!enabled) return;
    event.preventDefault();
  }, [enabled]);

  return {
    frameIndex,
    frameUrl,
    frameTimeSec,
    activeSegment,
    setFrame: setClampedFrame,
    stepFrame,
    onWheel,
    onMouseDown,
    onContextMenu,
  };
}
