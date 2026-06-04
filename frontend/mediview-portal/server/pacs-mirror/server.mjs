import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';

const PACS_APP_URL = (process.env.PACS_APP_URL || '').trim();
const PACS_MIRROR_PORT = Number(process.env.PACS_MIRROR_PORT || process.env.PORT || 8790);
const PACS_MIRROR_TOKEN = (process.env.PACS_MIRROR_TOKEN || '').trim();
const ALLOWED_MIRROR_ORIGIN = (process.env.ALLOWED_MIRROR_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const CAPTURE_INTERVAL_MS = Number(process.env.PACS_CAPTURE_INTERVAL_MS || 750);
const CAPTURE_QUALITY = Number(process.env.PACS_CAPTURE_QUALITY || 55);
const SEAT_IDLE_TTL_MS = Number(process.env.PACS_SEAT_IDLE_TTL_MS || 120000);

if (!PACS_APP_URL) {
  throw new Error('Missing PACS_APP_URL');
}
if (!PACS_MIRROR_TOKEN) {
  throw new Error('Missing PACS_MIRROR_TOKEN');
}

const seatMap = new Map();
let browserPromise = null;

const streamWss = new WebSocketServer({ noServer: true });
const controlWss = new WebSocketServer({ noServer: true });

function log(event, payload = {}) {
  process.stdout.write(`${new Date().toISOString()} pacs-mirror ${event} ${JSON.stringify(payload)}\n`);
}

function sendJson(res, statusCode, payload) {
  const reqOrigin = String(res.req?.headers.origin || '').trim();
  const allowOrigin = reqOrigin && isOriginAllowed(reqOrigin) ? reqOrigin : 'null';

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(payload));
}

function isOriginAllowed(origin) {
  if (!ALLOWED_MIRROR_ORIGIN.length) {
    return true;
  }
  return ALLOWED_MIRROR_ORIGIN.includes(origin);
}

function isTokenAuthorized(req) {
  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const url = new URL(req.url || '/', 'http://localhost');
  const queryToken = String(url.searchParams.get('token') || '').trim();
  const token = bearerToken || queryToken;
  return token === PACS_MIRROR_TOKEN;
}

function seatKey(officeSlug, seatId) {
  return `${officeSlug}::${seatId}`;
}

