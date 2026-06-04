import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AUTH_API_PORT || 8788);
const HOST = String(process.env.AUTH_API_HOST || process.env.HOST || '127.0.0.1').trim();
const CORS_ORIGINS = (process.env.AUTH_API_CORS_ORIGIN || '').trim();
const SESSION_COOKIE_NAME = (process.env.AUTH_SESSION_COOKIE || 'mediview_session').trim();
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;
const SECURE_COOKIES = String(process.env.AUTH_COOKIE_SECURE || 'false').toLowerCase() === 'true';
const BOOTSTRAP_ADMIN_PASSWORD = String(process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD || '').trim();
const DEFAULT_PORTAL_ORIGIN = (process.env.AUTH_PORTAL_ORIGIN || 'http://192.168.4.249:8080').trim();
const TWO_FACTOR_AUTH_ENABLED = false;
const DATA_DIR = join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'store.json');

mkdirSync(DATA_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function validateUsername(value) {
  const username = normalizeUsername(value);

  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 40) return 'Username must be 40 characters or fewer';
  if (!/^[a-z0-9._-]+$/.test(username)) {
    return 'Username can only include letters, numbers, periods, underscores, and hyphens';
  }

  return null;
}

function getAllowedOrigins(req) {
  const configuredOrigins = CORS_ORIGINS
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (configuredOrigins.length > 0) {
    return configuredOrigins;
  }

  const requestOrigin = String(req.headers.origin || '').trim();
  const host = String(req.headers.host || '').trim();

  return [
    requestOrigin,
    host ? `http://${host}` : '',
    host ? `https://${host}` : '',
    DEFAULT_PORTAL_ORIGIN,
    'http://localhost:8080',
    'http://127.0.0.1:8080',
  ].filter(Boolean);
}

function resolveCorsOrigin(req) {
  const requestOrigin = String(req.headers.origin || '').trim();
  const allowedOrigins = getAllowedOrigins(req);

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowedOrigins[0] || DEFAULT_PORTAL_ORIGIN;
}

function sendJson(res, statusCode, payload, cookieHeaders = []) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': resolveCorsOrigin(res.req),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
    ...(cookieHeaders.length ? { 'Set-Cookie': cookieHeaders } : {}),
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

function validatePassword(value) {
  const password = String(value || '').trim();

  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';

  return null;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derivedKey = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, hashedPassword) {
  const [salt, storedKey] = String(hashedPassword || '').split(':');
  if (!salt || !storedKey) {
    return false;
  }

  const derivedKey = scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(storedKey, 'hex');

  if (derivedKey.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, storedBuffer);
}

const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;

function createTwoFactorSecret() {
  const bytes = randomBytes(20);
  let bits = '';
  let output = '';

  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }

  for (let index = 0; index + 5 <= bits.length; index += 5) {
    output += TOTP_ALPHABET[parseInt(bits.slice(index, index + 5), 2)];
  }

  return output;
}

function decodeBase32Secret(secret) {
  const normalized = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  const bytes = [];

  for (const char of normalized) {
    const value = TOTP_ALPHABET.indexOf(char);
    if (value === -1) return null;
    bits += value.toString(2).padStart(5, '0');
  }

  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotp(secret, counter) {
  const secretBuffer = decodeBase32Secret(secret);
  if (!secretBuffer) return null;

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(value % 1000000).padStart(6, '0');
}

function verifyTotp(secret, token) {
  const cleanedToken = String(token || '').trim().replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(cleanedToken)) return false;

  const currentCounter = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    const expected = generateTotp(secret, currentCounter + offset);
    if (!expected) continue;
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(cleanedToken))) {
      return true;
    }
  }

  return false;
}

