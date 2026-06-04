import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Mic, Paperclip, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  addStudyReport,
  deleteSavedCaseStream,
  downloadSavedCaseStream,
  fetchStudyById,
  getSavedCaseStreamPresentation,
  listSavedCaseStreams,
  repairSavedCaseStream,
  updateStudyTechNotes,
  type CaseReport,
  type CaseStreamLibraryItem,
  type CaseStreamPresentationManifest,
  type Study,
} from '@/lib/api';
import {
  getNextCasePresentationIndex,
  getPreviousCasePresentationIndex,
} from '@/lib/caseStreamPresentation';
import { useAuth } from '@/context/AuthContext';

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: {
    transcript: string;
  };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
}

function formatDictationTranscript(transcript: string) {
  return transcript
    .trim()
    .replace(/\bnew paragraph\b/gi, '\n\n')
    .replace(/\bnew line\b|\bnewline\b/gi, '\n')
    .replace(/\bquestion mark\b/gi, '?')
    .replace(/\bexclamation point\b|\bexclamation mark\b/gi, '!')
    .replace(/\bfull stop\b|\bperiod\b/gi, '.')
    .replace(/\bcomma\b/gi, ',')
    .replace(/\bcolon\b/gi, ':')
    .replace(/\bsemicolon\b/gi, ';')
    .replace(/\bdash\b|\bhyphen\b/gi, '-')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])(?=\S)/g, '$1 ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .toUpperCase();
}

function appendDictatedText(current: string, transcript: string) {
  const cleanTranscript = formatDictationTranscript(transcript);
  if (!cleanTranscript) return current;
  const cleanCurrent = current.trimEnd();
  if (!cleanCurrent) return cleanTranscript;
  if (/^[,.!?;:]/.test(cleanTranscript)) return `${cleanCurrent}${cleanTranscript}`;
  if (cleanTranscript.startsWith('\n')) return `${cleanCurrent}${cleanTranscript}`;
  return `${cleanCurrent} ${cleanTranscript}`;
}

