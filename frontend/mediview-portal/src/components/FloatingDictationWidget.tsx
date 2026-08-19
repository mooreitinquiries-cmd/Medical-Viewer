import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useLocation } from 'react-router-dom';
import { Mic, Mic2, Move, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { uploadStudyDictation } from '@/lib/api';
import { showErrorToast } from '@/lib/errorToast';

type TextTarget = HTMLInputElement | HTMLTextAreaElement;

type DictationMode = 'dictate' | 'dictate-record';

const WIDGET_WIDTH = 232;
const WIDGET_HEIGHT = 124;
const VIEWPORT_PADDING = 8;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

function isTextTarget(element: EventTarget | null): element is TextTarget {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  if (element instanceof HTMLInputElement) {
    const type = (element.type || 'text').toLowerCase();
    return ['text', 'search', 'email', 'tel', 'url', 'password', 'number', 'date'].includes(type);
  }
  return true;
}

function insertText(target: TextTarget, text: string) {
  const value = target.value || '';
  const start = target.selectionStart ?? value.length;
  const end = target.selectionEnd ?? value.length;
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  const spacer = prefix && !/\s$/.test(prefix) ? ' ' : '';
  const nextText = `${spacer}${text}`;
  const nextValue = `${prefix}${nextText}${suffix}`;

  target.focus();
  target.value = nextValue;
  const cursor = prefix.length + nextText.length;
  target.setSelectionRange(cursor, cursor);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function getStudyIdFromPath(pathname: string) {
  const match = pathname.match(/^\/studies\/(\d+)/);
  return match ? match[1] : '';
}

function getSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return (
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type)
    ) || ''
  );
}

function getInitialPosition() {
  if (typeof window === 'undefined') {
    return { left: 24, top: 24 };
  }
  return {
    left: Math.max(VIEWPORT_PADDING, window.innerWidth - WIDGET_WIDTH - 24),
    top: Math.max(VIEWPORT_PADDING, window.innerHeight - WIDGET_HEIGHT - 24),
  };
}

function clampPosition(left: number, top: number) {
  if (typeof window === 'undefined') {
    return { left, top };
  }
  return {
    left: Math.max(VIEWPORT_PADDING, Math.min(window.innerWidth - WIDGET_WIDTH - VIEWPORT_PADDING, left)),
    top: Math.max(VIEWPORT_PADDING, Math.min(window.innerHeight - WIDGET_HEIGHT - VIEWPORT_PADDING, top)),
  };
}

