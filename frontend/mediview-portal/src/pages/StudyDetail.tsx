import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  ArrowLeft,
  ExternalLink,
  Trash2,
  Share2,
  Copy,
  Check,
  FileText,
  Cloud,
  CheckCircle2,
  FolderOpen,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useStudyRealtime } from '@/hooks/useStudyRealtime';
import {
  DicomInstance,
  Study,
  UploadProgressState,
  fetchStudyById,
  getViewerLink,
  deleteStudy,
  createShareLink,
  exportToCloud,
  listDicomInstances,
  uploadDicomToStudy,
  downloadDicomScreenshot,
  getDicomScreenshotUrls,
  getMediaBaseUrl,
  listCaseRecordings,
  type CaseRecording,
} from '@/lib/api';
import { openStudySignoffPopup } from '@/lib/studySignoff';
import { showErrorToast } from '@/lib/errorToast';
import { VideoScrubPreviewPlayer } from '@/components/VideoScrubPreviewPlayer';
import { Progress } from '@/components/ui/progress';

const DICOM_FILE_ACCEPT =
  '.dcm,.dicom,.ima,.dicm,.jp2,.j2k,.jpf,.jpx,.j2c,application/dicom,application/octet-stream,image/jp2,image/jpx,image/jpeg2000,video/jpeg2000';
const DICOM_EXTENSIONS = ['.dcm', '.dicom', '.ima', '.dicm', '.jp2', '.j2k', '.jpf', '.jpx', '.j2c'];