function createTotpUrl(user, secret) {
  const label = encodeURIComponent(`MediView:${user.username || user.email}`);
  const issuer = encodeURIComponent('MediView');
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&period=${TOTP_PERIOD_SECONDS}&digits=6`;
}

function createPublicUser(user) {
  return {
    username: user.username || user.email,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    twoFactorEnabled: TWO_FACTOR_AUTH_ENABLED && Boolean(user.twoFactorEnabled),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function defaultStore() {
  if (!BOOTSTRAP_ADMIN_PASSWORD) {
    throw new Error('AUTH_BOOTSTRAP_ADMIN_PASSWORD is required when initializing the auth store');
  }

  return {
    users: [
      {
        username: 'admin',
        email: 'admin',
        name: 'Master Admin',
        role: 'admin',
        status: 'active',
        twoFactorEnabled: false,
        twoFactorSecret: null,
        passwordHash: hashPassword(BOOTSTRAP_ADMIN_PASSWORD),
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: null,
      },
    ],
    sessions: [],
    cases: [],
    messages: [],
    calls: [],
  };
}

function readStore() {
  try {
    const raw = readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed.users) ||
      !Array.isArray(parsed.sessions) ||
      !Array.isArray(parsed.cases || []) ||
      !Array.isArray(parsed.messages || []) ||
      !Array.isArray(parsed.calls || [])
    ) {
      throw new Error('Invalid auth store');
    }
    parsed.users = parsed.users.map((user) => ({
      ...user,
      username: normalizeUsername(user.username || user.email),
      twoFactorEnabled: Boolean(user.twoFactorEnabled && user.twoFactorSecret),
      twoFactorSecret: user.twoFactorSecret || null,
    }));
    parsed.cases = parsed.cases || [];
    parsed.messages = parsed.messages || [];
    parsed.calls = parsed.calls || [];
    return parsed;
  } catch {
    const seeded = defaultStore();
    writeStore(seeded);
    return seeded;
  }
}

function writeStore(store) {
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};

  return raw.split(';').reduce((acc, pair) => {
    const [key, ...rest] = pair.trim().split('=');
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function makeSessionCookie(sessionId) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax;${
    SECURE_COOKIES ? ' Secure;' : ''
  } Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax;${
    SECURE_COOKIES ? ' Secure;' : ''
  } Max-Age=0`;
}

function createPatientSummary(store, patient) {
  const openCaseCount = store.cases.filter(
    (entry) => entry.patientEmail === patient.email && entry.status === 'new'
  ).length;

  return {
    email: patient.email,
    name: patient.name,
    status: patient.status,
    createdAt: patient.createdAt,
    lastLoginAt: patient.lastLoginAt,
    openCaseCount,
  };
}

function canAccessCase(currentUser, careCase) {
  if (currentUser.role === 'admin') return true;
  if (currentUser.role === 'doctor') return careCase.doctorEmail === currentUser.email;
  if (currentUser.role === 'patient') return careCase.patientEmail === currentUser.email;
  if (currentUser.role === 'clinic') return true;
  return false;
}

function createPublicContact(contact, latestMessageAt = null) {
  const titleByRole = {
    admin: 'Platform Admin',
    doctor: 'Doctor',
    patient: 'Patient',
    clinic: 'Clinic Staff',
  };

  return {
    email: contact.email,
    name: contact.name,
    role: contact.role,
    title: titleByRole[contact.role] || 'Care Team',
    latestMessageAt,
    unreadCount: 0,
  };
}

function normalizeCaseStudyStack(input) {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((item, index) => {
      const studyId = Number(item?.studyId);
      if (!Number.isInteger(studyId) || studyId <= 0) return null;
      const relation = item?.relation === 'current' ? 'current' : 'prior';
      return {
        studyId,
        relation,
        order: index,
        patientName: String(item?.patientName || '').trim(),
        patientId: String(item?.patientId || '').trim(),
        studyDate: String(item?.studyDate || '').trim(),
        modality: String(item?.modality || '').trim(),
        dicomCount: Number(item?.dicomCount) || 0,
      };
    })
    .filter(Boolean);

  const seen = new Set();
  const deduped = [];
  for (const entry of normalized) {
    if (seen.has(entry.studyId)) continue;
    seen.add(entry.studyId);
    deduped.push(entry);
  }
  return deduped.map((entry, index) => ({ ...entry, order: index }));
}