export default function Streams() {
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const [items, setItems] = useState<CaseStreamLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [libraryUnavailable, setLibraryUnavailable] = useState(false);
  const [activeStreamId, setActiveStreamId] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [presentingCases, setPresentingCases] = useState(false);
  const [activeCaseIndex, setActiveCaseIndex] = useState(0);
  const [presentationManifest, setPresentationManifest] = useState<CaseStreamPresentationManifest | null>(null);
  const [loadingActionId, setLoadingActionId] = useState('');
  const [repairingStreamId, setRepairingStreamId] = useState('');
  const [presentationStatus, setPresentationStatus] = useState('');
  const [caseTechNotes, setCaseTechNotes] = useState<Record<number, string>>({});
  const [caseTechNotesUnavailable, setCaseTechNotesUnavailable] = useState<Record<number, boolean>>({});
  const [techNotesDraft, setTechNotesDraft] = useState('');
  const [loadingTechNotesStudyId, setLoadingTechNotesStudyId] = useState<number | null>(null);
  const [savingTechNotes, setSavingTechNotes] = useState(false);
  const [dictatingStudyId, setDictatingStudyId] = useState<number | null>(null);
  const [caseReports, setCaseReports] = useState<Record<number, CaseReport[]>>({});
  const [reportTitle, setReportTitle] = useState('');
  const [reportText, setReportText] = useState('');
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [savingReport, setSavingReport] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const techNotesTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const reportFileInputRef = useRef<HTMLInputElement | null>(null);
  const activeCaseStudyIdRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationStudyIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLibraryUnavailable(false);
      const streams = await listSavedCaseStreams({ auth: studyApiAuth });
      setItems(streams);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load streams';
      if (message.toLowerCase().includes('route not found')) {
        setLibraryUnavailable(true);
        setItems([]);
      } else {
        toast.error(message);
      }
    } finally {
      setLoading(false);
    }
  }, [studyApiAuth]);

  useEffect(() => {
    load();
  }, [load]);

  const activeItem = useMemo(() => items.find((item) => item.id === activeStreamId) || null, [items, activeStreamId]);
  const caseSegments = useMemo(
    () =>
      presentationManifest?.cases.map((item) => ({
        index: item.index,
        studyId: item.study_id,
        label: item.label,
        startSec: item.start_sec,
        endSec: item.end_sec,
      })) || [],
    [presentationManifest]
  );
  const activeCaseSegment = presentingCases ? caseSegments[activeCaseIndex] || null : null;

  useEffect(() => {
    activeCaseStudyIdRef.current = activeCaseSegment?.studyId ?? null;
  }, [activeCaseSegment]);

  useEffect(() => {
    if (dictationStudyIdRef.current && activeCaseSegment?.studyId !== dictationStudyIdRef.current) {
      recognitionRef.current?.stop();
    }
  }, [activeCaseSegment]);

  useEffect(() => {
    if (!presentingCases || !activeCaseSegment || !studyApiAuth) {
      setTechNotesDraft('');
      return;
    }

    const studyId = activeCaseSegment.studyId;
    if (Object.prototype.hasOwnProperty.call(caseTechNotes, studyId)) {
      setTechNotesDraft(caseTechNotes[studyId] || '');
      return;
    }

    let cancelled = false;
    setLoadingTechNotesStudyId(studyId);
    setTechNotesDraft('');

    fetchStudyById(studyId, { auth: studyApiAuth })
      .then((response) => {
        if (cancelled) return;
        const study = (response as { study?: Study }).study;
        const notes = study?.tech_notes || '';
        const reports = Array.isArray(study?.case_reports) ? study.case_reports : [];
        setCaseTechNotes((prev) => ({ ...prev, [studyId]: notes }));
        setCaseReports((prev) => ({ ...prev, [studyId]: reports }));
        setTechNotesDraft(notes);
      })
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load tech notes';
          if (message.toLowerCase().includes('study not found')) {
            setCaseTechNotesUnavailable((prev) => ({ ...prev, [studyId]: true }));
            setCaseTechNotes((prev) => ({ ...prev, [studyId]: '' }));
            return;
          }
          toast.error(message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTechNotesStudyId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCaseSegment, caseTechNotes, presentingCases, studyApiAuth]);

  useEffect(() => {
    setReportTitle('');
    setReportText('');
    setReportFile(null);
    if (reportFileInputRef.current) {
      reportFileInputRef.current.value = '';
    }
  }, [activeCaseSegment]);

  useEffect(() => {
    if (!presentingCases || !activeCaseSegment || !videoRef.current) return;
    const video = videoRef.current;
    video.currentTime = activeCaseSegment.startSec;
    video.playbackRate = playbackRate;
    video.play().catch(() => {});
  }, [activeCaseSegment, playbackRate, presentingCases, videoUrl]);

  const playStream = async (item: CaseStreamLibraryItem, options?: { presentCases?: boolean }) => {
    const shouldPresentCases = Boolean(options?.presentCases);

    try {
      setLoadingActionId(`${item.id}:${shouldPresentCases ? 'present' : 'play'}`);
      setPresentationStatus(shouldPresentCases ? 'Loading case presentation manifest...' : '');
      if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
      setActiveStreamId(item.id);
      setPlaybackRate(1);
      setActiveCaseIndex(0);

      let playableItem = item;
      if (!playableItem.video_available) {
        if (!studyApiAuth) {
          throw new Error('This stream needs to be rebuilt by a signed-in user before playback.');
        }
        setRepairingStreamId(item.id);
        setPresentationStatus('Rebuilding saved stream video...');
        toast.message('Rebuilding saved stream video. This can take a minute for longer streams.');
        playableItem = await repairSavedCaseStream(item.id, { auth: studyApiAuth });
        setItems((prev) => prev.map((entry) => (entry.id === playableItem.id ? playableItem : entry)));
      }

      if (shouldPresentCases) {
        const manifest = await getSavedCaseStreamPresentation(playableItem.id, { auth: studyApiAuth });
        setPresentationStatus(`Loaded ${manifest.case_count} cases. Preparing video...`);
        setPresentationManifest(manifest);
        setPresentingCases(true);
        setVideoUrl(manifest.video_url || `/api/case-stream/jobs/${encodeURIComponent(manifest.job_id)}/download`);
        return;
      }

      const { blob } = await downloadSavedCaseStream(playableItem.id, { auth: studyApiAuth });
      const nextUrl = URL.createObjectURL(blob);
      setPresentationManifest(null);
      setPresentingCases(false);
      setVideoUrl(nextUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stream video';
      setPresentationStatus(message);
      toast.error(message);
    } finally {
      setLoadingActionId('');
      setRepairingStreamId('');
    }
  };

  const removeStream = async (item: CaseStreamLibraryItem) => {
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }

    try {
      await deleteSavedCaseStream(item.id, { auth: studyApiAuth });
      setItems((prev) => prev.filter((entry) => entry.id !== item.id));
      if (activeStreamId === item.id) {
        if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
        setVideoUrl('');
        setActiveStreamId('');
        setPresentingCases(false);
        setActiveCaseIndex(0);
        setPresentationManifest(null);
        setPresentationStatus('');
      }
      toast.success('Stream removed from library');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove stream');
    }
  };

  const seekToCaseIndex = (nextIndex: number) => {
    const nextSegment = caseSegments[nextIndex];
    if (!nextSegment || !videoRef.current) return;
    setActiveCaseIndex(nextIndex);
    videoRef.current.currentTime = nextSegment.startSec;
    videoRef.current.play().catch(() => {});
  };

  const saveTechNotes = async () => {
    if (!activeCaseSegment || !studyApiAuth) return;

    const studyId = activeCaseSegment.studyId;
    try {
      setSavingTechNotes(true);
      const result = await updateStudyTechNotes(studyId, techNotesDraft, { auth: studyApiAuth });
      const notes = result.study?.tech_notes ?? techNotesDraft;
      setCaseTechNotes((prev) => ({ ...prev, [studyId]: notes }));
      if (activeCaseStudyIdRef.current === studyId) {
        setTechNotesDraft(notes);
      }
      toast.success('Tech notes saved to this case');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save tech notes');
    } finally {
      setSavingTechNotes(false);
    }
  };

  const transformSelectedTechNotes = (transform: (value: string) => string) => {
    const textarea = techNotesTextareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) {
      toast.error('Highlight text in Tech Notes first.');
      return;
    }

    const replacement = transform(techNotesDraft.slice(start, end));
    const nextDraft = `${techNotesDraft.slice(0, start)}${replacement}${techNotesDraft.slice(end)}`;
    setTechNotesDraft(nextDraft);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start + replacement.length);
    });
  };

  const saveCaseReport = async () => {
    if (!activeCaseSegment || !studyApiAuth) return;
    if (!reportFile && !reportText.trim()) {
      toast.error('Attach a report file or enter report text.');
      return;
    }

    const studyId = activeCaseSegment.studyId;
    try {
      setSavingReport(true);
      const result = await addStudyReport(
        studyId,
        {
          title: reportTitle.trim() || `${activeCaseSegment.label} report`,
          caseLabel: activeCaseSegment.label,
          reportType: reportFile ? undefined : 'notepad',
          textReport: reportText,
          file: reportFile,
        },
        { auth: studyApiAuth }
      );
      setCaseReports((prev) => ({ ...prev, [studyId]: result.reports || [] }));
      setReportTitle('');
      setReportText('');
      setReportFile(null);
      if (reportFileInputRef.current) {
        reportFileInputRef.current.value = '';
      }
      toast.success('Report saved to this case');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save report');
    } finally {
      setSavingReport(false);
    }
  };

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    dictationStudyIdRef.current = null;
    setDictatingStudyId(null);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const startDictation = async () => {
    if (!activeCaseSegment) return;

    const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor) {
      toast.error('Dictation is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error('This browser cannot request microphone access.');
      return;
    }

    const studyId = activeCaseSegment.studyId;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });

      recognitionRef.current?.stop();
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';
      dictationStudyIdRef.current = studyId;
      recognitionRef.current = recognition;

      recognition.onresult = (event) => {
        let transcript = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result?.isFinal) {
            transcript += ` ${result[0]?.transcript || ''}`;
          }
        }
        if (!transcript.trim() || activeCaseStudyIdRef.current !== studyId) return;
        setTechNotesDraft((prev) => appendDictatedText(prev, transcript));
      };

      recognition.onerror = (event) => {
        const error = event.error || event.message || 'Dictation failed';
        if (error !== 'no-speech') {
          toast.error(`Dictation stopped: ${error}`);
        }
      };

      recognition.onend = () => {
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
          dictationStudyIdRef.current = null;
          setDictatingStudyId(null);
        }
      };

      recognition.start();
      setDictatingStudyId(studyId);
      toast.success('Dictation started');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone permission was not granted.';
      toast.error(message);
      stopDictation();
    }
  };

  const loopActiveCaseSegment = useCallback((video: HTMLVideoElement) => {
    if (!activeCaseSegment) return;
    const loopBoundarySlack = 0.08;
    if (
      video.currentTime < activeCaseSegment.startSec - loopBoundarySlack ||
      video.currentTime >= activeCaseSegment.endSec - loopBoundarySlack
    ) {
      video.currentTime = activeCaseSegment.startSec;
      video.play().catch(() => {});
    }
  }, [activeCaseSegment]);

  useEffect(() => {
    if (!presentingCases || !activeCaseSegment) return;
    let frameId = 0;

    const tick = () => {
      if (videoRef.current) {
        loopActiveCaseSegment(videoRef.current);
      }
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [activeCaseSegment, loopActiveCaseSegment, presentingCases]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Streams</h1>
        <p className="mt-1 text-sm text-muted-foreground">Saved case streams for quick reference and prior review.</p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading streams...</div>
      ) : libraryUnavailable ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          Streams library is not available on this API version yet. Please restart/update `mapdr-api` to enable saved streams.
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">No saved streams yet.</div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Created</th>
                <th className="px-3 py-2 text-left">Studies</th>
                <th className="px-3 py-2 text-left">FPS</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium preserve-case">{item.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{new Date(item.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(item.requested_study_ids || []).slice(0, 5).map((studyId) => (
                        <Badge key={`${item.id}-study-${studyId}`} variant="secondary">#{studyId}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{item.fps || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={loadingActionId === `${item.id}:play`}
                        onClick={() => playStream(item)}
                      >
                        {repairingStreamId === item.id
                          ? 'Rebuilding...'
                          : loadingActionId === `${item.id}:play`
                            ? 'Loading...'
                            : item.video_available
                              ? 'Play'
                              : 'Repair & Play'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={item.presentation_case_count === 0 || loadingActionId === `${item.id}:present`}
                        onClick={() => playStream(item, { presentCases: true })}
                      >
                        {repairingStreamId === item.id
                          ? 'Rebuilding...'
                          : loadingActionId === `${item.id}:present`
                            ? 'Preparing...'
                            : item.video_available
                              ? 'Present Cases'
                              : 'Repair & Present'}
                      </Button>
                      <Button size="sm" variant="outline" asChild>
                        <Link to="/studies">Open Studies</Link>
                      </Button>
                      {studyApiAuth && (
                        <Button size="sm" variant="destructive" onClick={() => removeStream(item)}>Remove</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {videoUrl && activeItem && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium preserve-case">
              {presentingCases ? 'Presenting Cases' : 'Now Playing'}: {activeItem.name}
            </div>
            {presentingCases && activeCaseSegment && (
              <Badge variant="secondary">
                Case {activeCaseIndex + 1} of {caseSegments.length}
              </Badge>
            )}
          </div>
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            preload="metadata"
            ref={videoRef}
            className="w-full rounded-md bg-black"
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = playbackRate;
              if (activeCaseSegment) {
                event.currentTarget.currentTime = activeCaseSegment.startSec;
                event.currentTarget.play().catch(() => {});
              }
            }}
            onTimeUpdate={(event) => loopActiveCaseSegment(event.currentTarget)}
            onEnded={(event) => loopActiveCaseSegment(event.currentTarget)}
            onError={() => toast.error('This stream could not be decoded by the browser.')}
          />
          {presentingCases && activeCaseSegment && (
            <div className="space-y-3 rounded-md bg-muted/40 px-3 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium preserve-case">{activeCaseSegment.label}</div>
                  <div className="text-xs text-muted-foreground">Study #{activeCaseSegment.studyId}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-muted-foreground" htmlFor="stream-case-selector">
                    Case
                  </label>
                  <select
                    id="stream-case-selector"
                    value={activeCaseIndex}
                    onChange={(event) => seekToCaseIndex(Number(event.target.value))}
                    className="h-9 max-w-[280px] rounded-md border border-input bg-background px-2 text-sm preserve-case"
                  >
                    {caseSegments.map((segment, index) => (
                      <option key={`${segment.studyId}-${segment.startSec}`} value={index}>
                        {index + 1}. {segment.label} - Study #{segment.studyId}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={activeCaseIndex === 0}
                    onClick={() => seekToCaseIndex(getPreviousCasePresentationIndex(activeCaseIndex, caseSegments))}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={activeCaseIndex >= caseSegments.length - 1}
                    onClick={() => seekToCaseIndex(getNextCasePresentationIndex(activeCaseIndex, caseSegments))}
                  >
                    Next
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Tech Notes</div>
                  {loadingTechNotesStudyId === activeCaseSegment.studyId && (
                    <div className="text-xs text-muted-foreground">Loading...</div>
                  )}
                  {caseTechNotesUnavailable[activeCaseSegment.studyId] && (
                    <div className="text-xs text-muted-foreground">Case record unavailable</div>
                  )}
                </div>
                <Textarea
                  ref={techNotesTextareaRef}
                  value={techNotesDraft}
                  onChange={(event) => setTechNotesDraft(event.target.value)}
                  rows={4}
                  placeholder="Add technical notes for this case..."
                  disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || loadingTechNotesStudyId === activeCaseSegment.studyId || savingTechNotes}
                  className="bg-background"
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => transformSelectedTechNotes((value) => value.toUpperCase())}
                    disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || loadingTechNotesStudyId === activeCaseSegment.studyId || savingTechNotes}
                    title="Make selected text uppercase"
                  >
                    AA
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => transformSelectedTechNotes((value) => value.toLowerCase())}
                    disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || loadingTechNotesStudyId === activeCaseSegment.studyId || savingTechNotes}
                    title="Make selected text lowercase"
                  >
                    aa
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={dictatingStudyId === activeCaseSegment.studyId ? 'destructive' : 'outline'}
                    onClick={dictatingStudyId === activeCaseSegment.studyId ? stopDictation : startDictation}
                    disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || loadingTechNotesStudyId === activeCaseSegment.studyId || savingTechNotes}
                    title={dictatingStudyId === activeCaseSegment.studyId ? 'Stop dictation' : 'Start dictation'}
                  >
                    {dictatingStudyId === activeCaseSegment.studyId ? (
                      <Square className="mr-2 h-4 w-4" />
                    ) : (
                      <Mic className="mr-2 h-4 w-4" />
                    )}
                    {dictatingStudyId === activeCaseSegment.studyId ? 'Stop Dictation' : 'Dictate'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={saveTechNotes}
                    disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || loadingTechNotesStudyId === activeCaseSegment.studyId || savingTechNotes}
                  >
                    {savingTechNotes ? 'Saving...' : 'Save Tech Notes'}
                  </Button>
                </div>
              </div>
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Reports</div>
                  <div className="text-xs text-muted-foreground">
                    {(caseReports[activeCaseSegment.studyId] || []).length} saved
                  </div>
                </div>
                {(caseReports[activeCaseSegment.studyId] || []).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {(caseReports[activeCaseSegment.studyId] || []).slice(-4).map((report) => (
                      <a
                        key={report.id}
                        href={report.report_url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-[260px] items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs preserve-case"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{report.title || report.filename || 'Report'}</span>
                      </a>
                    ))}
                  </div>
                )}
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                  <input
                    value={reportTitle}
                    onChange={(event) => setReportTitle(event.target.value)}
                    placeholder="Report title"
                    disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || savingReport}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm preserve-case"
                  />
                  <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                    <Paperclip className="h-4 w-4" />
                    <span className="max-w-[180px] truncate preserve-case">{reportFile ? reportFile.name : 'Attach File'}</span>
                    <input
                      ref={reportFileInputRef}
                      type="file"
                      className="hidden"
                      accept=".pdf,image/*,.txt,.md,.rtf,.csv,.doc,.docx,text/*,application/pdf"
                      disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || savingReport}
                      onChange={(event) => setReportFile(event.target.files?.[0] || null)}
                    />
                  </label>
                </div>
                <Textarea
                  value={reportText}
                  onChange={(event) => setReportText(event.target.value)}
                  rows={3}
                  placeholder="Type or paste a notepad-style report..."
                  disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || savingReport}
                  className="bg-background"
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    onClick={saveCaseReport}
                    disabled={caseTechNotesUnavailable[activeCaseSegment.studyId] || savingReport}
                  >
                    {savingReport ? 'Saving...' : 'Save Report'}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Speed:</span>
            {[0.1, 0.25, 0.5, 1, 1.5, 2].map((rate) => (
              <Button
                key={`stream-rate-${rate}`}
                type="button"
                size="sm"
                variant={playbackRate === rate ? 'default' : 'outline'}
                onClick={() => {
                  setPlaybackRate(rate);
                  if (videoRef.current) videoRef.current.playbackRate = rate;
                }}
              >
                {rate}x
              </Button>
            ))}
          </div>
        </div>
      )}
      {!videoUrl && presentationStatus && (
        <div className="rounded-lg border p-3 text-sm text-muted-foreground">
          {presentationStatus}
        </div>
      )}
    </div>
  );
}
