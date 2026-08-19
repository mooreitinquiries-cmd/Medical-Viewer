import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Cloud, FileClock, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import {
  fetchTenantAuditEvents,
  fetchTenantGovernanceStudies,
  fetchTenantGovernanceSummaries,
  refreshOrthancStorageAccounting,
  updateStudyRetention,
  type TenantAuditEvent,
  type TenantGovernanceStudy,
  type TenantGovernanceSummary,
} from '@/lib/api';
import { showErrorToast } from '@/lib/errorToast';

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function planLabel(planId: string) {
  if (planId === 'hosted_retention') return 'Hosted';
  if (planId === 'self_download_7_day') return '7-day download';
  if (planId === 'internal') return 'Internal';
  return planId;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export default function TenantGovernance() {
  const { studyApiAuth, hasPermission } = useAuth();
  const canExportData = hasPermission('exportData');
  const [studies, setStudies] = useState<TenantGovernanceStudy[]>([]);
  const [tenants, setTenants] = useState<TenantGovernanceSummary[]>([]);
  const [events, setEvents] = useState<TenantAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingStudyId, setUpdatingStudyId] = useState<number | null>(null);
  const [refreshingOrthanc, setRefreshingOrthanc] = useState(false);

  const load = useCallback(async () => {
    if (!studyApiAuth) return;
    if (!canExportData) {
      showErrorToast(new Error('Your account cannot manage tenant governance.'), 'Tenant governance unavailable');
      return;
    }
    setLoading(true);
    try {
      const [tenantData, studyData, auditData] = await Promise.all([
        fetchTenantGovernanceSummaries({ auth: studyApiAuth }),
        fetchTenantGovernanceStudies({ auth: studyApiAuth }),
        fetchTenantAuditEvents({ auth: studyApiAuth, limit: 250 }),
      ]);
      setTenants(tenantData);
      setStudies(studyData);
      setEvents(auditData);
    } catch (error) {
      showErrorToast(error, 'Could not load tenant governance');
    } finally {
      setLoading(false);
    }
  }, [studyApiAuth]);

  const updateRetention = useCallback(async (
    study: TenantGovernanceStudy,
    action: 'mark_downloaded' | 'extend_deadline'
  ) => {
    if (!studyApiAuth) return;
    setUpdatingStudyId(study.id);
    try {
      if (action === 'mark_downloaded') {
        await updateStudyRetention(study.id, { action: 'mark_downloaded' }, { auth: studyApiAuth });
      } else {
        await updateStudyRetention(
          study.id,
          { action: 'extend_deadline', days: 7, reason: 'Operational extension from governance console' },
          { auth: studyApiAuth }
        );
      }
      await load();
    } catch (error) {
      showErrorToast(error, 'Could not update retention');
    } finally {
      setUpdatingStudyId(null);
    }
  }, [load, studyApiAuth]);

  const refreshOrthancStorage = useCallback(async () => {
    if (!studyApiAuth) return;
    setRefreshingOrthanc(true);
    try {
      await refreshOrthancStorageAccounting({ auth: studyApiAuth });
      await load();
    } catch (error) {
      showErrorToast(error, 'Could not refresh Orthanc storage');
    } finally {
      setRefreshingOrthanc(false);
    }
  }, [load, studyApiAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  const dueSoonCount = studies.filter((study) => {
    if (!study.customer_download_required_by) return false;
    const dueMs = new Date(study.customer_download_required_by).getTime();
    return Number.isFinite(dueMs) && dueMs - Date.now() <= 24 * 60 * 60 * 1000;
  }).length;

  return (
    <main className="min-h-screen bg-background px-6 py-6 text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Button asChild variant="ghost" size="sm" className="-ml-3">
              <Link to="/white-label">
                <ArrowLeft className="mr-2 h-4 w-4" />
                White label
              </Link>
            </Button>
            <h1 className="mt-2 text-2xl font-semibold">Tenant Governance</h1>
            <p className="text-sm text-muted-foreground">Retention obligations and tenant audit activity.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
          <Button type="button" onClick={() => void refreshOrthancStorage()} disabled={refreshingOrthanc || loading}>
            {refreshingOrthanc ? 'Refreshing DICOM...' : 'Refresh DICOM Storage'}
          </Button>
        </div>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileClock className="h-4 w-4" />
              7-day cases
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {studies.filter((study) => study.requires_customer_download).length}
            </div>
          </div>
          <div className="rounded-md border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Cloud className="h-4 w-4" />
              Hosted cases
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {studies.filter((study) => study.hosted_by_octelerad).length}
            </div>
          </div>
          <div className="rounded-md border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4" />
              Due within 24h
            </div>
            <div className="mt-2 text-2xl font-semibold">{dueSoonCount}</div>
          </div>
        </section>

        <section className="rounded-md border bg-card">
          <div className="border-b p-4">
            <h2 className="text-base font-semibold">Tenant Storage</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="border-b text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Cases</th>
                  <th className="px-4 py-3">DICOM Count</th>
                  <th className="px-4 py-3">Local Media</th>
                  <th className="px-4 py-3">DICOM Storage</th>
                  <th className="px-4 py-3">Total</th>
                  <th className="px-4 py-3">Exported</th>
                  <th className="px-4 py-3">Risk</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr key={tenant.tenant_id || 'internal'} className="border-b last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{tenant.name}</div>
                      <div className="text-xs text-muted-foreground">{tenant.tenant_id || 'internal'}</div>
                    </td>
                    <td className="px-4 py-3">{tenant.plan_label}</td>
                    <td className="px-4 py-3">{tenant.active_study_count} active · {tenant.deleted_study_count} deleted</td>
                    <td className="px-4 py-3">{tenant.dicom_count}</td>
                    <td className="px-4 py-3">{formatBytes(tenant.local_media_bytes)}</td>
                    <td className="px-4 py-3">
                      <div>{formatBytes(tenant.orthanc_storage_bytes)}</div>
                      <div className="text-xs text-muted-foreground">
                        {tenant.orthanc_storage_cached_count} cached
                        {tenant.orthanc_storage_error_count ? ` · ${tenant.orthanc_storage_error_count} errors` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">{formatBytes(tenant.total_storage_bytes)}</td>
                    <td className="px-4 py-3">{tenant.nextcloud_exported_count}</td>
                    <td className="px-4 py-3">
                      {tenant.overdue_count > 0 ? (
                        <Badge variant="destructive">{tenant.overdue_count} overdue</Badge>
                      ) : tenant.due_within_24h_count > 0 ? (
                        <Badge variant="secondary">{tenant.due_within_24h_count} due soon</Badge>
                      ) : (
                        <Badge variant="outline">Clear</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-md border bg-card">
          <div className="border-b p-4">
            <h2 className="text-base font-semibold">Retention Queue</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Case</th>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Download By</th>
                  <th className="px-4 py-3">Storage</th>
                  <th className="px-4 py-3">Nextcloud</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {studies.map((study) => (
                  <tr key={study.id} className="border-b last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{study.patient_name || `Case ${study.id}`}</div>
                      <div className="text-xs text-muted-foreground">{study.modality || 'No modality'} · {formatDate(study.created_at)}</div>
                    </td>
                    <td className="px-4 py-3">{study.tenant_id || 'Internal'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={study.requires_customer_download ? 'secondary' : 'outline'}>
                        {planLabel(study.plan_id)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{formatDate(study.customer_download_required_by)}</td>
                    <td className="px-4 py-3">
                      <div>{formatBytes(study.total_storage_bytes || 0)}</div>
                      <div className="text-xs text-muted-foreground">
                        DICOM {formatBytes(study.orthanc_storage_bytes || 0)} · media {formatBytes(study.local_media_bytes || 0)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {study.nextcloud_url ? (
                        <a className="text-primary underline-offset-4 hover:underline" href={study.nextcloud_url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : (
                        study.nextcloud_export_status || 'Not exported'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {study.requires_customer_download ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void updateRetention(study, 'mark_downloaded')}
                            disabled={updatingStudyId === study.id}
                          >
                            Mark Downloaded
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void updateRetention(study, 'extend_deadline')}
                            disabled={updatingStudyId === study.id}
                          >
                            Extend 7d
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Hosted</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && studies.length === 0 && (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>No cases found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-md border bg-card">
          <div className="border-b p-4">
            <h2 className="text-base font-semibold">Audit Trail</h2>
          </div>
          <div className="divide-y">
            {events.map((event, index) => (
              <div key={`${event.ts}-${event.event}-${index}`} className="grid gap-1 p-4 text-sm md:grid-cols-[180px_1fr_180px]">
                <div className="text-muted-foreground">{formatDate(event.ts)}</div>
                <div>
                  <div className="font-medium">{event.action || event.event}</div>
                  <div className="text-xs text-muted-foreground">
                    Tenant {event.tenant_id || 'internal'} · Study {event.study_id || 'n/a'}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground md:text-right">{event.actor_email || 'system'}</div>
              </div>
            ))}
            {!loading && events.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">No audit events found.</div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
