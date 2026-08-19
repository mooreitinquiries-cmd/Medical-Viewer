import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, CheckCircle2, ExternalLink, FileText, LocateFixed, Maximize2, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { addStudyReport, completeStudy, fetchStudyById, getMediaBaseUrl, type ReadingLocation, type Study } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useStudyRealtime } from '@/hooks/useStudyRealtime';
import { showErrorToast } from '@/lib/errorToast';

type PdfAttachment = {
  id: string;
  title: string;
  url: string;
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

function getBrowserContext() {
  if (typeof navigator === 'undefined') {
    return {
      user_agent: '',
      timezone: '',
      language: '',
      platform: '',
    };
  }

  const nav = navigator as NavigatorWithUserAgentData;
  return {
    user_agent: nav.userAgent || '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    language: nav.language || '',
    platform: nav.userAgentData?.platform || nav.platform || '',
  };
}

function isBrowserGeolocationAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
}

function isPdfReport(report: NonNullable<Study['case_reports']>[number]) {
  const mimeType = String(report.mime_type || '').toLowerCase();
  const reportType = String(report.report_type || '').toLowerCase();
  const filename = String(report.filename || report.report_url || '').toLowerCase();
  return mimeType.includes('pdf') || reportType === 'pdf' || filename.endsWith('.pdf');
}

function getPdfAttachments(study: Study): PdfAttachment[] {
  const attachments: PdfAttachment[] = [];
  if (study.pdf_url) {
    attachments.push({
      id: 'study-pdf',
      title: 'Study Report PDF',
      url: study.pdf_url,
    });
  }
  if (Array.isArray(study.case_reports)) {
    study.case_reports.filter(isPdfReport).forEach((report) => {
      if (!report.report_url) return;
      attachments.push({
        id: report.id,
        title: report.title || report.filename || 'Attached PDF',
        url: report.report_url,
      });
    });
  }
  return attachments;
}

