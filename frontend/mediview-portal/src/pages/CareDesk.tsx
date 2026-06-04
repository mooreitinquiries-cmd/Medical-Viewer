import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowRight, MessageCircle, Video, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { fetchStudies, getMediaBaseUrl, uploadCaseReportPdfs, type Study } from '@/lib/api';
import {
  createCareCase,
  listCareCases,
  listCarePatients,
  scheduleCareCall,
  type CareCase,
  type CarePatient,
} from '@/lib/careApi';

export default function CareDesk() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<CarePatient[]>([]);
  const [cases, setCases] = useState<CareCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [patientEmail, setPatientEmail] = useState('');
  const [caseTitle, setCaseTitle] = useState('');
  const [caseNote, setCaseNote] = useState('');
  const [studies, setStudies] = useState<Study[]>([]);
  const [currentStudyId, setCurrentStudyId] = useState<number | null>(null);
  const [priorStudyIds, setPriorStudyIds] = useState<number[]>([]);
  const [selectedPriorReportStudyIds, setSelectedPriorReportStudyIds] = useState<number[]>([]);
  const [priorReportFiles, setPriorReportFiles] = useState<File[]>([]);
  const [priorAutoSort, setPriorAutoSort] = useState(true);
  const [draggedPriorId, setDraggedPriorId] = useState<number | null>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [patientsData, casesData, studiesData] = await Promise.all([listCarePatients(), listCareCases(), fetchStudies()]);
        setPatients(patientsData.patients || []);
        setCases(casesData.cases || []);
        setStudies(studiesData || []);

        setPatientEmail((prev) => prev || patientsData.patients[0]?.email || '');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load care desk');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.email === patientEmail) ?? patients[0],
    [patientEmail, patients]
  );

  const patientCases = useMemo(() => {
    if (!selectedPatient) return [];
    return cases.filter((entry) => entry.patientEmail === selectedPatient.email).slice(0, 5);
  }, [cases, selectedPatient]);

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

  const sortPriorIdsChronologically = useCallback(
    (ids: number[]) => {
      return [...ids].sort((leftId, rightId) => {
        const left = studies.find((entry) => entry.id === leftId);
        const right = studies.find((entry) => entry.id === rightId);
        const leftTs = parseStudyDateToMs(left?.study_date);
        const rightTs = parseStudyDateToMs(right?.study_date);
        if (leftTs !== rightTs) return leftTs - rightTs;
        return leftId - rightId;
      });
    },
    [studies]
  );

  const availableStudies = useMemo(() => {
    if (!selectedPatient) return studies;
    const patientEmail = selectedPatient.email.toLowerCase().trim();
    const patientName = selectedPatient.name.toLowerCase().trim();
    return studies.filter((entry) => {
      const patientId = String(entry.patient_id || '').toLowerCase().trim();
      const studyPatientName = String(entry.patient_name || '').toLowerCase().trim();
      if (patientId) return patientId === patientEmail;
      return Boolean(studyPatientName) && studyPatientName === patientName;
    });
  }, [selectedPatient, studies]);

  const orderedStack = useMemo(() => {
    const stack = [];
    if (currentStudyId) {
      const currentStudy = studies.find((entry) => entry.id === currentStudyId);
      if (currentStudy) stack.push({ ...currentStudy, relation: 'current' as const });
    }
    priorStudyIds.forEach((id) => {
      const prior = studies.find((entry) => entry.id === id);
      if (prior) stack.push({ ...prior, relation: 'prior' as const });
    });
    return stack;
  }, [currentStudyId, priorStudyIds, studies]);

  const currentStudy = useMemo(
    () => (currentStudyId ? studies.find((entry) => entry.id === currentStudyId) || null : null),
    [currentStudyId, studies]
  );

  const mediaBaseUrl = getMediaBaseUrl();

  const selectedStudiesWithReports = useMemo(() => {
    return orderedStack.filter((entry) => Boolean(entry.pdf_url));
  }, [orderedStack]);

  useEffect(() => {
    const allowedIds = new Set(availableStudies.map((entry) => entry.id));
    setCurrentStudyId((prev) => (prev && allowedIds.has(prev) ? prev : null));
    setPriorStudyIds((prev) => {
      const filtered = prev.filter((id) => allowedIds.has(id) && id !== currentStudyId);
      return priorAutoSort ? sortPriorIdsChronologically(filtered) : filtered;
    });
    setSelectedPriorReportStudyIds((prev) => {
      const reportIds = selectedStudiesWithReports.map((entry) => entry.id);
      const prevAllowed = prev.filter((id) => reportIds.includes(id));
      const newDefaults = reportIds.filter((id) => !prevAllowed.includes(id));
      return [...prevAllowed, ...newDefaults];
    });
  }, [availableStudies, currentStudyId, priorAutoSort, sortPriorIdsChronologically, selectedStudiesWithReports]);

  const togglePriorStudy = (studyId: number, checked: boolean) => {
    setPriorStudyIds((prev) => {
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
    setPriorStudyIds((prev) => {
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
    setPriorStudyIds((prev) => sortPriorIdsChronologically(prev));
    setPriorAutoSort(true);
  };

  const useSavedStudyPriors = () => {
    if (!currentStudy) {
      toast.error('Select a current study first');
      return;
    }
    const savedPriorIds = Array.isArray(currentStudy.prior_study_ids) ? currentStudy.prior_study_ids : [];
    const allowedIds = new Set(availableStudies.map((entry) => entry.id));
    const filtered = savedPriorIds.filter((id) => allowedIds.has(id) && id !== currentStudy.id);
    setPriorStudyIds(sortPriorIdsChronologically(filtered));
    setPriorAutoSort(true);
    toast.success(`Loaded ${filtered.length} saved prior${filtered.length === 1 ? '' : 's'}`);
  };

  const toAbsoluteMediaUrl = (relativeOrAbsolute: string) => {
    if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
    return `${mediaBaseUrl}${relativeOrAbsolute}`;
  };

  const toggleStudyReportSelection = (studyId: number, checked: boolean) => {
    setSelectedPriorReportStudyIds((prev) => {
      if (checked) {
        if (prev.includes(studyId)) return prev;
        return [...prev, studyId];
      }
      return prev.filter((id) => id !== studyId);
    });
  };

  const handleSendCase = async () => {
    if (!selectedPatient) {
      toast.error('Select a patient');
      return;
    }

    try {
      setSubmitting(true);
      const uploadedReports = priorReportFiles.length > 0 ? await uploadCaseReportPdfs(priorReportFiles) : { reports: [] };
      const selectedStudyReportItems = selectedStudiesWithReports
        .filter((entry) => selectedPriorReportStudyIds.includes(entry.id) && entry.pdf_url)
        .map((entry) => ({
          url: toAbsoluteMediaUrl(String(entry.pdf_url)),
          filename: `study-${entry.id}-report.pdf`,
          sourceStudyId: entry.id,
          createdAt: new Date().toISOString(),
        }));
      const uploadedReportItems = (uploadedReports.reports || []).map((entry) => ({
        url: toAbsoluteMediaUrl(entry.report_url),
        filename: entry.filename || 'prior-report.pdf',
        createdAt: entry.created_at || new Date().toISOString(),
      }));

      const response = await createCareCase({
        patientEmail: selectedPatient.email,
        title: caseTitle.trim(),
        notes: caseNote.trim(),
        studyStack: orderedStack.map((entry, index) => ({
          studyId: entry.id,
          relation: entry.relation,
          order: index,
          patientName: entry.patient_name || '',
          patientId: entry.patient_id || '',
          studyDate: entry.study_date || '',
          modality: entry.modality || '',
          dicomCount: entry.dicom_count || 0,
        })),
        priorReports: [...selectedStudyReportItems, ...uploadedReportItems],
      });

      setCases((prev) => [response.case, ...prev]);
      setCaseTitle('');
      setCaseNote('');
      setCurrentStudyId(null);
      setPriorStudyIds([]);
      setSelectedPriorReportStudyIds([]);
      setPriorReportFiles([]);
      setPriorAutoSort(true);
      toast.success(`Case sent to ${selectedPatient.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send case');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMessage = () => {
    if (!selectedPatient) return;
    navigate(`/messages?contact=${encodeURIComponent(selectedPatient.email)}`);
  };

  const handleScheduleCall = async () => {
    if (!selectedPatient) return;

    try {
      const scheduledAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await scheduleCareCall({ contactEmail: selectedPatient.email, scheduledAt });
      toast.success(`Follow-up call scheduled with ${selectedPatient.name}`);
      navigate(`/video?target=${encodeURIComponent(selectedPatient.name)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to schedule video call');
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading care desk...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Doctor Care Desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Send patient-facing summaries, then continue through secure messaging and video.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-4 border-b pb-4">
            <div className="text-sm font-medium">Send Case To Patient</div>
            <p className="text-xs text-muted-foreground">Create a patient-visible handoff in one step.</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="patient">Patient</Label>
              <select
                id="patient"
                value={selectedPatient?.email || ''}
                onChange={(e) => setPatientEmail(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {patients.map((patient) => (
                  <option key={patient.email} value={patient.email} className="preserve-case">
                    {patient.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="caseTitle">Case title</Label>
              <Input
                id="caseTitle"
                value={caseTitle}
                onChange={(e) => setCaseTitle(e.target.value)}
                placeholder="Example: Lumbar MRI follow-up"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="caseNote">Clinical summary</Label>
              <Textarea
                id="caseNote"
                rows={5}
                value={caseNote}
                onChange={(e) => setCaseNote(e.target.value)}
                placeholder="Findings and patient-facing instructions..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="currentStudy">Current Study</Label>
              <select
                id="currentStudy"
                value={currentStudyId || ''}
                onChange={(e) => setCurrentStudyId(e.target.value ? Number(e.target.value) : null)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">No study selected</option>
                {availableStudies.map((study) => (
                  <option key={study.id} value={study.id}>
                    #{study.id} · {study.study_date || '—'} · {study.modality || '—'}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Add Priors</div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={useSavedStudyPriors}>
                    Use Study Priors
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={resetPriorAutoSort}>
                    Auto Sort by Date
                  </Button>
                </div>
              </div>
              {!priorAutoSort && <div className="text-xs text-muted-foreground">Manual order enabled.</div>}
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {availableStudies
                  .filter((entry) => entry.id !== currentStudyId)
                  .map((study) => (
                    <label key={`prior-select-${study.id}`} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={priorStudyIds.includes(study.id)}
                        onChange={(e) => togglePriorStudy(study.id, e.target.checked)}
                      />
                      <span className="preserve-case">
                        #{study.id} · {study.study_date || '—'} · {study.modality || '—'}
                      </span>
                    </label>
                  ))}
              </div>
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-1 text-sm font-medium">Stack Priors and New Images</div>
              {orderedStack.length === 0 ? (
                <div className="text-xs text-muted-foreground">No imaging selected for this case.</div>
              ) : (
                <div className="space-y-1 text-xs">
                  {orderedStack.map((entry, index) => (
                    <div
                      key={`stack-${entry.id}`}
                      draggable={entry.relation === 'prior'}
                      onDragStart={() => entry.relation === 'prior' && setDraggedPriorId(entry.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => entry.relation === 'prior' && onPriorDrop(entry.id)}
                      className="flex items-center justify-between rounded border px-2 py-1"
                    >
                      <span className="preserve-case">
                        {index + 1}. {entry.relation === 'current' ? 'New' : 'Prior'} · {entry.study_date || '—'} · {entry.modality || '—'}
                      </span>
                      {entry.relation === 'prior' ? <GripVertical className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">Add Prior Reports (PDF)</div>
              {selectedStudiesWithReports.length === 0 ? (
                <div className="text-xs text-muted-foreground">No selected studies have PDF reports.</div>
              ) : (
                <div className="space-y-1">
                  {selectedStudiesWithReports.map((entry) => (
                    <label key={`prior-report-study-${entry.id}`} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selectedPriorReportStudyIds.includes(entry.id)}
                        onChange={(event) => toggleStudyReportSelection(entry.id, event.target.checked)}
                      />
                      <span className="preserve-case">Include report from study #{entry.id}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="priorReportFiles">Upload additional prior report PDFs</Label>
                <input
                  id="priorReportFiles"
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  onChange={(event) => setPriorReportFiles(Array.from(event.target.files || []))}
                  className="block w-full text-xs"
                />
                {priorReportFiles.length > 0 && (
                  <div className="text-xs text-muted-foreground">{priorReportFiles.length} PDF file(s) selected.</div>
                )}
              </div>
            </div>

            <Button
              disabled={!caseTitle.trim() || !caseNote.trim() || !selectedPatient || submitting}
              onClick={handleSendCase}
            >
              Send Case To <span className="preserve-case">{selectedPatient?.name || 'Patient'}</span>
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="mb-2 text-sm font-medium">Selected Patient</div>
            {selectedPatient ? (
              <div className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium preserve-case">{selectedPatient.name}</div>
                  <Badge variant="secondary">patient</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground preserve-case">{selectedPatient.email}</div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Open cases: {selectedPatient.openCaseCount}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                No patient accounts found. Create a patient user from User Profile Admin first.
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="mb-3 text-sm font-medium">Recent Cases</div>
            <div className="space-y-2">
              {patientCases.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  No cases sent yet for this patient.
                </div>
              ) : (
                patientCases.map((entry) => (
                  <div key={entry.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium preserve-case">{entry.title}</div>
                      <Badge variant={entry.status === 'new' ? 'default' : 'secondary'}>{entry.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="mb-3 text-sm font-medium">Direct Actions</div>
            <div className="space-y-2">
              <Button className="w-full justify-start" variant="outline" onClick={handleMessage}>
                <MessageCircle className="mr-2 h-4 w-4" />
                Message <span className="preserve-case">{selectedPatient?.name || 'Patient'}</span>
              </Button>
              <Button className="w-full justify-start" variant="outline" onClick={handleScheduleCall}>
                <Video className="mr-2 h-4 w-4" />
                Video Call <span className="preserve-case">{selectedPatient?.name || 'Patient'}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
