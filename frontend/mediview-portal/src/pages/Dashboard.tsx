import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchStudies, isStudyApiUnavailableError, type Study } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileImage, Clock3, Layers3, Upload } from 'lucide-react';
import { toast } from 'sonner';

export default function Dashboard() {
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadStudies = async () => {
      try {
        const data = await fetchStudies();
        setStudies(data);
      } catch (err) {
        console.error(err);
        setStudies([]);

        if (!isStudyApiUnavailableError(err)) {
          toast.error('Failed to load dashboard data');
        }
      } finally {
        setLoading(false);
      }
    };

    loadStudies();
  }, []);

  const stats = useMemo(() => {
    const processing = studies.filter((s) => (s.status || '').toLowerCase() === 'processing').length;

    const uniqueModalities = new Set(
      studies
        .map((s) => (s.modality || '').trim())
        .filter(Boolean)
    );

    const modalityCounts = studies.reduce<Record<string, number>>((acc, study) => {
      const key = (study.modality || 'Unknown').trim() || 'Unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const recentStudies = [...studies]
      .sort((a, b) => {
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      })
      .slice(0, 5);

    return {
      totalStudies: studies.length,
      processing,
      activeModalities: uniqueModalities.size,
      modalityCounts,
      recentStudies,
    };
  }, [studies]);

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading dashboard...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Real-time overview of uploaded studies
          </p>
        </div>

        <Button asChild>
          <Link to="/upload">
            <Upload className="mr-2 h-4 w-4" />
            New Case
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FileImage className="h-4 w-4" />
            <span className="text-sm font-medium">Total Studies</span>
          </div>
          <div className="mt-3 text-3xl font-semibold">{stats.totalStudies}</div>
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock3 className="h-4 w-4" />
            <span className="text-sm font-medium">Processing</span>
          </div>
          <div className="mt-3 text-3xl font-semibold">{stats.processing}</div>
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Layers3 className="h-4 w-4" />
            <span className="text-sm font-medium">Active Modalities</span>
          </div>
          <div className="mt-3 text-3xl font-semibold">{stats.activeModalities}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Modalities
          </h2>

          <div className="mt-4 space-y-3">
            {Object.keys(stats.modalityCounts).length === 0 ? (
              <div className="text-sm text-muted-foreground">No study data yet</div>
            ) : (
              Object.entries(stats.modalityCounts).map(([modality, count]) => (
                <div key={modality} className="flex items-center justify-between">
                  <Badge variant="secondary" className="font-mono">
                    {modality}
                  </Badge>
                  <span className="text-sm tabular-nums">{count}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Studies
          </h2>

          <div className="mt-4 space-y-3">
            {stats.recentStudies.length === 0 ? (
              <div className="text-sm text-muted-foreground">No studies uploaded yet</div>
            ) : (
              stats.recentStudies.map((study) => (
                <div
                  key={study.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <div className="font-medium preserve-case">{study.patient_name || 'Unknown Patient'}</div>
                    <div className="text-xs text-muted-foreground preserve-case">
                      {study.patient_id || '—'} · {study.study_date || '—'}
                    </div>
                  </div>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {study.modality || '—'}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
