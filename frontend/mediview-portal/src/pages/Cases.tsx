import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Cloud, FileText, MessageCircle, PlayCircle } from 'lucide-react';
import { toast } from 'sonner';
import { listCareCases, updateCareCaseStatus, type CareCase } from '@/lib/careApi';
import { getMediaBaseUrl, listCaseRecordings, type CaseRecording } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { getVisibleErrorMessage } from '@/lib/sessionApi';

const CALL_APP_URL = 'https://call.octelerad.com';

export default function Cases() {
  const navigate = useNavigate();
  const { user, hasFeature } = useAuth();
  const [cases, setCases] = useState<CareCase[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [caseRecordings, setCaseRecordings] = useState<CaseRecording[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const mediaBase = getMediaBaseUrl();
  const resolveStudyMediaUrl = (rawUrl?: string | null) => {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${mediaBase.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
  };

  useEffect(() => {
    const loadCases = async () => {
      try {
        setLoading(true);
        const data = await listCareCases();
        const nextCases = data.cases || [];
        setCases(nextCases);
        setActiveCaseId(nextCases[0]?.id || null);
      } catch (error) {
        const message = getVisibleErrorMessage(error, 'Failed to load cases');
        if (message) toast.error(message);
      } finally {
        setLoading(false);
      }
    };

    loadCases();
  }, []);

  const activeCase = useMemo(
    () => cases.find((item) => item.id === activeCaseId) ?? cases[0] ?? null,
    [activeCaseId, cases]
  );
  const activeCaseCurrentImages = useMemo(
    () => (activeCase?.studyStack || []).filter((entry) => entry.relation === 'current'),
    [activeCase]
  );
  const activeCasePriorImages = useMemo(
    () => (activeCase?.studyStack || []).filter((entry) => entry.relation !== 'current'),
    [activeCase]
  );
  const activeSoapEntries = useMemo(() => {
    const soap = activeCase?.soapNotes;
    if (!soap) return [];
    return [
      ['Subjective', soap.subjective],
      ['Objective', soap.objective],
      ['Assessment', soap.assessment],
      ['Plan', soap.plan],
    ] as Array<[string, string | undefined]>;
  }, [activeCase]);
  const activeCaseStudyIds = useMemo(() => {
    if (!activeCase?.studyStack?.length) return [];
    return Array.from(
      new Set(
        activeCase.studyStack
          .map((entry) => Number(entry.studyId))
          .filter((id) => Number.isFinite(id) && id > 0)
      )
    );
  }, [activeCase]);

  useEffect(() => {
    if (!activeCaseStudyIds.length) {
      setCaseRecordings([]);
      return;
    }

    let cancelled = false;
    const loadRecordings = async () => {
      try {
        setLoadingRecordings(true);
        const batches = await Promise.all(
          activeCaseStudyIds.map((studyId) =>
            listCaseRecordings(
              { studyId },
              user
                ? { email: user.email, role: user.role, name: user.name }
                : undefined
            )
          )
        );
        if (cancelled) return;
        const merged = batches.flatMap((batch) => batch.recordings || []);
        const deduped = Array.from(
          new Map(merged.map((record) => [record.id, record])).values()
        ).sort(
          (a, b) =>
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
        setCaseRecordings(deduped);
      } catch (error) {
        if (cancelled) return;
        setCaseRecordings([]);
        const message = getVisibleErrorMessage(error, 'Failed to load case recordings');
        if (message) toast.error(message);
      } finally {
        if (!cancelled) setLoadingRecordings(false);
      }
    };

    loadRecordings();
    return () => {
      cancelled = true;
    };
  }, [activeCaseStudyIds, user]);

  const markReviewed = async () => {
    if (!activeCase || activeCase.status === 'reviewed') return;

    try {
      const response = await updateCareCaseStatus(activeCase.id, 'reviewed');
      setCases((prev) => prev.map((entry) => (entry.id === response.case.id ? response.case : entry)));
      toast.success('Case marked as reviewed');
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to update case');
      if (message) toast.error(message);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading cases...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Cases</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review case handoffs from your doctor and continue via secure channels.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-3 text-sm font-medium">Case Inbox</div>
          <div className="space-y-2">
            {cases.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                No cases in your inbox yet.
              </div>
            ) : (
              cases.map((item) => {
                const isSelected = item.id === activeCase?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveCaseId(item.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left ${
                      isSelected ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                    }`}
                  >
                    <div className="font-medium preserve-case">{item.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          {!activeCase ? (
            <div className="p-6 text-sm text-muted-foreground">Choose a case to review details.</div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between border-b pb-4">
                <div>
                  <h2 className="text-lg font-semibold preserve-case">{activeCase.title}</h2>
                  <p className="text-xs text-muted-foreground preserve-case">Shared by {activeCase.doctorName}</p>
                </div>
                <Badge variant={activeCase.status === 'new' ? 'default' : 'secondary'}>
                  {activeCase.status}
                </Badge>
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4" />
                    Doctor Notes
                  </div>
                  <p className="text-sm text-muted-foreground preserve-case">{activeCase.notes}</p>
                </div>

                {activeSoapEntries.length > 0 && (
                  <div className="rounded-lg border p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <FileText className="h-4 w-4" />
                      SOAP Clinical Note
                    </div>
                    <div className="rounded-md border bg-background p-4">
                      <div className="border-2 border-foreground px-3 py-2 text-center text-sm font-semibold tracking-wide">
                        SUBJECTIVE OBJECTIVE ASSESSMENT PLAN - STUDY NOTES
                      </div>
                      <div className="mt-3 grid grid-cols-2 border-l border-t text-xs">
                        <div className="border-b border-r p-2 preserve-case">
                          <div className="font-semibold uppercase text-muted-foreground">Patient</div>
                          <div className="mt-0.5">{activeCase.patientName || 'Patient'}</div>
                        </div>
                        <div className="border-b border-r p-2 preserve-case">
                          <div className="font-semibold uppercase text-muted-foreground">Case title</div>
                          <div className="mt-0.5">{activeCase.title}</div>
                        </div>
                        <div className="border-b border-r p-2 preserve-case">
                          <div className="font-semibold uppercase text-muted-foreground">Shared by</div>
                          <div className="mt-0.5">{activeCase.doctorName}</div>
                        </div>
                        <div className="border-b border-r p-2 preserve-case">
                          <div className="font-semibold uppercase text-muted-foreground">Shared at</div>
                          <div className="mt-0.5">{new Date(activeCase.createdAt).toLocaleString()}</div>
                        </div>
                      </div>
                      <div className="mt-3 space-y-3">
                      {activeSoapEntries.map(([label, value]) => (
                        <div key={label} className="border">
                          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide">
                            {label}
                          </div>
                          <p className="min-h-20 whitespace-pre-wrap p-3 text-sm preserve-case">
                            {String(value || '').trim() || 'Not entered'}
                          </p>
                        </div>
                      ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="text-xs text-muted-foreground">
                  Updated: {new Date(activeCase.updatedAt).toLocaleString()}
                </div>

                {activeCase.nextcloudShare?.url && (
                  <div className="rounded-lg border p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                      <Cloud className="h-4 w-4" />
                      Case Package
                    </div>
                    <a
                      href={activeCase.nextcloudShare.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm text-primary underline-offset-2 hover:underline preserve-case"
                    >
                      {activeCase.nextcloudShare.url}
                    </a>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {activeCase.nextcloudShare.studyCount || 0} studies ·{' '}
                      {activeCase.nextcloudShare.reportCount || 0} reports ·{' '}
                      {activeCase.nextcloudShare.dicomExported || 0} DICOM files
                    </div>
                  </div>
                )}

                {!!activeCase.studyStack?.length && (
                  <div className="space-y-3">
                    <div className="rounded-lg border p-3">
                      <div className="mb-2 text-sm font-medium">New Images</div>
                      {activeCaseCurrentImages.length === 0 ? (
                        <div className="text-xs text-muted-foreground">No current images linked.</div>
                      ) : (
                        <div className="space-y-1">
                          {activeCaseCurrentImages.map((entry) => (
                            <div key={`current-${entry.studyId}`} className="text-xs preserve-case">
                              Study #{entry.studyId} · {entry.studyDate || '—'} · {entry.modality || '—'} · DICOM {entry.dicomCount || 0}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="mb-2 text-sm font-medium">Prior Images</div>
                      {activeCasePriorImages.length === 0 ? (
                        <div className="text-xs text-muted-foreground">No priors linked.</div>
                      ) : (
                        <div className="space-y-1">
                          {activeCasePriorImages.map((entry) => (
                            <div key={`prior-${entry.studyId}`} className="text-xs preserve-case">
                              Study #{entry.studyId} · {entry.studyDate || '—'} · {entry.modality || '—'} · DICOM {entry.dicomCount || 0}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {!!activeCase.priorReports?.length && (
                  <div className="rounded-lg border p-3">
                    <div className="mb-2 text-sm font-medium">Prior Reports (PDF)</div>
                    <div className="space-y-1">
                      {activeCase.priorReports.map((report, index) => (
                        <a
                          key={`prior-report-${index}-${report.url}`}
                          href={report.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-xs text-primary underline-offset-2 hover:underline preserve-case"
                        >
                          {report.filename || `Prior Report ${index + 1}`}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border p-3">
                  <div className="mb-2 text-sm font-medium">Screen Recordings</div>
                  {loadingRecordings ? (
                    <div className="text-xs text-muted-foreground">Loading recordings...</div>
                  ) : caseRecordings.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No screen recordings uploaded for this case yet.</div>
                  ) : (
                    <div className="space-y-3">
                      {caseRecordings.map((recording) => (
                        <div key={recording.id} className="space-y-1">
                          <div className="text-xs text-muted-foreground">
                            {new Date(recording.created_at || '').toLocaleString()} · Study #{recording.studyId}
                          </div>
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

                <div className="flex flex-wrap gap-2">
                  {user && user.role !== 'patient' && (
                    <>
                      {hasFeature('reportGeneration') && (
                        <Button
                          variant="outline"
                          onClick={() => navigate(`/reports/new?type=report&caseId=${encodeURIComponent(activeCase.id)}`)}
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Create Report
                        </Button>
                      )}
                      {hasFeature('soapNotes') && (
                        <Button
                          variant="outline"
                          onClick={() => navigate(`/reports/new?type=soap&caseId=${encodeURIComponent(activeCase.id)}`)}
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Create SOAP Note
                        </Button>
                      )}
                    </>
                  )}
                  {hasFeature('videoConsults') && (
                    <Button onClick={() => window.open(CALL_APP_URL, '_blank', 'noopener,noreferrer')}>
                      <PlayCircle className="mr-2 h-4 w-4" />
                      Join Video Follow-up
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => navigate(`/messages?contact=${encodeURIComponent(activeCase.doctorEmail)}`)}
                  >
                    <MessageCircle className="mr-2 h-4 w-4" />
                    Message Care Team
                  </Button>
                  {activeCase.status === 'new' ? (
                    <Button variant="outline" onClick={markReviewed}>
                      Mark Reviewed
                    </Button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