function normalizePersonValue(value) {
  return String(value || '').trim().toLowerCase();
}

function validateCaseStudyStackPatient(studyStack, patient) {
  if (!Array.isArray(studyStack) || studyStack.length === 0) return null;

  const patientEmail = normalizePersonValue(patient?.email);
  const patientName = normalizePersonValue(patient?.name);
  const first = studyStack[0];
  const firstPatientId = normalizePersonValue(first?.patientId);
  const firstPatientName = normalizePersonValue(first?.patientName);

  for (const entry of studyStack) {
    const entryPatientId = normalizePersonValue(entry?.patientId);
    const entryPatientName = normalizePersonValue(entry?.patientName);

    if (firstPatientId && entryPatientId && entryPatientId !== firstPatientId) {
      return 'All stacked studies must belong to the same patient.';
    }

    if (!firstPatientId && firstPatientName && entryPatientName && entryPatientName !== firstPatientName) {
      return 'All stacked studies must belong to the same patient.';
    }
  }

  if (firstPatientId && patientEmail && firstPatientId !== patientEmail) {
    return 'Selected studies do not match the selected patient.';
  }

  if (!firstPatientId && firstPatientName && patientName && firstPatientName !== patientName) {
    return 'Selected studies do not match the selected patient.';
  }

  return null;
}

function normalizeCasePriorReports(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const url = String(item?.url || item?.report_url || '').trim();
      if (!url) return null;
      return {
        url,
        filename: String(item?.filename || '').trim(),
        sourceStudyId: Number.isInteger(Number(item?.sourceStudyId)) ? Number(item?.sourceStudyId) : null,
        createdAt: String(item?.createdAt || new Date().toISOString()).trim(),
      };
    })
    .filter(Boolean);
}

function getSessionRecord(store, req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    return null;
  }

  const session = store.sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    store.sessions = store.sessions.filter((entry) => entry.id !== session.id);
    writeStore(store);
    return null;
  }

  return session;
}

function getAuthenticatedUser(store, req) {
  const session = getSessionRecord(store, req);
  if (!session) {
    return null;
  }

  const user = store.users.find((entry) => entry.email === session.email);
  if (!user || user.status !== 'active') {
    return null;
  }

  return user;
}

function requireAuth(store, req, res) {
  const user = getAuthenticatedUser(store, req);
  if (!user) {
    sendJson(res, 401, { error: 'Authentication required' });
    return null;
  }

  return user;
}

