import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clearStudyPresence,
  setStudyPresence,
  subscribeStudyRealtime,
  type StudyPresenceEntry,
  type StudyRealtimeEvent,
  type StudyApiAuthContext,
} from '@/lib/api';

type StudyRealtimeMode = 'viewing' | 'editing' | 'signoff';

function makeClientId() {
  try {
    if (typeof window !== 'undefined') {
      const key = 'mapdr-study-realtime-client-id';
      const existing = window.sessionStorage.getItem(key);
      if (existing) return existing;
      const next = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.sessionStorage.setItem(key, next);
      return next;
    }
  } catch {
    // fall through
  }
  return globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isStudyContentChangeEvent(event: StudyRealtimeEvent): boolean {
  const name = String(event.event || '').toLowerCase();
  if (!name || name === 'connected' || name === 'snapshot' || name === 'presence.updated') {
    return false;
  }
  return name.startsWith('study.');
}

export function useStudyRealtime(options: {
  studyId?: string | number | null;
  auth?: StudyApiAuthContext;
  mode?: StudyRealtimeMode;
  enabled?: boolean;
  onEvent?: (event: StudyRealtimeEvent) => void;
  onChange?: (event: StudyRealtimeEvent) => void;
}) {
  const { studyId, auth, mode = 'viewing', enabled = true, onEvent, onChange } = options;
  const clientIdRef = useRef(makeClientId());
  const authRef = useRef(auth);
  const onEventRef = useRef(onEvent);
  const onChangeRef = useRef(onChange);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<StudyPresenceEntry[]>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const studyKey = useMemo(() => (studyId === null || studyId === undefined ? '' : String(studyId)), [studyId]);
  const authKey = useMemo(
    () => [auth?.email || '', auth?.role || '', auth?.name || ''].join('|'),
    [auth?.email, auth?.name, auth?.role]
  );

  useEffect(() => {
    authRef.current = auth;
    onEventRef.current = onEvent;
    onChangeRef.current = onChange;
  }, [auth, onChange, onEvent]);

  useEffect(() => {
    if (!enabled || !studyKey || !authRef.current?.email) return;
    let cancelled = false;

    const pulse = async () => {
      try {
        const response = await setStudyPresence(studyKey, { client_id: clientIdRef.current, mode }, { auth: authRef.current });
        if (cancelled) return;
        setPresence(Array.isArray(response.presence) ? response.presence : []);
      } catch {
        // Presence is best-effort. Realtime still functions if this blips.
      }
    };

    void pulse();
    const intervalId = window.setInterval(() => {
      void pulse();
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      clearStudyPresence(studyKey, { client_id: clientIdRef.current }, { auth: authRef.current }).catch(() => {});
    };
  }, [authKey, enabled, mode, studyKey]);

  useEffect(() => {
    if (!enabled || !studyKey || !authRef.current?.email) return;
    const subscription = subscribeStudyRealtime({
      auth: authRef.current,
      studyId: studyKey,
      clientId: clientIdRef.current,
      onConnectionChange: setConnected,
      onEvent: (event) => {
        setLastEventAt(new Date().toISOString());
        if (Array.isArray(event.presence)) {
          setPresence(event.presence);
        } else if (event.snapshot && typeof event.snapshot === 'object') {
          const snapshot = event.snapshot as { presence?: StudyPresenceEntry[] };
          if (Array.isArray(snapshot.presence)) {
            setPresence(snapshot.presence);
          }
        }
        onEventRef.current?.(event);
        if (isStudyContentChangeEvent(event)) {
          onChangeRef.current?.(event);
        }
      },
      onError: () => {
        // The hook relies on the reconnect loop in subscribeStudyRealtime.
      },
    });

    return () => {
      subscription.close();
    };
  }, [authKey, enabled, studyKey]);

  return {
    clientId: clientIdRef.current,
    connected,
    lastEventAt,
    presence,
  };
}
