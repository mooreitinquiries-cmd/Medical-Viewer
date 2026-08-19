import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, FileImage, Calendar, User, Hash, FileText, CheckCircle2 } from 'lucide-react';
import { fetchSharedStudy, getMediaBaseUrl } from '@/lib/api';
import { toast } from 'sonner';
import { VideoScrubPreviewPlayer } from '@/components/VideoScrubPreviewPlayer';

interface SharedStudyRecord {
  patient_name?: string;
  patient_id?: string;
  patient_dob?: string;
  patient_age?: string;
  patient_sex?: string;
  patient_zip?: string;
  study_date?: string;
  client_name?: string;
  subclient?: string;
  modality?: string;
  dicom_count?: number;
  status?: string;
  notes?: string;
  pdf_url?: string;
  mp4_url?: string;
  video_processing_status?: string | null;
  video_processing_error?: string | null;
  video_metadata?: {
    duration?: number;
    fps?: number;
    thumbnail_interval_sec?: number;
    thumbnail_paths?: string[];
    playback_strategy?: string;
    hls?: {
      master_playlist?: string;
      segment_duration?: number;
      variants?: Array<{
        name: string;
        height: number;
        width?: number | null;
        bandwidth?: number;
        playlist?: string;
      }>;
    } | null;
  } | null;
}

export default function SharedStudy() {
  const { token } = useParams();
  const [study, setStudy] = useState<SharedStudyRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [stableVideo, setStableVideo] = useState<{
    url: string;
    metadata: SharedStudyRecord['video_metadata'];
  } | null>(null);
  const mediaBase = getMediaBaseUrl();

  // Keep the player mounted on the last-known-good video so a background
  // re-upload/reprocess on this study never stops or pauses active playback.
  useEffect(() => {
    if (study?.mp4_url && study.video_processing_status !== 'processing') {
      setStableVideo((prev) =>
        prev && prev.url === study.mp4_url ? prev : { url: study.mp4_url as string, metadata: study.video_metadata }
      );
    }
  }, [study?.mp4_url, study?.video_processing_status, study?.video_metadata]);
  const resolveStudyMediaUrl = (rawUrl?: string | null) => {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${mediaBase.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
  };

  useEffect(() => {
    const load = async () => {
      try {
        if (!token) return;
        const data = await fetchSharedStudy(token);
        setStudy(data);
      } catch (err) {
        console.error(err);
        toast.error('Failed to load shared study');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [token]);

  if (loading) {
    return <div className="p-6">Loading...</div>;
  }

  if (!study) {
    return <div className="p-6">Shared study not found</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <FileImage className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">OCTELERAD PACS</p>
            <p className="text-xs text-muted-foreground">Shared Study Results</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight preserve-case">{study.patient_name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground preserve-case">
            {study.patient_id} · {study.modality}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: User, label: 'Patient', value: study.patient_name },
            { icon: Hash, label: 'Patient ID', value: study.patient_id },
            { icon: Calendar, label: 'Study Date', value: study.study_date },
            { icon: User, label: 'Client', value: study.client_name },
            { icon: Hash, label: 'Subclient', value: study.subclient },
            { icon: Calendar, label: 'DOB / Age', value: [study.patient_dob, study.patient_age].filter(Boolean).join(' / ') },
            { icon: User, label: 'Sex / Zip', value: [study.patient_sex, study.patient_zip].filter(Boolean).join(' / ') },
            { icon: FileImage, label: 'DICOM Files', value: String(study.dicom_count || 0) },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <item.icon className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wider">{item.label}</span>
              </div>
              <p className="mt-2 font-medium tabular-nums preserve-case">{item.value}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="font-mono">
            {study.modality}
          </Badge>
          <span className="inline-flex items-center rounded-full bg-[hsl(var(--success))]/10 px-2.5 py-0.5 text-xs font-medium text-[hsl(var(--success))]">
            {String(study.status || '').toLowerCase() === 'complete' && <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
            {study.status || 'ready'}
          </span>
        </div>

        {study.notes && (
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Clinical Notes
            </h2>
            <p className="text-sm leading-relaxed preserve-case">{study.notes}</p>
          </div>
        )}

        {study.pdf_url && (
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Report PDF
            </h2>
            <div className="flex items-center gap-4 rounded-lg bg-muted/50 p-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-destructive/10">
                <FileText className="h-6 w-6 text-destructive" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Study Report</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  PDF document attached to this study
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <a
                  href={resolveStudyMediaUrl(study.pdf_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  View PDF
                </a>
              </Button>
            </div>
          </div>
        )}

        {study.video_processing_status === 'processing' && !stableVideo && (
          <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground shadow-sm">
            Video is processing. Playback will be available when optimization finishes.
          </div>
        )}

        {study.video_processing_status === 'failed' && !stableVideo && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive shadow-sm">
            Video processing failed{study.video_processing_error ? `: ${study.video_processing_error}` : '.'}
          </div>
        )}

        {stableVideo && (
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Study Video
            </h2>
            {study.video_processing_status === 'processing' && (
              <div className="mb-3 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                A newer version is processing in the background — playback below is uninterrupted.
              </div>
            )}
            {study.video_processing_status === 'failed' && (
              <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                Reprocessing failed{study.video_processing_error ? `: ${study.video_processing_error}` : '.'} Showing the last working version.
              </div>
            )}
            <div className="overflow-hidden rounded-lg bg-foreground/5">
              <VideoScrubPreviewPlayer
                src={resolveStudyMediaUrl(stableVideo.url)}
                metadata={stableVideo.metadata}
                resolveMediaUrl={resolveStudyMediaUrl}
              />
            </div>
          </div>
        )}

        <footer className="border-t pt-6 text-center text-xs text-muted-foreground">
          Shared via OCTELERAD PACS · This link provides read-only access to study results.
        </footer>
      </main>
    </div>
  );
}
