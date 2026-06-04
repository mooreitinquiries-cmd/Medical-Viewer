import type { AccountRole } from '@/lib/auth';

const configuredVideoApiBase = import.meta.env.VITE_VIDEO_API?.trim();

function getCurrentOrigin() {
  if (typeof window === 'undefined') {
    return 'http://192.168.4.249:8080';
  }

  return window.location.origin;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function getPortBaseCandidates(port: number) {
  if (typeof window === 'undefined') {
    return [`http://192.168.4.249:${port}`];
  }

  const { hostname, protocol } = window.location;
  const candidates = [`${protocol}//${hostname}:${port}`];

  if (protocol !== 'http:') {
    candidates.push(`http://${hostname}:${port}`);
  }

  return unique(candidates);
}

export function getVideoApiBaseCandidates(): string[] {
  const currentOrigin = getCurrentOrigin();
  const candidates = [
    configuredVideoApiBase,
    `${currentOrigin}/video-api`,
    ...getPortBaseCandidates(8787),
    'http://192.168.4.249:8787',
  ].filter((value): value is string => Boolean(value));

  return unique(candidates.map((value) => value.replace(/\/+$/, '')));
}

async function handleVideoResponse(res: Response) {
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `Video request failed (${res.status})`
    );
  }

  return data;
}

export interface CreateVideoRoomPayload {
  ownerName: string;
  ownerRole: AccountRole;
  targetName: string;
}

export interface VideoRoomDraft {
  roomName: string;
  roomLabel: string;
  targetName: string;
  createdAt: string;
}

export interface CreateVideoTokenPayload {
  roomName: string;
  participantName: string;
  participantRole: AccountRole;
}

export interface VideoTokenResponse {
  token: string;
  url: string;
  roomName: string;
  participantIdentity: string;
  expiresAt: string;
}

export async function createVideoRoom(
  payload: CreateVideoRoomPayload
): Promise<VideoRoomDraft> {
  let lastError: Error | null = null;

  for (const baseUrl of getVideoApiBaseCandidates()) {
    try {
      const res = await fetch(`${baseUrl}/video/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      return (await handleVideoResponse(res)) as VideoRoomDraft;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Failed to create video room');
    }
  }

  throw lastError || new Error('Failed to create video room');
}

export async function createVideoToken(
  payload: CreateVideoTokenPayload
): Promise<VideoTokenResponse> {
  let lastError: Error | null = null;

  for (const baseUrl of getVideoApiBaseCandidates()) {
    try {
      const res = await fetch(`${baseUrl}/video/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      return (await handleVideoResponse(res)) as VideoTokenResponse;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Failed to create video token');
    }
  }

  throw lastError || new Error('Failed to create video token');
}
