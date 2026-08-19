import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ChevronDown, ChevronRight, Cloud, FileText, FolderOpen, Link2, RefreshCw, Search, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { fetchStudies, listUpcomingPatients, updateStudy, type Study, type UpcomingPatient } from '@/lib/api';
import {
  createCarePatient,
  listCareCases,
  listCarePatients,
  updateCarePatientStatus,
  type CareCase,
  type CarePatient,
} from '@/lib/careApi';
import { getVisibleErrorMessage } from '@/lib/sessionApi';

function matchesPatient(study: Study, patient: CarePatient) {
  const patientEmail = patient.email.toLowerCase().trim();
  const patientName = patient.name.toLowerCase().trim();
  const studyPatientId = String(study.patient_id || '').toLowerCase().trim();
  const studyPatientName = String(study.patient_name || '').toLowerCase().trim();
  if (studyPatientId) return studyPatientId === patientEmail;
  return Boolean(studyPatientName) && studyPatientName === patientName;
}

export default function Patients() {
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const [patients, setPatients] = useState<CarePatient[]>([]);
  const [upcomingPatients, setUpcomingPatients] = useState<UpcomingPatient[]>([]);
  const [cases, setCases] = useState<CareCase[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [syncingUpcoming, setSyncingUpcoming] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [search, setSearch] = useState('');
  const [detailsPatientEmail, setDetailsPatientEmail] = useState('');
  const [assignmentPatientEmail, setAssignmentPatientEmail] = useState('');
  const [studySearch, setStudySearch] = useState('');
  const [selectedStudyIds, setSelectedStudyIds] = useState<number[]>([]);
  const [lastTemporaryPassword, setLastTemporaryPassword] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      const [patientsData, casesData, studiesData, upcomingData] = await Promise.all([
        listCarePatients(),
        listCareCases(),
        fetchStudies(),
        studyApiAuth ? listUpcomingPatients({ auth: studyApiAuth, limit: 50 }) : Promise.resolve({ upcomingPatients: [] }),
      ]);
      setPatients(patientsData.patients || []);
      setCases(casesData.cases || []);
      setStudies(studiesData || []);
      setUpcomingPatients(upcomingData.upcomingPatients || []);
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to load patients');
      if (message) toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [studyApiAuth]);

  useEffect(() => {
    if (!studyApiAuth) return undefined;
    const timer = window.setInterval(() => {
      listUpcomingPatients({ auth: studyApiAuth, limit: 50 })
        .then((data) => setUpcomingPatients(data.upcomingPatients || []))
        .catch(() => {});
    }, 30000);
    return () => window.clearInterval(timer);
  }, [studyApiAuth]);

  const visibleUpcomingPatients = useMemo(() => {
    const existingEmails = new Set(patients.map((patient) => patient.email.toLowerCase()));
    return upcomingPatients.filter((patient) => {
      const email = String(patient.email || '').toLowerCase().trim();
      return !email || !existingEmails.has(email);
    });
  }, [patients, upcomingPatients]);

  const patientRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return patients
      .filter((patient) => {
        if (!query) return true;
        return `${patient.name} ${patient.email} ${patient.status}`.toLowerCase().includes(query);
      })
      .map((patient) => {
        const patientCases = cases.filter((entry) => entry.patientEmail === patient.email);
        const patientStudies = studies.filter((study) => matchesPatient(study, patient));
        return {
          patient,
          cases: patientCases,
          studies: patientStudies,
          caseCount: patientCases.length,
          openCaseCount: patient.openCaseCount,
          studyCount: patientStudies.length,
        };
      })
      .sort((left, right) => left.patient.name.localeCompare(right.patient.name));
  }, [cases, patients, search, studies]);

  const assignmentPatient = useMemo(
    () => patients.find((patient) => patient.email === assignmentPatientEmail) || null,
    [assignmentPatientEmail, patients]
  );

  const assignmentSearchResults = useMemo(() => {
    const query = studySearch.trim().toLowerCase();
    return studies
      .filter((study) => {
        if (!query) return true;
        return [
          study.patient_name || '',
          study.patient_id || '',
          study.study_date || '',
          study.modality || '',
          study.notes || '',
          String(study.id),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .sort((left, right) => {
        const leftDate = String(left.study_date || '');
        const rightDate = String(right.study_date || '');
        if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
        return right.id - left.id;
      })
      .slice(0, 50);
  }, [studies, studySearch]);

  const assignmentPatientStudies = useMemo(() => {
    if (!assignmentPatient) return [];
    return studies
      .filter((study) => matchesPatient(study, assignmentPatient))
      .sort((left, right) => right.id - left.id);
  }, [assignmentPatient, studies]);

  const getStudyDisplayName = (study: Study) => {
    return String(study.patient_name || '').trim() || `Study ${study.id}`;
  };

  const getStudyDetailLine = (study: Study) => {
    return [
      String(study.status || '').toLowerCase() === 'complete' ? 'Complete' : '',
      `#${study.id}`,
      study.patient_id || '',
      study.study_date || 'No date',
      study.modality || 'No modality',
      `DICOM ${study.dicom_count || 0}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const getCaseStudyCount = (careCase: CareCase) => careCase.studyStack?.length || 0;

  const getCaseReportCount = (careCase: CareCase) => careCase.priorReports?.length || 0;

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanedName = name.trim();
    const cleanedEmail = email.trim().toLowerCase();
    if (!cleanedName || !cleanedEmail) {
      toast.error('Patient name and email are required');
      return;
    }

    try {
      setSubmitting(true);
      const response = await createCarePatient({
        name: cleanedName,
        email: cleanedEmail,
        username: username.trim().toLowerCase(),
        password: password.trim(),
      });
      setPatients((prev) => [...prev.filter((entry) => entry.email !== response.patient.email), response.patient]);
      setLastTemporaryPassword(response.temporaryPassword);
      setName('');
      setEmail('');
      setUsername('');
      setPassword('');
      toast.success('Patient account created');
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to create patient');
      if (message) toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const togglePatientStatus = async (patient: CarePatient) => {
    const nextStatus = patient.status === 'active' ? 'suspended' : 'active';
    try {
      const response = await updateCarePatientStatus(patient.email, nextStatus);
      setPatients((prev) => prev.map((entry) => (entry.email === response.patient.email ? response.patient : entry)));
      toast.success(nextStatus === 'active' ? 'Patient reactivated' : 'Patient suspended');
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to update patient');
      if (message) toast.error(message);
    }
  };

  const openAssignmentPanel = (patient: CarePatient) => {
    const nextEmail = assignmentPatientEmail === patient.email ? '' : patient.email;
    setAssignmentPatientEmail(nextEmail);
    setStudySearch('');
    setSelectedStudyIds([]);
  };

  const toggleDetailsPanel = (patient: CarePatient) => {
    setDetailsPatientEmail((prev) => (prev === patient.email ? '' : patient.email));
  };

  const toggleStudySelection = (studyId: number) => {
    setSelectedStudyIds((prev) => (
      prev.includes(studyId) ? prev.filter((id) => id !== studyId) : [...prev, studyId]
    ));
  };

  const syncUpcomingPatients = async () => {
    if (!studyApiAuth) return;
    try {
      setSyncingUpcoming(true);
      const data = await listUpcomingPatients({
        auth: studyApiAuth,
        limit: 50,
        sync: user?.role === 'admin',
      });
      setUpcomingPatients(data.upcomingPatients || []);
      toast.success(user?.role === 'admin' ? 'Synced upcoming patients' : 'Refreshed upcoming patients');
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to refresh upcoming patients');
      if (message) toast.error(message);
    } finally {
      setSyncingUpcoming(false);
    }
  };

  const useUpcomingPatient = (patient: UpcomingPatient) => {
    setName(String(patient.name || '').trim());
    setEmail(String(patient.email || '').trim().toLowerCase());
    setUsername(String(patient.email || '').trim().toLowerCase());
    toast.info('Patient form loaded into Add Patient');
  };

  const assignSelectedStudies = async () => {
    if (!assignmentPatient) {
      toast.error('Choose a patient before assigning studies');
      return;
    }
    if (!user) {
      toast.error('Session is still loading. Please try again.');
      return;
    }
    if (selectedStudyIds.length === 0) {
      toast.error('Select at least one study to assign');
      return;
    }

    try {
      setAssigning(true);
      const responses = await Promise.all(
        selectedStudyIds.map((studyId) =>
          updateStudy(
            studyId,
            {
              patient_name: assignmentPatient.name,
              patient_id: assignmentPatient.email,
            },
            {
              auth: { email: user.email, role: user.role, name: user.name },
              baseUpdatedAt: studies.find((study) => study.id === studyId)?.updated_at,
            }
          )
        )
      );
      const updatedStudies = responses.map((response) => response.study);
      setStudies((prev) =>
        prev.map((study) => updatedStudies.find((updated) => updated.id === study.id) || study)
      );
      setSelectedStudyIds([]);
      setStudySearch('');
      toast.success(`Assigned ${updatedStudies.length} study${updatedStudies.length === 1 ? '' : 'ies'} to ${assignmentPatient.name}`);
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Failed to assign studies');
      if (message) toast.error(message);
    } finally {
      setAssigning(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading patients...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Patients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add and manage patient accounts so studies, cases, reports, and SOAP packages stay linked to one record.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="h-4 w-4" />
              Upcoming Patients
              {visibleUpcomingPatients.length > 0 && <Badge variant="secondary">{visibleUpcomingPatients.length}</Badge>}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              New patient forms from the forms server appear here before an account is created.
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void syncUpcomingPatients()} disabled={syncingUpcoming || !studyApiAuth}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncingUpcoming ? 'animate-spin' : ''}`} />
            {syncingUpcoming ? 'Refreshing...' : user?.role === 'admin' ? 'Sync forms' : 'Refresh'}
          </Button>
        </div>

        {visibleUpcomingPatients.length === 0 ? (
          <div className="rounded border border-dashed p-5 text-center text-sm text-muted-foreground">
            No upcoming patients from submitted forms.
          </div>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {visibleUpcomingPatients.map((patient) => (
              <div key={patient.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium preserve-case">{patient.name || 'Upcoming patient'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {patient.email && <span className="preserve-case">{patient.email}</span>}
                      {patient.phone && <span>{patient.phone}</span>}
                      {patient.submitted_at && <span>{new Date(patient.submitted_at).toLocaleString()}</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {patient.patient_identifier && (
                        <Badge variant="outline" className="font-mono">
                          {patient.patient_identifier}
                        </Badge>
                      )}
                      {patient.form_name && <Badge variant="secondary" className="preserve-case">{patient.form_name}</Badge>}
                      {patient.source && <Badge variant="secondary" className="preserve-case">{patient.source}</Badge>}
                    </div>
                    {patient.patient_lookup_url && (
                      <a
                        href={patient.patient_lookup_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        Open lookup
                      </a>
                    )}
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => useUpcomingPatient(patient)}>
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                    Use for account
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <form onSubmit={handleCreate} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserPlus className="h-4 w-4" />
            Add Patient
          </div>
          <div className="space-y-2">
            <Label htmlFor="patientName">Patient name</Label>
            <Input id="patientName" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="patientEmail">Email</Label>
            <Input id="patientEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="patientUsername">Username</Label>
            <Input
              id="patientUsername"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Optional; generated if blank"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="patientPassword">Temporary password</Label>
            <Input
              id="patientPassword"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Optional; generated if blank"
            />
          </div>
          {lastTemporaryPassword && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              Last temporary password: <span className="font-mono">{lastTemporaryPassword}</span>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Patient'}
          </Button>
        </form>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium">Patient Records</div>
              <div className="text-xs text-muted-foreground">Assign studies directly to patient records by patient email.</div>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search patients..."
              className="sm:max-w-xs"
            />
          </div>

          <div className="space-y-2">
            {patientRows.length === 0 ? (
              <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
                No patient records found.
              </div>
            ) : (
              patientRows.map(({ patient, cases: patientCases, studies: patientStudies, caseCount, openCaseCount, studyCount }) => (
                <div key={patient.email} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => toggleDetailsPanel(patient)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="font-medium preserve-case">{patient.name}</div>
                      <div className="text-xs text-muted-foreground preserve-case">{patient.email}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {detailsPatientEmail === patient.email ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          View details
                        </span>
                        <span>{caseCount} cases</span>
                        <span>{openCaseCount} open</span>
                        <span className="inline-flex items-center gap-1">
                          <FolderOpen className="h-3.5 w-3.5" />
                          {studyCount} studies/files
                        </span>
                      </div>
                    </button>
                    <div className="flex items-center gap-2">
                      <Badge variant={patient.status === 'active' ? 'outline' : 'destructive'}>{patient.status}</Badge>
                      <Button type="button" variant="outline" size="sm" onClick={() => openAssignmentPanel(patient)}>
                        <Link2 className="mr-1.5 h-3.5 w-3.5" />
                        Assign Studies
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => togglePatientStatus(patient)}>
                        {patient.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </Button>
                    </div>
                  </div>
                  {detailsPatientEmail === patient.email && (
                    <div className="mt-3 grid gap-3 xl:grid-cols-2">
                      <div className="rounded-md border bg-muted/20 p-3">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                          <FileText className="h-4 w-4" />
                          Assigned Cases
                        </div>
                        {patientCases.length === 0 ? (
                          <div className="rounded border border-dashed bg-background p-4 text-center text-xs text-muted-foreground">
                            No cases are assigned to this patient yet.
                          </div>
                        ) : (
                          <div className="max-h-80 space-y-2 overflow-y-auto">
                            {patientCases
                              .slice()
                              .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
                              .map((careCase) => (
                                <div key={careCase.id} className="rounded border bg-background p-2 text-xs">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="font-medium preserve-case">{careCase.title}</div>
                                      <div className="mt-0.5 text-muted-foreground preserve-case">
                                        Shared by {careCase.doctorName} · {new Date(careCase.createdAt).toLocaleString()}
                                      </div>
                                    </div>
                                    <Badge variant={careCase.status === 'new' ? 'default' : 'secondary'}>
                                      {careCase.status}
                                    </Badge>
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground">
                                    <span>{getCaseStudyCount(careCase)} studies</span>
                                    <span>{getCaseReportCount(careCase)} reports</span>
                                    {careCase.nextcloudShare?.url && (
                                      <a
                                        href={careCase.nextcloudShare.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                                      >
                                        <Cloud className="h-3.5 w-3.5" />
                                        Case Package
                                      </a>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>

                      <div className="rounded-md border bg-muted/20 p-3">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                          <FolderOpen className="h-4 w-4" />
                          Linked Studies
                        </div>
                        {patientStudies.length === 0 ? (
                          <div className="rounded border border-dashed bg-background p-4 text-center text-xs text-muted-foreground">
                            No studies are linked to this patient yet.
                          </div>
                        ) : (
                          <div className="max-h-80 space-y-2 overflow-y-auto">
                            {patientStudies
                              .slice()
                              .sort((left, right) => {
                                const leftDate = String(left.study_date || '');
                                const rightDate = String(right.study_date || '');
                                if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
                                return right.id - left.id;
                              })
                              .map((study) => (
                                <div key={`detail-study-${patient.email}-${study.id}`} className="rounded border bg-background p-2 text-xs">
                                  <Link
                                    to={`/studies/${study.id}`}
                                    className="block rounded p-1 -m-1 transition-colors hover:bg-muted"
                                  >
                                    <div className="font-medium text-primary underline-offset-2 hover:underline preserve-case">
                                      {getStudyDisplayName(study)}
                                    </div>
                                    <div className="mt-0.5 text-muted-foreground preserve-case">{getStudyDetailLine(study)}</div>
                                  </Link>
                                  <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <Link
                                      to={`/studies/${study.id}`}
                                      className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                                    >
                                      <FolderOpen className="h-3.5 w-3.5" />
                                      Open Study
                                    </Link>
                                    {study.nextcloud_url && (
                                      <a
                                        href={study.nextcloud_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                                      >
                                        <Cloud className="h-3.5 w-3.5" />
                                        Nextcloud Study
                                      </a>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {assignmentPatientEmail === patient.email && (
                    <div className="mt-3 rounded-md border bg-muted/20 p-3">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium preserve-case">Assign studies to {patient.name}</div>
                          <div className="text-xs text-muted-foreground preserve-case">
                            Selected studies will use patient ID/email {patient.email}.
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setAssignmentPatientEmail('');
                            setSelectedStudyIds([]);
                            setStudySearch('');
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>

                      {assignmentPatientStudies.length > 0 && (
                        <div className="mb-3 rounded border bg-background p-2">
                          <div className="mb-2 text-xs font-medium text-muted-foreground">Currently linked studies</div>
                          <div className="flex flex-wrap gap-1.5">
                            {assignmentPatientStudies.slice(0, 8).map((study) => (
                              <Badge key={`linked-${study.id}`} variant="secondary" className="preserve-case">
                                #{study.id} {study.modality || 'Study'}
                              </Badge>
                            ))}
                            {assignmentPatientStudies.length > 8 && (
                              <Badge variant="outline">+{assignmentPatientStudies.length - 8} more</Badge>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label htmlFor={`assignStudySearch-${patient.email}`}>Find studies</Label>
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                          <Input
                            id={`assignStudySearch-${patient.email}`}
                            value={studySearch}
                            onChange={(event) => setStudySearch(event.target.value)}
                            placeholder="Search by study name, ID, date, modality, or current patient..."
                            className="pl-9"
                          />
                        </div>
                      </div>

                      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded border bg-background p-1">
                        {assignmentSearchResults.length === 0 ? (
                          <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
                            No studies matched this search.
                          </div>
                        ) : (
                          assignmentSearchResults.map((study) => {
                            const selected = selectedStudyIds.includes(study.id);
                            const alreadyLinked = matchesPatient(study, patient);
                            return (
                              <button
                                key={`assign-${patient.email}-${study.id}`}
                                type="button"
                                onClick={() => toggleStudySelection(study.id)}
                                className={`w-full rounded px-3 py-2 text-left text-xs transition-colors ${
                                  selected ? 'bg-primary/10' : 'hover:bg-muted'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium preserve-case">{getStudyDisplayName(study)}</span>
                                  <span className="flex shrink-0 items-center gap-1">
                                    {alreadyLinked && <Badge variant="secondary">linked</Badge>}
                                    {selected && <Badge variant="outline">selected</Badge>}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-muted-foreground preserve-case">{getStudyDetailLine(study)}</div>
                              </button>
                            );
                          })
                        )}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-muted-foreground">
                          {selectedStudyIds.length} selected
                        </div>
                        <Button type="button" size="sm" disabled={assigning || selectedStudyIds.length === 0} onClick={assignSelectedStudies}>
                          {assigning ? 'Assigning...' : 'Assign Selected Studies'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
