import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const LIVEKIT_URL = (process.env.LIVEKIT_URL || '').trim();
const LIVEKIT_API_KEY = (process.env.LIVEKIT_API_KEY || '').trim();
const LIVEKIT_API_SECRET = (process.env.LIVEKIT_API_SECRET || '').trim();
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 3600);

function sendJson(res, statusCode, payload) {
  const requestOrigin = String(res.req?.headers.origin || '').trim();
  const allowOrigin =
    CORS_ORIGIN === '*'
      ? requestOrigin || '*'
      : CORS_ORIGIN;

  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signJwt(payload, secret) {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const body = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function createRoomName(ownerName, targetName) {
  const ownerSlug = slugify(ownerName) || 'host';
  const targetSlug = slugify(targetName) || 'guest';
  return `consult-${ownerSlug}-${targetSlug}-${Date.now().toString(36)}`;
}

function ensureConfigured() {
  return Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
}

function resolveLivekitUrl(req) {
  const configured = LIVEKIT_URL.toLowerCase();
  if (configured && configured !== 'auto') {
    return LIVEKIT_URL;
  }

  const hostHeader = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').trim();
  const host = hostHeader.split(',')[0].trim();
  const hostname = host.includes(':') ? host.split(':')[0] : host;
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
  const isHttps = forwardedProto === 'https' || Boolean(req?.socket?.encrypted);
  const wsProto = isHttps ? 'wss' : 'ws';
  const finalHost = hostname || '127.0.0.1';
  return `${wsProto}://${finalHost}:7880`;
}

function createParticipantIdentity(participantName, participantRole) {
  const prefix = slugify(participantRole || 'guest') || 'guest';
  const name = slugify(participantName || 'participant') || 'participant';
  return `${prefix}-${name}-${randomUUID().slice(0, 8)}`;
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      configured: ensureConfigured(),
      livekitUrl: resolveLivekitUrl(req),
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/video/rooms') {
    try {
      const body = await readJsonBody(req);
      const ownerName = String(body.ownerName || '').trim();
      const targetName = String(body.targetName || '').trim();
      const ownerRole = String(body.ownerRole || '').trim();

      if (!ownerName || !targetName || !ownerRole) {
        sendJson(res, 400, { error: 'ownerName, ownerRole, and targetName are required' });
        return;
      }

      const roomName = createRoomName(ownerName, targetName);
      sendJson(res, 200, {
        roomName,
        roomLabel: `${ownerName} and ${targetName}`,
        targetName,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/video/token') {
    if (!ensureConfigured()) {
      sendJson(res, 500, {
        error: 'Missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET in video gateway env',
      });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const roomName = String(body.roomName || '').trim();
      const participantName = String(body.participantName || '').trim();
      const participantRole = String(body.participantRole || '').trim();

      if (!roomName || !participantName || !participantRole) {
        sendJson(res, 400, {
          error: 'roomName, participantName, and participantRole are required',
        });
        return;
      }

      const participantIdentity = createParticipantIdentity(participantName, participantRole);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = new Date((now + TOKEN_TTL_SECONDS) * 1000).toISOString();
      const metadata = JSON.stringify({
        name: participantName,
        role: participantRole,
      });

      const token = signJwt(
        {
          iss: LIVEKIT_API_KEY,
          sub: participantIdentity,
          iat: now,
          nbf: now - 10,
          exp: now + TOKEN_TTL_SECONDS,
          name: participantName,
          metadata,
          video: {
            room: roomName,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
          },
        },
        LIVEKIT_API_SECRET
      );

      sendJson(res, 200, {
        token,
        url: resolveLivekitUrl(req),
        roomName,
        participantIdentity,
        expiresAt,
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  process.stdout.write(`video-gateway listening on http://0.0.0.0:${PORT}\n`);
});
