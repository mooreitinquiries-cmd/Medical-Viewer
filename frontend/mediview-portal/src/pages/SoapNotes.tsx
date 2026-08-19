import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { ArrowRight, Cloud, FileText, GripVertical, UploadCloud, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/context/AuthContext';
import {
  exportPatientSummaryToCloud,
  fetchStudies,
  getMediaBaseUrl,
  uploadCaseReportPdfs,
  type Study,
} from '@/lib/api';
import {
  createCarePatient,
  createCareCase,
  listCarePatients,
  type CarePatient,
} from '@/lib/careApi';
import { getVisibleErrorMessage } from '@/lib/sessionApi';

type StudyRelation = 'current' | 'prior';
type PatientMode = 'none' | 'existing' | 'manual';

interface PriorDocument {
  id: string;
  file: File;
  url: string;
}

interface WorkspaceDocument {
  id: string;
  title: string;
  kind: 'study' | 'report' | 'prior';
  subtitle: string;
  url?: string;
  text?: string;
}

const EMPTY_NOTE_LABEL = 'Not entered';

export default function SoapNotes() {
  const { user } = useAuth();
  const [patients, setPatients] = useState<CarePatient[]>([]);
  const [patientMode, setPatientMode] = useState<PatientMode>('none');
  const [patientEmail, setPatientEmail] = useState('');
  const [typedPatientName, setTypedPatientName] = useState('');
  const [typedPatientEmail, setTypedPatientEmail] = useState('');
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [caseTitle, setCaseTitle] = useState('');
  const [clinicalSummary, setClinicalSummary] = useState('');
  const [selectedStudyIds, setSelectedStudyIds] = useState<number[]>([]);
  const [studySearch, setStudySearch] = useState('');
  const [studyPickerOpen, setStudyPickerOpen] = useState(false);
  const [relationByStudyId, setRelationByStudyId] = useState<Record<number, StudyRelation>>({});
  const [draggedStudyId, setDraggedStudyId] = useState<number | null>(null);
  const [priorDocuments, setPriorDocuments] = useState<PriorDocument[]>([]);
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(null);
  const [documentOrder, setDocumentOrder] = useState<string[]>([]);
  const [soapSubjective, setSoapSubjective] = useState('');
  const [soapObjective, setSoapObjective] = useState('');
  const [soapAssessment, setSoapAssessment] = useState('');
  const [soapPlan, setSoapPlan] = useState('');
  const mediaBaseUrl = getMediaBaseUrl();

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [patientsData, studiesData] = await Promise.all([listCarePatients(), fetchStudies()]);
        setPatients(patientsData.patients || []);
        setStudies(studiesData || []);
      } catch (error) {
        const message = getVisibleErrorMessage(error, 'Failed to load SOAP workspace');
        if (message) toast.error(message);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.email === patientEmail) ?? null,
    [patientEmail, patients]
  );

  const patientDraft = useMemo(() => {
    if (patientMode === 'existing' && selectedPatient) {
      return { name: selectedPatient.name, email: selectedPatient.email };
    }
    if (patientMode === 'manual') {
      return { name: typedPatientName.trim(), email: typedPatientEmail.trim().toLowerCase() };
    }
    return { name: '', email: '' };
  }, [patientMode, selectedPatient, typedPatientEmail, typedPatientName]);

  const availableStudies = useMemo(() => {
    const email = patientDraft.email.toLowerCase().trim();
    const name = patientDraft.name.toLowerCase().trim();
    if (!email && !name) return studies;
    return studies.filter((study) => {
      const patientId = String(study.patient_id || '').toLowerCase().trim();
      const patientName = String(study.patient_name || '').toLowerCase().trim();
      if (patientId) return patientId === email;
      return Boolean(patientName) && patientName === name;
    });
  }, [patientDraft.email, patientDraft.name, studies]);

  const selectedStudies = useMemo(() => {
    return selectedStudyIds
      .map((id) => studies.find((study) => study.id === id))
      .filter((study): study is Study => Boolean(study));
  }, [selectedStudyIds, studies]);

  const getStudyDisplayName = (study: Study) => {
    return String(study.patient_name || '').trim() || `Study ${study.id}`;
  };

  const getStudyDetailLine = (study: Study) => {
    return [
      String(study.status || '').toLowerCase() === 'complete' ? 'Complete' : '',
      study.patient_id || '',
      study.study_date || 'No date',
      study.modality || 'No modality',
      `DICOM ${study.dicom_count || 0}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const studySearchResults = useMemo(() => {
    const query = studySearch.trim().toLowerCase();
    const filtered = availableStudies.filter((study) => {
      if (!query) return true;
      return [
        getStudyDisplayName(study),
        study.patient_id || '',
        study.study_date || '',
        study.modality || '',
        study.notes || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return filtered.slice(0, 40);
  }, [availableStudies, studySearch]);

  const toAbsoluteMediaUrl = (rawUrl: string) => {
    if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
    return `${mediaBaseUrl.replace(/\/+$/, '')}/${rawUrl.replace(/^\/+/, '')}`;
  };

  const soapRows = useMemo(
    () => [
      { label: 'Subjective', value: soapSubjective.trim() },
      { label: 'Objective', value: soapObjective.trim() },
      { label: 'Assessment', value: soapAssessment.trim() },
      { label: 'Plan', value: soapPlan.trim() },
    ],
    [soapAssessment, soapObjective, soapPlan, soapSubjective]
  );

  const hasSoapContent = soapRows.some((entry) => entry.value);

  const workspaceDocuments = useMemo<WorkspaceDocument[]>(() => {
    const studyDocs = selectedStudies.flatMap((study) => {
      const docs: WorkspaceDocument[] = [
        {
          id: `study:${study.id}`,
          kind: 'study',
          title: getStudyDisplayName(study),
          subtitle: getStudyDetailLine(study),
          text: [
            `Patient: ${study.patient_name || ''}`,
            `Patient ID: ${study.patient_id || ''}`,
            `DICOM count: ${study.dicom_count || 0}`,
            '',
            study.notes || 'No study notes entered.',
          ].join('\n'),
        },
      ];
      if (study.pdf_url) {
        docs.push({
          id: `report:${study.id}`,
          kind: 'report',
          title: `Report for ${getStudyDisplayName(study)}`,
          subtitle: study.pdf_url,
          url: toAbsoluteMediaUrl(String(study.pdf_url)),
        });
      }
      return docs;
    });

    const priorDocs = priorDocuments.map((entry, index) => ({
      id: entry.id,
      kind: 'prior' as const,
      title: entry.file.name || `Uploaded Prior ${index + 1}`,
      subtitle: 'Uploaded prior report',
      url: entry.url,
    }));

    return [...studyDocs, ...priorDocs];
  }, [priorDocuments, selectedStudies]);

  useEffect(() => {
    const documentIds = workspaceDocuments.map((entry) => entry.id);
    setDocumentOrder((prev) => [
      ...prev.filter((id) => documentIds.includes(id)),
      ...documentIds.filter((id) => !prev.includes(id)),
    ]);
  }, [workspaceDocuments]);

  const orderedDocuments = useMemo(() => {
    const byId = new Map(workspaceDocuments.map((entry) => [entry.id, entry]));
    return documentOrder.map((id) => byId.get(id)).filter((entry): entry is WorkspaceDocument => Boolean(entry));
  }, [documentOrder, workspaceDocuments]);

  const toggleStudy = (studyId: number, checked: boolean) => {
    setSelectedStudyIds((prev) => {
      if (!checked) return prev.filter((id) => id !== studyId);
      if (prev.includes(studyId)) return prev;
      return [...prev, studyId];
    });
    setRelationByStudyId((prev) => ({
      ...prev,
      [studyId]: selectedStudyIds.length === 0 ? 'current' : prev[studyId] || 'prior',
    }));
  };

  const selectStudyFromPicker = (studyId: number) => {
    toggleStudy(studyId, true);
    setStudySearch('');
    setStudyPickerOpen(false);
  };

  const reorderStudy = (targetId: number) => {
    if (!draggedStudyId || draggedStudyId === targetId) return;
    setSelectedStudyIds((prev) => {
      const fromIndex = prev.indexOf(draggedStudyId);
      const toIndex = prev.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [entry] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, entry);
      return next;
    });
    setDraggedStudyId(null);
  };

  const setStudyRelation = (studyId: number, relation: StudyRelation) => {
    setRelationByStudyId((prev) => ({ ...prev, [studyId]: relation }));
  };

  const reorderDocument = (targetId: string) => {
    if (!draggedDocumentId || draggedDocumentId === targetId) return;
    setDocumentOrder((prev) => {
      const fromIndex = prev.indexOf(draggedDocumentId);
      const toIndex = prev.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [entry] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, entry);
      return next;
    });
    setDraggedDocumentId(null);
  };

  const addPriorDocuments = (files: FileList | null) => {
    const nextFiles = Array.from(files || []);
    if (nextFiles.length === 0) return;
    setPriorDocuments((prev) => [
      ...prev,
      ...nextFiles.map((file, index) => ({
        id: `prior:${Date.now()}:${index}:${file.name}`,
        file,
        url: URL.createObjectURL(file),
      })),
    ]);
  };

  const removePriorDocument = (id: string) => {
    setPriorDocuments((prev) => {
      const removed = prev.find((entry) => entry.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((entry) => entry.id !== id);
    });
  };

  const handleSend = async () => {
    if (!user) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    if (!caseTitle.trim()) {
      toast.error('Enter a case title');
      return;
    }
    if (!hasSoapContent) {
      toast.error('Enter at least one SOAP note field');
      return;
    }
    if (selectedStudies.length === 0 && priorDocuments.length === 0) {
      toast.error('Select at least one study or upload a prior report');
      return;
    }
    if (!patientDraft.name || !patientDraft.email) {
      toast.error('Select an existing patient or enter a patient name and email before sending');
      return;
    }

    try {
      setSubmitting(true);
      let resolvedPatient = patients.find((entry) => entry.email.toLowerCase() === patientDraft.email.toLowerCase()) || null;
      if (!resolvedPatient) {
        const created = await createCarePatient({
          name: patientDraft.name,
          email: patientDraft.email,
        });
        resolvedPatient = created.patient;
        setPatients((prev) => [...prev, created.patient].sort((a, b) => a.name.localeCompare(b.name)));
        toast.success(`Created patient account. Temporary password: ${created.temporaryPassword}`);
      }

      const uploadedPriors = priorDocuments.length > 0
        ? await uploadCaseReportPdfs(priorDocuments.map((entry) => entry.file))
        : { reports: [] };
      const selectedStudyReports = selectedStudies
        .filter((study) => Boolean(study.pdf_url))
        .map((study) => ({
          url: String(study.pdf_url),
          filename: `study-${study.id}-report.pdf`,
          sourceStudyId: study.id,
          createdAt: new Date().toISOString(),
        }));
      const uploadedReportItems = (uploadedPriors.reports || []).map((entry) => ({
        url: entry.report_url,
        filename: entry.filename || 'prior-report.pdf',
        createdAt: entry.created_at || new Date().toISOString(),
      }));
      const studyStack = selectedStudies.map((study, index) => ({
        studyId: study.id,
        relation: relationByStudyId[study.id] || (index === 0 ? 'current' : 'prior'),
        order: index,
      }));
      const soapNotes = {
        subjective: soapSubjective.trim(),
        objective: soapObjective.trim(),
        assessment: soapAssessment.trim(),
        plan: soapPlan.trim(),
      };
      const notes = clinicalSummary.trim() || 'SOAP clinical note attached.';

      const packageExport = await exportPatientSummaryToCloud(
        {
          patientEmail: resolvedPatient.email,
          patientName: resolvedPatient.name,
          title: caseTitle.trim(),
          notes,
          soapNotes,
          studyStack,
          priorReports: [...selectedStudyReports, ...uploadedReportItems],
        },
        { auth: { email: user.email, role: user.role, name: user.name } }
      );

      await createCareCase({
        patientEmail: resolvedPatient.email,
        title: caseTitle.trim(),
        notes,
        soapNotes,
        studyStack: selectedStudies.map((study, index) => ({
          studyId: study.id,
          relation: relationByStudyId[study.id] || (index === 0 ? 'current' : 'prior'),
          order: index,
          patientName: study.patient_name || '',
          patientId: study.patient_id || '',
          studyDate: study.study_date || '',
          modality: study.modality || '',
          dicomCount: study.dicom_count || 0,
        })),
        priorReports: [
          ...selectedStudyReports.map((entry) => ({ ...entry, url: toAbsoluteMediaUrl(entry.url) })),
          ...uploadedReportItems.map((entry) => ({ ...entry, url: toAbsoluteMediaUrl(entry.url) })),
        ],
        nextcloudShare: {
          url: packageExport.url,
          folder: packageExport.folder,
          createdAt: new Date().toISOString(),
          studyCount: packageExport.study_count,
          reportCount: packageExport.report_count,
          dicomExported: packageExport.dicom_exported,
        },
      });

      setCaseTitle('');
      setClinicalSummary('');
      setSelectedStudyIds([]);
      setRelationByStudyId({});
      setSoapSubjective('');
      setSoapObjective('');
      setSoapAssessment('');
      setSoapPlan('');
      setPriorDocuments((prev) => {
        prev.forEach((entry) => URL.revokeObjectURL(entry.url));
        return [];
      });
      toast.success(`SOAP note sent to ${resolvedPatient.name}`);
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to send SOAP note');
      if (message) toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading SOAP notes workspace...</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">SOAP Notes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a structured Subjective, Objective, Assessment, and Plan clinical note with studies and prior documents.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr_420px]">
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 text-sm font-medium">Patient and Case</div>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="soapPatientMode">Patient</Label>
                <select
                  id="soapPatientMode"
                  value={patientMode}
                  onChange={(event) => {
                    setPatientMode(event.target.value as PatientMode);
                    setSelectedStudyIds([]);
                    setRelationByStudyId({});
                    setStudySearch('');
                    setStudyPickerOpen(false);
                  }}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="none">No patient filter yet</option>
                  <option value="existing">Select existing patient</option>
                  <option value="manual">Type new patient</option>
                </select>
              </div>
              {patientMode === 'existing' && (
                <div className="space-y-1">
                  <Label htmlFor="soapPatient">Existing patient</Label>
                  <select
                    id="soapPatient"
                    value={patientEmail}
                    onChange={(event) => {
                      setPatientEmail(event.target.value);
                      setSelectedStudyIds([]);
                      setRelationByStudyId({});
                      setStudySearch('');
                      setStudyPickerOpen(false);
                    }}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Select patient</option>
                    {patients.map((patient) => (
                      <option key={patient.email} value={patient.email} className="preserve-case">
                        {patient.name} · {patient.email}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {patientMode === 'manual' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="typedPatientName">Patient name</Label>
                    <Input
                      id="typedPatientName"
                      value={typedPatientName}
                      onChange={(event) => {
                        setTypedPatientName(event.target.value);
                        setSelectedStudyIds([]);
                        setRelationByStudyId({});
                        setStudySearch('');
                        setStudyPickerOpen(false);
                      }}
                      placeholder="Type patient name"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="typedPatientEmail">Patient email</Label>
                    <Input
                      id="typedPatientEmail"
                      type="email"
                      value={typedPatientEmail}
                      onChange={(event) => {
                        setTypedPatientEmail(event.target.value);
                        setSelectedStudyIds([]);
                        setRelationByStudyId({});
                        setStudySearch('');
                        setStudyPickerOpen(false);
                      }}
                      placeholder="patient@example.com"
                    />
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="soapTitle">Case title</Label>
                <Input
                  id="soapTitle"
                  value={caseTitle}
                  onChange={(event) => setCaseTitle(event.target.value)}
                  placeholder="Example: Follow-up SOAP note"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="soapClinicalSummary">Clinical summary</Label>
                <Textarea
                  id="soapClinicalSummary"
                  rows={3}
                  value={clinicalSummary}
                  onChange={(event) => setClinicalSummary(event.target.value)}
                  placeholder="Optional patient-facing summary..."
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Choose Studies</div>
              <Badge variant="secondary">{selectedStudyIds.length} selected</Badge>
            </div>
            <div className="relative space-y-3">
              <div className="space-y-1">
                <Label htmlFor="studySearch">Search studies</Label>
                <Input
                  id="studySearch"
                  value={studySearch}
                  onFocus={() => setStudyPickerOpen(true)}
                  onChange={(event) => {
                    setStudySearch(event.target.value);
                    setStudyPickerOpen(true);
                  }}
                  placeholder="Search by study name, ID, date, or modality"
                />
              </div>
              {studyPickerOpen && (
                <div className="absolute left-0 right-0 top-[66px] z-20 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-lg">
                  {availableStudies.length === 0 ? (
                    <div className="rounded border border-dashed p-3 text-xs text-muted-foreground">
                      No studies matched this patient.
                    </div>
                  ) : studySearchResults.length === 0 ? (
                    <div className="rounded border border-dashed p-3 text-xs text-muted-foreground">
                      No studies matched this search.
                    </div>
                  ) : (
                    studySearchResults.map((study) => {
                      const selected = selectedStudyIds.includes(study.id);
                      return (
                        <button
                          key={study.id}
                          type="button"
                          onClick={() => (selected ? toggleStudy(study.id, false) : selectStudyFromPicker(study.id))}
                          className={`w-full rounded px-3 py-2 text-left text-xs transition-colors ${
                            selected ? 'bg-primary/10' : 'hover:bg-muted'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium preserve-case">{getStudyDisplayName(study)}</span>
                            {selected && <Badge variant="secondary">selected</Badge>}
                          </div>
                          <div className="mt-0.5 text-muted-foreground preserve-case">{getStudyDetailLine(study)}</div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
              {studyPickerOpen && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setStudyPickerOpen(false)}>
                  Close Study Search
                </Button>
              )}
              {selectedStudies.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <div className="text-xs font-medium text-muted-foreground">Selected studies</div>
                  {selectedStudies.map((study) => (
                    <div key={`selected-${study.id}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs">
                      <div className="min-w-0 preserve-case">
                        <div className="truncate font-medium">{getStudyDisplayName(study)}</div>
                        <div className="truncate text-muted-foreground">{getStudyDetailLine(study)}</div>
                      </div>
                      <Button type="button" variant="ghost" size="icon" onClick={() => toggleStudy(study.id, false)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <UploadCloud className="h-4 w-4" />
              Upload Prior Docs
            </div>
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={(event) => addPriorDocuments(event.target.files)}
              className="block w-full text-xs"
            />
            <div className="mt-3 space-y-2">
              {priorDocuments.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
                  <span className="truncate preserve-case">{entry.file.name}</span>
                  <Button type="button" variant="ghost" size="icon" onClick={() => removePriorDocument(entry.id)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 text-sm font-medium">Study Stack</div>
            {selectedStudies.length === 0 ? (
              <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                Select one or more studies to build the comparison stack.
              </div>
            ) : (
              <div className="space-y-2">
                {selectedStudies.map((study, index) => {
                  const relation = relationByStudyId[study.id] || (index === 0 ? 'current' : 'prior');
                  return (
                    <div
                      key={study.id}
                      draggable
                      onDragStart={() => setDraggedStudyId(study.id)}
                      onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                      onDrop={() => reorderStudy(study.id)}
                      className="flex items-center gap-2 rounded border bg-background p-2"
                    >
                      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 text-sm preserve-case">
                        <div className="font-medium">#{index + 1} · {getStudyDisplayName(study)}</div>
                        <div className="text-xs text-muted-foreground">
                          {getStudyDetailLine(study)}
                        </div>
                      </div>
                      <select
                        value={relation}
                        onChange={(event) => setStudyRelation(study.id, event.target.value as StudyRelation)}
                        className="h-8 rounded border bg-background px-2 text-xs"
                      >
                        <option value="current">Current</option>
                        <option value="prior">Prior</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 text-sm font-medium">Document Workspace</div>
            {orderedDocuments.length === 0 ? (
              <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                Study summaries, reports, and uploaded priors will appear here as movable panels.
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {orderedDocuments.map((doc) => (
                  <div
                    key={doc.id}
                    draggable
                    onDragStart={() => setDraggedDocumentId(doc.id)}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                    onDrop={() => reorderDocument(doc.id)}
                    className="min-h-[260px] rounded-lg border bg-background p-3 shadow-sm"
                  >
                    <div className="mb-2 flex items-start gap-2">
                      <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium preserve-case">{doc.title}</div>
                        <div className="truncate text-xs text-muted-foreground preserve-case">{doc.subtitle}</div>
                      </div>
                      <Badge variant="outline">{doc.kind}</Badge>
                    </div>
                    {doc.url ? (
                      <iframe
                        title={doc.title}
                        src={doc.url}
                        className="h-[210px] w-full rounded border bg-muted"
                      />
                    ) : (
                      <pre className="h-[210px] overflow-auto rounded border bg-muted/30 p-3 text-xs whitespace-pre-wrap preserve-case">
                        {doc.text}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4" />
              SOAP Fields
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="soapSubjective">Subjective</Label>
                <Textarea id="soapSubjective" rows={3} value={soapSubjective} onChange={(event) => setSoapSubjective(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="soapObjective">Objective</Label>
                <Textarea id="soapObjective" rows={3} value={soapObjective} onChange={(event) => setSoapObjective(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="soapAssessment">Assessment</Label>
                <Textarea id="soapAssessment" rows={3} value={soapAssessment} onChange={(event) => setSoapAssessment(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="soapPlan">Plan</Label>
                <Textarea id="soapPlan" rows={3} value={soapPlan} onChange={(event) => setSoapPlan(event.target.value)} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-3 text-sm font-medium">SOAP Clinical Note Preview</div>
            <div className="rounded border bg-background p-4 text-sm shadow-sm">
              <div className="border-2 border-foreground px-3 py-2 text-center text-sm font-semibold tracking-wide">
                SUBJECTIVE OBJECTIVE ASSESSMENT PLAN - STUDY NOTES
              </div>
              <div className="mt-3 grid grid-cols-2 border-l border-t text-xs">
                <div className="border-b border-r p-2 preserve-case">
                  <div className="font-semibold uppercase text-muted-foreground">Patient</div>
                  <div className="mt-0.5">{patientDraft.name || 'Not selected'}</div>
                </div>
                <div className="border-b border-r p-2 preserve-case">
                  <div className="font-semibold uppercase text-muted-foreground">Patient email</div>
                  <div className="mt-0.5">{patientDraft.email || 'Not selected'}</div>
                </div>
                <div className="border-b border-r p-2 preserve-case">
                  <div className="font-semibold uppercase text-muted-foreground">Case title</div>
                  <div className="mt-0.5">{caseTitle.trim() || 'Untitled case'}</div>
                </div>
                <div className="border-b border-r p-2 preserve-case">
                  <div className="font-semibold uppercase text-muted-foreground">Prepared by</div>
                  <div className="mt-0.5">{user?.name || user?.email || 'Current user'}</div>
                </div>
              </div>
              <div className="mt-3 space-y-3">
                {soapRows.map((entry) => (
                  <div key={entry.label} className="border">
                    <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide">
                      {entry.label}
                    </div>
                    <div className="min-h-20 whitespace-pre-wrap p-3 preserve-case">{entry.value || EMPTY_NOTE_LABEL}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Button className="w-full" disabled={submitting} onClick={handleSend}>
            {submitting ? (
              <>
                Sending SOAP Package
                <Cloud className="ml-2 h-4 w-4" />
              </>
            ) : (
              <>
                Send SOAP Note
                <ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
