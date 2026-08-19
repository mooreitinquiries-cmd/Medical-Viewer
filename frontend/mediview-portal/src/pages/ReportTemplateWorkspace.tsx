import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileText, Save, Send, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/context/AuthContext';
import { addStudyReport, fetchStudyById, updateStudy, type Study } from '@/lib/api';
import { listCareCases, type CareCase } from '@/lib/careApi';
import { getVisibleErrorMessage } from '@/lib/sessionApi';
import {
  REPORT_TEMPLATES,
  buildReportMetadataLines,
  makeDraftStorageKey,
  type ReportTemplateKind,
} from '@/lib/reportTemplates';
import { showErrorToast } from '@/lib/errorToast';

function normalizeKind(value: string | null): ReportTemplateKind {
  return value === 'soap' ? 'soap' : 'report';
}

function composeReportText(input: {
  title: string;
  metadataLines: string[];
  sectionValues: Record<string, string>;
  kind: ReportTemplateKind;
}) {
  const template = REPORT_TEMPLATES[input.kind];
  const sections = template.sections.map((section) => {
    return `${section.label.toUpperCase()}\n${input.sectionValues[section.key]?.trim() || 'Not entered'}`;
  });
  return [
    input.title.trim() || template.reportTitle,
    '',
    'CASE METADATA',
    ...input.metadataLines,
    '',
    ...sections.flatMap((section) => [section, '']),
  ]
    .join('\n')
    .trim();
}

export default function ReportTemplateWorkspace() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, isLoading: authLoading, hasFeature, hasPermission, studyApiAuth } = useAuth();
  const kind = normalizeKind(params.get('type'));
  const requiredFeature = kind === 'soap' ? 'soapNotes' : 'reportGeneration';
  const studyId = params.get('studyId');
  const caseId = params.get('caseId');
  const template = REPORT_TEMPLATES[kind];
  const canCreateReports = hasPermission('createReports');

  const [study, setStudy] = useState<Study | null>(null);
  const [careCase, setCareCase] = useState<CareCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [title, setTitle] = useState(template.reportTitle);
  const [sectionValues, setSectionValues] = useState<Record<string, string>>({});

  const draftKey = useMemo(() => makeDraftStorageKey({ kind, studyId, caseId }), [caseId, kind, studyId]);
  const metadataLines = useMemo(() => buildReportMetadataLines({ study, careCase }), [careCase, study]);
  const primaryStudyId = useMemo(() => {
    if (studyId) return studyId;
    const currentStudy = (careCase?.studyStack || []).find((entry) => entry.relation === 'current');
    return currentStudy?.studyId ? String(currentStudy.studyId) : '';
  }, [careCase, studyId]);

  const loadContext = useCallback(async () => {
    if (authLoading || !studyApiAuth) return;
    setLoading(true);
    try {
      if (studyId) {
        const payload = await fetchStudyById(studyId, { auth: studyApiAuth });
        setStudy(payload.study || payload);
        return;
      }

      if (caseId) {
        const payload = await listCareCases();
        const found = (payload.cases || []).find((entry) => entry.id === caseId) || null;
        setCareCase(found);
        if (!found) toast.error('Case not found');
      }
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Could not load report context');
      if (message) toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [authLoading, caseId, studyApiAuth, studyId]);

  useEffect(() => {
    if (!authLoading && (!hasFeature(requiredFeature) || !canCreateReports)) {
      toast.error(kind === 'soap' ? 'SOAP notes are not enabled for this account' : 'Report generation is not enabled for this account');
      navigate('/dashboard', { replace: true });
      return;
    }
    void loadContext();
  }, [authLoading, canCreateReports, hasFeature, kind, loadContext, navigate, requiredFeature]);

  useEffect(() => {
    const raw = window.localStorage.getItem(draftKey);
    if (!raw) {
      setTitle(template.reportTitle);
      setSectionValues({});
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { title?: string; sectionValues?: Record<string, string> };
      setTitle(parsed.title || template.reportTitle);
      setSectionValues(parsed.sectionValues || {});
    } catch {
      setTitle(template.reportTitle);
      setSectionValues({});
    }
  }, [draftKey, template.reportTitle]);

  const saveDraft = () => {
    window.localStorage.setItem(
      draftKey,
      JSON.stringify({
        title,
        sectionValues,
        savedAt: new Date().toISOString(),
      })
    );
    toast.success('Draft saved');
  };

  const publish = async () => {
    const reportText = composeReportText({ title, metadataLines, sectionValues, kind });
    if (!primaryStudyId) {
      saveDraft();
      toast.error('No linked study is available yet. Draft saved locally.');
      return;
    }

    setPublishing(true);
    try {
      if (kind === 'report') {
        await updateStudy(
          primaryStudyId,
          { radiology_report: reportText },
          { auth: studyApiAuth, baseUpdatedAt: study?.updated_at }
        );
      }

      await addStudyReport(
        primaryStudyId,
        {
          title: title.trim() || template.reportTitle,
          reportType: kind === 'soap' ? 'notepad' : 'text',
          textReport: reportText,
          baseUpdatedAt: study?.updated_at,
        },
        { auth: studyApiAuth }
      );
      window.localStorage.removeItem(draftKey);
      toast.success(kind === 'soap' ? 'SOAP note saved to study reports' : 'Report saved to study');
      navigate(`/studies/${primaryStudyId}`);
    } catch (error) {
      showErrorToast(error, 'Could not publish report');
    } finally {
      setPublishing(false);
    }
  };

  const icon = kind === 'soap' ? <Stethoscope className="h-5 w-5" /> : <FileText className="h-5 w-5" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Button type="button" variant="outline" size="icon" asChild>
            <Link to={primaryStudyId ? `/studies/${primaryStudyId}` : '/cases'}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2 text-muted-foreground">
              {icon}
              <span className="text-sm">Template Workspace</span>
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{template.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Draft now, publish to the linked study report list when ready.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={saveDraft}>
            <Save className="mr-2 h-4 w-4" />
            Save Draft
          </Button>
          <Button type="button" onClick={() => void publish()} disabled={publishing || loading}>
            <Send className="mr-2 h-4 w-4" />
            {publishing ? 'Publishing...' : 'Publish'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="space-y-2">
            <Label htmlFor="report-title">Title</Label>
            <Input id="report-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          {template.sections.map((section) => (
            <div key={section.key} className="space-y-2">
              <Label htmlFor={`section-${section.key}`}>{section.label}</Label>
              <Textarea
                id={`section-${section.key}`}
                value={sectionValues[section.key] || ''}
                onChange={(event) =>
                  setSectionValues((current) => ({
                    ...current,
                    [section.key]: event.target.value,
                  }))
                }
                placeholder={section.placeholder}
                rows={kind === 'report' && section.key === 'findings' ? 8 : 4}
              />
            </div>
          ))}
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 text-sm font-medium">Context</div>
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : metadataLines.length === 0 ? (
              <div className="text-sm text-muted-foreground">No case or study context loaded.</div>
            ) : (
              <div className="space-y-2 text-sm">
                {metadataLines.map((item) => (
                  <div key={item} className="break-words preserve-case">
                    {item}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 text-sm font-medium">Output Path</div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <div>Current: text report attached to the linked study.</div>
              <div>Next: DOCX/PDF template rendering and Nextcloud export.</div>
              <div className="preserve-case">Linked study: {primaryStudyId || 'none'}</div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 text-sm font-medium">Preview</div>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs preserve-case">
              {composeReportText({ title, metadataLines, sectionValues, kind })}
            </pre>
          </div>
        </aside>
      </div>
    </div>
  );
}
