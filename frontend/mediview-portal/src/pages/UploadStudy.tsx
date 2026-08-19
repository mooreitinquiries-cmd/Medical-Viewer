import {
  fetchStudyById,
  heartbeatLiveCase,
  getLiveFinalizeJob,
  listActiveLiveCases,
  preconvertDicomFiles,
  startLiveCase,
  stopLiveCase,
  addStudyReport,
  uploadCaseRecording,
  uploadLiveCaseRecording,
  uploadStudy,
} from '@/lib/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Upload, FileVideo, FileImage, FileText, X, Wand2, MonitorPlay, Square, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { listCareClients, type CareClient } from '@/lib/careApi';
import { formatVideoTime } from '@/lib/timeFormat';
import { openStudySignoffPopup } from '@/lib/studySignoff';
import { showErrorToast } from '@/lib/errorToast';

const MODALITIES = ['CT', 'MR', 'US', 'XR', 'PT', 'MG', 'CR', 'DX', 'NM', 'RF'];
const DICOM_EXTENSIONS = ['.dcm', '.dicom', '.ima', '.dicm', '.jp2', '.j2k', '.jpf', '.jpx', '.j2c'];
const MIN_TRIM_GAP_SEC = 0.1;
const WORKFLOW_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PRECONVERT_MAX_BYTES = 256 * 1024 * 1024;
const NOTE_IMAGE_LABELS = {
  notes: 'Notes',
  tech_notes: 'Tech Notes',
  radiologist_notes: 'Radiologist Notes',
  radiology_report: 'Radiology Report',
} as const;
const SCREEN_RECORDING_MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm',
];

function getPreferredScreenRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return 'video/webm';
  return SCREEN_RECORDING_MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || 'video/webm';
}

function calculateDecimalAge(dob: string, studyDate: string) {
  if (!dob || !studyDate) return '';
  const dobDate = new Date(`${dob}T00:00:00Z`);
  const examDate = new Date(`${studyDate}T00:00:00Z`);
  if (Number.isNaN(dobDate.getTime()) || Number.isNaN(examDate.getTime())) return '';
  const diffMs = examDate.getTime() - dobDate.getTime();
  if (diffMs < 0) return '';
  const years = diffMs / (365.2425 * 24 * 60 * 60 * 1000);
  return years.toFixed(4).padStart(7, '0');
}