function parseMirrorPath(urlPathname) {
  const match = /^\/mirror\/([^/]+)\/([^/]+)(?:\/(stream|control))?$/.exec(urlPathname);
  if (!match) {
    return null;
  }
  return {
    officeSlug: match[1],
    seatId: match[2],
    channel: match[3] || null,
  };
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

function startCaptureLoop(seat) {
  if (seat.captureTimer) {
    return;
  }

  seat.captureTimer = setInterval(async () => {
    if (!seat.streamClients.size) {
      return;
    }

    try {
      const frame = await seat.page.screenshot({
        type: 'jpeg',
        quality: CAPTURE_QUALITY,
        fullPage: false,
      });

      for (const client of seat.streamClients) {
        if (client.readyState === client.OPEN) {
          client.send(frame, { binary: true });
        }
      }
    } catch (error) {
      log('error_capturing_frame', {
        seatKey: seat.key,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }, CAPTURE_INTERVAL_MS);

  log('mirror started', {
    officeSlug: seat.officeSlug,
    seatId: seat.seatId,
    captureIntervalMs: CAPTURE_INTERVAL_MS,
  });
}

function stopCaptureLoop(seat) {
  if (seat.captureTimer) {
    clearInterval(seat.captureTimer);
    seat.captureTimer = null;
  }
}

function maybeScheduleSeatCleanup(seat) {
  if (seat.streamClients.size || seat.controlClients.size) {
    return;
  }
  if (seat.cleanupTimer) {
    return;
  }

  seat.cleanupTimer = setTimeout(async () => {
    if (seat.streamClients.size || seat.controlClients.size) {
      seat.cleanupTimer = null;
      return;
    }

    stopCaptureLoop(seat);
    seatMap.delete(seat.key);

    try {
      await seat.context.close();
    } catch {
      // no-op
    }

    log('seat disconnected', {
      officeSlug: seat.officeSlug,
      seatId: seat.seatId,
      reason: 'idle_timeout',
    });
  }, SEAT_IDLE_TTL_MS);
}

function clearCleanupTimer(seat) {
  if (seat.cleanupTimer) {
    clearTimeout(seat.cleanupTimer);
    seat.cleanupTimer = null;
  }
}

async function getOrCreateSeat(officeSlug, seatId) {
  const key = seatKey(officeSlug, seatId);
  const existing = seatMap.get(key);
  if (existing) {
    return existing;
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(PACS_APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) {
    await context.close();
    log('error opening PACS', {
      officeSlug,
      seatId,
      pacsUrl: PACS_APP_URL,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }

  const seat = {
    id: randomUUID(),
    key,
    officeSlug,
    seatId,
    createdAt: new Date().toISOString(),
    context,
    page,
    streamClients: new Set(),
    controlClients: new Set(),
    captureTimer: null,
    cleanupTimer: null,
  };

  seatMap.set(key, seat);
  log('seat created', { officeSlug, seatId, seatKey: key, pacsUrl: PACS_APP_URL });
  return seat;
}

async function handleControlInput(seat, message) {
  let payload;
  try {
    payload = JSON.parse(String(message));
  } catch {
    return;
  }

  const type = String(payload?.type || '').trim();
  log('control input received', {
    officeSlug: seat.officeSlug,
    seatId: seat.seatId,
    type,
  });

  const x = Number(payload?.x ?? 0);
  const y = Number(payload?.y ?? 0);

  switch (type) {
    case 'mouse_move':
      await seat.page.mouse.move(x, y);
      return;
    case 'mouse_click':
      await seat.page.mouse.click(x, y, {
        button: payload?.button === 'right' ? 'right' : 'left',
        clickCount: Number(payload?.clickCount || 1),
      });
      return;
    case 'scroll':
      await seat.page.mouse.move(x, y);
      await seat.page.mouse.wheel(Number(payload?.deltaX || 0), Number(payload?.deltaY || 0));
      return;
    case 'keyboard_input':
      if (payload?.text) {
        await seat.page.keyboard.type(String(payload.text));
      } else if (payload?.key) {
        await seat.page.keyboard.press(String(payload.key));
      }
      return;
    default:
      return;
  }
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

  if (req.method === 'GET' && req.url.startsWith('/health')) {
    sendJson(res, 200, {
      ok: true,
      pacsAppUrl: PACS_APP_URL,
      activeSeatCount: seatMap.size,
      activeStreamClients: [...seatMap.values()].reduce((sum, seat) => sum + seat.streamClients.size, 0),
      activeControlClients: [...seatMap.values()].reduce((sum, seat) => sum + seat.controlClients.size, 0),
    });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const parsed = parseMirrorPath(url.pathname);
  if (req.method === 'GET' && parsed && !parsed.channel) {
    if (!isTokenAuthorized(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const reqOrigin = String(req.headers.origin || '').trim();
    if (reqOrigin && !isOriginAllowed(reqOrigin)) {
      sendJson(res, 403, { error: 'Origin not allowed' });
      return;
    }

    try {
      const seat = await getOrCreateSeat(parsed.officeSlug, parsed.seatId);
      sendJson(res, 200, {
        ok: true,
        officeSlug: parsed.officeSlug,
        seatId: parsed.seatId,
        seatSessionId: seat.id,
        streamUrl: `/mirror/${parsed.officeSlug}/${parsed.seatId}/stream`,
        controlUrl: `/mirror/${parsed.officeSlug}/${parsed.seatId}/control`,
      });
    } catch (error) {
      sendJson(res, 502, {
        error: 'Failed to open PACS session',
        details: error instanceof Error ? error.message : 'unknown',
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const parsed = parseMirrorPath(url.pathname);
    if (!parsed?.channel) {
      socket.destroy();
      return;
    }

    const reqOrigin = String(req.headers.origin || '').trim();
    if (reqOrigin && !isOriginAllowed(reqOrigin)) {
      socket.destroy();
      return;
    }
    if (!isTokenAuthorized(req)) {
      socket.destroy();
      return;
    }

    const seat = await getOrCreateSeat(parsed.officeSlug, parsed.seatId);
    clearCleanupTimer(seat);

    const target = parsed.channel === 'stream' ? streamWss : controlWss;
    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit('connection', ws, req, seat);
    });
  } catch (error) {
    log('upgrade_error', { error: error instanceof Error ? error.message : 'unknown' });
    socket.destroy();
  }
});

streamWss.on('connection', (ws, req, seat) => {
  seat.streamClients.add(ws);
  log('seat connected', {
    officeSlug: seat.officeSlug,
    seatId: seat.seatId,
    channel: 'stream',
    streamClients: seat.streamClients.size,
  });

  startCaptureLoop(seat);

  ws.on('close', () => {
    seat.streamClients.delete(ws);
    log('seat disconnected', {
      officeSlug: seat.officeSlug,
      seatId: seat.seatId,
      channel: 'stream',
      streamClients: seat.streamClients.size,
    });
    if (!seat.streamClients.size) {
      stopCaptureLoop(seat);
    }
    maybeScheduleSeatCleanup(seat);
  });

  ws.on('error', (error) => {
    log('stream_socket_error', {
      officeSlug: seat.officeSlug,
      seatId: seat.seatId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
});

controlWss.on('connection', (ws, req, seat) => {
  seat.controlClients.add(ws);
  log('seat connected', {
    officeSlug: seat.officeSlug,
    seatId: seat.seatId,
    channel: 'control',
    controlClients: seat.controlClients.size,
  });

  ws.on('message', async (message) => {
    try {
      await handleControlInput(seat, message);
    } catch (error) {
      log('control_input_error', {
        officeSlug: seat.officeSlug,
        seatId: seat.seatId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  });

  ws.on('close', () => {
    seat.controlClients.delete(ws);
    log('seat disconnected', {
      officeSlug: seat.officeSlug,
      seatId: seat.seatId,
      channel: 'control',
      controlClients: seat.controlClients.size,
    });
    maybeScheduleSeatCleanup(seat);
  });

  ws.on('error', (error) => {
    log('control_socket_error', {
      officeSlug: seat.officeSlug,
      seatId: seat.seatId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
});

server.listen(PACS_MIRROR_PORT, () => {
  log('service_started', {
    port: PACS_MIRROR_PORT,
    pacsAppUrl: PACS_APP_URL,
    allowedOrigins: ALLOWED_MIRROR_ORIGIN,
  });
});