export default function StudySignoffPopup() {
  const { id } = useParams();
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const [study, setStudy] = useState<Study | null>(null);
  const [radiologyReport, setRadiologyReport] = useState('');
  const [completionNote, setCompletionNote] = useState('');
  const [recordedBy, setRecordedBy] = useState('');
  const [transcribedBy, setTranscribedBy] = useState('');
  const [readingLocation, setReadingLocation] = useState<ReadingLocation>({
    country: '',
    state: '',
    zip_code: '',
    address: '',
  });
  const [selectedPdfId, setSelectedPdfId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const mediaBase = getMediaBaseUrl();
  const loadStudy = useCallback(async () => {
    if (!id) return;
    const response = await fetchStudyById(id, { auth: studyApiAuth });
    const nextStudy = response.study || response;
    setStudy(nextStudy);
    setRadiologyReport(nextStudy.radiology_report || '');
    setCompletionNote(nextStudy.completion_note || '');
    setRecordedBy(nextStudy.recorded_by || '');
    setTranscribedBy(nextStudy.transcribed_by || '');
    setReadingLocation({
      country: nextStudy.reading_location?.country || '',
      state: nextStudy.reading_location?.state || '',
      zip_code: nextStudy.reading_location?.zip_code || '',
      address: nextStudy.reading_location?.address || '',
      latitude: nextStudy.reading_location?.latitude ?? null,
      longitude: nextStudy.reading_location?.longitude ?? null,
    });
    setIsDirty(false);
    const pdfs = getPdfAttachments(nextStudy);
    setSelectedPdfId((current) => current || pdfs[0]?.id || '');
  }, [id, studyApiAuth]);

  const realtime = useStudyRealtime({
    studyId: id,
    auth: studyApiAuth,
    mode: 'signoff',
    enabled: Boolean(id && studyApiAuth),
    onChange: () => {
      if (!isDirty) {
        void loadStudy();
      }
    },
  });

  useEffect(() => {
    if (!id) return;
    let isMounted = true;
    loadStudy()
      .then(() => {
        if (!isMounted) return;
      })
      .catch((error) => {
        showErrorToast(error, 'Failed to load study');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [loadStudy]);

  const requestFullscreen = () => {
    document.documentElement.requestFullscreen?.().catch(() => {
      toast.error('Fullscreen was blocked by the browser.');
    });
  };

  const updateReadingLocation = (field: 'country' | 'state' | 'zip_code' | 'address', value: string) => {
    setReadingLocation((current) => ({
      ...current,
      [field]: value,
    }));
    setIsDirty(true);
  };

  const captureBrowserCoordinates = () => {
    if (!isBrowserGeolocationAvailable()) {
      toast.error('Location capture is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setReadingLocation((current) => ({
          ...current,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }));
        setIsDirty(true);
        toast.success('Browser coordinates captured');
      },
      () => {
        toast.error('Browser location permission was denied or unavailable.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  };

  const attachSignoffImage = async (file: File | undefined, title: string) => {
    if (!file || !id || !studyApiAuth) return;
    try {
      setSaving(true);
      const response = await addStudyReport(
        id,
        {
          title,
          caseLabel: study?.patient_name || `Study #${id}`,
          reportType: 'image',
          file,
        },
        { auth: studyApiAuth }
      );
      setStudy(response.study);
      toast.success('Image attached');
    } catch (error) {
      showErrorToast(error, 'Failed to attach image');
    } finally {
      setSaving(false);
    }
  };

  const signComplete = async () => {
    if (!id) return;
    if (!studyApiAuth) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    if (!readingLocation.country?.trim() || !readingLocation.state?.trim() || !readingLocation.zip_code?.trim()) {
      toast.error('Country, state/region, and postal code are required before sign-off.');
      return;
    }
    try {
      setSaving(true);
      const response = await completeStudy(
        id,
        {
          radiology_report: radiologyReport,
          completion_note: completionNote,
          recorded_by: recordedBy,
          transcribed_by: transcribedBy,
          reading_location: {
            country: readingLocation.country?.trim(),
            state: readingLocation.state?.trim(),
            zip_code: readingLocation.zip_code?.trim(),
            address: readingLocation.address?.trim(),
            latitude: readingLocation.latitude ?? null,
            longitude: readingLocation.longitude ?? null,
          },
          browser_context: getBrowserContext(),
        },
        { auth: studyApiAuth, baseUpdatedAt: study?.updated_at }
      );
      setStudy(response.study);
      setIsDirty(false);
      toast.success('Case signed complete');
    } catch (error) {
      showErrorToast(error, 'Failed to sign complete');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading signoff...</div>;
  }

  if (!study) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Study not found.</div>;
  }

  const completed = String(study.status || '').toLowerCase() === 'complete';
  const pdfAttachments = getPdfAttachments(study);
  const selectedPdf = pdfAttachments.find((attachment) => attachment.id === selectedPdfId) || pdfAttachments[0] || null;
  const resolveStudyMediaUrl = (rawUrl?: string | null) => {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${mediaBase.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
  };
  const selectedPdfUrl = selectedPdf ? resolveStudyMediaUrl(selectedPdf.url) : '';

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold preserve-case">{study.patient_name || `Study #${study.id}`}</h1>
              <Badge className={completed ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : undefined} variant={completed ? 'secondary' : 'secondary'}>
                {completed && <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                {study.status || 'ready'}
              </Badge>
            </div>
            <div className="mt-1 text-sm text-muted-foreground preserve-case">
              {study.modality || 'Modality'} · {study.study_date || 'No date'} · DICOM {study.dicom_count || 0}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Live sync</span>
              <Badge variant={realtime.connected ? 'secondary' : 'outline'}>
                {realtime.connected ? 'Connected' : 'Offline'}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={requestFullscreen}>
              <Maximize2 className="mr-2 h-4 w-4" />
              Full Screen
            </Button>
            <Button type="button" onClick={signComplete} disabled={saving}>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {saving ? 'Signing...' : 'Sign Complete'}
            </Button>
            <Button type="button" variant="outline" onClick={() => window.close()}>
              <X className="mr-2 h-4 w-4" />
              Close
            </Button>
          </div>
        </div>
      </header>

      <main className="grid gap-6 px-6 py-6 xl:grid-cols-[minmax(360px,0.95fr)_minmax(420px,1.05fr)_360px] lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-5">
          <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">PDF Viewer</h2>
              {selectedPdfUrl && (
                <Button type="button" size="sm" variant="outline" asChild>
                  <a href={selectedPdfUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open PDF
                  </a>
                </Button>
              )}
            </div>
            {pdfAttachments.length > 0 ? (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {pdfAttachments.map((attachment) => (
                    <Button
                      key={attachment.id}
                      type="button"
                      size="sm"
                      variant={attachment.id === selectedPdf?.id ? 'default' : 'outline'}
                      onClick={() => setSelectedPdfId(attachment.id)}
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      {attachment.title}
                    </Button>
                  ))}
                </div>
                <iframe
                  title={selectedPdf?.title || 'PDF report'}
                  src={selectedPdfUrl}
                  className="h-[68vh] w-full rounded-md border bg-muted"
                />
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                No PDF is attached to this study.
              </div>
            )}
          </div>
        </section>

        <section className="space-y-5">
          <div className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Radiology Report</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" asChild disabled={saving}>
                <label>
                  <Paperclip className="mr-2 h-4 w-4" />
                  Add Image
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => {
                      void attachSignoffImage(event.target.files?.[0], 'Radiology report image');
                      event.target.value = '';
                    }}
                  />
                </label>
              </Button>
              <Button type="button" size="sm" variant="outline" asChild disabled={saving}>
                <label>
                  <Camera className="mr-2 h-4 w-4" />
                  Add Screenshot
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => {
                      void attachSignoffImage(event.target.files?.[0], 'Signoff screenshot');
                      event.target.value = '';
                    }}
                  />
                </label>
              </Button>
            </div>
            <Textarea
              value={radiologyReport}
              onChange={(event) => {
                setRadiologyReport(event.target.value);
                setIsDirty(true);
              }}
              className="mt-3 min-h-[52vh] preserve-case"
              placeholder="Read, edit, or paste the radiology report before signing..."
            />
          </div>
          <div className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Completion Note</h2>
            <div className="mt-3 flex justify-end">
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Attach image to completion note" asChild disabled={saving}>
                <label>
                  <Paperclip className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => {
                      void attachSignoffImage(event.target.files?.[0], 'Completion note image');
                      event.target.value = '';
                    }}
                  />
                </label>
              </Button>
            </div>
            <Textarea
              value={completionNote}
              onChange={(event) => {
                setCompletionNote(event.target.value);
                setIsDirty(true);
              }}
              className="mt-3 min-h-24 preserve-case"
              placeholder="Optional completion/signoff note..."
            />
          </div>
          <div className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Signoff Details</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="recorded_by" className="text-sm font-medium">Recorded By</label>
                <Input
                  id="recorded_by"
                  value={recordedBy}
                  onChange={(event) => {
                    setRecordedBy(event.target.value);
                    setIsDirty(true);
                  }}
                  placeholder="Who recorded the case"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="transcribed_by" className="text-sm font-medium">Transcribed By</label>
                <Input
                  id="transcribed_by"
                  value={transcribedBy}
                  onChange={(event) => {
                    setTranscribedBy(event.target.value);
                    setIsDirty(true);
                  }}
                  placeholder="Who transcribed the case"
                />
              </div>
            </div>
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium">Reading Location</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <label htmlFor="reading_country" className="text-sm font-medium">Country</label>
                  <Input
                    id="reading_country"
                    value={readingLocation.country || ''}
                    onChange={(event) => updateReadingLocation('country', event.target.value)}
                    placeholder="US"
                    autoComplete="country-name"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="reading_state" className="text-sm font-medium">State / Region</label>
                  <Input
                    id="reading_state"
                    value={readingLocation.state || ''}
                    onChange={(event) => updateReadingLocation('state', event.target.value)}
                    placeholder="State or region"
                    autoComplete="address-level1"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="reading_zip" className="text-sm font-medium">Postal Code</label>
                  <Input
                    id="reading_zip"
                    value={readingLocation.zip_code || ''}
                    onChange={(event) => updateReadingLocation('zip_code', event.target.value)}
                    placeholder="ZIP or postal code"
                    autoComplete="postal-code"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="reading_address" className="text-sm font-medium">Address</label>
                <Input
                  id="reading_address"
                  value={readingLocation.address || ''}
                  onChange={(event) => updateReadingLocation('address', event.target.value)}
                  placeholder="Street address"
                  autoComplete="street-address"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" size="sm" variant="outline" onClick={captureBrowserCoordinates} disabled={!isBrowserGeolocationAvailable()}>
                  <LocateFixed className="mr-2 h-4 w-4" />
                  Capture Browser Location
                </Button>
                {readingLocation.latitude !== null && readingLocation.latitude !== undefined && readingLocation.longitude !== null && readingLocation.longitude !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    {readingLocation.latitude.toFixed(5)}, {readingLocation.longitude.toFixed(5)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="space-y-4 lg:col-start-2 xl:col-start-auto">
          <div className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Case Summary</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div><dt className="text-muted-foreground">Patient</dt><dd className="preserve-case">{study.patient_name || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Patient ID</dt><dd className="preserve-case">{study.patient_id || '-'}</dd></div>
              <div><dt className="text-muted-foreground">DOB / Age</dt><dd className="preserve-case">{study.patient_dob || '-'} / {study.patient_age || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Sex / Zip</dt><dd className="preserve-case">{study.patient_sex || '-'} / {study.patient_zip || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Client</dt><dd className="preserve-case">{study.client_name || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Subclient</dt><dd className="preserve-case">{study.subclient || '-'}</dd></div>
              <div><dt className="text-muted-foreground">MD</dt><dd className="preserve-case">{study.md_name || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Revenue</dt><dd className="preserve-case">{study.revenue || '-'}</dd></div>
              <div><dt className="text-muted-foreground">OCTRQAUI</dt><dd className="preserve-case">{study.octrqaui || '-'}</dd></div>
              <div><dt className="text-muted-foreground">OCTRACCUI</dt><dd className="preserve-case">{study.octraccui || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Signed By</dt><dd className="preserve-case">{study.completed_by_name || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Recorded By</dt><dd className="preserve-case">{study.recorded_by || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Transcribed By</dt><dd className="preserve-case">{study.transcribed_by || '-'}</dd></div>
              <div><dt className="text-muted-foreground">Signed At</dt><dd>{study.completed_at ? new Date(study.completed_at).toLocaleString() : '-'}</dd></div>
              <div>
                <dt className="text-muted-foreground">Reading Location</dt>
                <dd className="preserve-case">
                  {[study.reading_location?.address, study.reading_location?.state, study.reading_location?.zip_code, study.reading_location?.country].filter(Boolean).join(', ') || '-'}
                </dd>
              </div>
            </dl>
          </div>
          {study.notes && (
            <div className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Notes</h2>
              <p className="mt-3 whitespace-pre-wrap preserve-case text-sm">{study.notes}</p>
            </div>
          )}
          {study.tech_notes && (
            <div className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tech Notes</h2>
              <p className="mt-3 whitespace-pre-wrap preserve-case text-sm">{study.tech_notes}</p>
            </div>
          )}
          {study.radiologist_notes && (
            <div className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Radiologist Notes</h2>
              <p className="mt-3 whitespace-pre-wrap preserve-case text-sm">{study.radiologist_notes}</p>
            </div>
          )}
          {Array.isArray(study.case_reports) && study.case_reports.length > 0 && (
            <div className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Attached Reports</h2>
              <div className="mt-3 space-y-2 text-sm">
                {study.case_reports.map((report) => (
                  <div key={report.id} className="rounded border p-2">
                    <div className="font-medium preserve-case">{report.title || report.filename || 'Report'}</div>
                    <div className="text-xs text-muted-foreground">{report.report_type || 'report'}</div>
                    {report.text && <p className="mt-2 whitespace-pre-wrap preserve-case">{report.text}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