export default function UploadStudy() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, whiteLabelAccount, studyApiAuth, hasPermission } = useAuth();
  const canSeeRevenue = !whiteLabelAccount || Boolean(user?.isSuperAdmin);
  const canUploadStudies = hasPermission('uploadStudies');
  const dicomInputRef = useRef<HTMLInputElement>(null);
  const jpeg2000InputRef = useRef<HTMLInputElement>(null);
  const dicomFolderInputRef = useRef<HTMLInputElement>(null);
  const mp4InputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const signAfterUploadRef = useRef(false);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const liveSessionIdRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingDurationHintRef = useRef(0);
  const recordingBlobRef = useRef<Blob | null>(null);
  const recordingStopPromiseRef = useRef<Promise<Blob | null> | null>(null);
  const resolveRecordingStopRef = useRef<((blob: Blob | null) => void) | null>(null);

  const [form, setForm] = useState({
    patient_name: '',
    patient_age: '',
    patient_dob: '',
    patient_sex: '',
    patient_zip: '',
    study_date: '',
    octrqaui: '',
    octraccui: '',
    client_email: '',
    client_name: '',
    subclient: '',
    md_name: 'Sarai',
    revenue: '',
    modality: '',
    notes: '',
    tech_notes: '',
    radiologist_notes: '',
    radiology_report: '',
  });
  const [dicomFiles, setDicomFiles] = useState<File[]>([]);
  const [mp4File, setMp4File] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [noteImageFiles, setNoteImageFiles] = useState<Record<keyof typeof NOTE_IMAGE_LABELS, File | null>>({
    notes: null,
    tech_notes: null,
    radiologist_notes: null,
    radiology_report: null,
  });
  const [convertJpeg2000ToDcm, setConvertJpeg2000ToDcm] = useState(false);
  const [conversionToken, setConversionToken] = useState<string | null>(null);
  const [conversionExpiresAt, setConversionExpiresAt] = useState<string | null>(null);
  const [preconverting, setPreconverting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [clients, setClients] = useState<CareClient[]>([]);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [redactionSummary, setRedactionSummary] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingPreviewUrl, setRecordingPreviewUrl] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingNeedsProcessing, setRecordingNeedsProcessing] = useState(false);
  const [trimStartSec, setTrimStartSec] = useState(0);
  const [trimEndSec, setTrimEndSec] = useState(0);
  const [cropX, setCropX] = useState(5);
  const [cropY, setCropY] = useState(5);
  const [cropW, setCropW] = useState(90);
  const [cropH, setCropH] = useState(90);
  const [processingRecording, setProcessingRecording] = useState(false);
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [liveStudyId, setLiveStudyId] = useState<number | null>(null);
  const [startingLive, setStartingLive] = useState(false);
  const [finalizingLive, setFinalizingLive] = useState(false);
  const [liveFinalizePending, setLiveFinalizePending] = useState(false);
  const [recoverableLiveSession, setRecoverableLiveSession] = useState<{ id: string; study_id: number } | null>(null);
  const recoverLivePanelRef = useRef<HTMLDivElement | null>(null);
  const cropAreaRef = useRef<HTMLDivElement | null>(null);
  const [cropDragging, setCropDragging] = useState<null | {
    mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
    startX: number;
    startY: number;
    startCrop: { x: number; y: number; w: number; h: number };
  }>(null);

  const updateField = (field: string, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const computedAge = useMemo(() => calculateDecimalAge(form.patient_dob, form.study_date), [form.patient_dob, form.study_date]);
  const formWithComputedAge = useMemo(() => ({ ...form, patient_age: computedAge }), [computedAge, form]);

  const clampToDuration = (value: number) => Math.max(0, Math.min(recordingDuration, value));
  const clampTrimEndToDuration = (value: number) =>
    Math.max(0, Math.min(Math.max(0, recordingDuration), value));
  const getMaxTrimEnd = () => Math.max(0, recordingDuration);

  const waitForStudyProcessing = async (studyId: number) => {
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS) {
      attempt += 1;
      const delayMs = Math.min(1800, 500 + attempt * 120);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const response = await fetchStudyById(studyId, { auth: studyApiAuth });
      const studyStatus = String(response?.study?.status || response?.status || '').toLowerCase();
      const bounded = Math.min(99, 94 + attempt);
      setProgress(bounded);
      setProgressText(`Processing study... (${studyStatus || 'working'})`);

      if (!studyStatus || studyStatus === 'ready') {
        return;
      }
      if (studyStatus === 'error' || studyStatus === 'failed') {
        throw new Error(`Study processing failed (${studyStatus}).`);
      }
      if (studyStatus !== 'processing' && studyStatus !== 'queued') {
        return;
      }
    }
    throw new Error('Study processing timed out. Please check Studies in a moment.');
  };

  useEffect(() => {
    if (!dicomFolderInputRef.current) return;
    dicomFolderInputRef.current.setAttribute('webkitdirectory', '');
    dicomFolderInputRef.current.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (!user?.email) return;
    listCareClients()
      .then((data) => setClients(data.clients || []))
      .catch(() => setClients([]));
  }, [user?.email]);

  const canScreenRecord =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getDisplayMedia) &&
    typeof MediaRecorder !== 'undefined';

  const isDicomFile = (file: File) => {
    const name = file.name.toLowerCase();
    const mime = (file.type || '').toLowerCase();
    return (
      DICOM_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
      mime === 'image/jp2' ||
      mime === 'image/jpx' ||
      mime === 'image/jpeg2000' ||
      mime === 'video/jpeg2000' ||
      mime.includes('dicom') ||
      mime === 'application/octet-stream'
    );
  };

  const isLikelyJpeg2000File = (file: File) => {
    const name = file.name.toLowerCase();
    const mime = (file.type || '').toLowerCase();
    return (
      name.endsWith('.jp2') ||
      name.endsWith('.j2k') ||
      name.endsWith('.jpf') ||
      name.endsWith('.jpx') ||
      name.endsWith('.j2c') ||
      mime === 'image/jp2' ||
      mime === 'image/jpx' ||
      mime === 'image/jpeg2000' ||
      mime === 'video/jpeg2000' ||
      mime === 'application/octet-stream'
    );
  };

  const appendFilesDeduped = (files: File[]) => {
    setDicomFiles((prev) => {
      const seen = new Set(prev.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
      const deduped = files.filter((file) => {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [...prev, ...deduped];
    });
    setConversionToken(null);
    setConversionExpiresAt(null);
  };

  const addDicomFiles = (files: File[]) => {
    const nextDicomFiles = files.filter(isDicomFile);

    if (nextDicomFiles.length === 0) {
      toast.error('No DICOM files found in selection');
      return;
    }

    appendFilesDeduped(nextDicomFiles);
  };

  const addJpeg2000Files = (files: File[]) => {
    if (files.length === 0) {
      toast.error('No files selected');
      return;
    }

    const likely = files.filter(isLikelyJpeg2000File);
    const selected = likely.length > 0 ? likely : files;

    appendFilesDeduped(selected);
    setConvertJpeg2000ToDcm(true);

    if (likely.length === 0) {
      toast.warning('Added selected files for JPEG2000 conversion (type could not be confirmed from filename/mime).');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const shouldOpenSignoff = signAfterUploadRef.current;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    if (!canUploadStudies) {
      toast.error('Your account is view-only for uploads.');
      return;
    }
    if (liveSessionId || finalizingLive) {
      toast.error('Finish or stop the live case share before uploading normally.');
      return;
    }
    if (processingRecording) {
      toast.error('Wait for recording processing to finish before uploading.');
      return;
    }

    let currentRecordingBlob = recordingBlobRef.current || recordingBlob;
    if (!currentRecordingBlob && recordingStopPromiseRef.current) {
      currentRecordingBlob = await recordingStopPromiseRef.current;
    }
    if (isRecording && !currentRecordingBlob) {
      toast.error('Stop recording before uploading.');
      return;
    }

    const hasDicomMedia = dicomFiles.length > 0 || Boolean(conversionToken);
    const hasAlternateMedia = Boolean(mp4File) || Boolean(currentRecordingBlob);

    try {
      setUploading(true);
      setRedactionSummary('');
      setProgress(1);
      setProgressText('Preparing upload...');
      let recordingToUpload = currentRecordingBlob;

      if (recordingToUpload && recordingNeedsProcessing) {
        setProgress(5);
        setProgressText('Processing screen recording...');
        const processed = await processRecording(true);
        if (!processed) {
          throw new Error('Failed to process screen recording');
        }
        recordingToUpload = processed;
        setProgress(25);
        setProgressText('Recording processing complete. Starting upload...');
      }

      const result = await uploadStudy(formWithComputedAge, dicomFiles, mp4File, pdfFile, {
        convertJpeg2000ToDcm: convertJpeg2000ToDcm,
        redactTextOnUpload: false,
        conversionToken: conversionToken || undefined,
        auth: studyApiAuth,
        onProgress: (state) => {
          setProgress(Math.max(0, Math.min(100, Math.round(state.percent))));
          setProgressText(state.message);
        },
      });

      if (recordingToUpload) {
        setProgress(92);
        setProgressText('Uploading screen recording...');
        await uploadCaseRecording(
          {
            recordingFile: recordingToUpload,
            caseId: String(result.study_id),
            studyId: result.study_id,
            studyInstanceUID: result.study?.orthanc_study_id || result.orthanc_study_id,
            uploadedBy: user?.email || 'unknown',
          },
          studyApiAuth
        );
        toast.success('Screen recording uploaded');
      }

      const noteImageEntries = Object.entries(noteImageFiles).filter((entry): entry is [keyof typeof NOTE_IMAGE_LABELS, File] =>
        Boolean(entry[1])
      );
      if (noteImageEntries.length > 0) {
        setProgress(94);
        setProgressText('Attaching note images...');
        for (const [field, file] of noteImageEntries) {
          await addStudyReport(
            result.study_id,
            {
              title: `${NOTE_IMAGE_LABELS[field]} image`,
              caseLabel: form.patient_name || result.study?.patient_name || `Study #${result.study_id}`,
              reportType: 'image',
              file,
            },
            { auth: studyApiAuth }
          );
        }
      }

      const initialStudyStatus = String(result.study?.status || '').toLowerCase();
      const shouldWaitForStudyReady = hasDicomMedia;
      if (shouldWaitForStudyReady && (initialStudyStatus === 'processing' || initialStudyStatus === 'queued')) {
        setProgress(94);
        setProgressText('Waiting for study processing to complete...');
        await waitForStudyProcessing(result.study_id);
      }

      setProgress(100);
      toast.success('Study uploaded successfully');
      if ((result.dicom_redacted_count || 0) > 0) {
        setRedactionSummary(
          `Automatic redaction complete: ${result.dicom_redacted_count} image(s) redacted before upload.`
        );
      } else if ((result.dicom_redaction_failed_count || 0) > 0) {
        setRedactionSummary(
          `Automatic redaction partially completed: ${result.dicom_redaction_failed_count} image(s) uploaded as-is.`
        );
      } else if (dicomFiles.length > 0 || conversionToken) {
        setRedactionSummary('Automatic redaction ran with no detectable text changes needed.');
      }
      if ((result.dicom_redaction_failed_count || 0) > 0) {
        toast.info(
          `${result.dicom_redaction_failed_count} image(s) skipped automatic text redaction and were uploaded as-is.`
        );
      }
      if ((result.dicom_converted_count || 0) > 0) {
        toast.success(
          `${result.dicom_converted_count} JPEG2000 DICOM file(s) converted to .dcm and added to workflow.`
        );
      }
      if ((result.dicom_failed_count || 0) > 0) {
        const sample = (result.dicom_failed_files || [])
          .slice(0, 2)
          .map((item) => `${item.name || 'file'} (${item.reason || 'error'})`)
          .join(', ');
        toast.warning(
          `${result.dicom_failed_count} file(s) were skipped by Orthanc.` +
            (sample ? ` Example: ${sample}` : '')
        );
      }

      console.log('Uploaded study:', result);
      setConversionToken(null);
      setConversionExpiresAt(null);
      setRecordingBlob(null);
      recordingBlobRef.current = null;
      recordingStopPromiseRef.current = null;
      resolveRecordingStopRef.current = null;
      setRecordingNeedsProcessing(false);
      setNoteImageFiles({
        notes: null,
        tech_notes: null,
        radiologist_notes: null,
        radiology_report: null,
      });

      if (shouldOpenSignoff) {
        openStudySignoffPopup(result.study_id);
      }
      navigate('/studies');
    } catch (error) {
      console.error(error);
      showErrorToast(error, 'Upload failed');
    } finally {
      setUploading(false);
      signAfterUploadRef.current = false;
      setTimeout(() => {
        setProgress(0);
        setProgressText('');
      }, 500);
    }
  };

  const removeDicomFile = (index: number) => {
    setDicomFiles((files) => files.filter((_, i) => i !== index));
    setConversionToken(null);
    setConversionExpiresAt(null);
  };

  const handleConvertNow = async () => {
    if (dicomFiles.length === 0) {
      toast.error('Select DICOM/JPEG2000 files before running conversion');
      return;
    }
    const selectedBytes = dicomFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    if (selectedBytes > PRECONVERT_MAX_BYTES) {
      toast.info('Large JPEG2000 folders are converted automatically during upload. Click Create Case to upload this selection.');
      return;
    }
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }

    try {
      setPreconverting(true);
      const result = await preconvertDicomFiles(dicomFiles, {
        convertJpeg2000ToDcm: true,
        auth: studyApiAuth,
      });

      setConversionToken(result.conversion_token);
      setConversionExpiresAt(result.conversion_expires_at || null);

      if ((result.dicom_converted_count || 0) > 0) {
        toast.success(
          `${result.dicom_converted_count} JPEG2000 DICOM file(s) converted and staged for upload.`
        );
      } else {
        toast.success('No JPEG2000 files needed conversion. DICOM files are staged for upload.');
      }
    } catch (error) {
      console.error(error);
      showErrorToast(error, 'Pre-conversion failed');
      setConversionToken(null);
      setConversionExpiresAt(null);
    } finally {
      setPreconverting(false);
    }
  };

  const handleStartScreenRecording = async () => {
    if (!canScreenRecord) {
      toast.error('Screen recording is not supported in this browser/environment');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      recordingStartedAtRef.current = performance.now();
      recordingDurationHintRef.current = 0;
      const chunks: BlobPart[] = [];
      recordingStopPromiseRef.current = new Promise((resolve) => {
        resolveRecordingStopRef.current = resolve;
      });
      const preferredMime = getPreferredScreenRecordingMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: preferredMime });
      } catch {
        recorder = new MediaRecorder(stream);
      }
      recorderRef.current = recorder;
      displayStreamRef.current = stream;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const startedAt = recordingStartedAtRef.current;
        recordingStartedAtRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        displayStreamRef.current = null;
        const blob = new Blob(chunks, { type: 'video/webm' });
        if (blob.size === 0) {
          toast.error('Recording was empty. Start recording again and capture a longer clip.');
          setIsRecording(false);
          resolveRecordingStopRef.current?.(null);
          resolveRecordingStopRef.current = null;
          recordingStopPromiseRef.current = null;
          return;
        }
        const elapsedSec =
          startedAt !== null ? Math.max(0.1, (performance.now() - startedAt) / 1000) : Math.max(1, Math.ceil(blob.size / 250000));
        recordingDurationHintRef.current = elapsedSec;
        setRecordingDuration(elapsedSec);
        setTrimStartSec(0);
        setTrimEndSec(elapsedSec);
        recordingBlobRef.current = blob;
        setRecordingBlob(blob);
        setRecordingNeedsProcessing(false);
        setIsRecording(false);
        resolveRecordingStopRef.current?.(blob);
        resolveRecordingStopRef.current = null;
        recordingStopPromiseRef.current = null;
        if (liveSessionIdRef.current) {
          setLiveFinalizePending(true);
        }
      };

      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          if (recorder.state !== 'inactive') {
            recorder.requestData?.();
            recorder.stop();
          }
        };
      });

      recorder.start(250);
      setIsRecording(true);
      toast.success('Recording started');
      return true;
    } catch (error) {
      showErrorToast(error, 'Failed to start recording');
      return false;
    }
  };

  const probeRecordingDuration = async (blob: Blob) => {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = objectUrl;
      const fallbackDuration = recordingDurationHintRef.current > 0
        ? recordingDurationHintRef.current
        : Math.max(1, Math.ceil(blob.size / 250000));
      const duration = await new Promise<number>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          const nextDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          if (nextDuration > 0) {
            settled = true;
            resolve(nextDuration);
          }
        };
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackDuration);
        }, 1500);

        video.onloadedmetadata = () => {
          window.clearTimeout(timeoutId);
          finish();
        };
        video.onloadeddata = () => {
          window.clearTimeout(timeoutId);
          finish();
        };
        video.ondurationchange = () => {
          window.clearTimeout(timeoutId);
          finish();
        };
        video.onerror = () => {
          if (settled) return;
          window.clearTimeout(timeoutId);
          settled = true;
          resolve(fallbackDuration);
        };
      });
      const safeDuration = duration > 0 ? duration : fallbackDuration;
      setRecordingDuration(safeDuration);
      setTrimStartSec(0);
      setTrimEndSec(safeDuration > 0 ? safeDuration : 0);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const handleStopScreenRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      setIsRecording(false);
      recorder.requestData?.();
      recorder.stop();
      return;
    }
    const stream = displayStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    recorderRef.current = null;
    displayStreamRef.current = null;
  };

  useEffect(() => {
    liveSessionIdRef.current = liveSessionId;
  }, [liveSessionId]);

  useEffect(() => {
    if (!liveSessionId || !isRecording) return;
    const intervalId = window.setInterval(() => {
      heartbeatLiveCase(liveSessionId, { auth: studyApiAuth }).catch(() => {
        // heartbeat failures are transient; keep recording flow uninterrupted
      });
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [isRecording, liveSessionId, studyApiAuth]);

  useEffect(() => {
    if (!liveFinalizePending || !recordingBlob || !liveSessionId) return;
    const finalize = async () => {
      try {
        setFinalizingLive(true);
        setProgress(4);
        setProgressText('Finalizing live recording...');
        let blobToFinalize = recordingBlob;
        if (recordingNeedsProcessing) {
          const processed = await processRecording(true);
          if (!processed) {
            throw new Error('Failed to process live recording');
          }
          blobToFinalize = processed;
        }
        setProgress(28);
        setProgressText('Uploading live recording...');
        const finalizeResult = await uploadLiveCaseRecording(liveSessionId, blobToFinalize, { auth: studyApiAuth });
        if (finalizeResult.queued && finalizeResult.finalize_job_id) {
          let done = false;
          const startedAt = Date.now();
          let pollAttempt = 0;
          while (!done && Date.now() - startedAt < WORKFLOW_TIMEOUT_MS) {
            pollAttempt += 1;
            const pollDelayMs = Math.min(1500, 400 + pollAttempt * 100);
            await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
            const job = await getLiveFinalizeJob(finalizeResult.finalize_job_id, { auth: studyApiAuth });
            setProgress(Math.min(95, 30 + pollAttempt * 2));
            setProgressText(`Finalizing live case... (${job.status})`);
            if (job.status === 'done') {
              done = true;
              break;
            }
            if (job.status === 'failed') {
              throw new Error(job.error || 'Live finalize job failed');
            }
          }
          if (!done) {
            throw new Error('Live finalize timed out. Please check Studies in a moment.');
          }
        }
        await stopLiveCase(liveSessionId, { auth: studyApiAuth });
        setProgress(100);
        setProgressText('Live case finalized');
        toast.success('Live case saved as MP4');
        liveSessionIdRef.current = null;
        setLiveSessionId(null);
        setLiveStudyId(null);
        setLiveFinalizePending(false);
        setRecordingBlob(null);
        recordingBlobRef.current = null;
        recordingStopPromiseRef.current = null;
        resolveRecordingStopRef.current = null;
        setRecordingNeedsProcessing(false);
        navigate('/studies');
      } catch (error) {
        showErrorToast(error, 'Failed to finalize live case');
      } finally {
        setFinalizingLive(false);
      }
    };
    void finalize();
  }, [liveFinalizePending, recordingBlob, liveSessionId, navigate, recordingNeedsProcessing, studyApiAuth]);

  const handleStartLiveCaseShare = async () => {
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    try {
      setStartingLive(true);
      const { session, study } = await startLiveCase(
        {
          patient_name: form.patient_name,
          patient_age: computedAge,
          patient_dob: form.patient_dob,
          patient_sex: form.patient_sex,
          patient_zip: form.patient_zip,
          study_date: form.study_date,
          octrqaui: form.octrqaui,
          octraccui: form.octraccui,
          client_email: form.client_email,
          client_name: form.client_name,
          subclient: form.subclient,
          md_name: form.md_name,
          revenue: form.revenue,
          modality: form.modality,
          notes: form.notes,
          tech_notes: form.tech_notes,
          radiologist_notes: form.radiologist_notes,
          radiology_report: form.radiology_report,
          started_by_email: user?.email,
          started_by_name: user?.name,
        },
        { auth: studyApiAuth }
      );
      setLiveSessionId(session.id);
      liveSessionIdRef.current = session.id;
      setLiveStudyId(study.id);
      const ok = await handleStartScreenRecording();
      if (!ok) {
        await stopLiveCase(session.id, { auth: studyApiAuth });
        liveSessionIdRef.current = null;
        setLiveSessionId(null);
        setLiveStudyId(null);
        return;
      }
      toast.success(`Live sharing started (Study #${study.id})`);
    } catch (error) {
      showErrorToast(error, 'Failed to start live sharing');
    } finally {
      setStartingLive(false);
    }
  };

  const handleStopLiveCaseShare = async () => {
    if (!liveSessionId) return;
    handleStopScreenRecording();
  };

  const handleResumeLiveCase = async () => {
    if (!recoverableLiveSession) return;
    setLiveSessionId(recoverableLiveSession.id);
    setLiveStudyId(recoverableLiveSession.study_id);
    setRecoverableLiveSession(null);
    const ok = await handleStartScreenRecording();
    if (!ok) {
      setLiveSessionId(null);
      setLiveStudyId(null);
    }
  };

  const handleDismissRecoverableLive = async () => {
    if (!recoverableLiveSession) return;
    try {
      await stopLiveCase(recoverableLiveSession.id, { auth: studyApiAuth });
      if (liveSessionIdRef.current === recoverableLiveSession.id) {
        liveSessionIdRef.current = null;
      }
      setRecoverableLiveSession(null);
      toast.success('Previous live session closed');
    } catch (error) {
      showErrorToast(error, 'Failed to close previous live session');
    }
  };

  useEffect(() => {
    if (!user?.email) return;
    listActiveLiveCases(user.email, { auth: studyApiAuth })
      .then((sessions) => {
        if (!sessions.length) return;
        if (liveSessionId) return;
        const active = sessions[0];
        setRecoverableLiveSession({ id: active.id, study_id: Number(active.study_id) || 0 });
      })
      .catch(() => {
        // ignore recovery check failures
      });
  }, [studyApiAuth, user?.email]);

  useEffect(() => {
    if (!recoverableLiveSession) return;
    if (searchParams.get('resumeLive') !== '1') return;
    recoverLivePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast.info('Active live session found. Resume or end it below.');
  }, [recoverableLiveSession, searchParams]);

  useEffect(() => {
    if (!recordingBlob) {
      setRecordingDuration(0);
      setTrimStartSec(0);
      setTrimEndSec(0);
      return;
    }
    probeRecordingDuration(recordingBlob).catch(() => {
      if (recordingDurationHintRef.current > 0) {
        setRecordingDuration(recordingDurationHintRef.current);
        setTrimStartSec(0);
        setTrimEndSec(recordingDurationHintRef.current);
      }
    });
  }, [recordingBlob]);

  useEffect(() => {
    if (!recordingDuration) return;
    const clampedStart = clampToDuration(trimStartSec);
    const clampedEnd = clampTrimEndToDuration(trimEndSec);
    if (clampedEnd <= clampedStart) {
      setTrimEndSec(Math.min(getMaxTrimEnd(), clampedStart + MIN_TRIM_GAP_SEC));
      return;
    }
    if (clampedStart !== trimStartSec) setTrimStartSec(clampedStart);
    if (clampedEnd !== trimEndSec) setTrimEndSec(clampedEnd);
  }, [recordingDuration, trimStartSec, trimEndSec]);

  useEffect(() => {
    if (!recordingBlob) {
      setRecordingPreviewUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(recordingBlob);
    setRecordingPreviewUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [recordingBlob]);

  const processRecording = async (silent = false): Promise<Blob | null> => {
    const sourceBlob = recordingBlobRef.current || recordingBlob;
    if (!sourceBlob) return null;
    if (trimEndSec <= trimStartSec) {
      toast.error('Trim end must be greater than trim start');
      return null;
    }

    const videoUrl = URL.createObjectURL(sourceBlob);
    try {
      setProcessingRecording(true);
      if (uploading || finalizingLive) {
        setProgress(8);
        setProgressText('Preparing recording processing...');
      }
      const video = document.createElement('video');
      video.src = videoUrl;
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('Timed out loading recording metadata for editing'));
        }, 5000);
        const cleanup = () => {
          window.clearTimeout(timeoutId);
          video.onloadedmetadata = null;
          video.onerror = null;
        };
        video.onloadedmetadata = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        video.onerror = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('Could not load recording for editing'));
        };
      });

      const sourceW = video.videoWidth || 1280;
      const sourceH = video.videoHeight || 720;
      const sx = Math.max(0, Math.min(sourceW - 1, Math.round((cropX / 100) * sourceW)));
      const sy = Math.max(0, Math.min(sourceH - 1, Math.round((cropY / 100) * sourceH)));
      const sw = Math.max(1, Math.min(sourceW - sx, Math.round((cropW / 100) * sourceW)));
      const sh = Math.max(1, Math.min(sourceH - sy, Math.round((cropH / 100) * sourceH)));
      const videoDuration = Number.isFinite(video.duration) ? video.duration : recordingDuration;
      const stopCap = Math.max(0, videoDuration);
      const stopAt = Math.min(trimEndSec, Math.max(trimStartSec + MIN_TRIM_GAP_SEC, stopCap));
      const startAt = Math.min(trimStartSec, Math.max(0, stopAt - MIN_TRIM_GAP_SEC));

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to create video processing context');

      const stream = canvas.captureStream(30);
      const canvasTrack = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
      const mimeType = getPreferredScreenRecordingMimeType();
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, { mimeType });
      } catch {
        rec = new MediaRecorder(stream);
      }
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };

      await new Promise<void>((resolve, reject) => {
        let raf = 0;
        let settled = false;
        const duration = Math.max(0.001, stopAt - startAt);
        const finish = () => {
          if (settled) return;
          settled = true;
          cancelAnimationFrame(raf);
          video.pause();
          resolve();
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cancelAnimationFrame(raf);
          video.pause();
          reject(error);
        };
        const drawFrame = () => {
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          canvasTrack?.requestFrame?.();
        };
        const waitForAnimationFrame = () =>
          new Promise<void>((frameResolve) => {
            requestAnimationFrame(() => frameResolve());
          });
        const seekToStart = () =>
          new Promise<void>((seekResolve, seekReject) => {
            let resolved = false;
            const timeoutId = window.setTimeout(() => {
              cleanup();
              seekResolve();
            }, 2000);
            const cleanup = () => {
              resolved = true;
              window.clearTimeout(timeoutId);
              video.onseeked = null;
              video.onerror = null;
            };
            const complete = () => {
              if (resolved) return;
              cleanup();
              requestAnimationFrame(() => seekResolve());
            };
            video.onseeked = complete;
            video.onerror = () => {
              cleanup();
              seekReject(new Error('Could not seek recording segment'));
            };
            try {
              video.currentTime = startAt;
            } catch {
              cleanup();
              seekReject(new Error('Could not seek recording segment'));
              return;
            }
            requestAnimationFrame(() => {
              if (!resolved && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                complete();
              }
            });
          });
        const draw = () => {
          if (video.currentTime >= stopAt || video.ended) {
            drawFrame();
            if (rec.state !== 'inactive') {
              rec.requestData?.();
              rec.stop();
            }
            cancelAnimationFrame(raf);
            return;
          }
          if (uploading || finalizingLive) {
            const elapsed = Math.max(0, video.currentTime - startAt);
            const processPct = Math.min(100, Math.max(0, (elapsed / duration) * 100));
            setProgress(Math.round(8 + processPct * 0.14));
            setProgressText(`Processing recording... ${Math.round(processPct)}%`);
          }
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          raf = requestAnimationFrame(draw);
        };

        rec.onstop = finish;
        rec.onerror = () => fail(new Error('Failed to process recording'));

        (async () => {
          try {
            await seekToStart();
            drawFrame();
            rec.start(100);
            for (let seedFrame = 0; seedFrame < 12; seedFrame += 1) {
              await waitForAnimationFrame();
              drawFrame();
            }
            await video.play();
            draw();
          } catch {
            fail(new Error('Could not play recording segment'));
          }
        })();
      });

      if (chunks.length === 0) {
        throw new Error('Recording segment is empty. Record a longer clip and try again.');
      }

      const nextBlob = new Blob(chunks, { type: 'video/webm' });
      recordingBlobRef.current = nextBlob;
      setRecordingBlob(nextBlob);
      setRecordingNeedsProcessing(false);
      if (!silent) toast.success('Recording cropped/trimmed');
      if (uploading || finalizingLive) {
        setProgress(25);
        setProgressText('Recording processing complete.');
      }
      return nextBlob;
    } catch (error) {
      showErrorToast(error, 'Failed to edit recording');
      return null;
    } finally {
      URL.revokeObjectURL(videoUrl);
      setProcessingRecording(false);
    }
  };

  const startCropDrag = (
    event: React.PointerEvent,
    mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  ) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setCropDragging({
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: { x: cropX, y: cropY, w: cropW, h: cropH },
    });
  };

  useEffect(() => {
    if (!cropDragging) return;

    const onMove = (event: PointerEvent) => {
      const area = cropAreaRef.current;
      if (!area) return;
      const rect = area.getBoundingClientRect();
      const dxPct = ((event.clientX - cropDragging.startX) / Math.max(rect.width, 1)) * 100;
      const dyPct = ((event.clientY - cropDragging.startY) / Math.max(rect.height, 1)) * 100;
      const minSize = 5;
      const { x, y, w, h } = cropDragging.startCrop;

      if (cropDragging.mode === 'move') {
        const nextX = Math.max(0, Math.min(100 - w, x + dxPct));
        const nextY = Math.max(0, Math.min(100 - h, y + dyPct));
        setCropX(nextX);
        setCropY(nextY);
        setRecordingNeedsProcessing(true);
        return;
      }

      let nextX = x;
      let nextY = y;
      let nextW = w;
      let nextH = h;

      const mode = cropDragging.mode;

      if (mode.includes('e')) {
        nextW = Math.max(minSize, Math.min(100 - x, w + dxPct));
      }
      if (mode.includes('s')) {
        nextH = Math.max(minSize, Math.min(100 - y, h + dyPct));
      }
      if (mode.includes('w')) {
        const right = x + w;
        const tentativeX = Math.max(0, Math.min(right - minSize, x + dxPct));
        nextX = tentativeX;
        nextW = right - tentativeX;
      }
      if (mode.includes('n')) {
        const bottom = y + h;
        const tentativeY = Math.max(0, Math.min(bottom - minSize, y + dyPct));
        nextY = tentativeY;
        nextH = bottom - tentativeY;
      }

      setCropX(nextX);
      setCropY(nextY);
      setCropW(nextW);
      setCropH(nextH);
      setRecordingNeedsProcessing(true);
    };

    const onUp = () => setCropDragging(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [cropDragging]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="animate-fade-up">
        <h1 className="text-2xl font-semibold tracking-tight">New Case</h1>
        <p className="mt-1 text-sm text-muted-foreground">Create a new case and submit imaging for processing</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 animate-fade-up-delay-1">
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Case Information</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="patient_name">Study Title</Label>
              <Input
                id="patient_name"
                value={form.patient_name}
                onChange={(e) => updateField('patient_name', e.target.value)}
                placeholder="Enter study title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client_name">Client</Label>
              <Input
                id="client_name"
                value={form.client_name}
                onChange={(e) => {
                  const value = e.target.value;
                  const matchedClient = clients.find(
                    (client) => client.name.toLowerCase() === value.trim().toLowerCase()
                  );
                  setForm((current) => ({
                    ...current,
                    client_name: value,
                    client_email: matchedClient?.email || current.client_email,
                  }));
                }}
                placeholder="Enter client"
                list="clientOptions"
              />
              <datalist id="clientOptions">
                {clients.map((client) => (
                  <option key={client.email} value={client.name} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="patient_dob">DOB</Label>
              <Input
                id="patient_dob"
                value={form.patient_dob}
                onChange={(e) => updateField('patient_dob', e.target.value)}
                placeholder="YYYY-MM-DD"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="study_date">Study Date</Label>
              <Input id="study_date" value={form.study_date} onChange={(e) => updateField('study_date', e.target.value)} placeholder="YYYY-MM-DD" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient_sex">Sex</Label>
              <Input id="patient_sex" value={form.patient_sex} onChange={(e) => updateField('patient_sex', e.target.value)} placeholder="Enter sex" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient_zip">Zip Code</Label>
              <Input
                id="patient_zip"
                value={form.patient_zip}
                onChange={(e) => updateField('patient_zip', e.target.value)}
                placeholder="Zip code"
                inputMode="numeric"
                autoComplete="postal-code"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="octrqaui">OCTRQAUI</Label>
              <Input id="octrqaui" value={form.octrqaui} onChange={(e) => updateField('octrqaui', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="octraccui">OCTRACCUI</Label>
              <Input id="octraccui" value={form.octraccui} onChange={(e) => updateField('octraccui', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subclient">Subclient</Label>
              <Input id="subclient" value={form.subclient} onChange={(e) => updateField('subclient', e.target.value)} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="md_name">MD</Label>
              <Input
                id="md_name"
                value={form.md_name}
                onChange={(e) => updateField('md_name', e.target.value)}
                placeholder="Sarai"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {canSeeRevenue && (
              <div className="space-y-2">
                <Label htmlFor="revenue">Revenue</Label>
                <Input
                  id="revenue"
                  value={form.revenue}
                  onChange={(e) => updateField('revenue', e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="modality">Modality</Label>
              <Input
                id="modality"
                value={form.modality}
                onChange={(e) => updateField('modality', e.target.value)}
                placeholder="CT, MR, US..."
                list="modalityOptions"
              />
              <datalist id="modalityOptions">
                {MODALITIES.map((modality) => (
                  <option key={modality} value={modality} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient_age">Calculated Age</Label>
              <Input id="patient_age" value={computedAge} readOnly className="bg-muted/40" placeholder="N/A" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Attach image to notes" asChild>
                <label>
                  <Paperclip className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => setNoteImageFiles((current) => ({ ...current, notes: event.target.files?.[0] || null }))}
                  />
                </label>
              </Button>
            </div>
            <Textarea id="notes" value={form.notes} onChange={(e) => updateField('notes', e.target.value)} placeholder="Clinical notes or study description..." rows={3} />
            {noteImageFiles.notes && <p className="text-xs text-muted-foreground preserve-case">{noteImageFiles.notes.name}</p>}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="tech_notes">Tech Notes</Label>
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Attach image to tech notes" asChild>
                <label>
                  <Paperclip className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => setNoteImageFiles((current) => ({ ...current, tech_notes: event.target.files?.[0] || null }))}
                  />
                </label>
              </Button>
            </div>
            <Textarea id="tech_notes" value={form.tech_notes} onChange={(e) => updateField('tech_notes', e.target.value)} placeholder="Technical notes for the study..." rows={3} />
            {noteImageFiles.tech_notes && <p className="text-xs text-muted-foreground preserve-case">{noteImageFiles.tech_notes.name}</p>}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="radiologist_notes">Radiologist Notes</Label>
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Attach image to radiologist notes" asChild>
                <label>
                  <Paperclip className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => setNoteImageFiles((current) => ({ ...current, radiologist_notes: event.target.files?.[0] || null }))}
                  />
                </label>
              </Button>
            </div>
            <Textarea id="radiologist_notes" value={form.radiologist_notes} onChange={(e) => updateField('radiologist_notes', e.target.value)} placeholder="Radiologist notes..." rows={3} />
            {noteImageFiles.radiologist_notes && <p className="text-xs text-muted-foreground preserve-case">{noteImageFiles.radiologist_notes.name}</p>}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="radiology_report">Radiology Report</Label>
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Attach image to radiology report" asChild>
                <label>
                  <Paperclip className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => setNoteImageFiles((current) => ({ ...current, radiology_report: event.target.files?.[0] || null }))}
                  />
                </label>
              </Button>
            </div>
            <Textarea id="radiology_report" value={form.radiology_report} onChange={(e) => updateField('radiology_report', e.target.value)} placeholder="Paste or type the radiology report..." rows={5} />
            {noteImageFiles.radiology_report && <p className="text-xs text-muted-foreground preserve-case">{noteImageFiles.radiology_report.name}</p>}
          </div>
        </div>

        {/* File uploads */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Files</h2>
          {recoverableLiveSession && !liveSessionId && (
            <div ref={recoverLivePanelRef} className="rounded-md border border-red-300 bg-red-50 p-3 space-y-2">
              <div className="text-xs font-semibold text-red-700">
                Active live session found for this account (Study #{recoverableLiveSession.study_id}).
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="destructive" onClick={handleResumeLiveCase}>
                  Resume Live Share
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={handleDismissRecoverableLive}>
                  End Previous Session
                </Button>
              </div>
            </div>
          )}

          {/* DICOM */}
          <div className="space-y-2">
            <Label>DICOM Files</Label>
            <input
              ref={dicomInputRef}
              type="file"
              multiple
              accept=".dcm,.dicom,.ima,.dicm,.jp2,.j2k,.jpf,.jpx,application/dicom,application/octet-stream,image/jp2,image/jpx,image/jpeg2000,video/jpeg2000"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addDicomFiles(Array.from(e.target.files));
              }}
            />
            <input
              ref={jpeg2000InputRef}
              type="file"
              multiple
              accept=".jp2,.j2k,.jpf,.jpx,.j2c,image/jp2,image/jpx,image/jpeg2000,video/jpeg2000,application/octet-stream"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addJpeg2000Files(Array.from(e.target.files));
              }}
            />
            <input
              ref={dicomFolderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addDicomFiles(Array.from(e.target.files));
              }}
            />
            <div className="grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => dicomInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary active:scale-[0.99]"
              >
                <FileImage className="h-5 w-5" />
                Select DICOM files
              </button>
              <button
                type="button"
                onClick={() => jpeg2000InputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-amber-300 px-4 py-8 text-sm text-amber-700 transition-colors hover:border-amber-500 hover:text-amber-800 active:scale-[0.99]"
              >
                <Wand2 className="h-5 w-5" />
                Select JPEG2000 files
              </button>
              <button
                type="button"
                onClick={() => dicomFolderInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary active:scale-[0.99]"
              >
                <FileImage className="h-5 w-5" />
                Upload DICOM/JPEG2000 folder
              </button>
            </div>
            <button
              type="button"
              onClick={() => setConvertJpeg2000ToDcm((prev) => !prev)}
              className={`mt-1 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                convertJpeg2000ToDcm
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              disabled={uploading}
              aria-pressed={convertJpeg2000ToDcm}
            >
              <Wand2 className="h-3.5 w-3.5" />
              {convertJpeg2000ToDcm
                ? 'JPEG2000 conversion forced ON'
                : 'JPEG2000 conversion AUTO'}
            </button>
            <div className="mt-1 inline-flex items-center gap-2 rounded-md border border-black/80 bg-black px-3 py-1.5 text-xs text-white">
              <FileText className="h-3.5 w-3.5" />
              PHI text redaction ON (automatic)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleConvertNow}
                disabled={uploading || preconverting || dicomFiles.length === 0}
                className="h-8 px-3 text-xs"
              >
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                {preconverting ? 'Converting...' : 'Convert Now'}
              </Button>
              {conversionToken && (
                <span className="text-xs text-emerald-600">
                  Converted batch staged
                  {conversionExpiresAt
                    ? ` (expires ${new Date(conversionExpiresAt).toLocaleTimeString()})`
                    : ''}
                </span>
              )}
            </div>
            {dicomFiles.length > 0 && (
              <div className="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
                {dicomFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between rounded-md bg-muted px-3 py-1.5 text-sm">
                    <span className="truncate">{(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}</span>
                    <button type="button" onClick={() => removeDicomFile(i)} className="ml-2 text-muted-foreground hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="text-xs font-medium">Share Case Live</div>
              <div className="flex flex-wrap items-center gap-2">
                {!liveSessionId ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleStartLiveCaseShare}
                    disabled={uploading || preconverting || isRecording || startingLive || !canScreenRecord}
                  >
                    <MonitorPlay className="mr-1.5 h-3.5 w-3.5" />
                    {startingLive ? 'Starting Live...' : 'Share Case Live'}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleStopLiveCaseShare}
                    disabled={uploading || finalizingLive}
                  >
                    <Square className="mr-1.5 h-3.5 w-3.5" />
                    {finalizingLive ? 'Finalizing MP4...' : 'Stop Live Share'}
                  </Button>
                )}
                {liveSessionId && (
                  <span className="text-xs text-red-600 font-medium animate-pulse">
                    LIVE {liveStudyId ? `• Study #${liveStudyId}` : ''}
                  </span>
                )}
              </div>
              <div className="h-px bg-border/60" />
              <div className="text-xs font-medium">Secondary Option: Screen Record DICOM Review</div>
              <div className="flex flex-wrap items-center gap-2">
                {!isRecording ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleStartScreenRecording}
                    disabled={uploading || preconverting || !canScreenRecord}
                  >
                    <MonitorPlay className="mr-1.5 h-3.5 w-3.5" />
                    Record
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleStopScreenRecording}
                    disabled={uploading}
                  >
                    <Square className="mr-1.5 h-3.5 w-3.5" />
                    Stop Recording
                  </Button>
                )}
                {!canScreenRecord && (
                  <span className="text-xs text-muted-foreground">
                    Not supported in this browser/session.
                  </span>
                )}
                {recordingBlob && !isRecording && (
                  <span className="text-xs text-emerald-600">
                    Recording ready ({Math.round(recordingBlob.size / 1024)} KB).
                    {recordingNeedsProcessing ? ' Processing will run before upload.' : ' Will upload with study.'}
                  </span>
                )}
              </div>
              {recordingBlob && !isRecording && (
                <div className="space-y-2 pt-2">
                  <div ref={cropAreaRef} className="relative w-full rounded border bg-black overflow-hidden">
                    <video controls className="w-full" src={recordingPreviewUrl || undefined} />
                    <div
                      className="absolute z-20 border-2 border-white/90 bg-white/10 cursor-move touch-none"
                      style={{
                        left: `${cropX}%`,
                        top: `${cropY}%`,
                        width: `${cropW}%`,
                        height: `${cropH}%`,
                      }}
                      onPointerDown={(e) => startCropDrag(e, 'move')}
                    >
                      <div className="absolute inset-0 pointer-events-none" />
                      <div
                        className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-white border border-black cursor-nwse-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'nw')}
                      />
                      <div
                        className="absolute left-1/2 -translate-x-1/2 -top-2 h-4 w-4 rounded-full bg-white border border-black cursor-ns-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'n')}
                      />
                      <div
                        className="absolute -right-2 -top-2 h-4 w-4 rounded-full bg-white border border-black cursor-nesw-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'ne')}
                      />
                      <div
                        className="absolute -left-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-white border border-black cursor-ew-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'w')}
                      />
                      <div
                        className="absolute -right-2 -bottom-2 h-4 w-4 rounded-full bg-white border border-black cursor-se-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'se')}
                      />
                      <div
                        className="absolute -right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-white border border-black cursor-ew-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'e')}
                      />
                      <div
                        className="absolute -left-2 -bottom-2 h-4 w-4 rounded-full bg-white border border-black cursor-nesw-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 'sw')}
                      />
                      <div
                        className="absolute left-1/2 -translate-x-1/2 -bottom-2 h-4 w-4 rounded-full bg-white border border-black cursor-ns-resize touch-none"
                        onPointerDown={(e) => startCropDrag(e, 's')}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Drag the box to move crop. Use any corner/edge handle to resize from all angles.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="sm:col-span-2 space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Trim range</span>
                        <span>
                          {formatVideoTime(trimStartSec, 1)} - {formatVideoTime(trimEndSec, 1)}
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={Math.max(getMaxTrimEnd(), MIN_TRIM_GAP_SEC)}
                        step={0.1}
                        minStepsBetweenThumbs={Math.ceil(MIN_TRIM_GAP_SEC / 0.1)}
                        value={[trimStartSec, trimEndSec]}
                        onValueChange={(value) => {
                          if (!value || value.length < 2) return;
                          const start = value[0];
                          let end = value[1];
                          if (end <= start) {
                            end = Math.min(getMaxTrimEnd(), start + MIN_TRIM_GAP_SEC);
                          }
                          setTrimStartSec(clampToDuration(start));
                          setTrimEndSec(clampTrimEndToDuration(end));
                          setRecordingNeedsProcessing(true);
                        }}
                        disabled={processingRecording || uploading || !recordingBlob}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Trim Start</Label>
                      <Input
                        type="number"
                        min={0}
                        max={Math.max(0, getMaxTrimEnd())}
                        step="0.1"
                        value={trimStartSec}
                        onChange={(e) => {
                          const nextStart = clampToDuration(Number(e.target.value || 0));
                          setTrimStartSec(nextStart);
                          if (trimEndSec <= nextStart) {
                            setTrimEndSec(Math.min(getMaxTrimEnd(), nextStart + MIN_TRIM_GAP_SEC));
                          }
                          setRecordingNeedsProcessing(true);
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Trim End</Label>
                      <Input
                        type="number"
                        min={0}
                        max={Math.max(0, getMaxTrimEnd())}
                        step="0.1"
                        value={trimEndSec}
                        onChange={(e) => {
                          const nextEnd = clampTrimEndToDuration(Number(e.target.value || 0));
                          setTrimEndSec(nextEnd);
                          if (nextEnd <= trimStartSec) {
                            setTrimStartSec(Math.max(0, nextEnd - MIN_TRIM_GAP_SEC));
                          }
                          setRecordingNeedsProcessing(true);
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="secondary" onClick={processRecording} disabled={processingRecording || uploading}>
                      {processingRecording ? 'Processing...' : 'Apply Crop/Trim'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRecordingBlob(null);
                        recordingBlobRef.current = null;
                        recordingStopPromiseRef.current = null;
                        resolveRecordingStopRef.current = null;
                        setRecordingNeedsProcessing(false);
                      }}
                      disabled={uploading}
                    >
                      Delete Recording
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRecordingBlob(null);
                        recordingBlobRef.current = null;
                        recordingStopPromiseRef.current = null;
                        resolveRecordingStopRef.current = null;
                        setRecordingNeedsProcessing(false);
                        handleStartScreenRecording();
                      }}
                      disabled={uploading || processingRecording}
                    >
                      Retry Recording
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* MP4 */}
          <div className="space-y-2">
            <Label>MP4 Video</Label>
            <input
              ref={mp4InputRef}
              type="file"
              accept=".mp4,.mov,.m4v,.webm,.mkv,.avi,video/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) setMp4File(e.target.files[0]);
              }}
            />
            <button
              type="button"
              onClick={() => mp4InputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary active:scale-[0.99]"
            >
              <FileVideo className="h-5 w-5" />
              {mp4File ? mp4File.name : 'Click to select MP4 file'}
            </button>
            {mp4File && (
              <div className="flex items-center justify-between rounded-md bg-muted px-3 py-1.5 text-sm">
                <span className="truncate">{mp4File.name}</span>
                <button type="button" onClick={() => setMp4File(null)} className="ml-2 text-muted-foreground hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* PDF Report */}
          <div className="space-y-2">
            <Label>Report PDF</Label>
            <input
              ref={pdfInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) setPdfFile(e.target.files[0]);
              }}
            />
            <button
              type="button"
              onClick={() => pdfInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary active:scale-[0.99]"
            >
              <FileText className="h-5 w-5" />
              {pdfFile ? pdfFile.name : 'Click to select report PDF'}
            </button>
            {pdfFile && (
              <div className="flex items-center justify-between rounded-md bg-muted px-3 py-1.5 text-sm">
                <span className="truncate">{pdfFile.name}</span>
                <button type="button" onClick={() => setPdfFile(null)} className="ml-2 text-muted-foreground hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Progress */}
        {(uploading || processingRecording || finalizingLive) && (
          <div className="space-y-2">
            <Progress value={progress} className="h-2" />
            <p className="text-center text-sm text-muted-foreground tabular-nums">{progress}%</p>
            <p className="text-center text-xs text-muted-foreground">{progressText}</p>
          </div>
        )}
        {redactionSummary && !uploading && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <span className="font-medium">Redaction Summary:</span> {redactionSummary}
          </div>
        )}

        <div className="flex gap-3">
          <Button
            type="submit"
            onClick={() => {
              signAfterUploadRef.current = false;
            }}
            disabled={uploading || preconverting || processingRecording || Boolean(liveSessionId) || finalizingLive || !canUploadStudies}
            className="active:scale-[0.98] transition-transform"
          >
            <Upload className="mr-2 h-4 w-4" />
            {uploading ? 'Creating...' : 'Create Case'}
          </Button>
          <Button
            type="submit"
            variant="outline"
            onClick={() => {
              signAfterUploadRef.current = true;
            }}
            disabled={uploading || preconverting || processingRecording || Boolean(liveSessionId) || finalizingLive || !canUploadStudies}
            className="active:scale-[0.98] transition-transform"
          >
            <FileText className="mr-2 h-4 w-4" />
            Create & Sign
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/studies')} disabled={uploading || preconverting}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
