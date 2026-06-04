import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileText, MessageCircle, PlayCircle } from 'lucide-react';
import { toast } from 'sonner';
import { listCareCases, updateCareCaseStatus, type CareCase } from '@/lib/careApi';
import { getMediaBaseUrl, listCaseRecordings, type CaseRecording } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

export default function Cases() {
  const navigate = useNavigate();
  const { user } = useAuth();
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
        toast.error(error instanceof Error ? error.message : 'Failed to load cases');
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
        toast.error(error instanceof Error ? error.message : 'Failed to load case recordings');
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
      toast.error(error instanceof Error ? error.message : 'Failed to update case');
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

                <div className="text-xs text-muted-foreground">
                  Updated: {new Date(activeCase.updatedAt).toLocaleString()}
                </div>

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
                  <Button onClick={() => navigate(`/video?target=${encodeURIComponent(activeCase.doctorName)}`)}>
                    <PlayCircle className="mr-2 h-4 w-4" />
                    Join Video Follow-up
                  </Button>
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
