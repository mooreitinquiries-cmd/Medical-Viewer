import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Search, Eye, Upload, Trash2, FileText, FileVideo, Film, Download, SkipBack, SkipForward, RotateCcw, Plus, History, GripVertical, Crop } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteSavedCaseStream,
  cancelCaseStreamJob,
  createCaseStreamJob,
  deleteStudy,
  restoreStudy,
  permanentlyDeleteStudy,
  downloadCaseStreamJob,
  fetchStudies,
  listActiveLiveCases,
  type LiveCaseSession,
  uploadStudy,
  updateStudyPriors,
  getCaseStreamJob,
  saveCaseStreamToLibrary,
  isStudyApiUnavailableError,
  type Study,
} from '@/lib/api';
import {
  buildStreamLayoutPayload,
  defaultStreamLayout,
  normalizeStreamLayout,
  type StreamLayout,
  type StreamLayoutMode,
} from '@/lib/caseStreamLayout';
import { formatVideoTime } from '@/lib/timeFormat';
import { useAuth } from '@/context/AuthContext';

const statusStyles: Record<string, string> = {
  ready: 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]',
  processing: 'bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]',
  error: 'bg-destructive/10 text-destructive',
};

export default function StudiesList() {
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const [search, setSearch] = useState('');
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingStudies, setRefreshingStudies] = useState(false);
  const [deletedStudies, setDeletedStudies] = useState<Study[]>([]);
  const [liveSessionByStudyId, setLiveSessionByStudyId] = useState<Record<number, LiveCaseSession>>({});
  const [deleteTarget, setDeleteTarget] = useState<Study | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<Study | null>(null);
  const [makeStreamOpen, setMakeStreamOpen] = useState(false);
  const [selectedStudyIds, setSelectedStudyIds] = useState<number[]>([]);
  const [showDeletedInStream, setShowDeletedInStream] = useState(false);
  const [streamLayouts, setStreamLayouts] = useState<Record<number, StreamLayout>>({});
  const [isExportingStream, setIsExportingStream] = useState(false);
  const [exportStatusText, setExportStatusText] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [streamVideoUrl, setStreamVideoUrl] = useState('');
  const [streamFilename, setStreamFilename] = useState('');
  const [streamJobId, setStreamJobId] = useState('');
  const [streamName, setStreamName] = useState('');
  const [savedStreamId, setSavedStreamId] = useState('');
  const [streamClosePromptOpen, setStreamClosePromptOpen] = useState(false);
  const [savingStreamRecord, setSavingStreamRecord] = useState(false);
  const [streamTimeline, setStreamTimeline] = useState<
    Array<{ index: number; study_id: number; label: string; frame_count: number; start_sec: number; end_sec: number }>
  >([]);
  const [activeCaseIndex, setActiveCaseIndex] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [scrubTimeSec, setScrubTimeSec] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isStreamFullscreen, setIsStreamFullscreen] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [priorEditorStudy, setPriorEditorStudy] = useState<Study | null>(null);
  const [priorSelection, setPriorSelection] = useState<number[]>([]);
  const [savingPriors, setSavingPriors] = useState(false);
  const [refreshingPriors, setRefreshingPriors] = useState(false);
  const [priorAutoSort, setPriorAutoSort] = useState(true);
  const [draggedPriorId, setDraggedPriorId] = useState<number | null>(null);
  const [priorUploadFiles, setPriorUploadFiles] = useState<File[]>([]);
  const [priorUploadPdf, setPriorUploadPdf] = useState<File | null>(null);
  const [priorUploadDate, setPriorUploadDate] = useState('');
  const [priorUploadModality, setPriorUploadModality] = useState('');
  const [priorUploading, setPriorUploading] = useState(false);
  const [loopStartSec, setLoopStartSec] = useState(0);
  const [loopEndSec, setLoopEndSec] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const streamFpsRef = useRef(24);

  const loadStudies = async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    const shouldShowInitialLoader = !silent && studies.length === 0;
    const shouldShowRefreshState = !silent && studies.length > 0;
    try {
      if (shouldShowInitialLoader) {
        setLoading(true);
      } else if (shouldShowRefreshState) {
        setRefreshingStudies(true);
      }
      const shouldRefreshDeleted = !silent || showDeletedInStream || deletedStudies.length === 0;
      const [data, deletedData, liveSessions] = await Promise.all([
        fetchStudies({ auth: studyApiAuth }),
        shouldRefreshDeleted ? fetchStudies({ deletedOnly: true, auth: studyApiAuth }) : Promise.resolve(deletedStudies),
        listActiveLiveCases(undefined, { auth: studyApiAuth }).catch(() => [] as LiveCaseSession[]),
      ]);
      const liveByStudy: Record<number, LiveCaseSession> = {};
      liveSessions.forEach((session) => {
        if (!session?.study_id) return;
        const existing = liveByStudy[session.study_id];
        if (!existing) {
          liveByStudy[session.study_id] = session;
          return;
        }
        const existingTs = new Date(existing.started_at || 0).getTime();
        const nextTs = new Date(session.started_at || 0).getTime();
        if (nextTs > existingTs) {
          liveByStudy[session.study_id] = session;
        }
      });
      setStudies(data);
      setDeletedStudies(deletedData);
      setLiveSessionByStudyId(liveByStudy);
    } catch (err) {
      console.error(err);
      if (studies.length === 0) {
        setStudies([]);
        setDeletedStudies([]);
        setLiveSessionByStudyId({});
      }

      if (!isStudyApiUnavailableError(err)) {
        toast.error('Failed to load studies');
      }
    } finally {
      if (shouldShowInitialLoader) {
        setLoading(false);
      }
      if (shouldShowRefreshState) {
        setRefreshingStudies(false);
      }
    }
  };

  useEffect(() => {
    void loadStudies();
  }, [studyApiAuth]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (priorEditorStudy || makeStreamOpen || isExportingStream) return;
      loadStudies({ silent: true }).catch(() => {
        // keep background polling silent
      });
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [deletedStudies, isExportingStream, makeStreamOpen, priorEditorStudy, showDeletedInStream, studyApiAuth]);

  useEffect(() => {
    return () => {
      if (streamVideoUrl) URL.revokeObjectURL(streamVideoUrl);
    };
  }, [streamVideoUrl]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();

    return studies.filter((s) =>
      [s.patient_name, s.patient_id, s.patient_age, s.patient_sex, s.patient_zip, s.modality, s.notes]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [studies, search]);

  const streamStudyOptions = useMemo(() => {
    const base = showDeletedInStream ? [...studies, ...deletedStudies] : studies;
    const seen = new Set<number>();
    return base.filter((study) => {
      if (seen.has(study.id)) return false;
      seen.add(study.id);
      return true;
    });
  }, [deletedStudies, showDeletedInStream, studies]);

  const getLiveOwnerText = (studyId: number) => {
    const session = liveSessionByStudyId[studyId];
    if (!session) return '';
    const startedByName = String(session.started_by_name || '').trim();
    const startedByEmail = String(session.started_by_email || '').trim();
    if (startedByName && startedByEmail) return `${startedByName} (${startedByEmail})`;
    return startedByName || startedByEmail || '';
  };

  const parseStudyDateToMs = (value?: string) => {
    const raw = String(value || '').trim();
    if (!raw) return Number.MAX_SAFE_INTEGER;
    if (/^\d{8}$/.test(raw)) {
      const yyyy = raw.slice(0, 4);
      const mm = raw.slice(4, 6);
      const dd = raw.slice(6, 8);
      const ts = Date.parse(`${yyyy}-${mm}-${dd}T00:00:00Z`);
      return Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts;
    }
    const ts = Date.parse(raw);
    return Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts;
  };

  const sortPriorIdsChronologically = (ids: number[]) => {
    return [...ids].sort((leftId, rightId) => {
      const left = studies.find((entry) => entry.id === leftId);
      const right = studies.find((entry) => entry.id === rightId);
      const leftTs = parseStudyDateToMs(left?.study_date);
      const rightTs = parseStudyDateToMs(right?.study_date);
      if (leftTs !== rightTs) return leftTs - rightTs;
      return leftId - rightId;
    });
  };

  const candidatePriors = useMemo(() => {
    if (!priorEditorStudy) return [];
    return studies.filter((entry) => entry.id !== priorEditorStudy.id);
  }, [priorEditorStudy, studies]);

  const openPriorEditor = (study: Study) => {
    setPriorEditorStudy(study);
    const candidateIds = Array.isArray(study.prior_study_ids) ? study.prior_study_ids : [];
    setPriorSelection(sortPriorIdsChronologically(candidateIds));
    setPriorAutoSort(true);
    setPriorUploadFiles([]);
    setPriorUploadPdf(null);
    setPriorUploadDate('');
    setPriorUploadModality(study.modality || '');
  };

  const togglePriorSelection = (studyId: number, checked: boolean) => {
    setPriorSelection((prev) => {
      if (checked) {
        if (prev.includes(studyId)) return prev;
        const next = [...prev, studyId];
        return priorAutoSort ? sortPriorIdsChronologically(next) : next;
      }
      return prev.filter((id) => id !== studyId);
    });
  };

  const onPriorDrop = (targetId: number) => {
    if (!draggedPriorId || draggedPriorId === targetId) return;
    setPriorSelection((prev) => {
      const fromIndex = prev.indexOf(draggedPriorId);
      const toIndex = prev.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [entry] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, entry);
      return next;
    });
    setPriorAutoSort(false);
    setDraggedPriorId(null);
  };

  const resetPriorAutoSort = () => {
    setPriorSelection((prev) => sortPriorIdsChronologically(prev));
    setPriorAutoSort(true);
  };

  const savePriors = async () => {
    if (!priorEditorStudy) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    try {
      setSavingPriors(true);
      const normalizedSelection = priorAutoSort ? sortPriorIdsChronologically(priorSelection) : priorSelection;
      const response = await updateStudyPriors(priorEditorStudy.id, normalizedSelection, { auth: studyApiAuth });
      setStudies((prev) =>
        prev.map((entry) => (entry.id === priorEditorStudy.id ? { ...entry, prior_study_ids: response.prior_study_ids } : entry))
      );
      toast.success('Priors updated');
      setPriorEditorStudy(null);
      setPriorSelection([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update priors');
    } finally {
      setSavingPriors(false);
    }
  };

  const refreshPriorCandidates = async () => {
    try {
      setRefreshingPriors(true);
      await loadStudies();
      toast.success('Prior list refreshed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to refresh priors');
    } finally {
      setRefreshingPriors(false);
    }
  };

  const uploadPriorStudyInline = async () => {
    if (!priorEditorStudy) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    if (priorUploadFiles.length === 0 && !priorUploadPdf) {
      toast.error('Select DICOM files and/or a PDF report to upload');
      return;
    }
    if (!priorUploadModality.trim()) {
      toast.error('Enter modality for prior upload');
      return;
    }

    try {
      setPriorUploading(true);
      await uploadStudy(
        {
          patient_name: priorEditorStudy.patient_name || '',
          patient_id: priorEditorStudy.patient_id || '',
          patient_age: priorEditorStudy.patient_age || '',
          patient_sex: priorEditorStudy.patient_sex || '',
          patient_zip: priorEditorStudy.patient_zip || '',
          study_date: priorUploadDate || new Date().toISOString().slice(0, 10),
          modality: priorUploadModality.trim(),
          notes: `Inline prior upload for study ${priorEditorStudy.id}`,
        },
        priorUploadFiles,
        null,
        priorUploadPdf,
        {
          redactTextOnUpload: false,
          auth: studyApiAuth,
        }
      );
      setPriorUploadFiles([]);
      setPriorUploadPdf(null);
      await loadStudies();
      toast.success('Prior study uploaded. Select it below and save priors.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload prior study');
    } finally {
      setPriorUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }

    try {
      await deleteStudy(deleteTarget.id, { auth: studyApiAuth });
      setStudies((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeletedStudies((prev) => [{ ...deleteTarget, deleted_at: new Date().toISOString() }, ...prev]);
      toast.success(`Study moved to Recently Deleted`);
      setDeleteTarget(null);
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete study');
    }
  };

  const handleRestore = async (study: Study) => {
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    try {
      const response = await restoreStudy(study.id, { auth: studyApiAuth });
      setDeletedStudies((prev) => prev.filter((entry) => entry.id !== study.id));
      setStudies((prev) => [response.study, ...prev]);
      toast.success('Study restored');
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to restore study');
    }
  };

  const handlePermanentDelete = async () => {
    if (!purgeTarget) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    try {
      await permanentlyDeleteStudy(purgeTarget.id, { auth: studyApiAuth });
      setDeletedStudies((prev) => prev.filter((entry) => entry.id !== purgeTarget.id));
      toast.success('Study permanently deleted');
      setPurgeTarget(null);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to permanently delete study');
    }
  };

  const toggleStudySelection = (studyId: number, checked: boolean) => {
    setSelectedStudyIds((prev) => {
      if (checked) {
        setStreamLayouts((layouts) => ({
          ...layouts,
          [studyId]: layouts[studyId] || defaultStreamLayout(),
        }));
        if (prev.includes(studyId)) return prev;
        return [...prev, studyId];
      }
      setStreamLayouts((layouts) => {
        const next = { ...layouts };
        delete next[studyId];
        return next;
      });
      return prev.filter((id) => id !== studyId);
    });
  };

  const updateStreamLayout = (studyId: number, updater: (layout: StreamLayout) => StreamLayout) => {
    setStreamLayouts((prev) => ({
      ...prev,
      [studyId]: normalizeStreamLayout(updater(prev[studyId] || defaultStreamLayout())),
    }));
  };

  const handleExportCaseStream = async () => {
    const normalizedStreamName = streamName.trim();
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    if (!normalizedStreamName) {
      toast.error('Enter a stream name before exporting');
      return;
    }
    if (selectedStudyIds.length === 0) {
      toast.error('Select at least one study');
      return;
    }

    try {
      setIsExportingStream(true);
      setExportStatusText('Queuing export job...');
      setExportProgress(0);
      const createdJob = await createCaseStreamJob(selectedStudyIds, {
        fps: 24,
        studyLayouts: buildStreamLayoutPayload(selectedStudyIds, streamLayouts),
        auth: studyApiAuth,
      });
      setActiveJobId(createdJob.id);
      let job = createdJob;
      let attempts = 0;
      const maxAttempts = 900;

      while (attempts < maxAttempts) {
        attempts += 1;

        if (job.status === 'ready') {
          break;
        }

        if (job.status === 'failed') {
          throw new Error(job.error?.message || 'Case stream export job failed');
        }
        if (job.status === 'cancelled') {
          throw new Error('Case stream export cancelled.');
        }

        setExportStatusText(
          job.progress_message ||
            (job.status === 'processing'
              ? 'Rendering case stream...'
              : 'Waiting for export worker...')
        );
        setExportProgress(Math.min(Math.max(Number(job.progress_pct) || 0, 0), 100));

        const pollDelayMs = Math.min(2000, 500 + attempts * 100);
        await new Promise((resolve) => {
          setTimeout(resolve, pollDelayMs);
        });
        job = await getCaseStreamJob(job.id, { auth: studyApiAuth });
      }

      if (job.status !== 'ready') {
        throw new Error('Case stream export timed out. Please try again.');
      }

      setExportStatusText('Downloading MP4...');
      setExportProgress(100);
      const { blob, filename } = await downloadCaseStreamJob(job.id, { auth: studyApiAuth });
      const fileUrl = URL.createObjectURL(blob);
      if (streamVideoUrl) {
        URL.revokeObjectURL(streamVideoUrl);
      }
      setStreamVideoUrl(fileUrl);
      setStreamFilename(filename);
      setStreamJobId(job.id);
      setStreamTimeline(Array.isArray(job.timeline) ? job.timeline : []);
      setSavedStreamId('');
      setActiveCaseIndex(0);
      setLoopEnabled(false);
      setLoopStartSec(0);
      setLoopEndSec(0);
      setPlaybackRate(1);
      setScrubTimeSec(0);
      try {
        const saved = await saveCaseStreamToLibrary(job.id, normalizedStreamName, { auth: studyApiAuth });
        setSavedStreamId(saved.id);
      } catch (saveErr) {
        console.error(saveErr);
        toast.error(saveErr instanceof Error ? saveErr.message : 'Stream created but not saved');
      }

      toast.success('Case stream ready to play');
      setSelectedStudyIds([]);
      setStreamLayouts({});
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to export case stream');
    } finally {
      setIsExportingStream(false);
      setExportStatusText('');
      setExportProgress(0);
      setActiveJobId(null);
    }
  };

  const seekToCase = (index: number) => {
    const entry = streamTimeline[index];
    const video = videoRef.current;
    if (!entry || !video) return;
    video.currentTime = Math.max(entry.start_sec, 0);
    setActiveCaseIndex(index);
  };

  const applyPlaybackRate = (nextRate: number) => {
    setPlaybackRate(nextRate);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextRate;
    }
  };

  const setLoopFromCurrentCase = () => {
    const entry = streamTimeline[activeCaseIndex];
    if (!entry) return;
    setLoopStartSec(entry.start_sec);
    setLoopEndSec(entry.end_sec);
    setLoopEnabled(true);
  };

  const onStreamTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const current = video.currentTime;
    if (!isScrubbing) {
      setScrubTimeSec(current);
    }
    if (loopEnabled && loopEndSec > loopStartSec && current >= loopEndSec) {
      video.currentTime = loopStartSec;
      return;
    }

    const idx = streamTimeline.findIndex((entry) => current >= entry.start_sec && current < entry.end_sec);
    if (idx >= 0 && idx !== activeCaseIndex) {
      setActiveCaseIndex(idx);
    }
  };

  const stepFrame = (direction: -1 | 1) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const fps = Math.max(1, streamFpsRef.current || 24);
    const frameSec = 1 / fps;
    const nextTime = Math.min(video.duration, Math.max(0, video.currentTime + direction * frameSec));
    video.currentTime = nextTime;
    setScrubTimeSec(nextTime);
  };

  const toggleStreamFullscreen = async () => {
    const target = streamViewportRef.current;
    if (!target) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await target.requestFullscreen();
    } catch (err) {
      console.error(err);
      toast.error('Could not toggle fullscreen mode for stream preview.');
    }
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsStreamFullscreen(Boolean(document.fullscreenElement === streamViewportRef.current));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const handleDownloadStream = async () => {
    if (!streamJobId) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }

    try {
      const { blob, filename } = await downloadCaseStreamJob(streamJobId, { auth: studyApiAuth });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename || streamFilename || `case-stream-${streamJobId}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to download stream');
    }
  };

  const handleCancelCaseStream = async () => {
    if (!activeJobId) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    try {
      const job = await cancelCaseStreamJob(activeJobId, { auth: studyApiAuth });
      setExportStatusText(job.progress_message || 'Cancellation requested...');
      setExportProgress(Math.min(Math.max(Number(job.progress_pct) || 0, 0), 100));
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to cancel export');
    }
  };

  const resetStreamDialogState = () => {
    setSelectedStudyIds([]);
    setStreamName('');
    setSavedStreamId('');
    setStreamVideoUrl('');
    setStreamFilename('');
    setStreamJobId('');
    setStreamTimeline([]);
    setActiveCaseIndex(0);
    setLoopEnabled(false);
    setLoopStartSec(0);
    setLoopEndSec(0);
    setPlaybackRate(1);
    setScrubTimeSec(0);
    setStreamClosePromptOpen(false);
    setShowDeletedInStream(false);
    setStreamLayouts({});
  };

  const handleCloseMakeStreamDialog = () => {
    if (isExportingStream) return;
    if (!streamVideoUrl) {
      setMakeStreamOpen(false);
      resetStreamDialogState();
      return;
    }
    setStreamClosePromptOpen(true);
  };

  const handleDiscardStreamAndClose = async () => {
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }

    try {
      setSavingStreamRecord(true);
      if (savedStreamId) {
        await deleteSavedCaseStream(savedStreamId, { auth: studyApiAuth });
      }
      setMakeStreamOpen(false);
      resetStreamDialogState();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to discard stream');
    } finally {
      setSavingStreamRecord(false);
    }
  };

  const handleKeepStreamAndClose = async () => {
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }

    try {
      setSavingStreamRecord(true);
      if (!savedStreamId && streamJobId && streamName.trim()) {
        const saved = await saveCaseStreamToLibrary(streamJobId, streamName.trim(), { auth: studyApiAuth });
        setSavedStreamId(saved.id);
      }
      setMakeStreamOpen(false);
      resetStreamDialogState();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save stream');
    } finally {
      setSavingStreamRecord(false);
    }
  };

  if (loading && studies.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">Loading studies...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Studies</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {studies.length} studies total{refreshingStudies ? ' · Refreshing...' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setMakeStreamOpen(true)}
            disabled={studies.length === 0}
          >
            <Film className="mr-2 h-4 w-4" />
            Make Case Stream
          </Button>
          <Button asChild>
            <Link to="/upload">
              <Upload className="mr-2 h-4 w-4" />
              Upload
            </Link>
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name, ID, or modality..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <table className="w-full min-w-[1180px] text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">ID</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Date</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Modality</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Files</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Attachments</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((study) => (
              <tr key={study.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium preserve-case">
                  <div>{study.patient_name || '—'}</div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {[study.patient_age ? `Age ${study.patient_age}` : '', study.patient_sex, study.patient_zip ? `Zip ${study.patient_zip}` : ''].filter(Boolean).join(' · ') || '—'}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums text-muted-foreground preserve-case">{study.patient_id || '—'}</td>
                <td className="px-4 py-3 tabular-nums preserve-case">{study.study_date || '—'}</td>
                <td className="px-4 py-3">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {study.modality || '—'}
                  </Badge>
                </td>
                <td className="px-4 py-3 tabular-nums text-muted-foreground">
                  {study.dicom_count ?? 0}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    {study.mp4_url && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                        <FileVideo className="h-3 w-3" />
                        MP4
                      </span>
                    )}
                    {study.pdf_url && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                        <FileText className="h-3 w-3" />
                        PDF
                      </span>
                    )}
                    {!study.mp4_url && !study.pdf_url && (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {study.live_streaming ? (
                      <span className="inline-flex items-center rounded-full bg-red-600/10 text-red-600 px-2 py-0.5 text-xs font-semibold">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-red-600" />
                        LIVE{getLiveOwnerText(study.id) ? ` · ${getLiveOwnerText(study.id)}` : ''}
                      </span>
                    ) : null}
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        statusStyles[study.status || 'ready'] || 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {study.status || 'ready'}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/studies/${study.id}`}>
                        <Eye className="mr-1.5 h-3.5 w-3.5" />
                        View
                      </Link>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openPriorEditor(study)}>
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      Add Priors
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openPriorEditor(study)}>
                      <History className="mr-1.5 h-3.5 w-3.5" />
                      View Priors
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setDeleteTarget(study)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  No studies match your search
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <div className="border-b bg-muted/40 px-4 py-3">
          <h2 className="text-sm font-semibold">Recently Deleted</h2>
          <p className="text-xs text-muted-foreground">Restore studies or permanently delete to reclaim storage.</p>
        </div>
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">ID</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Date</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Modality</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Deleted At</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {deletedStudies.map((study) => (
              <tr key={`deleted-${study.id}`} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium preserve-case">
                  <div>{study.patient_name || '—'}</div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {[study.patient_age ? `Age ${study.patient_age}` : '', study.patient_sex, study.patient_zip ? `Zip ${study.patient_zip}` : ''].filter(Boolean).join(' · ') || '—'}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums text-muted-foreground preserve-case">{study.patient_id || '—'}</td>
                <td className="px-4 py-3 tabular-nums preserve-case">{study.study_date || '—'}</td>
                <td className="px-4 py-3">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {study.modality || '—'}
                  </Badge>
                </td>
                <td className="px-4 py-3 tabular-nums text-muted-foreground">
                  {study.deleted_at ? new Date(study.deleted_at).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => handleRestore(study)}>
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setPurgeTarget(study)}
                    >
                      Permanently Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {deletedStudies.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No recently deleted studies
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Study</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the study for{' '}
                  <span className="font-medium text-foreground preserve-case">{deleteTarget?.patient_name}</span>{' '}
              <span className="preserve-case">({deleteTarget?.patient_id}).</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Study
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!purgeTarget} onOpenChange={(open) => !open && setPurgeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently Delete Study</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes study files, recordings, and linked media for{' '}
              <span className="font-medium text-foreground preserve-case">{purgeTarget?.patient_name}</span>.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePermanentDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Permanently Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!priorEditorStudy} onOpenChange={(open) => !open && setPriorEditorStudy(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {priorEditorStudy?.patient_name || 'Study'}: Add Priors
            </DialogTitle>
            <DialogDescription>
              Select prior studies, then arrange chronological stack order.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={refreshPriorCandidates}
              disabled={refreshingPriors}
            >
              <RotateCcw className="mr-1 h-4 w-4" />
              {refreshingPriors ? 'Refreshing...' : 'Refresh Priors List'}
            </Button>
          </div>
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium">Upload Prior Study or Report (Same Screen)</div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input
                type="date"
                value={priorUploadDate}
                onChange={(event) => setPriorUploadDate(event.target.value)}
              />
              <Input
                placeholder="Modality (e.g. CT)"
                value={priorUploadModality}
                onChange={(event) => setPriorUploadModality(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={uploadPriorStudyInline}
                disabled={priorUploading}
              >
                <Plus className="mr-1 h-4 w-4" />
                {priorUploading ? 'Uploading...' : 'Upload Prior'}
              </Button>
            </div>
            <Input
              type="file"
              multiple
              accept=".dcm,.dicom,.ima,.dicm,.jp2,.j2k,.jpf,.jpx"
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                setPriorUploadFiles(files);
              }}
            />
            <Input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                setPriorUploadPdf(file);
              }}
            />
            {priorUploadFiles.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {priorUploadFiles.length} file(s) selected for inline prior upload.
              </div>
            )}
            {priorUploadPdf && (
              <div className="text-xs text-muted-foreground">
                Prior report selected: {priorUploadPdf.name}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="rounded-lg border max-h-52 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left">Use</th>
                    <th className="px-3 py-2 text-left">Patient</th>
                    <th className="px-3 py-2 text-left">Study</th>
                  </tr>
                </thead>
                <tbody>
                  {candidatePriors
                    .filter((entry) => {
                      if (!priorEditorStudy) return true;
                      const studyPatientId = String(priorEditorStudy.patient_id || '').trim().toLowerCase();
                      const entryPatientId = String(entry.patient_id || '').trim().toLowerCase();
                      const studyPatientName = String(priorEditorStudy.patient_name || '').trim().toLowerCase();
                      const entryPatientName = String(entry.patient_name || '').trim().toLowerCase();
                      if (studyPatientId && entryPatientId) return studyPatientId === entryPatientId;
                      return Boolean(studyPatientName) && studyPatientName === entryPatientName;
                    })
                    .map((entry) => (
                    <tr key={`prior-candidate-${entry.id}`} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={priorSelection.includes(entry.id)}
                          onCheckedChange={(checked) => togglePriorSelection(entry.id, checked === true)}
                        />
                      </td>
                      <td className="px-3 py-2 preserve-case">{entry.patient_name || '—'}</td>
                      <td className="px-3 py-2 preserve-case">
                        {entry.study_date || '—'} · {entry.modality || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Selected Prior Order</div>
                <Button type="button" size="sm" variant="outline" onClick={resetPriorAutoSort}>
                  Auto Sort by Date
                </Button>
              </div>
              {!priorAutoSort && (
                <div className="mb-2 text-xs text-muted-foreground">Manual order enabled.</div>
              )}
              {priorSelection.length === 0 ? (
                <div className="text-xs text-muted-foreground">No priors selected.</div>
              ) : (
                <div className="space-y-1.5">
                  {priorSelection.map((id, index) => {
                    const entry = studies.find((item) => item.id === id);
                    return (
                      <div
                        key={`prior-order-${id}`}
                        draggable
                        onDragStart={() => setDraggedPriorId(id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => onPriorDrop(id)}
                        className="flex items-center justify-between rounded border px-2 py-1.5"
                      >
                        <div className="text-xs preserve-case">
                          {index + 1}. {entry?.study_date || '—'} · {entry?.modality || '—'} · {entry?.patient_name || `Study ${id}`}
                        </div>
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriorEditorStudy(null)}>Cancel</Button>
            <Button onClick={savePriors} disabled={savingPriors}>{savingPriors ? 'Saving...' : 'Save Priors'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={makeStreamOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleCloseMakeStreamDialog();
            return;
          }
          setMakeStreamOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Make Case Stream</DialogTitle>
            <DialogDescription>
              Select studies with DICOM, MP4, or report files and export a combined MP4 stream.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <div className="text-sm font-medium">Stream Name</div>
            <Input
              value={streamName}
              onChange={(event) => setStreamName(event.target.value)}
              placeholder="e.g. Trauma follow-up timeline"
              maxLength={120}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={showDeletedInStream}
              onCheckedChange={(checked) => setShowDeletedInStream(checked === true)}
            />
            Include deleted cases
          </label>

          <div className="rounded-lg border max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Use</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Patient</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Study</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Media</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Layout</th>
                </tr>
              </thead>
              <tbody>
                {streamStudyOptions.map((study) => {
                  const dicomCount = study.dicom_count ?? 0;
                  const selected = selectedStudyIds.includes(study.id);
                  const layout = streamLayouts[study.id] || defaultStreamLayout();

                  return (
                    <tr key={`stream-${study.id}`} className="border-b last:border-0">
                      <td className="px-4 py-2.5">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) => toggleStudySelection(study.id, checked === true)}
                          aria-label={`Select study ${study.id}`}
                        />
                      </td>
                      <td className="px-4 py-2.5 preserve-case">
                        {study.patient_name || '—'}
                        {study.deleted_at && <span className="ml-2 text-xs text-muted-foreground">Deleted</span>}
                      </td>
                      <td className="px-4 py-2.5 preserve-case">
                        {study.study_date || '—'} · {study.modality || '—'}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {dicomCount}
                        {study.mp4_url && <span className="ml-2 text-xs text-muted-foreground">MP4</span>}
                        {study.pdf_url && <span className="ml-2 text-xs text-muted-foreground">PDF</span>}
                        {study.has_recording && <span className="ml-2 text-xs text-muted-foreground">Recording</span>}
                        {dicomCount === 0 && !study.mp4_url && !study.pdf_url && !study.has_recording && (
                          <span className="ml-2 text-xs text-muted-foreground">Fallback</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 min-w-[15rem]">
                        {selected ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Crop className="h-4 w-4 text-muted-foreground" />
                              <select
                                value={layout.mode}
                                onChange={(event) => {
                                  const mode = event.target.value as StreamLayoutMode;
                                  updateStreamLayout(study.id, (current) => ({ ...current, mode }));
                                }}
                                className="h-8 rounded-md border bg-background px-2 text-xs"
                              >
                                <option value="fit">Fit</option>
                                <option value="fill">Fill crop</option>
                                <option value="manual">Manual crop</option>
                              </select>
                            </div>
                            {layout.mode === 'manual' && (
                              <div className="grid grid-cols-2 gap-1.5 text-xs">
                                {[
                                  ['x', 'Left'],
                                  ['y', 'Top'],
                                  ['width', 'Width'],
                                  ['height', 'Height'],
                                ].map(([key, label]) => (
                                  <label key={`${study.id}-${key}`} className="flex items-center gap-1">
                                    <span className="w-10 text-muted-foreground">{label}</span>
                                    <Input
                                      type="number"
                                      min={key === 'width' || key === 'height' ? 5 : 0}
                                      max={100}
                                      step={1}
                                      value={Math.round((layout.crop[key as keyof StreamLayout['crop']] || 0) * 100)}
                                      onChange={(event) => {
                                        const nextValue = Math.min(Math.max(Number(event.target.value) || 0, key === 'width' || key === 'height' ? 5 : 0), 100) / 100;
                                        updateStreamLayout(study.id, (current) => ({
                                          ...current,
                                          crop: {
                                            ...current.crop,
                                            [key]: nextValue,
                                          },
                                        }));
                                      }}
                                      className="h-7 px-2 text-xs"
                                    />
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Select to edit</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="text-sm text-muted-foreground">
            {selectedStudyIds.length} study{selectedStudyIds.length === 1 ? '' : 'ies'} selected
          </div>
          {isExportingStream && exportStatusText && (
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">
                {exportStatusText}
                {exportProgress > 0 ? ` (${exportProgress}%)` : ''}
              </div>
              {activeJobId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCancelCaseStream}
                >
                  Cancel Export
                </Button>
              )}
            </div>
          )}
          {streamVideoUrl && (
            <div className="space-y-3 rounded-lg border p-3 max-h-[54vh] overflow-y-auto">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium">Stream Playback</div>
                  {streamName && (
                    <div className="text-xs text-muted-foreground truncate max-w-[18rem] preserve-case">{streamName}</div>
                  )}
                </div>
                {streamJobId && (
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => void toggleStreamFullscreen()}>
                      {isStreamFullscreen ? 'Exit Fullscreen' : 'Maximize Stream'}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleDownloadStream()}>
                      <Download className="mr-2 h-4 w-4" />
                      Download MP4
                    </Button>
                  </div>
                )}
              </div>
              <div
                ref={streamViewportRef}
                className={isStreamFullscreen ? 'bg-black p-3 space-y-2' : 'space-y-2'}
              >
                <video
                  key={streamVideoUrl}
                  ref={videoRef}
                  src={streamVideoUrl}
                  controls
                  preload="metadata"
                  className={isStreamFullscreen ? 'w-full h-[82vh] rounded-md bg-black object-contain' : 'w-full h-[250px] rounded-md bg-black object-contain'}
                  onLoadedMetadata={() => {
                    const video = videoRef.current;
                    if (!video) return;
                    video.playbackRate = playbackRate;
                    setScrubTimeSec(video.currentTime || 0);
                    const totalFrames = streamTimeline.reduce((sum, entry) => sum + (Number(entry.frame_count) || 0), 0);
                    const duration = video.duration || 0;
                    const estFps = duration > 0 && totalFrames > 0 ? totalFrames / duration : 24;
                    streamFpsRef.current = Number.isFinite(estFps) && estFps > 0 ? estFps : 24;
                  }}
                  onError={() => toast.error('This stream could not be decoded by the browser.')}
                  onTimeUpdate={onStreamTimeUpdate}
                />
                <div className="rounded-md border p-2 space-y-2 bg-background">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Frame Scrub</span>
                    <span>
                      {formatVideoTime(scrubTimeSec, 3)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(videoRef.current?.duration || 0, 0)}
                    step={0.001}
                    value={Math.min(scrubTimeSec, Math.max(videoRef.current?.duration || 0, 0))}
                    onMouseDown={() => setIsScrubbing(true)}
                    onTouchStart={() => setIsScrubbing(true)}
                    onChange={(event) => {
                      const next = Number(event.target.value) || 0;
                      setScrubTimeSec(next);
                      const video = videoRef.current;
                      if (video) {
                        video.currentTime = next;
                      }
                    }}
                    onMouseUp={() => setIsScrubbing(false)}
                    onTouchEnd={() => setIsScrubbing(false)}
                    className="w-full"
                    aria-label="Scrub stream video timeline"
                  />
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => stepFrame(-1)}>
                      -1 Frame
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => stepFrame(1)}>
                      +1 Frame
                    </Button>
                    <span className="text-xs text-muted-foreground">~{streamFpsRef.current.toFixed(2)} fps</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => seekToCase(Math.max(0, activeCaseIndex - 1))}
                  disabled={activeCaseIndex <= 0}
                >
                  <SkipBack className="mr-1 h-4 w-4" />
                  Prev Case
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => seekToCase(Math.min(streamTimeline.length - 1, activeCaseIndex + 1))}
                  disabled={streamTimeline.length === 0 || activeCaseIndex >= streamTimeline.length - 1}
                >
                  <SkipForward className="mr-1 h-4 w-4" />
                  Next Case
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={setLoopFromCurrentCase} disabled={streamTimeline.length === 0}>
                  <RotateCcw className="mr-1 h-4 w-4" />
                  Repeat Current Case
                </Button>
                <span className="text-xs text-muted-foreground">
                  Case {streamTimeline.length > 0 ? activeCaseIndex + 1 : 0}/{streamTimeline.length}
                  {streamTimeline[activeCaseIndex] ? ` • ${streamTimeline[activeCaseIndex].label}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Speed:</span>
                {[0.1, 0.25, 0.5, 1, 1.5, 2].map((rate) => (
                  <Button
                    key={`rate-${rate}`}
                    type="button"
                    size="sm"
                    variant={playbackRate === rate ? 'default' : 'outline'}
                    onClick={() => applyPlaybackRate(rate)}
                  >
                    {rate}x
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const current = videoRef.current?.currentTime || 0;
                    setLoopStartSec(current);
                    if (loopEndSec <= current) setLoopEndSec(current + 1);
                  }}
                >
                  Set Loop Start
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const current = videoRef.current?.currentTime || 0;
                    setLoopEndSec(Math.max(current, loopStartSec + 0.1));
                  }}
                >
                  Set Loop End
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={loopEnabled ? 'default' : 'outline'}
                  onClick={() => setLoopEnabled((prev) => !prev)}
                  disabled={loopEndSec <= loopStartSec}
                >
                  {loopEnabled ? 'Loop On' : 'Loop Off'}
                </Button>
                <span className="text-muted-foreground">
                  Loop {formatVideoTime(loopStartSec, 1)} → {formatVideoTime(loopEndSec, 1)}
                </span>
              </div>
              {streamTimeline.length > 0 && (
                <div className="max-h-36 overflow-y-auto rounded border p-2">
                  <div className="mb-1 text-xs font-medium">Case Thread</div>
                  <div className="flex flex-wrap gap-1.5">
                    {streamTimeline.map((entry, index) => (
                      <Button
                        key={`segment-${entry.index}-${entry.study_id}`}
                        type="button"
                        size="sm"
                        variant={index === activeCaseIndex ? 'default' : 'outline'}
                        onClick={() => seekToCase(index)}
                      >
                        {index + 1}. {entry.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <div className="text-xs text-muted-foreground preserve-case">File: {streamFilename}</div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCloseMakeStreamDialog}
              disabled={isExportingStream}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleExportCaseStream}
              disabled={isExportingStream || selectedStudyIds.length === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              {isExportingStream ? 'Exporting...' : 'Export MP4'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={streamClosePromptOpen} onOpenChange={setStreamClosePromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close Stream Builder</AlertDialogTitle>
            <AlertDialogDescription>
              Keep this stream in the Streams list for future reference, or discard it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingStreamRecord}>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDiscardStreamAndClose();
              }}
              disabled={savingStreamRecord}
            >
              {savingStreamRecord ? 'Working...' : 'Discard'}
            </AlertDialogAction>
            <Button type="button" onClick={() => void handleKeepStreamAndClose()} disabled={savingStreamRecord}>
              {savingStreamRecord ? 'Working...' : 'Add to Streams'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
