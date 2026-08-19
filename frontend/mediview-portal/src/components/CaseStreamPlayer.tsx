import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Layers,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { FrameReviewSegment } from '@/hooks/useFrameReviewScrubber';
import { formatVideoTime } from '@/lib/timeFormat';

const SEGMENT_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#f43f5e',
  '#0ea5e9', '#8b5cf6', '#ec4899', '#14b8a6',
];

const PLAYBACK_RATES = [0.1, 0.25, 0.5, 1, 1.5, 2, 3];

function clampFrame(frame: number, total: number) {
  return Math.min(Math.max(0, Math.round(frame) || 0), Math.max(0, Math.floor(total) - 1));
}

interface TooltipState {
  x: number;
  time: string;
  label: string;
  frame: number;
}

export interface CaseStreamPlayerProps {
  videoUrl: string;
  fps: number;
  totalFrames: number;
  segments?: FrameReviewSegment[];
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  activeSegmentIndex?: number | null;
  loopActiveSegment?: boolean;
  onSegmentNavigate?: (index: number) => void;
  getFrameUrl?: (frameIndex: number) => string;
  prewarmFrames?: (frameIndex: number, radius: number) => void;
}

export function CaseStreamPlayer({
  videoUrl,
  fps,
  totalFrames,
  segments = [],
  playbackRate: externalRate = 1,
  onPlaybackRateChange,
  activeSegmentIndex = null,
  loopActiveSegment = false,
  onSegmentNavigate,
  getFrameUrl,
  prewarmFrames,
}: CaseStreamPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaAreaRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prewarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPrewarmRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);
  const prevSegmentIndexRef = useRef<number | null | undefined>(undefined);
  // Tracks which segment the loop/snap effects should treat as "active" right now. Kept separate
  // from the activeSegmentIndex prop so an internal scrub-triggered segment change can take effect
  // synchronously, ahead of the parent re-render that eventually updates the prop.
  const loopSegmentIndexRef = useRef<number | null>(null);
  const isScrubbing = useRef(false);
  const wasPlayingBeforeScrub = useRef(false);
  const seekRafRef = useRef<number>(0);
  const pendingSeekFrameRef = useRef<number>(0);
  const isPanningRef = useRef(false);
  const hasPannedRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  // Scrub overlay — img element updated directly (no React re-render per frame)
  const scrubOverlayRef = useRef<HTMLImageElement>(null);
  const lastSeekTimestampRef = useRef(0);
  const lastPlaybackTimeRef = useRef(0);
  const lastLoopSeekAtRef = useRef(0);

  // Refs for stable native event handler (avoids passive listener stale-closure issues)
  const frameReviewActiveRef = useRef(false);
  const frameReviewIndexRef = useRef(0);
  const frameMaxRef = useRef(1);
  const normalizedFpsRef = useRef(24);
  const getFrameUrlRef = useRef(getFrameUrl);
  const prewarmFramesRef = useRef(prewarmFrames);
  const zoomRef = useRef(1);
  const playbackRateRef = useRef(externalRate);

  const [currentFrame, setCurrentFrame] = useState(0);
  const [displayFrame, setDisplayFrame] = useState(0); // scrubber UI position, decoupled from video.currentTime during scrub
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(externalRate);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [frameReviewActive, setFrameReviewActive] = useState(false);
  const [frameReviewIndex, setFrameReviewIndex] = useState(0);
  const [frameReviewUrl, setFrameReviewUrl] = useState('');
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [renderKey, setRenderKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isScrubbingState, setIsScrubbingState] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoErrorRecoverable, setVideoErrorRecoverable] = useState(true);

  const normalizedFps = Math.max(1, Number(fps) || 24);
  const frameMax = Math.max(totalFrames, 1);
  const totalSec = frameMax / normalizedFps;

  // Keep refs in sync every render
  frameReviewActiveRef.current = frameReviewActive;
  frameReviewIndexRef.current = frameReviewIndex;
  frameMaxRef.current = frameMax;
  normalizedFpsRef.current = normalizedFps;
  getFrameUrlRef.current = getFrameUrl;
  prewarmFramesRef.current = prewarmFrames;
  zoomRef.current = zoom;
  playbackRateRef.current = playbackRate;

  // ── Zoom/pan helpers ──────────────────────────────────────────────────────

  const clampPan = useCallback((x: number, y: number, z: number): { x: number; y: number } => {
    const el = mediaAreaRef.current;
    if (!el || z <= 1) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const maxX = (rect.width * (z - 1)) / 2;
    const maxY = (rect.height * (z - 1)) / 2;
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, []);

  const resetZoomPan = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const adjustZoom = useCallback((step: number) => {
    setZoom(prev => {
      const next = Math.min(8, Math.max(1, prev + step));
      if (next <= 1) { setPan({ x: 0, y: 0 }); return 1; }
      setPan(p => clampPan(p.x, p.y, next));
      return next;
    });
  }, [clampPan]);

  // ── External sync effects ─────────────────────────────────────────────────

  useEffect(() => {
    setPlaybackRate(externalRate);
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.playbackRate = externalRate;
    }
  }, [externalRate]);

  useEffect(() => {
    if (activeSegmentIndex === null || activeSegmentIndex === undefined) return;
    if (activeSegmentIndex === prevSegmentIndexRef.current) return;
    prevSegmentIndexRef.current = activeSegmentIndex;
    loopSegmentIndexRef.current = activeSegmentIndex;
    const segment = segments[activeSegmentIndex];
    const video = videoRef.current;
    if (!segment || !video) return;

    // The saved timeline's start/end seconds are computed from each case's expected
    // recording length and can drift from the actual rendered file (e.g. a source
    // clip came in shorter than planned). Seeking past the real duration never
    // resolves — the browser clamps currentTime to duration and 'seeking' hangs
    // forever — so detect that up front instead of asking for an unreachable time.
    const duration = video.duration;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    if (hasDuration && segment.startSec > duration + 0.5) {
      video.pause();
      setVideoErrorRecoverable(false);
      setVideoError(
        "This case's footage isn't in the saved video (it's shorter than the stream's timeline expects). Try re-rendering this stream."
      );
      return;
    }

    setVideoError(null);
    setVideoErrorRecoverable(true);
    const target = hasDuration ? Math.min(segment.startSec, Math.max(duration - 0.08, 0)) : segment.startSec;
    const currentTime = video.currentTime || 0;
    const insideSegment =
      currentTime >= Math.max(0, segment.startSec - 0.08) &&
      currentTime < Math.max(segment.endSec, segment.endFrame / normalizedFps) + 0.08;
    if (insideSegment) {
      video.playbackRate = externalRate;
      return;
    }
    lastPlaybackTimeRef.current = target;
    lastLoopSeekAtRef.current = performance.now();
    video.currentTime = target;
    video.playbackRate = externalRate;
    video.play().catch(() => {});
  }, [activeSegmentIndex, externalRate, normalizedFps, segments]);

  useEffect(() => {
    if (!onSegmentNavigate || isScrubbing.current || frameReviewActive) return;
    const nextIndex = segments.findIndex((seg) => currentFrame >= seg.startFrame && currentFrame < seg.endFrame);
    if (nextIndex < 0 || nextIndex === activeSegmentIndex) return;
    prevSegmentIndexRef.current = nextIndex;
    loopSegmentIndexRef.current = nextIndex;
    onSegmentNavigate(nextIndex);
  }, [activeSegmentIndex, currentFrame, frameReviewActive, onSegmentNavigate, segments]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (!loopActiveSegment || activeSegmentIndex === null || activeSegmentIndex === undefined) return;
    const tick = () => {
      // Read the tracked segment fresh every frame (not captured at effect-setup time) so a
      // manual scrub that just retargeted loopSegmentIndexRef is respected immediately, instead
      // of racing the React re-render that eventually updates activeSegmentIndex.
      const segment = segments[loopSegmentIndexRef.current ?? -1];
      const video = videoRef.current;
      if (video && segment && !isScrubbing.current && !video.seeking) {
        const duration = video.duration;
        const hasDuration = Number.isFinite(duration) && duration > 0;
        const now = performance.now();
        const currentTime = video.currentTime || 0;
        const lastTime = lastPlaybackTimeRef.current;
        const isAdvancing = !video.paused && currentTime > lastTime + 0.001;
        const segmentStart = segment.startSec;
        const segmentEndFromFrames = segment.endFrame > segment.startFrame
          ? segment.endFrame / normalizedFpsRef.current
          : segment.endSec;
        const segmentEnd = Math.max(segment.endSec || 0, segmentEndFromFrames || 0);
        lastPlaybackTimeRef.current = currentTime;

        // Out-of-range segment already surfaced an error above; don't fight it here.
        if (!hasDuration || segmentStart <= duration + 0.5) {
          const startSlack = 0.2;
          const endSlack = Math.max(0.35, 3 / normalizedFpsRef.current);
          const clampedStart = hasDuration ? Math.min(segmentStart, Math.max(duration - startSlack, 0)) : segmentStart;
          const beyondEnd = currentTime >= Math.min(segmentEnd + endSlack, hasDuration ? duration + endSlack : segmentEnd + endSlack);
          const beforeStart = currentTime < clampedStart - startSlack;
          const recentlySought = now - lastLoopSeekAtRef.current < 500;
          if ((beforeStart || beyondEnd) && !isAdvancing && !recentlySought) {
            lastLoopSeekAtRef.current = now;
            video.currentTime = clampedStart;
            video.play().catch(() => {});
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeSegmentIndex, loopActiveSegment, segments]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Native wheel listener — passive: false so we can preventDefault
  useEffect(() => {
    const el = mediaAreaRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (frameReviewActiveRef.current) {
        // Step frames
        const nextFrame = clampFrame(
          frameReviewIndexRef.current + (e.deltaY > 0 ? 1 : -1),
          frameMaxRef.current
        );
        frameReviewIndexRef.current = nextFrame;
        setFrameReviewIndex(nextFrame);
        const url = getFrameUrlRef.current;
        if (url) setFrameReviewUrl(url(nextFrame));
        if (videoRef.current) videoRef.current.currentTime = nextFrame / normalizedFpsRef.current;
        setCurrentFrame(nextFrame);
        return;
      }
      // Zoom
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      setZoom(prev => {
        const next = Math.min(8, Math.max(1, prev * factor));
        if (next <= 1) { setPan({ x: 0, y: 0 }); return 1; }
        setPan(p => clampPan(p.x, p.y, next));
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [clampPan]);

  // ── Controls visibility ───────────────────────────────────────────────────

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!isScrubbing.current) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, []);

  useEffect(() => {
    if (!playing || frameReviewActive) {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }, [frameReviewActive, playing]);

  // ── Active segment ────────────────────────────────────────────────────────

  const activeSegment = useMemo(() => {
    if (activeSegmentIndex !== null && activeSegmentIndex !== undefined && segments[activeSegmentIndex]) {
      return segments[activeSegmentIndex];
    }
    return (
      segments.find((seg) => currentFrame >= seg.startFrame && currentFrame < seg.endFrame) ||
      segments[segments.length - 1] ||
      null
    );
  }, [activeSegmentIndex, currentFrame, segments]);

  // ── Video sync ────────────────────────────────────────────────────────────

  const syncFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const frame = clampFrame((video.currentTime || 0) * normalizedFps, frameMax);
    setCurrentFrame(frame);
    // Don't let the video's async seek position overwrite what the user is dragging to
    if (!isScrubbing.current) setDisplayFrame(frame);
  }, [frameMax, normalizedFps]);

  // ── Frame review ──────────────────────────────────────────────────────────

  const loadReviewFrame = useCallback(
    (frame: number) => {
      const clamped = clampFrame(frame, frameMax);
      setFrameReviewIndex(clamped);
      frameReviewIndexRef.current = clamped;
      if (getFrameUrl) setFrameReviewUrl(getFrameUrl(clamped));
      if (videoRef.current) videoRef.current.currentTime = clamped / normalizedFps;
      setCurrentFrame(clamped);
      if (prewarmFrames) {
        if (prewarmTimerRef.current) clearTimeout(prewarmTimerRef.current);
        if (lastPrewarmRef.current === null || Math.abs(clamped - (lastPrewarmRef.current ?? 0)) >= 48) {
          prewarmTimerRef.current = setTimeout(() => {
            lastPrewarmRef.current = clamped;
            prewarmFrames(clamped, 48);
          }, 250);
        }
      }
    },
    [frameMax, getFrameUrl, normalizedFps, prewarmFrames]
  );

  const enterFrameReview = useCallback(() => {
    const video = videoRef.current;
    video?.pause();
    const frame = clampFrame((video?.currentTime || 0) * normalizedFps, frameMax);
    setFrameReviewActive(true);
    frameReviewActiveRef.current = true;
    loadReviewFrame(frame);
  }, [frameMax, loadReviewFrame, normalizedFps]);

  const exitFrameReview = useCallback(() => {
    setFrameReviewActive(false);
    frameReviewActiveRef.current = false;
    setFrameReviewUrl('');
  }, []);

  // ── Playback controls ─────────────────────────────────────────────────────

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await el.requestFullscreen().catch(() => {});
    }
  }, []);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || frameReviewActive) return;
    if (video.paused) {
      video.playbackRate = playbackRate;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [frameReviewActive, playbackRate]);

  const changeRate = useCallback(
    (rate: number) => {
      setPlaybackRate(rate);
      if (videoRef.current) videoRef.current.playbackRate = rate;
      onPlaybackRateChange?.(rate);
    },
    [onPlaybackRateChange]
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  // ── Pan pointer handlers ──────────────────────────────────────────────────

  const handleMediaPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (zoomRef.current <= 1) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    isPanningRef.current = true;
    hasPannedRef.current = false;
    setIsPanning(true);
    panStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMediaPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return;
    const dx = e.clientX - panStartRef.current.mouseX;
    const dy = e.clientY - panStartRef.current.mouseY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasPannedRef.current = true;
    setPan(clampPan(panStartRef.current.panX + dx, panStartRef.current.panY + dy, zoomRef.current));
  }, [clampPan]);

  const handleMediaPointerUp = useCallback(() => {
    if (!isPanningRef.current) return;
    const didPan = hasPannedRef.current;
    isPanningRef.current = false;
    hasPannedRef.current = false;
    setIsPanning(false);
    if (!didPan) togglePlayback();
  }, [togglePlayback]);

  const handleMediaClick = useCallback(() => {
    if (zoomRef.current > 1) return; // pointer events handle click when zoomed
    togglePlayback();
  }, [togglePlayback]);

  // ── Timeline handlers ─────────────────────────────────────────────────────

  // Accept both MouseEvent and PointerEvent (PointerEvent extends MouseEvent in both DOM and React types)
  const getFrameAtPointer = useCallback(
    (event: { clientX: number; currentTarget: HTMLDivElement }) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      return Math.round(pct * (frameMax - 1));
    },
    [frameMax]
  );

  // Smooth seek: instant scrubber + overlay thumbnail, throttled video seek (~10/s)
  const scheduleSeek = useCallback(
    (frame: number) => {
      pendingSeekFrameRef.current = frame;
      setDisplayFrame(frame); // instant scrubber position (React state)

      // Directly update overlay img src — bypasses React re-render for zero-latency thumbnail
      const urlFn = getFrameUrlRef.current;
      if (urlFn && scrubOverlayRef.current) {
        scrubOverlayRef.current.src = urlFn(frame);
      }

      // Coalesce rapid pointer events via RAF, then gate video seeks to ~10/s via timestamp.
      // This prevents flooding the decoder with 60+ seeks/second while still tracking the scrub.
      cancelAnimationFrame(seekRafRef.current);
      seekRafRef.current = requestAnimationFrame(() => {
        if (!isScrubbing.current) return;
        const now = performance.now();
        if (now - lastSeekTimestampRef.current < 100) return; // ~10 video seeks/second max
        lastSeekTimestampRef.current = now;
        const v = videoRef.current;
        if (!v) return;
        const t = pendingSeekFrameRef.current / normalizedFpsRef.current;
        // fastSeek targets nearest keyframe (much lower decode cost than exact seek)
        if ('fastSeek' in v) (v as any).fastSeek(t);
        else v.currentTime = t;
        if (frameReviewActiveRef.current) {
          const url = getFrameUrlRef.current;
          if (url) setFrameReviewUrl(url(pendingSeekFrameRef.current));
        }
        // Prime thumbnail cache for nearby frames as the user scrubs through
        const pw = prewarmFramesRef.current;
        if (pw) {
          const pf = pendingSeekFrameRef.current;
          if (lastPrewarmRef.current === null || Math.abs(pf - (lastPrewarmRef.current ?? 0)) > 30) {
            lastPrewarmRef.current = pf;
            pw(pf, 24);
          }
        }
      });
    },
    [] // stable — reads only stable refs and state setters
  );

  const seekToFrame = useCallback(
    (frame: number) => {
      const video = videoRef.current;
      const clamped = clampFrame(frame, frameMax);
      if (video) video.currentTime = clamped / normalizedFps;
      setCurrentFrame(clamped);
      setDisplayFrame(clamped);
      if (frameReviewActive) loadReviewFrame(clamped);
    },
    [frameMax, frameReviewActive, loadReviewFrame, normalizedFps]
  );

  const handleTimelineMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const frame = Math.round(pct * (frameMax - 1));
      const seg = segments.find((s) => frame >= s.startFrame && frame < s.endFrame) || null;
      setTooltip({
        x: event.clientX - rect.left,
        time: formatVideoTime(frame / normalizedFps, 3),
        label: seg?.label || '',
        frame,
      });
    },
    [frameMax, normalizedFps, segments]
  );

  const handleTimelinePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Capture pointer so moves outside the element keep firing on this element
      event.currentTarget.setPointerCapture(event.pointerId);
      isScrubbing.current = true;
      wasPlayingBeforeScrub.current = Boolean(videoRef.current && !videoRef.current.paused);
      videoRef.current?.pause();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      const frame = getFrameAtPointer(event as unknown as { clientX: number; currentTarget: HTMLDivElement });
      setIsScrubbingState(true); // show frame overlay for instant visual feedback
      scheduleSeek(frame);
      // Eagerly prime thumbnail cache around the scrub start position
      prewarmFramesRef.current?.(frame, 48);
    },
    [getFrameAtPointer, scheduleSeek]
  );

  const handleTimelinePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isScrubbing.current) return;
      scheduleSeek(getFrameAtPointer(event as unknown as { clientX: number; currentTarget: HTMLDivElement }));
    },
    [getFrameAtPointer, scheduleSeek]
  );

  const handleTimelinePointerUp = useCallback(() => {
    if (!isScrubbing.current) return;
    cancelAnimationFrame(seekRafRef.current);
    isScrubbing.current = false;
    // Exact seek to the committed frame on release (not fastSeek — we want precision here)
    const finalFrame = pendingSeekFrameRef.current;
    const v = videoRef.current;
    if (v) v.currentTime = finalFrame / normalizedFpsRef.current;
    setCurrentFrame(finalFrame);
    setDisplayFrame(finalFrame);
    if (wasPlayingBeforeScrub.current && v && !frameReviewActiveRef.current) {
      v.playbackRate = playbackRateRef.current;
      v.play().catch(() => {});
    }
    // If the user scrubbed into a different segment's range, retarget the tracked segment
    // immediately so the loop/snap-back effect doesn't yank playback back to the old one, and
    // let the parent know so its own "active segment" state (labels, tabs) stays in sync.
    if (segments.length > 0) {
      const matchedIndex = segments.findIndex((s) => finalFrame >= s.startFrame && finalFrame < s.endFrame);
      if (matchedIndex !== -1 && matchedIndex !== prevSegmentIndexRef.current) {
        prevSegmentIndexRef.current = matchedIndex;
        loopSegmentIndexRef.current = matchedIndex;
        onSegmentNavigate?.(matchedIndex);
      }
    }
    // Keep overlay visible briefly to mask the video seek decode latency, then fade out
    window.setTimeout(() => setIsScrubbingState(false), 80);
    showControls();
  }, [onSegmentNavigate, segments, showControls]);

  // ── Keyboard handler ──────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const video = videoRef.current;
      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlayback();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (frameReviewActive) loadReviewFrame(frameReviewIndex - 1);
          else if (video) {
            video.pause();
            video.currentTime = Math.max(0, video.currentTime - 1 / normalizedFps);
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (frameReviewActive) loadReviewFrame(frameReviewIndex + 1);
          else if (video) {
            video.pause();
            video.currentTime = Math.min(totalSec, video.currentTime + 1 / normalizedFps);
          }
          break;
        case ',':
          event.preventDefault();
          if (frameReviewActive) loadReviewFrame(frameReviewIndex - 1);
          else enterFrameReview();
          break;
        case '.':
          event.preventDefault();
          if (frameReviewActive) loadReviewFrame(frameReviewIndex + 1);
          else enterFrameReview();
          break;
        case 'j':
          if (video && !frameReviewActive) video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'l':
          if (video && !frameReviewActive) video.currentTime = Math.min(totalSec, video.currentTime + 10);
          break;
        case 'f':
          event.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          toggleMute();
          break;
        case '+':
        case '=':
          event.preventDefault();
          adjustZoom(0.5);
          break;
        case '-':
        case '_':
          event.preventDefault();
          adjustZoom(-0.5);
          break;
        case 'Escape':
          if (frameReviewActive) exitFrameReview();
          else if (zoom > 1) resetZoomPan();
          break;
        default:
          if (event.key >= '0' && event.key <= '9' && video && !frameReviewActive) {
            video.currentTime = totalSec * (parseInt(event.key) / 10);
          }
      }
    },
    [
      adjustZoom,
      enterFrameReview,
      exitFrameReview,
      frameReviewActive,
      frameReviewIndex,
      loadReviewFrame,
      normalizedFps,
      resetZoomPan,
      toggleFullscreen,
      toggleMute,
      togglePlayback,
      totalSec,
      zoom,
    ]
  );

  // Reset on new video URL
  useEffect(() => {
    // Cancel any in-flight scrub so syncFrame isn't permanently gated
    cancelAnimationFrame(seekRafRef.current);
    isScrubbing.current = false;
    wasPlayingBeforeScrub.current = false;
    isPanningRef.current = false;
    hasPannedRef.current = false;
    lastSeekTimestampRef.current = 0;
    lastPlaybackTimeRef.current = 0;
    lastLoopSeekAtRef.current = 0;
    setCurrentFrame(0);
    setDisplayFrame(0);
    setPlaying(false);
    setFrameReviewActive(false);
    frameReviewActiveRef.current = false;
    setFrameReviewUrl('');
    setIsPanning(false);
    setIsScrubbingState(false);
    setVideoError(null);
    setVideoErrorRecoverable(true);
    setRenderKey((k) => k + 1);
    prevSegmentIndexRef.current = undefined;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [videoUrl]);

  const progressPct = (displayFrame / Math.max(frameMax - 1, 1)) * 100;
  const mediaCursor = isPanning ? 'grabbing' : zoom > 1 ? 'grab' : (playing && !controlsVisible && !frameReviewActive ? 'none' : 'pointer');

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={`relative flex flex-col bg-black select-none outline-none ${isFullscreen ? 'h-screen' : ''}`}
      onMouseMove={showControls}
      onKeyDown={handleKeyDown}
    >
      {/* ── Video / Frame area ── */}
      <div
        ref={mediaAreaRef}
        className="relative flex-1 min-h-[220px] bg-black overflow-hidden"
        style={{ cursor: mediaCursor }}
        onClick={handleMediaClick}
        onPointerDown={handleMediaPointerDown}
        onPointerMove={handleMediaPointerMove}
        onPointerUp={handleMediaPointerUp}
        onPointerCancel={() => { isPanningRef.current = false; hasPannedRef.current = false; setIsPanning(false); }}
      >
        {/* Zoom / pan transform wrapper */}
        <div
          style={{
            transform: zoom !== 1 || pan.x !== 0 || pan.y !== 0
              ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              : undefined,
            transformOrigin: 'center center',
            width: '100%',
            height: '100%',
          }}
        >
          <video
            key={`${videoUrl}-${renderKey}`}
            ref={videoRef}
            src={videoUrl}
            preload="auto"
            className={`h-full w-full bg-black object-contain ${isFullscreen ? '' : 'max-h-[70vh]'} ${frameReviewActive ? 'invisible absolute' : 'visible'}`}
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = playbackRate;
              syncFrame();
            }}
            onTimeUpdate={syncFrame}
            onSeeked={syncFrame}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onVolumeChange={(e) => {
              setMuted(e.currentTarget.muted);
              setVolume(e.currentTarget.volume);
            }}
            onError={(e) => {
              const code = e.currentTarget.error?.code;
              const message =
                code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                  ? 'This video could not be loaded. The file may be missing or corrupted.'
                  : code === MediaError.MEDIA_ERR_NETWORK
                  ? 'Video failed to load — check your connection or sign-in status, then retry.'
                  : 'Video playback failed unexpectedly.';
              setVideoError(message);
              setVideoErrorRecoverable(true);
              setPlaying(false);
            }}
          />

          {videoError && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/85 p-4 text-center text-sm text-white">
              <span>{videoError}</span>
              {videoErrorRecoverable && (
              <button
                type="button"
                className="rounded bg-white/10 px-3 py-1.5 hover:bg-white/20"
                onClick={() => {
                  setVideoError(null);
                  setRenderKey((k) => k + 1);
                }}
              >
                Retry
              </button>
              )}
            </div>
          )}

          {frameReviewActive && (
            <div
              className={`flex items-center justify-center bg-black ${isFullscreen ? 'h-full' : 'min-h-[220px] max-h-[70vh]'} w-full`}
            >
              {frameReviewUrl ? (
                <img
                  key={frameReviewUrl}
                  src={frameReviewUrl}
                  alt={`Frame ${frameReviewIndex + 1}`}
                  className="max-h-full w-full object-contain"
                  draggable={false}
                />
              ) : (
                <span className="text-sm text-zinc-600">Loading frame...</span>
              )}
            </div>
          )}

          {/* Scrub overlay — always in DOM for zero-latency src updates; fades in/out via CSS */}
          <img
            ref={scrubOverlayRef}
            alt=""
            draggable={false}
            className={`pointer-events-none absolute inset-0 z-10 h-full w-full bg-black object-contain transition-opacity duration-75 ${
              isScrubbingState && getFrameUrl ? 'opacity-100' : 'opacity-0'
            }`}
          />
        </div>

        {/* Centre play indicator — outside transform so it stays centred when zoomed */}
        {!playing && !frameReviewActive && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/50">
              <Play className="h-8 w-8 translate-x-0.5 text-white" />
            </div>
          </div>
        )}

        {/* Zoom level badge */}
        {zoom > 1 && (
          <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs tabular-nums text-white">
            {(Math.round(zoom * 10) / 10).toFixed(1)}×
          </div>
        )}
      </div>

      {/* ── Controls bar ── */}
      <div
        className={`relative z-10 flex flex-col gap-1 bg-zinc-950/95 px-3 pt-2 pb-3 transition-opacity duration-300 ${
          controlsVisible || !playing || frameReviewActive || segments.length > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Segment timeline */}
        <div className="relative">
          {segments.length > 0 && (
            <div className="mb-1 flex gap-3 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
              {segments.map((seg, i) => (
                <button
                  key={`seg-tab-${seg.studyId}-${i}`}
                  type="button"
                  className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
                    activeSegment?.studyId === seg.studyId && activeSegment?.startFrame === seg.startFrame
                      ? 'bg-white/10 text-white'
                      : 'text-zinc-500 hover:text-zinc-200'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const video = videoRef.current;
                    if (video) {
                      video.currentTime = seg.startSec;
                      video.playbackRate = playbackRate;
                      video.play().catch(() => {});
                    }
                    onSegmentNavigate?.(i);
                  }}
                  title={`Jump to: ${seg.label}`}
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
                  />
                  <span className="max-w-[140px] truncate preserve-case">{seg.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Progress track */}
          <div
            className="relative h-8 cursor-pointer"
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={() => setTooltip(null)}
            onPointerDown={handleTimelinePointerDown}
            onPointerMove={handleTimelinePointerMove}
            onPointerUp={handleTimelinePointerUp}
            onPointerCancel={handleTimelinePointerUp}
          >
            {/* Track bg */}
            <div className="absolute top-3 left-0 right-0 h-2 overflow-hidden rounded-full bg-zinc-700">
              {segments.map((seg, i) => (
                <div
                  key={`band-${seg.studyId}-${i}`}
                  className="absolute top-0 h-full opacity-50"
                  style={{
                    left: `${(seg.startFrame / frameMax) * 100}%`,
                    width: `${((seg.endFrame - seg.startFrame) / frameMax) * 100}%`,
                    backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                  }}
                />
              ))}
              <div
                className="absolute left-0 top-0 h-full bg-white/50 pointer-events-none"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {/* Segment boundary ticks */}
            {segments.slice(1).map((seg, i) => (
              <div
                key={`tick-${seg.studyId}-${i}`}
                className="absolute top-2 h-4 w-px bg-zinc-950/70 pointer-events-none"
                style={{ left: `${(seg.startFrame / frameMax) * 100}%` }}
              />
            ))}

            {/* Playhead thumb */}
            <div
              className="pointer-events-none absolute top-1.5 -translate-x-1/2"
              style={{ left: `${progressPct}%` }}
            >
              <div className="h-5 w-3 rounded-full bg-white shadow-lg" />
            </div>

            {/* Hover tooltip with optional frame thumbnail */}
            {tooltip && (
              <div
                className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 overflow-hidden rounded-md bg-zinc-900 shadow-lg"
                style={{ left: `clamp(72px, ${tooltip.x}px, calc(100% - 72px))` }}
              >
                {getFrameUrl && (
                  <img
                    src={getFrameUrl(tooltip.frame)}
                    alt=""
                    className="block h-20 w-36 bg-black object-contain"
                    draggable={false}
                  />
                )}
                <div className="px-2 py-1 text-xs text-white">
                  <div className="tabular-nums">{tooltip.time}</div>
                  {tooltip.label && (
                    <div className="mt-0.5 max-w-[144px] truncate text-zinc-400 preserve-case">{tooltip.label}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Transport row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Left: transport + volume */}
          <div className="flex items-center gap-1">
            <ControlBtn onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; }} title="Restart">
              <RotateCcw className="h-3.5 w-3.5" />
            </ControlBtn>

            <ControlBtn
              onClick={() => {
                if (frameReviewActive) { loadReviewFrame(frameReviewIndex - 1); return; }
                const v = videoRef.current;
                if (v) { v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / normalizedFps); }
              }}
              title="Previous frame (←)"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </ControlBtn>

            <button
              type="button"
              className="mx-1 flex h-8 w-8 items-center justify-center rounded-full bg-white text-zinc-900 transition-colors hover:bg-zinc-200 active:scale-95"
              onClick={(e) => { e.stopPropagation(); togglePlayback(); }}
              title="Play / Pause (Space)"
            >
              {playing && !frameReviewActive
                ? <Pause className="h-4 w-4" />
                : <Play className="h-4 w-4 translate-x-px" />}
            </button>

            <ControlBtn
              onClick={() => {
                if (frameReviewActive) { loadReviewFrame(frameReviewIndex + 1); return; }
                const v = videoRef.current;
                if (v) { v.pause(); v.currentTime = Math.min(totalSec, v.currentTime + 1 / normalizedFps); }
              }}
              title="Next frame (→)"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </ControlBtn>

            <ControlBtn onClick={toggleMute} title="Mute (M)">
              {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </ControlBtn>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                if (videoRef.current) {
                  videoRef.current.volume = v;
                  videoRef.current.muted = v === 0;
                  setMuted(v === 0);
                }
              }}
              className="w-16 cursor-pointer accent-white"
              aria-label="Volume"
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          {/* Centre: time display */}
          <div className="flex min-w-0 items-center gap-3 text-xs text-zinc-400">
            <span className="tabular-nums">
              {formatVideoTime(frameReviewActive ? frameReviewIndex / normalizedFps : displayFrame / normalizedFps, 3)}
              {' / '}
              {formatVideoTime(totalSec, 3)}
            </span>
            {frameReviewActive ? (
              <span className="text-amber-400">
                Frame {frameReviewIndex + 1}/{frameMax} · scroll or , / . to step
              </span>
            ) : (
              activeSegment && (
                <span className="max-w-[200px] truncate text-zinc-300 preserve-case">{activeSegment.label}</span>
              )
            )}
          </div>

          {/* Right: zoom + speed + frame review + fullscreen */}
          <div className="flex items-center gap-1">
            {/* Zoom controls */}
            <ControlBtn onClick={() => adjustZoom(-0.5)} title="Zoom out (-)">
              <ZoomOut className="h-3.5 w-3.5" />
            </ControlBtn>
            {zoom > 1 ? (
              <button
                type="button"
                className="min-w-[38px] rounded px-1.5 py-0.5 text-center text-xs tabular-nums text-amber-400 hover:bg-zinc-700"
                onClick={(e) => { e.stopPropagation(); resetZoomPan(); }}
                title="Reset zoom (Esc)"
              >
                {(Math.round(zoom * 10) / 10).toFixed(1)}×
              </button>
            ) : (
              <span className="min-w-[38px] text-center text-xs text-zinc-600">1×</span>
            )}
            <ControlBtn onClick={() => adjustZoom(0.5)} title="Zoom in (+)">
              <ZoomIn className="h-3.5 w-3.5" />
            </ControlBtn>

            <div className="mx-1 h-4 w-px bg-zinc-700" />

            {PLAYBACK_RATES.map((rate) => (
              <button
                key={`rate-${rate}`}
                type="button"
                className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                  playbackRate === rate && !frameReviewActive
                    ? 'bg-white text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-700 hover:text-white'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  changeRate(rate);
                  if (frameReviewActive) exitFrameReview();
                }}
                title={`${rate}x speed`}
              >
                {rate}x
              </button>
            ))}

            {getFrameUrl && (
              <button
                type="button"
                className={`ml-1 flex h-7 items-center gap-1 rounded px-2 text-xs transition-colors ${
                  frameReviewActive
                    ? 'bg-amber-500 text-white'
                    : 'text-zinc-500 hover:bg-zinc-700 hover:text-white'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (frameReviewActive) exitFrameReview();
                  else enterFrameReview();
                }}
                title="Frame-by-frame review (, / .)"
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Frames</span>
              </button>
            )}

            <ControlBtn onClick={toggleFullscreen} title="Fullscreen (F)">
              {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </ControlBtn>
          </div>
        </div>

        {/* Keyboard hint */}
        <div className="mt-0.5 text-[10px] text-zinc-600">
          Space · J/K/L 10s · ←/→ frame · ,/. frame review · 0–9 seek · F fullscreen · M mute · scroll/+/- zoom · drag to pan
        </div>
      </div>
    </div>
  );
}

function ControlBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white active:scale-95"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
    >
      {children}
    </button>
  );
}
