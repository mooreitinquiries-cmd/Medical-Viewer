import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type Hls from 'hls.js';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { formatVideoTime } from '@/lib/timeFormat';

interface VideoMetadata {
  duration?: number | null;
  fps?: number | null;
  thumbnail_interval_sec?: number | null;
  thumbnail_paths?: string[] | null;
  hls?: {
    master_playlist?: string | null;
    variants?: Array<{
      name: string;
      height: number;
      bandwidth?: number;
      playlist?: string;
    }>;
  } | null;
}

interface VideoScrubPreviewPlayerProps {
  src: string;
  metadata?: VideoMetadata | null;
  resolveMediaUrl: (rawUrl?: string | null) => string;
  className?: string;
}

const PAN_STEP = 60;

export function VideoScrubPreviewPlayer({
  src,
  metadata,
  resolveMediaUrl,
  className,
}: VideoScrubPreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaAreaRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const qualityRecoverTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const zoomRef = useRef(1);
  const isPanningRef = useRef(false);
  const hasPannedRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });

  const [duration, setDuration] = useState(Number(metadata?.duration) || 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [playbackMode, setPlaybackMode] = useState<'hls' | 'mp4'>('mp4');
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const fps = Math.max(1, Number(metadata?.fps) || 30);

  const hlsUrl = metadata?.hls?.master_playlist ? resolveMediaUrl(metadata.hls.master_playlist) : '';
  const videoPreload = useMemo<'metadata' | 'auto'>(() => {
    try {
      return window.localStorage.getItem('mapdr_video_preload') === 'auto' ? 'auto' : 'metadata';
    } catch {
      return 'metadata';
    }
  }, []);

  const thumbnailPaths = Array.isArray(metadata?.thumbnail_paths) ? metadata.thumbnail_paths : [];
  const thumbnailInterval = Math.max(Number(metadata?.thumbnail_interval_sec) || 1, 1);
  const previewUrl = useMemo(() => {
    if (thumbnailPaths.length === 0) return '';
    const index = Math.min(
      Math.max(Math.floor(scrubTime / thumbnailInterval), 0),
      thumbnailPaths.length - 1
    );
    return resolveMediaUrl(thumbnailPaths[index]);
  }, [resolveMediaUrl, scrubTime, thumbnailInterval, thumbnailPaths]);

  const maxDuration = Math.max(duration || 0, Number(metadata?.duration) || 0, 0);
  const rangeValue = Math.min(isScrubbing ? scrubTime : currentTime, maxDuration || 0);
  const previewLeftPercent = maxDuration > 0 ? Math.min(Math.max((scrubTime / maxDuration) * 100, 0), 100) : 0;

  zoomRef.current = zoom;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;

    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPlaybackMode('mp4');
    setVideoError(null);

    if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      setPlaybackMode('hls');
    } else if (hlsUrl) {
      void import('hls.js').then(({ default: HlsRuntime }) => {
        if (cancelled || !videoRef.current) return;
        if (!HlsRuntime.isSupported()) {
          videoRef.current.src = src;
          return;
        }
        const hls = new HlsRuntime({
          startLevel: -1,
          capLevelToPlayerSize: true,
          lowLatencyMode: false,
        });
        hlsRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoRef.current);
        hls.on(HlsRuntime.Events.MANIFEST_PARSED, () => {
          const levels = hls.levels || [];
          if (levels.length > 0) {
            const lowestLevel = levels.reduce(
              (lowest, level, index) => (level.height < levels[lowest].height ? index : lowest),
              0
            );
            hls.startLevel = lowestLevel;
            hls.currentLevel = lowestLevel;
            window.setTimeout(() => {
              if (hlsRef.current === hls) hls.currentLevel = -1;
            }, 1200);
          }
        });
        hls.on(HlsRuntime.Events.ERROR, (_event, data) => {
          if (cancelled || !data?.fatal) return;
          if (data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          hls.destroy();
          hlsRef.current = null;
          if (videoRef.current) {
            setPlaybackMode('mp4');
            videoRef.current.src = src;
          }
        });
        setPlaybackMode('hls');
      });
    } else {
      video.src = src;
    }

    return () => {
      cancelled = true;
      if (seekTimerRef.current) window.clearTimeout(seekTimerRef.current);
      if (qualityRecoverTimerRef.current) window.clearTimeout(qualityRecoverTimerRef.current);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [hlsUrl, src, retryToken]);

  // Reset zoom/pan when the source actually changes (new study video)
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [src]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const setLowestHlsLevel = () => {
    const hls = hlsRef.current;
    if (!hls || !hls.levels.length) return;
    const lowestLevel = hls.levels.reduce(
      (lowest, level, index) => (level.height < hls.levels[lowest].height ? index : lowest),
      0
    );
    hls.currentLevel = lowestLevel;
  };

  const recoverHlsAutoLevel = () => {
    if (qualityRecoverTimerRef.current) window.clearTimeout(qualityRecoverTimerRef.current);
    qualityRecoverTimerRef.current = window.setTimeout(() => {
      if (hlsRef.current) hlsRef.current.currentLevel = -1;
    }, 900);
  };

  const applySeek = (nextTime: number) => {
    const next = Math.min(Math.max(Number(nextTime) || 0, 0), maxDuration || 0);
    setScrubTime(next);
    setCurrentTime(next);
    if (videoRef.current) {
      videoRef.current.currentTime = next;
    }
    recoverHlsAutoLevel();
  };

  const scheduleSeek = (nextTime: number, delayMs = 180) => {
    const next = Math.min(Math.max(Number(nextTime) || 0, 0), maxDuration || 0);
    setScrubTime(next);
    setCurrentTime(next);
    if (seekTimerRef.current) window.clearTimeout(seekTimerRef.current);
    seekTimerRef.current = window.setTimeout(() => applySeek(next), delayMs);
  };

  const beginScrub = () => {
    setScrubTime(rangeValue);
    setIsScrubbing(true);
    setLowestHlsLevel();
  };

  const endScrub = () => {
    setIsScrubbing(false);
    scheduleSeek(scrubTime, 80);
  };

  // ── Transport ──────────────────────────────────────────────────────────────

  const togglePlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const stepFrame = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      const next = Math.min(Math.max(v.currentTime + delta / fps, 0), maxDuration || v.duration || 0);
      v.currentTime = next;
      setCurrentTime(next);
      setScrubTime(next);
    },
    [fps, maxDuration]
  );

  // ── Zoom / pan ─────────────────────────────────────────────────────────────

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

  const adjustZoom = useCallback(
    (step: number) => {
      setZoom((prev) => {
        const next = Math.min(8, Math.max(1, prev + step));
        if (next <= 1) {
          setPan({ x: 0, y: 0 });
          return 1;
        }
        setPan((p) => clampPan(p.x, p.y, next));
        return next;
      });
    },
    [clampPan]
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      if (zoomRef.current <= 1) return;
      setPan((p) => clampPan(p.x + dx, p.y + dy, zoomRef.current));
    },
    [clampPan]
  );

  // Native wheel listener — passive: false so we can preventDefault
  useEffect(() => {
    const el = mediaAreaRef.current;
    if (!el) return undefined;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      setZoom((prev) => {
        const next = Math.min(8, Math.max(1, prev * factor));
        if (next <= 1) {
          setPan({ x: 0, y: 0 });
          return 1;
        }
        setPan((p) => clampPan(p.x, p.y, next));
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [clampPan]);

  const handleMediaPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (zoomRef.current <= 1) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      isPanningRef.current = true;
      hasPannedRef.current = false;
      setIsPanning(true);
      panStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan]
  );

  const handleMediaPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.mouseX;
      const dy = e.clientY - panStartRef.current.mouseY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasPannedRef.current = true;
      setPan(clampPan(panStartRef.current.panX + dx, panStartRef.current.panY + dy, zoomRef.current));
    },
    [clampPan]
  );

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

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlayback();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          stepFrame(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          stepFrame(1);
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
          if (zoom > 1) resetZoomPan();
          break;
        default:
          break;
      }
    },
    [adjustZoom, resetZoomPan, stepFrame, toggleFullscreen, toggleMute, togglePlayback, zoom]
  );

  const mediaCursor = isPanning ? 'grabbing' : zoom > 1 ? 'grab' : 'pointer';

  return (
    <div
      ref={containerRef}
      className={className}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={mediaAreaRef}
        className={`relative overflow-hidden rounded border bg-black ${isFullscreen ? 'h-screen' : ''}`}
        style={{ cursor: mediaCursor }}
        onClick={handleMediaClick}
        onPointerDown={handleMediaPointerDown}
        onPointerMove={handleMediaPointerMove}
        onPointerUp={handleMediaPointerUp}
        onPointerCancel={() => { isPanningRef.current = false; hasPannedRef.current = false; setIsPanning(false); }}
      >
        <div
          style={{
            transform: zoom !== 1 || pan.x !== 0 || pan.y !== 0
              ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              : undefined,
            transformOrigin: 'center center',
          }}
        >
          <video
            ref={videoRef}
            preload={videoPreload}
            className={`w-full bg-black ${isFullscreen ? 'h-screen object-contain' : ''}`}
            onLoadedMetadata={() => {
              const nextDuration = Number(videoRef.current?.duration) || Number(metadata?.duration) || 0;
              setDuration(nextDuration);
              if (videoRef.current) {
                videoRef.current.volume = volume;
                videoRef.current.muted = muted;
              }
            }}
            onTimeUpdate={() => {
              if (!isScrubbing) {
                setCurrentTime(Number(videoRef.current?.currentTime) || 0);
              }
            }}
            onWaiting={() => setIsBuffering(true)}
            onStalled={() => setIsBuffering(true)}
            onSeeking={() => setIsBuffering(true)}
            onPlaying={() => setIsBuffering(false)}
            onCanPlay={() => setIsBuffering(false)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onVolumeChange={(e) => {
              setMuted(e.currentTarget.muted);
              setVolume(e.currentTarget.volume);
            }}
            onError={(e) => {
              // In HLS mode, transient <video> errors are handled by the hls.js ERROR
              // listener above; only surface a fatal message for direct mp4 playback.
              if (playbackMode === 'hls') return;
              const code = e.currentTarget.error?.code;
              const message =
                code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                  ? 'This video could not be loaded. The file may be missing or corrupted.'
                  : code === MediaError.MEDIA_ERR_NETWORK
                  ? 'Video failed to load — check your connection or sign-in status, then retry.'
                  : 'Video playback failed unexpectedly.';
              setVideoError(message);
              setIsBuffering(false);
              setPlaying(false);
            }}
          />
        </div>

        {isBuffering && !videoError && (
          <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-white">
            Loading
          </div>
        )}

        {videoError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/85 p-4 text-center text-sm text-white">
            <span>{videoError}</span>
            <button
              type="button"
              className="rounded bg-white/10 px-3 py-1.5 hover:bg-white/20"
              onClick={() => {
                setVideoError(null);
                setRetryToken((k) => k + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}

        {!playing && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/50">
              <Play className="h-7 w-7 translate-x-0.5 text-white" />
            </div>
          </div>
        )}

        {zoom > 1 && (
          <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs tabular-nums text-white">
            {(Math.round(zoom * 10) / 10).toFixed(1)}×
          </div>
        )}
      </div>

      {/* ── Transport + zoom/pan controls ── */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2">
        <div className="flex items-center gap-1">
          <CtrlBtn onClick={() => { if (videoRef.current) { videoRef.current.currentTime = 0; setCurrentTime(0); setScrubTime(0); } }} title="Restart">
            <RotateCcw className="h-3.5 w-3.5" />
          </CtrlBtn>
          <CtrlBtn onClick={() => stepFrame(-1)} title="Previous frame (←)">
            <ChevronLeft className="h-3.5 w-3.5" />
          </CtrlBtn>
          <button
            type="button"
            className="mx-1 flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-90 active:scale-95"
            onClick={togglePlayback}
            title="Play / Pause (Space)"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
          </button>
          <CtrlBtn onClick={() => stepFrame(1)} title="Next frame (→)">
            <ChevronRight className="h-3.5 w-3.5" />
          </CtrlBtn>
          <CtrlBtn onClick={toggleMute} title="Mute (M)">
            {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </CtrlBtn>
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
            className="w-16 cursor-pointer accent-foreground"
            aria-label="Volume"
          />
        </div>

        <div className="flex items-center gap-1">
          <CtrlBtn onClick={() => adjustZoom(-0.5)} title="Zoom out (-)">
            <ZoomOut className="h-3.5 w-3.5" />
          </CtrlBtn>
          {zoom > 1 ? (
            <button
              type="button"
              className="min-w-[38px] rounded px-1.5 py-0.5 text-center text-xs tabular-nums text-amber-500 hover:bg-muted"
              onClick={resetZoomPan}
              title="Reset zoom (Esc)"
            >
              {(Math.round(zoom * 10) / 10).toFixed(1)}×
            </button>
          ) : (
            <span className="min-w-[38px] text-center text-xs text-muted-foreground">1×</span>
          )}
          <CtrlBtn onClick={() => adjustZoom(0.5)} title="Zoom in (+)">
            <ZoomIn className="h-3.5 w-3.5" />
          </CtrlBtn>

          <div className="mx-1 h-4 w-px bg-border" />

          <CtrlBtn onClick={() => panBy(-PAN_STEP, 0)} title="Pan left" disabled={zoom <= 1}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </CtrlBtn>
          <div className="flex flex-col">
            <CtrlBtn onClick={() => panBy(0, -PAN_STEP)} title="Pan up" disabled={zoom <= 1} className="h-3.5">
              <ChevronUp className="h-3 w-3" />
            </CtrlBtn>
            <CtrlBtn onClick={() => panBy(0, PAN_STEP)} title="Pan down" disabled={zoom <= 1} className="h-3.5">
              <ChevronDown className="h-3 w-3" />
            </CtrlBtn>
          </div>
          <CtrlBtn onClick={() => panBy(PAN_STEP, 0)} title="Pan right" disabled={zoom <= 1}>
            <ChevronRight className="h-3.5 w-3.5" />
          </CtrlBtn>

          <div className="mx-1 h-4 w-px bg-border" />

          <CtrlBtn onClick={toggleFullscreen} title="Fullscreen (F)">
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </CtrlBtn>
        </div>
      </div>

      {/* ── Scrub timeline ── */}
      {maxDuration > 0 && (
        <div className="relative mt-2 rounded-md border bg-background p-2">
          {isScrubbing && previewUrl && (
            <div
              className="pointer-events-none absolute bottom-10 z-10 w-40 -translate-x-1/2 rounded-md border bg-black p-1 shadow-lg"
              style={{ left: `${previewLeftPercent}%` }}
            >
              <img src={previewUrl} alt="" className="h-24 w-full rounded object-contain" draggable={false} />
              <div className="mt-1 text-center text-[11px] font-medium text-white">
                {formatVideoTime(scrubTime, 1)}
              </div>
            </div>
          )}
          <input
            type="range"
            min={0}
            max={maxDuration}
            step={0.001}
            value={rangeValue}
            onMouseDown={beginScrub}
            onTouchStart={beginScrub}
            onInput={(event) => {
              setScrubTime(Number(event.currentTarget.value) || 0);
              setLowestHlsLevel();
            }}
            onChange={(event) => {
              setScrubTime(Number(event.target.value) || 0);
            }}
            onMouseUp={endScrub}
            onTouchEnd={endScrub}
            onKeyUp={(event) => scheduleSeek(Number(event.currentTarget.value) || 0)}
            className="w-full"
            aria-label="Scrub video timeline"
          />
          <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
            <span>{formatVideoTime(rangeValue, 1)}</span>
            <span>
              {playbackMode.toUpperCase()} · {formatVideoTime(maxDuration, 1)}
            </span>
          </div>
        </div>
      )}

      <div className="mt-1 text-[10px] text-muted-foreground">
        Space play/pause · ←/→ frame step · scroll or +/- zoom · drag or arrows to pan · F fullscreen · M mute
      </div>
    </div>
  );
}

function CtrlBtn({
  onClick,
  title,
  disabled,
  className = '',
  children,
}: {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-30 disabled:hover:bg-transparent ${className}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