function requireAdmin(store, req, res) {
  const user = requireAuth(store, req, res);
  if (!user) {
    return null;
  }

  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'Admin access required' });
    return null;
  }

  return user;
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

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const store = readStore();

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, users: store.users.length });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/session') {
    const user = getAuthenticatedUser(store, req);
    if (!user) {
      sendJson(res, 401, { error: 'No active session' }, [clearSessionCookie()]);
      return;
    }

    sendJson(res, 200, { user: createPublicUser(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    try {
      const body = await readJsonBody(req);
      const identifier = normalizeUsername(body.username || body.email);
      const password = String(body.password || '');
      const user = store.users.find(
        (entry) => entry.username === identifier || normalizeEmail(entry.email) === identifier
      );

      if (!user || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { error: 'Invalid username or password' });
        return;
      }

      if (user.status !== 'active') {
        sendJson(res, 403, { error: 'This account is suspended' });
        return;
      }

      if (
        TWO_FACTOR_AUTH_ENABLED &&
        user.twoFactorEnabled &&
        !verifyTotp(user.twoFactorSecret, String(body.twoFactorCode || ''))
      ) {
        sendJson(res, 401, { error: 'A valid 2FA code is required' });
        return;
      }

      user.lastLoginAt = nowIso();

      const session = {
        id: randomUUID(),
        email: user.email,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      };

      store.sessions = store.sessions
        .filter((entry) => entry.email !== user.email && new Date(entry.expiresAt).getTime() > Date.now())
        .concat(session);
      writeStore(store);

      sendJson(res, 200, { user: createPublicUser(user) }, [makeSessionCookie(session.id)]);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const session = getSessionRecord(store, req);
    if (session) {
      store.sessions = store.sessions.filter((entry) => entry.id !== session.id);
      writeStore(store);
    }

    sendJson(res, 200, { ok: true }, [clearSessionCookie()]);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/users') {
    const admin = requireAdmin(store, req, res);
    if (!admin) return;
    sendJson(res, 200, { users: store.users.map(createPublicUser) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/users') {
    const admin = requireAdmin(store, req, res);
    if (!admin) return;

    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const username = normalizeUsername(body.username);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const role = String(body.role || '');
      const twoFactorEnabled = TWO_FACTOR_AUTH_ENABLED && Boolean(body.twoFactorEnabled);

      if (!name || !username || !email || !password || !['doctor', 'patient', 'clinic'].includes(role)) {
        sendJson(res, 400, { error: 'name, username, email, password, and a valid role are required' });
        return;
      }

      const usernameError = validateUsername(username);
      if (usernameError) {
        sendJson(res, 400, { error: usernameError });
        return;
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        sendJson(res, 400, { error: passwordError });
        return;
      }

      if (store.users.some((entry) => entry.email === email)) {
        sendJson(res, 409, { error: 'A user with this email already exists' });
        return;
      }

      if (store.users.some((entry) => entry.username === username)) {
        sendJson(res, 409, { error: 'A user with this username already exists' });
        return;
      }

      const twoFactorSecret = twoFactorEnabled ? createTwoFactorSecret() : null;
      const user = {
        username,
        email,
        name,
        role,
        status: 'active',
        twoFactorEnabled,
        twoFactorSecret,
        passwordHash: hashPassword(password),
        createdAt: nowIso(),
        lastLoginAt: null,
      };

      store.users.push(user);
      writeStore(store);
      sendJson(res, 201, {
        user: createPublicUser(user),
        twoFactorSetup: twoFactorEnabled
          ? {
              secret: twoFactorSecret,
              otpauthUrl: createTotpUrl(user, twoFactorSecret),
            }
          : null,
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const statusMatch = url.pathname.match(/^\/auth\/users\/(.+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    const admin = requireAdmin(store, req, res);
    if (!admin) return;

    try {
      const targetEmail = normalizeEmail(decodeURIComponent(statusMatch[1]));
      const body = await readJsonBody(req);
      const status = String(body.status || '');
      const user = store.users.find((entry) => entry.email === targetEmail);

      if (!user) {
        sendJson(res, 404, { error: 'User not found' });
        return;
      }

      if (!['active', 'suspended'].includes(status)) {
        sendJson(res, 400, { error: 'Invalid account status' });
        return;
      }

      if (user.role === 'admin' && status === 'suspended') {
        sendJson(res, 400, { error: 'The master admin account cannot be suspended' });
        return;
      }

      user.status = status;
      if (status === 'suspended') {
        store.sessions = store.sessions.filter((entry) => entry.email !== user.email);
      }
      writeStore(store);
      sendJson(res, 200, { user: createPublicUser(user) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const resetPasswordMatch = url.pathname.match(/^\/auth\/users\/(.+)\/reset-password$/);
  if (req.method === 'POST' && resetPasswordMatch) {
    const admin = requireAdmin(store, req, res);
    if (!admin) return;

    try {
      const targetEmail = normalizeEmail(decodeURIComponent(resetPasswordMatch[1]));
      const body = await readJsonBody(req);
      const nextPassword = String(body.nextPassword || '');
      const user = store.users.find((entry) => entry.email === targetEmail);

      if (!user) {
        sendJson(res, 404, { error: 'User not found' });
        return;
      }

      const passwordError = validatePassword(nextPassword);
      if (passwordError) {
        sendJson(res, 400, { error: passwordError });
        return;
      }

      user.passwordHash = hashPassword(nextPassword);
      store.sessions = store.sessions.filter((entry) => entry.email !== user.email);
      writeStore(store);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/change-password') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    try {
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || '');
      const nextPassword = String(body.nextPassword || '');

      if (!verifyPassword(currentPassword, user.passwordHash)) {
        sendJson(res, 400, { error: 'Current password is incorrect' });
        return;
      }

      const passwordError = validatePassword(nextPassword);
      if (passwordError) {
        sendJson(res, 400, { error: passwordError });
        return;
      }

      if (currentPassword === nextPassword) {
        sendJson(res, 400, { error: 'New password must be different from current password' });
        return;
      }

      user.passwordHash = hashPassword(nextPassword);
      store.sessions = store.sessions.filter((entry) => entry.email !== user.email);
      writeStore(store);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/care/patients') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    if (!['admin', 'doctor', 'clinic'].includes(user.role)) {
      sendJson(res, 403, { error: 'Doctor, admin, or clinic access required' });
      return;
    }

    const patients = store.users
      .filter((entry) => entry.role === 'patient')
      .map((entry) => createPatientSummary(store, entry))
      .sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, { patients });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/care/cases') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    const visibleCases = store.cases
      .filter((entry) => canAccessCase(user, entry))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    sendJson(res, 200, { cases: visibleCases });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/care/cases') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    if (!['admin', 'doctor', 'clinic'].includes(user.role)) {
      sendJson(res, 403, { error: 'Doctor, admin, or clinic access required' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const patientEmail = normalizeEmail(body.patientEmail);
      const title = String(body.title || '').trim();
      const notes = String(body.notes || '').trim();
      const studyStack = normalizeCaseStudyStack(body.studyStack);
      const priorReports = normalizeCasePriorReports(body.priorReports);
      const patient = store.users.find((entry) => entry.email === patientEmail && entry.role === 'patient');

      if (!patient) {
        sendJson(res, 404, { error: 'Patient account not found' });
        return;
      }

      if (!title || !notes) {
        sendJson(res, 400, { error: 'title and notes are required' });
        return;
      }

      const studyStackPatientError = validateCaseStudyStackPatient(studyStack, patient);
      if (studyStackPatientError) {
        sendJson(res, 400, { error: studyStackPatientError });
        return;
      }

      const careCase = {
        id: randomUUID(),
        title,
        notes,
        status: 'new',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        patientEmail: patient.email,
        patientName: patient.name,
        doctorEmail: user.email,
        doctorName: user.name,
        studyStack,
        priorReports,
      };

      store.cases.push(careCase);
      writeStore(store);
      sendJson(res, 201, { case: careCase });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const caseStatusMatch = url.pathname.match(/^\/care\/cases\/(.+)\/status$/);
  if (req.method === 'PATCH' && caseStatusMatch) {
    const user = requireAuth(store, req, res);
    if (!user) return;

    try {
      const caseId = decodeURIComponent(caseStatusMatch[1]);
      const body = await readJsonBody(req);
      const status = String(body.status || '').trim();
      const careCase = store.cases.find((entry) => entry.id === caseId);

      if (!careCase) {
        sendJson(res, 404, { error: 'Case not found' });
        return;
      }

      if (!canAccessCase(user, careCase)) {
        sendJson(res, 403, { error: 'Not allowed to update this case' });
        return;
      }

      if (!['new', 'reviewed'].includes(status)) {
        sendJson(res, 400, { error: 'Invalid case status' });
        return;
      }

      careCase.status = status;
      careCase.updatedAt = nowIso();
      writeStore(store);
      sendJson(res, 200, { case: careCase });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/care/messages/contacts') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    const roleFiltered = store.users.filter((entry) => {
      if (entry.email === user.email) return false;
      if (entry.status !== 'active') return false;
      if (user.role === 'patient') return entry.role !== 'patient';
      return true;
    });

    const contacts = roleFiltered
      .map((entry) => {
        const latestMessage = store.messages
          .filter(
            (message) =>
              (message.senderEmail === user.email && message.recipientEmail === entry.email) ||
              (message.senderEmail === entry.email && message.recipientEmail === user.email)
          )
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

        return createPublicContact(entry, latestMessage ? latestMessage.createdAt : null);
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, { contacts });
    return;
  }

  const messageThreadMatch = url.pathname.match(/^\/care\/messages\/(.+)$/);
  if (req.method === 'GET' && messageThreadMatch) {
    const user = requireAuth(store, req, res);
    if (!user) return;

    const contactEmail = normalizeEmail(decodeURIComponent(messageThreadMatch[1]));
    const contact = store.users.find((entry) => entry.email === contactEmail);

    if (!contact) {
      sendJson(res, 404, { error: 'Contact not found' });
      return;
    }

    const messages = store.messages
      .filter(
        (entry) =>
          (entry.senderEmail === user.email && entry.recipientEmail === contactEmail) ||
          (entry.senderEmail === contactEmail && entry.recipientEmail === user.email)
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    sendJson(res, 200, { messages });
    return;
  }

  if (req.method === 'POST' && messageThreadMatch) {
    const user = requireAuth(store, req, res);
    if (!user) return;

    try {
      const contactEmail = normalizeEmail(decodeURIComponent(messageThreadMatch[1]));
      const contact = store.users.find((entry) => entry.email === contactEmail);
      const body = await readJsonBody(req);
      const messageBody = String(body.body || '').trim();

      if (!contact) {
        sendJson(res, 404, { error: 'Contact not found' });
        return;
      }

      if (!messageBody) {
        sendJson(res, 400, { error: 'Message body is required' });
        return;
      }

      const message = {
        id: randomUUID(),
        senderEmail: user.email,
        senderName: user.name,
        recipientEmail: contact.email,
        recipientName: contact.name,
        body: messageBody,
        createdAt: nowIso(),
      };

      store.messages.push(message);
      writeStore(store);
      sendJson(res, 201, { message });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/care/video/calls') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    const calls = store.calls
      .filter(
        (entry) => entry.organizerEmail === user.email || entry.contactEmail === user.email || user.role === 'admin'
      )
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

    sendJson(res, 200, { calls });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/care/video/calls') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    try {
      const body = await readJsonBody(req);
      const contactEmail = normalizeEmail(body.contactEmail);
      const scheduledAt = String(body.scheduledAt || '').trim();
      const contact = store.users.find((entry) => entry.email === contactEmail);

      if (!contact) {
        sendJson(res, 404, { error: 'Contact not found' });
        return;
      }

      const parsedDate = new Date(scheduledAt);
      if (!scheduledAt || Number.isNaN(parsedDate.getTime())) {
        sendJson(res, 400, { error: 'A valid scheduledAt ISO datetime is required' });
        return;
      }

      const call = {
        id: randomUUID(),
        roomLabel: `${user.name} with ${contact.name}`,
        status: 'scheduled',
        scheduledAt: parsedDate.toISOString(),
        createdAt: nowIso(),
        organizerEmail: user.email,
        organizerName: user.name,
        contactEmail: contact.email,
        contactName: contact.name,
      };

      store.calls.push(call);
      writeStore(store);
      sendJson(res, 201, { call });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const completeCallMatch = url.pathname.match(/^\/care\/video\/calls\/(.+)\/complete$/);
  if (req.method === 'PATCH' && completeCallMatch) {
    const user = requireAuth(store, req, res);
    if (!user) return;

    try {
      const callId = decodeURIComponent(completeCallMatch[1]);
      const call = store.calls.find((entry) => entry.id === callId);

      if (!call) {
        sendJson(res, 404, { error: 'Call not found' });
        return;
      }

      const canEdit = user.role === 'admin' || call.organizerEmail === user.email || call.contactEmail === user.email;
      if (!canEdit) {
        sendJson(res, 403, { error: 'Not allowed to update this call' });
        return;
      }

      call.status = 'completed';
      writeStore(store);
      sendJson(res, 200, { call });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`auth-api listening on http://${HOST}:${PORT}\n`);
});
