import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Camera, LoaderCircle, PhoneCall, Video } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/AuthContext';
import {
  completeCareCall,
  listCareCalls,
  type CareCall,
} from '@/lib/careApi';
import { createVideoRoom, createVideoToken, getVideoApiBaseCandidates } from '@/lib/video';

const LiveKitCallRoom = lazy(() => import('@/components/LiveKitCallRoom'));

interface ActiveSession {
  roomName: string;
  roomLabel: string;
  targetName: string;
  token: string;
  serverUrl: string;
}

export default function VideoCalls() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [target, setTarget] = useState('');
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [queue, setQueue] = useState<CareCall[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);

  const videoApiHints = useMemo(() => getVideoApiBaseCandidates(), []);

  const loadQueue = async () => {
    try {
      setLoadingQueue(true);
      const data = await listCareCalls();
      setQueue(data.calls || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load call queue');
    } finally {
      setLoadingQueue(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  useEffect(() => {
    const queryTarget = searchParams.get('target')?.trim();
    if (queryTarget) {
      setTarget(queryTarget);
    }
  }, [searchParams]);

  async function startCall(targetName: string, sourceCall?: CareCall) {
    if (!user) {
      return;
    }

    const normalizedTarget = targetName.trim();
    if (!normalizedTarget) {
      return;
    }

    setPendingTarget(normalizedTarget);

    try {
      const roomDraft = await createVideoRoom({
        ownerName: user.name,
        ownerRole: user.role,
        targetName: normalizedTarget,
      });

      const tokenResponse = await createVideoToken({
        roomName: roomDraft.roomName,
        participantName: user.name,
        participantRole: user.role,
      });

      setActiveSession({
        roomName: tokenResponse.roomName,
        roomLabel: roomDraft.roomLabel,
        targetName: roomDraft.targetName,
        token: tokenResponse.token,
        serverUrl: tokenResponse.url,
      });

      if (sourceCall && sourceCall.status !== 'completed') {
        await completeCareCall(sourceCall.id).catch(() => undefined);
        setQueue((prev) => prev.map((entry) => (entry.id === sourceCall.id ? { ...entry, status: 'completed' } : entry)));
      }

      setTarget('');
      toast.success(`Connected to ${roomDraft.roomLabel}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start call');
    } finally {
      setPendingTarget(null);
    }
  }

  const sortedQueue = useMemo(
    () => [...queue].sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()),
    [queue]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Video Calls</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Self-hosted LiveKit sessions for patient consults and secure doctor collaboration.
          </p>
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Token API fallback order: {videoApiHints.join(' -> ')}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between border-b pb-4">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-primary" />
              <span className="font-medium">Active Session</span>
            </div>
            <Badge variant={activeSession ? 'default' : 'secondary'}>
              {activeSession ? 'Live' : 'Idle'}
            </Badge>
          </div>

          {!activeSession ? (
            <div className="flex h-[520px] items-center justify-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
              <div className="max-w-sm space-y-3">
                <Video className="mx-auto h-8 w-8 text-primary" />
                <div className="text-base font-medium">No room connected</div>
                <p className="text-sm text-muted-foreground">
                  Start a room from the right panel. The frontend requests a short-lived token
                  from your self-hosted gateway and connects directly to LiveKit.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/25 px-3 py-2 text-sm">
                <Badge variant="outline">{activeSession.roomName}</Badge>
                <span className="font-medium">{activeSession.roomLabel}</span>
                <span className="text-muted-foreground">with {activeSession.targetName}</span>
              </div>

              <Suspense
                fallback={
                  <div className="flex min-h-[520px] items-center justify-center rounded-lg border bg-black text-sm text-white/70">
                    Loading video room...
                  </div>
                }
              >
                <LiveKitCallRoom
                  token={activeSession.token}
                  serverUrl={activeSession.serverUrl}
                  roomLabel={activeSession.roomLabel}
                  onConnected={() => toast.success(`Joined ${activeSession.roomLabel}`)}
                  onDisconnected={() => {
                    setActiveSession(null);
                    toast.message('Video call ended');
                  }}
                  onError={(error) => toast.error(error.message)}
                />
              </Suspense>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="mb-2 font-medium">Start Direct Call</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Generate a room, mint a participant token, and connect to your self-hosted LiveKit cluster.
            </p>
            <Input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="Patient, doctor, or clinic name"
            />
            <div className="mt-3">
              <Button
                className="w-full"
                disabled={!target.trim() || Boolean(pendingTarget)}
                onClick={() => startCall(target)}
              >
                {pendingTarget === target.trim() ? (
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PhoneCall className="mr-2 h-4 w-4" />
                )}
                {pendingTarget === target.trim() ? 'Connecting...' : `Call ${target || 'Contact'}`}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="mb-3 font-medium">Upcoming Queue</div>
            {loadingQueue ? (
              <div className="text-xs text-muted-foreground">Loading queue...</div>
            ) : sortedQueue.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No scheduled calls yet.
              </div>
            ) : (
              <div className="space-y-2">
                {sortedQueue.map((item) => {
                  const displayName =
                    item.organizerName === user?.name ? item.contactName : item.organizerName;
                  const isPending = pendingTarget === displayName;

                  return (
                    <div key={item.id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{displayName}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {new Date(item.scheduledAt).toLocaleString()}
                          </div>
                        </div>
                        <Badge variant={item.status === 'completed' ? 'secondary' : 'default'}>
                          {item.status}
                        </Badge>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                        disabled={Boolean(pendingTarget) || item.status === 'completed'}
                        onClick={() => startCall(displayName, item)}
                      >
                        {isPending ? (
                          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Video className="mr-2 h-4 w-4" />
                        )}
                        {isPending ? 'Connecting...' : 'Join Room'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-card p-4 text-xs text-muted-foreground shadow-sm">
            This screen assumes a token gateway is running and configured with `LIVEKIT_URL`,
            `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
          </div>
        </div>
      </div>
    </div>
  );
}
