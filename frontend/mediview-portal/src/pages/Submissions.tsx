import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, ClipboardList, ExternalLink, Filter, Inbox, RefreshCw, Search, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { listFormSubmissions, syncFormSubmissions, type FormSubmission } from '@/lib/api';
import { showErrorToast } from '@/lib/errorToast';

const TYPE_LABELS: Record<string, string> = {
  patient: 'Patient',
  clinic: 'Clinic',
  other: 'Other',
};

function formatSubmittedAt(value?: string) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function submissionMatchesLocalQuery(submission: FormSubmission, query: string) {
  const clean = query.trim().toLowerCase();
  if (!clean) return true;
  return [
    submission.id,
    submission.type,
    submission.submission_subject_type,
    submission.display_name,
    submission.submitted_name,
    submission.email,
    submission.phone,
    submission.source,
    submission.form_name,
    submission.created_at,
    submission.submitted_at,
    submission.nextcloud_study_url,
    submission.matched_study_name,
    ...(submission.fields || []).flatMap((field) => [field.key, field.value]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(clean);
}

export default function Submissions() {
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const [submissions, setSubmissions] = useState<FormSubmission[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState('');

  const load = useCallback(async () => {
    if (!studyApiAuth) return;
    setLoading(true);
    try {
      const items = await listFormSubmissions({
        auth: studyApiAuth,
        type: typeFilter,
        q: query,
        limit: 1000,
      });
      setSubmissions(items);
      setSelectedId((current) => (current && items.some((item) => item.id === current) ? current : items[0]?.id || ''));
    } catch (error) {
      showErrorToast(error, 'Could not load submissions');
    } finally {
      setLoading(false);
    }
  }, [query, studyApiAuth, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncAllSubmissions = useCallback(async () => {
    if (!studyApiAuth) return;
    setSyncing(true);
    setSyncSummary('');
    try {
      const result = await syncFormSubmissions({ auth: studyApiAuth });
      setSyncSummary(
        `Synced ${result.fetched} pulled, ${result.created} new, ${result.updated} updated. ${result.total} total.`
      );
      await load();
    } catch (error) {
      showErrorToast(error, 'Could not sync submissions');
    } finally {
      setSyncing(false);
    }
  }, [load, studyApiAuth]);

  const filteredSubmissions = useMemo(
    () => submissions.filter((submission) => submissionMatchesLocalQuery(submission, query)),
    [query, submissions]
  );
  const selectedSubmission = filteredSubmissions.find((item) => item.id === selectedId) || filteredSubmissions[0] || null;
  const counts = useMemo(
    () =>
      submissions.reduce<Record<string, number>>(
        (result, submission) => {
          const type = submission.submission_subject_type || submission.type || 'other';
          result.all += 1;
          result[type] = (result[type] || 0) + 1;
          return result;
        },
        { all: 0, patient: 0, clinic: 0, other: 0 }
      ),
    [submissions]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SUBMISSIONS</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Form requests received from formchapter1.octelerad.com.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => void load()} disabled={loading || syncing}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Button type="button" onClick={() => void syncAllSubmissions()} disabled={loading || syncing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync'}
            </Button>
          </div>
          {syncSummary ? <div className="text-xs text-muted-foreground preserve-case">{syncSummary}</div> : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[390px_1fr]">
        <div className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-[1fr_150px] lg:grid-cols-1">
            <div className="space-y-2">
              <Label htmlFor="submissionSearch">Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="submissionSearch"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Name, email, phone, keyword..."
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="submissionTypeFilter">Type</Label>
              <div className="relative">
                <Filter className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <select
                  id="submissionTypeFilter"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-9 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="all">All ({counts.all})</option>
                  <option value="patient">Patient ({counts.patient || 0})</option>
                  <option value="clinic">Clinic ({counts.clinic || 0})</option>
                  <option value="other">Other ({counts.other || 0})</option>
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {filteredSubmissions.length === 0 ? (
              <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
                {loading ? 'Loading submissions...' : 'No submissions found.'}
              </div>
            ) : (
              filteredSubmissions.map((submission) => {
                const active = selectedSubmission?.id === submission.id;
                const subjectType = submission.submission_subject_type || submission.type || 'other';
                const submittedAt = submission.submitted_at || submission.created_at;
                return (
                  <button
                    key={submission.id}
                    type="button"
                    onClick={() => setSelectedId(submission.id)}
                    className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                      active ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium preserve-case">
                          {submission.submitted_name || submission.display_name}
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground preserve-case">
                          {formatSubmittedAt(submittedAt)}
                        </div>
                      </div>
                      <Badge variant={subjectType === 'patient' ? 'default' : 'secondary'}>
                        {TYPE_LABELS[subjectType] || subjectType || 'Other'}
                      </Badge>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <Inbox className="h-3.5 w-3.5" />
                      <span className="truncate preserve-case">
                        {submission.nextcloud_study_url ? 'Nextcloud study linked' : 'No Nextcloud study link'}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 shadow-sm">
          {!selectedSubmission ? (
            <div className="flex min-h-[360px] items-center justify-center rounded border border-dashed text-sm text-muted-foreground">
              Select a submission.
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <ClipboardList className="h-4 w-4" />
                    <span>{selectedSubmission.id}</span>
                  </div>
                  <h2 className="mt-1 truncate text-xl font-semibold preserve-case">
                    {selectedSubmission.submitted_name || selectedSubmission.display_name}
                  </h2>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Submitted {formatSubmittedAt(selectedSubmission.submitted_at || selectedSubmission.created_at)}
                  </div>
                </div>
                <Badge
                  variant={
                    (selectedSubmission.submission_subject_type || selectedSubmission.type) === 'patient'
                      ? 'default'
                      : 'secondary'
                  }
                >
                  {TYPE_LABELS[selectedSubmission.submission_subject_type || selectedSubmission.type] ||
                    selectedSubmission.submission_subject_type ||
                    selectedSubmission.type ||
                    'Other'}
                </Badge>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                    <UserRound className="h-3.5 w-3.5" />
                    Name
                  </div>
                  <div className="mt-2 text-sm font-medium preserve-case">
                    {selectedSubmission.submitted_name || selectedSubmission.display_name || '-'}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                    <ClipboardList className="h-3.5 w-3.5" />
                    Type
                  </div>
                  <div className="mt-2 text-sm font-medium preserve-case">
                    {TYPE_LABELS[selectedSubmission.submission_subject_type || selectedSubmission.type] ||
                      selectedSubmission.submission_subject_type ||
                      selectedSubmission.type ||
                      'Other'}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                    <CalendarClock className="h-3.5 w-3.5" />
                    Date Submitted
                  </div>
                  <div className="mt-2 text-sm font-medium preserve-case">
                    {formatSubmittedAt(selectedSubmission.submitted_at || selectedSubmission.created_at)}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Nextcloud Study
                  </div>
                  {selectedSubmission.nextcloud_study_url ? (
                    <a
                      href={selectedSubmission.nextcloud_study_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex max-w-full items-center gap-2 text-sm font-medium text-primary hover:underline"
                    >
                      <span className="truncate preserve-case">
                        {selectedSubmission.matched_study_name || 'Open study'}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ) : (
                    <div className="mt-2 text-sm text-muted-foreground">No Nextcloud link available.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
