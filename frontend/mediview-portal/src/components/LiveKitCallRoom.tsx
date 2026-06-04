import {
  DisconnectButton,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  VideoConference,
} from '@livekit/components-react';

interface LiveKitCallRoomProps {
  token: string;
  serverUrl: string;
  roomLabel: string;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: Error) => void;
}

export default function LiveKitCallRoom({
  token,
  serverUrl,
  roomLabel,
  onConnected,
  onDisconnected,
  onError,
}: LiveKitCallRoomProps) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect
      audio
      video
      onConnected={onConnected}
      onDisconnected={onDisconnected}
      onError={onError}
      className="lk-theme-default overflow-hidden rounded-lg border bg-black"
      data-lk-theme="default"
    >
      <div className="flex min-h-[520px] flex-col">
        <div className="border-b border-white/10 bg-black/50 px-3 py-2 text-sm text-white/80">
          {roomLabel}
        </div>
        <div className="flex-1">
          <VideoConference />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/60 px-3 py-3">
          <StartAudio
            label="Enable call audio"
            className="rounded-md border border-white/15 px-3 py-2 text-sm text-white"
          />
          <DisconnectButton className="inline-flex items-center rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground">
            End Call
          </DisconnectButton>
        </div>
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
