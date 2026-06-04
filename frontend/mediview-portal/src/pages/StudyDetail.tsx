import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import {
  DicomInstance,
  Study,
  fetchStudyById,
  getViewerLink,
  deleteStudy,
  createShareLink,
  exportToCloud,
  listDicomInstances,
  downloadDicomScreenshot,
  getDicomScreenshotUrls,
  getMediaBaseUrl,
  listCaseRecordings,
  type CaseRecording,
} from '@/lib/api';

export default function StudyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );

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
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const DICOM_PAGE_SIZE = 24;

  const mediaBase = getMediaBaseUrl();
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
        if (!id) return;

        const data = await fetchStudyById(id, { auth: studyApiAuth });
        if (active) {
          setStudy(data.study || data);
        }
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
  }, [id, studyApiAuth]);

  useEffect(() => {
    let active = true;
    const loadRecordings = async () => {
      if (!id) return;
      try {
        setLoadingRecordings(true);
        const payload = await listCaseRecordings(
          { studyId: id },
          studyApiAuth
        );
        if (!active) return;
        const items = Array.isArray(payload.recordings) ? payload.recordings : [];
        items.sort(
          (a, b) =>
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
        setCaseRecordings(items);
      } catch (err) {
        if (!active) return;
        setCaseRecordings([]);
        toast.error(err instanceof Error ? err.message : 'Failed to load screen recordings');
      } finally {
        if (active) setLoadingRecordings(false);
      }
    };

    loadRecordings();
    return () => {
      active = false;
    };
  }, [id, studyApiAuth]);

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
      toast.error(err instanceof Error ? err.message : 'Cloud export failed');
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
      const viewer = await getViewerLink(id, { auth: studyApiAuth });
      window.open(viewer.viewer_url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to open viewer');
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
      toast.error(err instanceof Error ? err.message : 'Failed to load DICOM images');
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
      toast.error(err instanceof Error ? err.message : 'Failed to capture screenshot');
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
            {[study.patient_id, study.modality, study.patient_age ? `Age ${study.patient_age}` : '', study.patient_sex, study.patient_zip ? `Zip ${study.patient_zip}` : ''].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handleShare}>
            <Share2 className="mr-2 h-4 w-4" />
            Share
          </Button>

          <Button
            variant="outline"
            onClick={handleExportToCloud}
            disabled={exporting}
          >
            <Cloud className="mr-2 h-4 w-4" />
            {exporting ? 'Exporting...' : 'Export to Cloud'}
          </Button>

          <Button onClick={handleOpenViewer}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Viewer
          </Button>
          <Button variant="ghost" onClick={() => setShowDelete(true)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
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
        <div className="preserve-case">Age: {study.patient_age || '—'}</div>
        <div className="preserve-case">Sex: {study.patient_sex || '—'}</div>
        <div className="preserve-case">Zip Code: {study.patient_zip || '—'}</div>
        <div className="preserve-case">Date: {study.study_date}</div>
        <div>DICOM: {study.dicom_count || 0}</div>
      </div>

      <Badge>{study.status || 'ready'}</Badge>

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

      {study.mp4_url && (
        <video
          controls
          className="w-full rounded border"
          src={resolveStudyMediaUrl(study.mp4_url)}
        />
      )}

      <div className="space-y-2">
        <h2 className="font-semibold">Screen Recordings</h2>
        {loadingRecordings ? (
          <p className="text-xs text-muted-foreground">Loading recordings...</p>
        ) : caseRecordings.length === 0 ? (
          <p className="text-xs text-muted-foreground">No screen recordings uploaded for this study yet.</p>
        ) : (
          <div className="space-y-3">
            {caseRecordings.map((recording) => (
              <div key={recording.id} className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {new Date(recording.created_at || '').toLocaleString()}
                </p>
                <video
                  controls
                  className="w-full rounded border bg-black"
                  src={resolveStudyMediaUrl(recording.recording_url)}
                />
              </div>
            ))}
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