export default function StudyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const dicomFileInputRef = useRef<HTMLInputElement>(null);
  const dicomFolderInputRef = useRef<HTMLInputElement>(null);
  const { user, isLoading: authLoading, hasFeature, hasPermission, whiteLabelAccount, studyApiAuth } = useAuth();
  const canSeeRevenue = !whiteLabelAccount || Boolean(user?.isSuperAdmin);
  const canEditStudies = hasPermission('editStudies');
  const canCreateReports = hasPermission('createReports');
  const canExportData = hasPermission('exportData');
  const canDeleteStudies = hasPermission('deleteStudies');

  const [study, setStudy] = useState<Study | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDelete, setShowDelete] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dicomInstances, setDicomInstances] = useState<DicomInstance[]>([]);
  const [loadingDicomInstances, setLoadingDicomInstances] = useState(false);
  const [screenshottingInstanceId, setScreenshottingInstanceId] = useState<string | null>(null);
  const [dicomPage, setDicomPage] = useState(1);
  const [thumbnailAttemptByInstance, setThumbnailAttemptByInstance] = useState<Record<string, number>>({});
  const [selectedDicomInstanceId, setSelectedDicomInstanceId] = useState<string | null>(null);
  const [caseRecordings, setCaseRecordings] = useState<CaseRecording[]>([]);
  const [recordingErrors, setRecordingErrors] = useState<Record<string, string>>({});
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [attachingDicom, setAttachingDicom] = useState(false);
  const [attachProgress, setAttachProgress] = useState<UploadProgressState | null>(null);
  const [stableVideo, setStableVideo] = useState<{
    url: string;
    metadata: Study['video_metadata'];
  } | null>(null);
  const DICOM_PAGE_SIZE = 24;

  const mediaBase = getMediaBaseUrl();

  useEffect(() => {
    if (!dicomFolderInputRef.current) return;
    dicomFolderInputRef.current.setAttribute('webkitdirectory', '');
    dicomFolderInputRef.current.setAttribute('directory', '');
  }, []);

  // Keep the player mounted on the last-known-good video so a background
  // re-upload/reprocess on this study never stops or pauses active playback.
  useEffect(() => {
    if (study?.mp4_url && study.video_processing_status !== 'processing') {
      setStableVideo((prev) =>
        prev && prev.url === study.mp4_url ? prev : { url: study.mp4_url as string, metadata: study.video_metadata }
      );
    }
  }, [study?.mp4_url, study?.video_processing_status, study?.video_metadata]);
  const loadStudy = useCallback(async () => {
    if (!id || authLoading || !studyApiAuth) return;
    const data = await fetchStudyById(id, { auth: studyApiAuth });
    setStudy(data.study || data);
  }, [authLoading, id, studyApiAuth]);

  const loadRecordings = useCallback(async () => {
    if (!id || authLoading || !studyApiAuth) return;
    setLoadingRecordings(true);
    try {
      const payload = await listCaseRecordings({ studyId: id }, studyApiAuth);
      const items = Array.isArray(payload.recordings) ? payload.recordings : [];
      items.sort(
        (a, b) =>
          new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );
      setCaseRecordings(items);
    } catch (err) {
      setCaseRecordings([]);
      showErrorToast(err, 'Failed to load screen recordings');
    } finally {
      setLoadingRecordings(false);
    }
  }, [authLoading, id, studyApiAuth]);

  const realtime = useStudyRealtime({
    studyId: id,
    auth: studyApiAuth,
    mode: 'viewing',
    enabled: Boolean(id && !authLoading && studyApiAuth),
    onChange: () => {
      void loadStudy();
      void loadRecordings();
    },
  });

  const resolveStudyMediaUrl = (rawUrl?: string | null) => {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${mediaBase.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await loadStudy();
      } catch (err) {
        console.error(err);
        if (active) {
          toast.error('Failed to load study');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, [loadStudy]);

  useEffect(() => {
    let active = true;
    loadRecordings().catch((err) => {
      console.error(err);
    });
    return () => {
      active = false;
    };
  }, [loadRecordings]);

  const copyToClipboard = async (text: string, successMessage = 'Copied to clipboard') => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      toast.success(successMessage);
      return true;
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      toast.error('Failed to copy to clipboard');
      return false;
    }
  };

  const handleDelete = async () => {
    try {
      if (!id) return;
      await deleteStudy(id, { auth: studyApiAuth });
      toast.success('Study deleted successfully');
      navigate('/studies');
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete study');
    }
  };

  const handleShare = async () => {
    try {
      if (!id) return;
      const data = await createShareLink(id, { auth: studyApiAuth });
      const url = `${window.location.origin}${data.share_url}`;
      setShareLink(url);
      toast.success('Share link created');
    } catch (err) {
      console.error(err);
      toast.error('Failed to create share link');
    }
  };

  const handleCopyLink = async () => {
    if (!shareLink) return;
    const ok = await copyToClipboard(shareLink, 'Link copied');
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleExportToCloud = async () => {
    try {
      if (!id) return;

      setExporting(true);

      const data = await exportToCloud(id, { auth: studyApiAuth });

      setStudy((prev) =>
        prev
          ? {
              ...prev,
              nextcloud_url: data.url,
              nextcloud_folder: data.folder,
            }
          : prev
      );

      if (data.url) {
        await copyToClipboard(data.url, 'Exported to cloud and link copied');
      } else {
        toast.success('Exported to cloud');
      }
    } catch (err) {
      console.error(err);
      showErrorToast(err, 'Cloud export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleCopyCloudLink = async () => {
    if (!study?.nextcloud_url) return;
    await copyToClipboard(study.nextcloud_url, 'Cloud link copied');
  };

  const handleOpenViewer = async () => {
    try {
      if (!id) return;
      if ((study?.dicom_count ?? 0) <= 0) {
        toast.error('No DICOM images are attached to this case yet.');
        return;
      }
      const viewer = await getViewerLink(id, { auth: studyApiAuth });
      window.open(viewer.viewer_url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error(err);
      showErrorToast(err, 'Failed to open viewer');
    }
  };

  const isDicomLikeFile = (file: File) => {
    const name = file.name.toLowerCase();
    const type = file.type.toLowerCase();
    return (
      DICOM_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
      type.includes('dicom') ||
      type.includes('jpeg2000') ||
      type.includes('jp2') ||
      type === 'application/octet-stream'
    );
  };

  const handleAttachDicomSelection = async (fileList: FileList | null) => {
    const selectedFiles = Array.from(fileList || []);
    const dicomFiles = selectedFiles.filter(isDicomLikeFile);

    if (!id || !dicomFiles.length) {
      toast.error('No DICOM files were selected.');
      return;
    }

    setAttachingDicom(true);
    setAttachProgress({
      stage: 'uploading_dicom',
      percent: 0,
      message: `Preparing ${dicomFiles.length} DICOM file(s)...`,
      totalFiles: dicomFiles.length,
      processedFiles: 0,
      filesRemaining: dicomFiles.length,
    });

    try {
      const result = await uploadDicomToStudy(id, dicomFiles, {
        auth: studyApiAuth,
        convertJpeg2000ToDcm: true,
        redactTextOnUpload: false,
        onProgress: setAttachProgress,
      });
      const uploadedCount = result.dicom_count || dicomFiles.length;
      toast.success(`Attached ${uploadedCount} DICOM image(s) to this case.`);
      setDicomInstances([]);
      await loadStudy();
      setAttachProgress({
        stage: 'finalizing',
        percent: 100,
        message: 'DICOM upload complete.',
        totalFiles: dicomFiles.length,
        processedFiles: dicomFiles.length,
        filesRemaining: 0,
      });
    } catch (err) {
      console.error(err);
      showErrorToast(err, 'Failed to attach DICOM files');
    } finally {
      setAttachingDicom(false);
      if (dicomFileInputRef.current) dicomFileInputRef.current.value = '';
      if (dicomFolderInputRef.current) dicomFolderInputRef.current.value = '';
    }
  };

  const handleLoadDicomInstances = async () => {
    try {
      if (!id) return;
      setLoadingDicomInstances(true);
      const data = await listDicomInstances(id, { auth: studyApiAuth });
      setDicomInstances(data.instances || []);
      setThumbnailAttemptByInstance({});
      setDicomPage(1);
      setSelectedDicomInstanceId(data.instances?.[0]?.instance_id || null);
    } catch (err) {
      console.error(err);
      showErrorToast(err, 'Failed to load DICOM images');
    } finally {
      setLoadingDicomInstances(false);
    }
  };

  const handleScreenshot = async (instance: DicomInstance) => {
    try {
      setScreenshottingInstanceId(instance.instance_id);
      const blob = await downloadDicomScreenshot(instance.instance_id, 0);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `study-${study?.id || 'case'}-image-${instance.index}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast.success(`Downloaded screenshot for image ${instance.index}`);
    } catch (err) {
      console.error(err);
      showErrorToast(err, 'Failed to capture screenshot');
    } finally {
      setScreenshottingInstanceId(null);
    }
  };

  const getThumbnailUrl = (instanceId: string) => {
    const attempt = thumbnailAttemptByInstance[instanceId] || 0;
    const candidates = getDicomScreenshotUrls(instanceId, 0);
    return candidates[Math.min(attempt, candidates.length - 1)];
  };

  const handleThumbnailError = (instanceId: string) => {
    const candidates = getDicomScreenshotUrls(instanceId, 0);

    setThumbnailAttemptByInstance((prev) => {
      const currentAttempt = prev[instanceId] || 0;
      if (currentAttempt >= candidates.length - 1) {
        return prev;
      }

      return {
        ...prev,
        [instanceId]: currentAttempt + 1,
      };
    });
  };

  if (loading) return <div className="p-6">Loading...</div>;
  if (!study) return <div className="p-6">Study not found</div>;

  const totalDicomPages = Math.max(
    1,
    Math.ceil(dicomInstances.length / DICOM_PAGE_SIZE)
  );
  const safeDicomPage = Math.min(dicomPage, totalDicomPages);
  const dicomPageStart = (safeDicomPage - 1) * DICOM_PAGE_SIZE;
  const dicomPageItems = dicomInstances.slice(
    dicomPageStart,
    dicomPageStart + DICOM_PAGE_SIZE
  );
  const selectedDicomInstance =
    dicomInstances.find((instance) => instance.instance_id === selectedDicomInstanceId) ||
    dicomPageItems[0] ||
    null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link to="/studies">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>

        <div className="flex-1">
          <h1 className="text-2xl font-semibold preserve-case">{study.patient_name}</h1>
          <p className="text-sm text-muted-foreground preserve-case">
            {[study.patient_id, study.modality, study.patient_dob ? `DOB ${study.patient_dob}` : '', study.patient_age ? `Age ${study.patient_age}` : '', study.patient_sex, study.patient_zip ? `Zip ${study.patient_zip}` : '', study.client_name, study.md_name ? `MD ${study.md_name}` : ''].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          <input
            ref={dicomFileInputRef}
            type="file"
            multiple
            className="hidden"
            accept={DICOM_FILE_ACCEPT}
            onChange={(event) => void handleAttachDicomSelection(event.currentTarget.files)}
          />
          <input
            ref={dicomFolderInputRef}
            type="file"
            multiple
            className="hidden"
            accept={DICOM_FILE_ACCEPT}
            onChange={(event) => void handleAttachDicomSelection(event.currentTarget.files)}
          />

          <Button variant="outline" onClick={() => openStudySignoffPopup(study.id)}>
            <FileText className="mr-2 h-4 w-4" />
            Read & Sign
          </Button>

          {hasFeature('reportGeneration') && canCreateReports && (
            <Button variant="outline" asChild>
              <Link to={`/reports/new?type=report&studyId=${encodeURIComponent(String(study.id))}`}>
                <FileText className="mr-2 h-4 w-4" />
                Create Report
              </Link>
            </Button>
          )}

          {hasFeature('soapNotes') && canCreateReports && (
            <Button variant="outline" asChild>
              <Link to={`/reports/new?type=soap&studyId=${encodeURIComponent(String(study.id))}`}>
                <FileText className="mr-2 h-4 w-4" />
                Create SOAP Note
              </Link>
            </Button>
          )}

          {canExportData && (
            <Button variant="outline" onClick={handleShare}>
              <Share2 className="mr-2 h-4 w-4" />
              Share
            </Button>
          )}

          {hasFeature('nextcloudReports') && canExportData && (
            <Button
              variant="outline"
              onClick={handleExportToCloud}
              disabled={exporting}
            >
              <Cloud className="mr-2 h-4 w-4" />
              {exporting ? 'Exporting...' : 'Export to Cloud'}
            </Button>
          )}

          <Button onClick={handleOpenViewer}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Viewer
          </Button>
          <Button
            variant="outline"
            onClick={() => dicomFolderInputRef.current?.click()}
            disabled={attachingDicom || !canEditStudies}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Attach DICOM Folder
          </Button>
          <Button
            variant="outline"
            onClick={() => dicomFileInputRef.current?.click()}
            disabled={attachingDicom || !canEditStudies}
          >
            <Upload className="mr-2 h-4 w-4" />
            Attach DICOM Files
          </Button>
          {canDeleteStudies && (
            <Button variant="ghost" onClick={() => setShowDelete(true)}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      {shareLink && (
        <div className="flex items-center gap-3 border p-4 rounded">
          <div className="flex-1 truncate text-sm preserve-case">{shareLink}</div>
          <Button size="sm" onClick={handleCopyLink}>
            {copied ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-2 h-4 w-4" />
                Copy
              </>
            )}
          </Button>
        </div>
      )}

      {study.nextcloud_url && (
        <div className="flex items-center gap-3 border p-4 rounded">
          <div className="flex-1 truncate text-sm preserve-case">{study.nextcloud_url}</div>
          <Button size="sm" onClick={handleCopyCloudLink}>
            <Copy className="mr-2 h-4 w-4" />
            Copy Cloud Link
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="preserve-case">Patient: {study.patient_name}</div>
        <div className="preserve-case">ID: {study.patient_id}</div>
        <div className="preserve-case">DOB: {study.patient_dob || '—'}</div>
        <div className="preserve-case">Calculated Age: {study.patient_age || '—'}</div>
        <div className="preserve-case">Sex: {study.patient_sex || '—'}</div>
        <div className="preserve-case">Zip Code: {study.patient_zip || '—'}</div>
        <div className="preserve-case">Date: {study.study_date}</div>
        <div className="preserve-case">Client: {study.client_name || '—'}</div>
        <div className="preserve-case">Subclient: {study.subclient || '—'}</div>
        <div className="preserve-case">MD: {study.md_name || '—'}</div>
        {canSeeRevenue && <div className="preserve-case">Revenue: {study.revenue || '—'}</div>}
        <div className="preserve-case">Recorded By: {study.recorded_by || '—'}</div>
        <div className="preserve-case">Transcribed By: {study.transcribed_by || '—'}</div>
        <div className="preserve-case">OCTRQAUI: {study.octrqaui || '—'}</div>
        <div className="preserve-case">OCTRACCUI: {study.octraccui || '—'}</div>
        <div>DICOM: {study.dicom_count || 0}</div>
      </div>

      <Badge className={String(study.status || '').toLowerCase() === 'complete' ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : undefined}>
        {String(study.status || '').toLowerCase() === 'complete' && <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
        {study.status || 'ready'}
      </Badge>

      {attachProgress && (
        <div className="space-y-2 rounded border p-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{attachProgress.message}</span>
            <span className="text-muted-foreground">{Math.round(attachProgress.percent)}%</span>
          </div>
          <Progress value={attachProgress.percent} />
          <p className="text-xs text-muted-foreground">
            {attachProgress.processedFiles}/{attachProgress.totalFiles} file(s) processed
            {attachProgress.totalBatches
              ? ` · batch ${attachProgress.currentBatch || 1}/${attachProgress.totalBatches}`
              : ''}
          </p>
        </div>
      )}

      {(study.dicom_count ?? 0) <= 0 && (
        <div className="space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-medium">No DICOM images are attached to this case.</div>
          <p>
            Attach the original DICOM folder here to link images to this case. This avoids creating another empty case record.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => dicomFolderInputRef.current?.click()}
              disabled={attachingDicom}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              Attach Folder
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => dicomFileInputRef.current?.click()}
              disabled={attachingDicom}
            >
              <Upload className="mr-2 h-4 w-4" />
              Attach Files
            </Button>
          </div>
        </div>
      )}

      {(study.dicom_count ?? 0) > 0 && (
        <div className="space-y-3 border p-4 rounded">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">DICOM Images</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadDicomInstances}
              disabled={loadingDicomInstances}
            >
              {loadingDicomInstances ? 'Loading...' : 'Load Images'}
            </Button>
          </div>

          {dicomInstances.length > 0 && (
            <div className="space-y-3">
              {selectedDicomInstance && (
                <div className="border rounded p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">Selected Image {selectedDicomInstance.index}</div>
                      <div className="text-xs text-muted-foreground truncate preserve-case">
                        {selectedDicomInstance.instance_id}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleScreenshot(selectedDicomInstance)}
                      disabled={screenshottingInstanceId === selectedDicomInstance.instance_id}
                    >
                      {screenshottingInstanceId === selectedDicomInstance.instance_id
                        ? 'Capturing...'
                        : 'Download Screenshot'}
                    </Button>
                  </div>

                  <div className="aspect-video w-full overflow-hidden rounded bg-muted">
                    <img
                      src={getThumbnailUrl(selectedDicomInstance.instance_id)}
                      alt={`Selected DICOM image ${selectedDicomInstance.index}`}
                      className="h-full w-full object-contain"
                      onError={() => handleThumbnailError(selectedDicomInstance.instance_id)}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {dicomPageItems.map((instance) => (
                  <div
                    key={instance.instance_id}
                    className={`border rounded p-2 space-y-2 cursor-pointer ${
                      selectedDicomInstanceId === instance.instance_id ? 'ring-2 ring-primary' : ''
                    }`}
                    onClick={() => setSelectedDicomInstanceId(instance.instance_id)}
                  >
                    <div className="aspect-square w-full overflow-hidden rounded bg-muted">
                      <img
                        src={getThumbnailUrl(instance.instance_id)}
                        alt={`DICOM image ${instance.index}`}
                        loading="lazy"
                        className="h-full w-full object-contain"
                        onError={() => handleThumbnailError(instance.instance_id)}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">
                        Image {instance.index}
                      </div>
                      <Button
                        size="sm"
                        variant={selectedDicomInstanceId === instance.instance_id ? 'default' : 'outline'}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedDicomInstanceId(instance.instance_id);
                          handleScreenshot(instance);
                        }}
                        disabled={screenshottingInstanceId === instance.instance_id}
                      >
                        {screenshottingInstanceId === instance.instance_id
                          ? 'Capturing...'
                          : 'Screenshot'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Showing {dicomPageStart + 1}-{Math.min(dicomPageStart + DICOM_PAGE_SIZE, dicomInstances.length)} of {dicomInstances.length} images.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDicomPage((p) => Math.max(1, p - 1))}
                    disabled={safeDicomPage <= 1}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {safeDicomPage} / {totalDicomPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDicomPage((p) => Math.min(totalDicomPages, p + 1))
                    }
                    disabled={safeDicomPage >= totalDicomPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}

          {dicomInstances.length === 0 && !loadingDicomInstances && (
            <p className="text-xs text-muted-foreground">
              Click "Load Images" to preview thumbnails and capture a specific slice.
            </p>
          )}
        </div>
      )}

      {study.notes && (
        <div>
          <h2>Notes</h2>
          <p className="preserve-case">{study.notes}</p>
        </div>
      )}

      {study.tech_notes && (
        <div>
          <h2>Tech Notes</h2>
          <p className="preserve-case whitespace-pre-wrap">{study.tech_notes}</p>
        </div>
      )}

      {study.radiologist_notes && (
        <div>
          <h2>Radiologist Notes</h2>
          <p className="preserve-case whitespace-pre-wrap">{study.radiologist_notes}</p>
        </div>
      )}

      {study.radiology_report && (
        <div>
          <h2>Radiology Report</h2>
          <p className="preserve-case whitespace-pre-wrap">{study.radiology_report}</p>
        </div>
      )}

      {Array.isArray(study.case_reports) && study.case_reports.length > 0 && (
        <div className="space-y-2">
          <h2>Reports</h2>
          <div className="space-y-2">
            {study.case_reports.map((report) => (
              <div key={report.id} className="rounded border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium preserve-case">{report.title || report.filename || 'Report'}</div>
                    <div className="text-xs text-muted-foreground preserve-case">
                      {report.case_label || `Study #${study.id}`} · {report.report_type || 'report'}
                    </div>
                  </div>
                  {report.report_url && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={resolveStudyMediaUrl(report.report_url)} target="_blank" rel="noopener noreferrer">
                        <FileText className="mr-2 h-4 w-4" />
                        Open
                      </a>
                    </Button>
                  )}
                </div>
                {report.text && (
                  <p className="mt-2 whitespace-pre-wrap preserve-case">{report.text}</p>
                )}
                {report.report_url && (String(report.report_type || '').toLowerCase() === 'image' || String(report.mime_type || '').startsWith('image/')) && (
                  <a href={resolveStudyMediaUrl(report.report_url)} target="_blank" rel="noopener noreferrer">
                    <img
                      src={resolveStudyMediaUrl(report.report_url)}
                      alt={report.title || report.filename || 'Attached image'}
                      className="mt-3 max-h-80 rounded border object-contain"
                    />
                  </a>
                )}
                {report.report_url && (report.report_type === 'audio' || String(report.mime_type || '').startsWith('audio/')) && (
                  <audio controls className="mt-3 w-full" src={resolveStudyMediaUrl(report.report_url)}>
                    <a href={resolveStudyMediaUrl(report.report_url)}>Download audio</a>
                  </audio>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {study.pdf_url && (
        <Button asChild>
          <a
            href={resolveStudyMediaUrl(study.pdf_url)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileText className="mr-2 h-4 w-4" />
            View PDF
          </a>
        </Button>
      )}

      {study.video_processing_status === 'processing' && !stableVideo && (
        <div className="rounded border bg-muted/30 p-4 text-sm text-muted-foreground">
          Video is processing. Playback will be available when optimization finishes.
        </div>
      )}

      {study.video_processing_status === 'failed' && !stableVideo && (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Video processing failed{study.video_processing_error ? `: ${study.video_processing_error}` : '.'}
        </div>
      )}

      {stableVideo && (
        <div>
          {study.video_processing_status === 'processing' && (
            <div className="mb-2 rounded border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
              A newer version is processing in the background — playback below is uninterrupted.
            </div>
          )}
          {study.video_processing_status === 'failed' && (
            <div className="mb-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              Reprocessing failed{study.video_processing_error ? `: ${study.video_processing_error}` : '.'} Showing the last working version.
            </div>
          )}
          <VideoScrubPreviewPlayer
            src={resolveStudyMediaUrl(stableVideo.url)}
            metadata={stableVideo.metadata}
            resolveMediaUrl={resolveStudyMediaUrl}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Live sync</span>
        <Badge variant={realtime.connected ? 'secondary' : 'outline'}>
          {realtime.connected ? 'Connected' : 'Offline'}
        </Badge>
        <span>
          {realtime.presence.filter((entry) => entry.mode === 'editing' || entry.mode === 'signoff').length
            ? `${realtime.presence.filter((entry) => entry.mode === 'editing' || entry.mode === 'signoff').length} editing`
            : `${realtime.presence.length} viewing`}
        </span>
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">Screen Recordings</h2>
        {loadingRecordings ? (
          <p className="text-xs text-muted-foreground">Loading recordings...</p>
        ) : caseRecordings.length === 0 ? (
          <p className="text-xs text-muted-foreground">No screen recordings uploaded for this study yet.</p>
        ) : (
          <div className="space-y-3">
            {caseRecordings.map((recording) => {
              const looksCorrupted =
                typeof recording.file_size === 'number' && recording.file_size > 0 && recording.file_size < 1024;
              const errorMessage =
                recordingErrors[recording.id] ||
                (looksCorrupted ? 'This recording appears to be corrupted (file too small) and cannot be played.' : null);
              return (
                <div key={recording.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {new Date(recording.created_at || '').toLocaleString()}
                  </p>
                  {errorMessage ? (
                    <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {errorMessage}
                    </div>
                  ) : (
                    <video
                      controls
                      className="w-full rounded border bg-black"
                      src={resolveStudyMediaUrl(recording.recording_url)}
                      onError={(e) => {
                        const code = e.currentTarget.error?.code;
                        const message =
                          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                            ? 'This recording could not be loaded. The file may be missing or corrupted.'
                            : code === MediaError.MEDIA_ERR_NETWORK
                            ? 'Recording failed to load — check your connection or sign-in status, then reload the page.'
                            : 'Recording playback failed unexpectedly.';
                        setRecordingErrors((prev) => ({ ...prev, [recording.id]: message }));
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Study</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the study for <span className="preserve-case">{study.patient_name}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