export default function FloatingDictationWidget() {
  const location = useLocation();
  const { user } = useAuth();
  const auth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const studyId = getStudyIdFromPath(location.pathname);
  const [position, setPosition] = useState(getInitialPosition);
  const [mode, setMode] = useState<DictationMode | null>(null);
  const [status, setStatus] = useState('Ready');
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<TextTarget | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef('');
  const dragRef = useRef({ active: false, pointerId: 0, startX: 0, startY: 0, originLeft: 24, originTop: 24 });
  const positionRef = useRef(position);
  const frameRef = useRef<number | null>(null);

  const paintPosition = (nextPosition: { left: number; top: number }) => {
    positionRef.current = nextPosition;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (!widgetRef.current) return;
      widgetRef.current.style.transform = `translate3d(${positionRef.current.left}px, ${positionRef.current.top}px, 0)`;
    });
  };

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      if (isTextTarget(event.target)) {
        targetRef.current = event.target;
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const handleResize = () => {
      const nextPosition = clampPosition(positionRef.current.left, positionRef.current.top);
      positionRef.current = nextPosition;
      setPosition(nextPosition);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const stopMediaStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const stopDictation = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      stopMediaStream();
      setMode(null);
      setStatus('Ready');
    }
  };

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      stopMediaStream();
    };
  }, []);

  const uploadRecording = async (blob: Blob, transcript: string) => {
    if (!studyId) {
      toast.info('Dictation audio was recorded. Open a study before recording if you want it attached to a case.');
      return;
    }
    if (!auth) {
      toast.error('Sign in before attaching dictation audio.');
      return;
    }

    setStatus('Saving MP3...');
    const file = new File([blob], `dictation-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
    await uploadStudyDictation(
      studyId,
      {
        audioFile: file,
        transcript,
        title: `Dictation ${new Date().toLocaleString()}`,
      },
      { auth }
    );
    toast.success('Dictation MP3 attached to this study');
  };

  const startDictation = async (nextMode: DictationMode) => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      toast.error('Speech dictation is not supported in this browser.');
      return;
    }
    if (!targetRef.current) {
      toast.error('Click into a text field before starting dictation.');
      return;
    }
    if (mode) {
      stopDictation();
      return;
    }

    transcriptRef.current = '';
    chunksRef.current = [];
    setMode(nextMode);
    setStatus(nextMode === 'dictate-record' ? 'Dictating + recording' : 'Dictating');

    if (nextMode === 'dictate-record') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const mimeType = getSupportedAudioMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          stopMediaStream();
          uploadRecording(blob, transcriptRef.current.trim()).catch((error) => {
            showErrorToast(error, 'Failed to attach dictation audio');
          }).finally(() => {
            setMode(null);
            setStatus('Ready');
          });
        };
        recorder.start();
      } catch (error) {
        setMode(null);
        setStatus('Ready');
        toast.error(error instanceof Error ? error.message : 'Microphone access failed');
        return;
      }
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result.isFinal) continue;
        const text = result[0].transcript.trim();
        if (!text) continue;
        transcriptRef.current = `${transcriptRef.current} ${text}`.trim();
        const target = targetRef.current;
        if (target) insertText(target, text);
      }
    };
    recognition.onerror = (event) => {
      toast.error(event.error ? `Dictation error: ${event.error}` : 'Dictation failed');
    };
    recognition.onend = () => {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
        return;
      }
      setMode(null);
      setStatus('Ready');
    };
    recognition.start();
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = widgetRef.current?.getBoundingClientRect();
    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect?.left ?? positionRef.current.left,
      originTop: rect?.top ?? positionRef.current.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return;
    const nextPosition = clampPosition(
      dragRef.current.originLeft + event.clientX - dragRef.current.startX,
      dragRef.current.originTop + event.clientY - dragRef.current.startY
    );
    paintPosition(nextPosition);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current.pointerId === event.pointerId) {
      dragRef.current.active = false;
      setPosition(positionRef.current);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current.pointerId === event.pointerId) {
      dragRef.current.active = false;
      setPosition(positionRef.current);
    }
  };

  return (
    <div
      ref={widgetRef}
      className="fixed z-50 w-[232px] rounded-lg border bg-background p-2 shadow-lg"
      style={{ left: 0, top: 0, transform: `translate3d(${position.left}px, ${position.top}px, 0)` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">Dictation</div>
          <div className="truncate text-[11px] text-muted-foreground">{status}</div>
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          aria-label="Move dictation widget"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <Move className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === 'dictate' ? 'default' : 'outline'}
          onClick={() => (mode ? stopDictation() : startDictation('dictate'))}
        >
          {mode === 'dictate' ? <Square className="mr-1.5 h-3.5 w-3.5" /> : <Mic className="mr-1.5 h-3.5 w-3.5" />}
          {mode === 'dictate' ? 'Stop' : 'Dictate'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'dictate-record' ? 'default' : 'outline'}
          onClick={() => (mode ? stopDictation() : startDictation('dictate-record'))}
        >
          {mode === 'dictate-record' ? <Square className="mr-1.5 h-3.5 w-3.5" /> : <Mic2 className="mr-1.5 h-3.5 w-3.5" />}
          {mode === 'dictate-record' ? 'Stop' : 'Record'}
        </Button>
      </div>
      {!studyId && <div className="mt-2 text-[11px] text-muted-foreground">Audio attaches when used on a study page.</div>}
    </div>
  );
}
