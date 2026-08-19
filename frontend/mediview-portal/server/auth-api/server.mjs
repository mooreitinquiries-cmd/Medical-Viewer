import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AUTH_API_PORT || 8788);
const HOST = String(process.env.AUTH_API_HOST || process.env.HOST || '127.0.0.1').trim();
const CORS_ORIGINS = (process.env.AUTH_API_CORS_ORIGIN || '').trim();
const SESSION_COOKIE_NAME = (process.env.AUTH_SESSION_COOKIE || 'mediview_session').trim();
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_HOURS || 8760) * 60 * 60 * 1000;
const SECURE_COOKIES = String(process.env.AUTH_COOKIE_SECURE || 'false').toLowerCase() === 'true';
const BOOTSTRAP_ADMIN_PASSWORD = String(process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD || '').trim();
const DEFAULT_PORTAL_ORIGIN = (process.env.AUTH_PORTAL_ORIGIN || 'http://192.168.4.249:8080').trim();
const TWO_FACTOR_AUTH_ENABLED = String(process.env.TWO_FACTOR_AUTH_ENABLED || 'false').toLowerCase() === 'true';
const TWO_FACTOR_CODE_SECRET = String(process.env.TWO_FACTOR_CODE_SECRET || process.env.AUTH_SESSION_SECRET || '').trim();
const TWO_FACTOR_CODE_TTL_MINUTES = Math.min(Math.max(Number(process.env.TWO_FACTOR_CODE_TTL_MINUTES || 10), 2), 30);
const TWO_FACTOR_CODE_MAX_ATTEMPTS = Math.min(Math.max(Number(process.env.TWO_FACTOR_CODE_MAX_ATTEMPTS || 5), 1), 10);
const TWO_FACTOR_APP_NAME = String(process.env.TWO_FACTOR_APP_NAME || 'MAPDR').trim();
const TWO_FACTOR_RESEND_API_KEY = String(process.env.TWO_FACTOR_RESEND_API_KEY || process.env.RESEND_API_KEY || '').trim();
const TWO_FACTOR_RESEND_FROM = String(process.env.TWO_FACTOR_RESEND_FROM || process.env.RESEND_FROM || '').trim();
const AUTH_LOGIN_RATE_LIMIT_MAX = Math.min(Math.max(Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX || 10), 1), 100);
const AUTH_LOGIN_RATE_LIMIT_WINDOW_MS = Math.min(
  Math.max(Number(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000), 60 * 1000),
  60 * 60 * 1000
);
const TWO_FACTOR_SEND_RATE_LIMIT_MAX = Math.min(Math.max(Number(process.env.TWO_FACTOR_SEND_RATE_LIMIT_MAX || 3), 1), 20);
const TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000), 60 * 1000),
  60 * 60 * 1000
);
const TWO_FACTOR_VERIFY_RATE_LIMIT_MAX = Math.min(Math.max(Number(process.env.TWO_FACTOR_VERIFY_RATE_LIMIT_MAX || 8), 1), 50);
const TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000), 60 * 1000),
  60 * 60 * 1000
);
const DATA_DIR = join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'store.json');
const DATA_BACKUP_FILE = join(DATA_DIR, 'store.json.bak');
const SUPER_ADMIN_EMAILS = new Set(
  String(process.env.AUTH_SUPER_ADMIN_EMAILS || 'admin,sarai,admin@octelerad.com')
    .split(',')
    .map((value) => normalizeEmail(value))
    .filter(Boolean)
);
const WHITE_LABEL_PLANS = new Set(['self_download_7_day', 'hosted_retention']);
const WHITE_LABEL_BILLING_STATUSES = new Set(['trial', 'pending_payment', 'active', 'past_due', 'paused', 'cancelled']);
const WHITE_LABEL_LAUNCH_STATUSES = new Set(['draft', 'setup', 'ready', 'live', 'paused']);
const WHITE_LABEL_SIGNUP_TOKEN_TTL_DAYS = Math.min(
  Math.max(Number(process.env.WHITE_LABEL_SIGNUP_TOKEN_TTL_DAYS || 14), 1),
  90
);
const WHITE_LABEL_PAYMENT_SETUP_URL = String(
  process.env.WHITE_LABEL_WORDPRESS_PAYMENT_URL || process.env.WHITE_LABEL_PAYMENT_SETUP_URL || ''
).trim();
const WHITE_LABEL_PAYMENT_CALLBACK_SECRET = String(process.env.WHITE_LABEL_PAYMENT_CALLBACK_SECRET || '').trim();
const WHITE_LABEL_OPERATIONS_EMAIL = String(process.env.WHITE_LABEL_OPERATIONS_EMAIL || 'operations@octelerad.com').trim();
const WHITE_LABEL_SELF_DOWNLOAD_PRICE_PER_DOCTOR = Math.max(
  Number(process.env.WHITE_LABEL_SELF_DOWNLOAD_PRICE_PER_DOCTOR || 249),
  0
);
const WHITE_LABEL_HOSTED_RETENTION_PRICE_PER_DOCTOR = Math.max(
  Number(process.env.WHITE_LABEL_HOSTED_RETENTION_PRICE_PER_DOCTOR || 499),
  0
);
const rateLimitBuckets = new Map();

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

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
}

function normalizeHexColor(value, fallback = '#2563eb') {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  return fallback;
}

function normalizeAccessLevel(value) {
  const accessLevel = String(value || '').trim().toLowerCase();
  if (['owner', 'admin', 'uploader', 'viewer'].includes(accessLevel)) return accessLevel;
  return 'viewer';
}

function normalizeWhiteLabelPlan(value) {
  const plan = String(value && typeof value === 'object' ? value.id : value || '').trim().toLowerCase();
  return WHITE_LABEL_PLANS.has(plan) ? plan : 'self_download_7_day';
}

function getWhiteLabelPlanPricing(plan) {
  const normalizedPlan = normalizeWhiteLabelPlan(plan);
  if (normalizedPlan === 'hosted_retention') {
    return {
      id: 'hosted_retention',
      label: 'Hosted 6-Month Storage',
      description: 'OCTELERAD hosts PACS data for 6 months.',
      retentionDays: 180,
      pricePerDoctorMonthly: WHITE_LABEL_HOSTED_RETENTION_PRICE_PER_DOCTOR,
      customQuote: false,
    };
  }
  return {
    id: 'self_download_7_day',
    label: 'Self-Download 7-Day Storage',
    description: 'Lower-cost PACS access with customer download required within 7 days.',
    retentionDays: 7,
    pricePerDoctorMonthly: WHITE_LABEL_SELF_DOWNLOAD_PRICE_PER_DOCTOR,
    customQuote: false,
  };
}

function getWhiteLabelSignupPlans() {
  return ['self_download_7_day', 'hosted_retention'].map(getWhiteLabelPlanPricing);
}

function normalizeDoctorSeatCount(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

function calculateWhiteLabelMonthlyPrice(plan, doctorSeats) {
  const pricing = getWhiteLabelPlanPricing(plan);
  return pricing.pricePerDoctorMonthly * normalizeDoctorSeatCount(doctorSeats);
}

function replacePaymentUrlTokens(value, params) {
  return String(value || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(params, key) ? encodeURIComponent(String(params[key] ?? '')) : match;
  });
}

function buildWhiteLabelPaymentSetupUrl(account) {
  if (!WHITE_LABEL_PAYMENT_SETUP_URL || !account) return '';
  const subscription = account.subscription || {};
  const params = {
    accountId: account.id,
    tenantId: account.id,
    slug: account.slug || '',
    plan: normalizeWhiteLabelPlan(account.plan),
    planLabel: getWhiteLabelPlanConfig(account.plan).label,
    doctorSeats: normalizeDoctorSeatCount(subscription.doctorSeats, 1),
    pricePerDoctorMonthly: normalizeMonthlyPrice(subscription.pricePerDoctorMonthly),
    monthlyPrice: normalizeMonthlyPrice(subscription.monthlyPrice),
    billingEmail: normalizeEmail(account.customerProfile && account.customerProfile.billingEmail),
    contactEmail: normalizeEmail(account.customerProfile && account.customerProfile.contactEmail),
    organizationName: account.name || '',
    callbackUrl: `${DEFAULT_PORTAL_ORIGIN.replace(/\/+$/, '')}/auth-api/white-label/payment-callback`,
    returnUrl: `${DEFAULT_PORTAL_ORIGIN.replace(/\/+$/, '')}/white-label`,
  };

  const resolved = replacePaymentUrlTokens(WHITE_LABEL_PAYMENT_SETUP_URL, params);
  try {
    const url = new URL(resolved);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  } catch {
    return resolved;
  }
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback;
}

function normalizeOptionalDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function normalizeMonthlyPrice(value, fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed.toFixed(2).replace(/\.00$/, '');
}

function getWhiteLabelPlanConfig(plan) {
  const normalizedPlan = normalizeWhiteLabelPlan(plan);
  if (normalizedPlan === 'hosted_retention') {
    return {
      id: 'hosted_retention',
      label: 'Hosted 6-Month Storage',
      retentionDays: 180,
      customerDownloadRequiredDays: null,
      hostedByOctelerad: true,
      requiresCustomerDownload: false,
      pricePerDoctorMonthly: WHITE_LABEL_HOSTED_RETENTION_PRICE_PER_DOCTOR,
    };
  }
  return {
    id: 'self_download_7_day',
    label: 'Self-Download 7-Day Storage',
    retentionDays: 7,
    customerDownloadRequiredDays: 7,
    hostedByOctelerad: false,
    requiresCustomerDownload: true,
    pricePerDoctorMonthly: WHITE_LABEL_SELF_DOWNLOAD_PRICE_PER_DOCTOR,
  };
}

function normalizeLogoDataUrl(value) {
  const logo = String(value || '').trim();
  if (!logo) return null;
  if (logo.length > 750000) {
    throw new Error('Logo image is too large. Use a smaller PNG, JPEG, SVG, or WebP image.');
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(logo)) {
    throw new Error('Logo must be uploaded as a PNG, JPEG, WebP, or SVG data URL.');
  }
  return logo;
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Octelerad-Webhook-Secret',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
    ...(cookieHeaders.length ? { 'Set-Cookie': cookieHeaders } : {}),
  });
  res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || String(req.socket.remoteAddress || '').trim() || 'unknown';
}

function consumeRateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  for (const [bucketKey, bucket] of rateLimitBuckets.entries()) {
    if (!bucket || Number(bucket.resetAt || 0) <= now) {
      rateLimitBuckets.delete(bucketKey);
    }
  }

  const current = rateLimitBuckets.get(key);
  if (!current || Number(current.resetAt || 0) <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(maxAttempts - 1, 0), retryAfterSeconds: 0 };
  }

  current.count = Number(current.count || 0) + 1;
  const retryAfterSeconds = Math.max(Math.ceil((current.resetAt - now) / 1000), 1);
  return {
    allowed: current.count <= maxAttempts,
    remaining: Math.max(maxAttempts - current.count, 0),
    retryAfterSeconds,
  };
}

function enforceRateLimit(req, res, scope, subject, maxAttempts, windowMs) {
  const normalizedSubject = String(subject || 'anonymous').trim().toLowerCase() || 'anonymous';
  const result = consumeRateLimit(`${scope}:${getClientIp(req)}:${normalizedSubject}`, maxAttempts, windowMs);
  if (result.allowed) return true;
  sendJson(res, 429, {
    error: `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.`,
    retryAfterSeconds: result.retryAfterSeconds,
  });
  return false;
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

function normalizeTwoFactorSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  return {
    enabled: Boolean(settings.enabled),
    verifiedAt: String(settings.verifiedAt || settings.verified_at || '').trim() || null,
    method: String(settings.method || 'email').trim().toLowerCase() || 'email',
    email: normalizeEmail(settings.email),
    lastChallengeAt: String(settings.lastChallengeAt || settings.last_challenge_at || '').trim() || null,
    disabledAt: String(settings.disabledAt || settings.disabled_at || '').trim() || null,
  };
}

function getUserTwoFactorSettings(user) {
  const settings = normalizeTwoFactorSettings(user?.twoFactor);
  if (!settings.enabled && user?.twoFactorEnabled && user?.twoFactorSecret) {
    return {
      enabled: true,
      verifiedAt: user.twoFactorVerifiedAt || user.createdAt || nowIso(),
      method: 'totp',
      email: normalizeEmail(user.email),
      lastChallengeAt: null,
      disabledAt: null,
    };
  }
  return {
    ...settings,
    email: settings.email || normalizeEmail(user?.email),
  };
}

function getTwoFactorStatus(user) {
  const settings = getUserTwoFactorSettings(user);
  return {
    available: TWO_FACTOR_AUTH_ENABLED,
    configured: Boolean(TWO_FACTOR_AUTH_ENABLED && TWO_FACTOR_CODE_SECRET && TWO_FACTOR_RESEND_API_KEY && TWO_FACTOR_RESEND_FROM),
    enabled: Boolean(settings.enabled),
    verified: Boolean(settings.enabled && settings.verifiedAt),
    method: settings.method || 'email',
    email: settings.email || normalizeEmail(user?.email),
    lastChallengeAt: settings.lastChallengeAt || null,
  };
}

function requireTwoFactorFrameworkReady() {
  if (!TWO_FACTOR_AUTH_ENABLED) {
    throw new Error('Two-factor authentication is not enabled yet.');
  }
  if (!TWO_FACTOR_CODE_SECRET) {
    throw new Error('Two-factor code secret is not configured.');
  }
}

function requireTwoFactorEmailReady() {
  requireTwoFactorFrameworkReady();
  if (!TWO_FACTOR_RESEND_API_KEY || !TWO_FACTOR_RESEND_FROM) {
    throw new Error('Two-factor email delivery is not configured yet.');
  }
}

function makeTwoFactorCode() {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

function hashTwoFactorCode(challengeId, email, code) {
  return createHmac('sha256', TWO_FACTOR_CODE_SECRET)
    .update([String(challengeId || '').trim(), normalizeEmail(email), String(code || '').trim()].join(':'))
    .digest('hex');
}

function pruneTwoFactorChallenges(user) {
  const nowMs = Date.now();
  const challenges = Array.isArray(user.twoFactorChallenges) ? user.twoFactorChallenges : [];
  user.twoFactorChallenges = challenges
    .filter((entry) => {
      const expiresAtMs = new Date(entry?.expiresAt || 0).getTime();
      return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs && !String(entry?.consumedAt || '').trim();
    })
    .slice(-5);
}

function createTwoFactorChallenge(user, purpose) {
  const email = normalizeEmail(user.email);
  const code = makeTwoFactorCode();
  const challenge = {
    id: randomUUID(),
    purpose: String(purpose || 'login').trim(),
    method: 'email',
    email,
    codeHash: '',
    attempts: 0,
    maxAttempts: TWO_FACTOR_CODE_MAX_ATTEMPTS,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000).toISOString(),
    consumedAt: null,
  };
  challenge.codeHash = hashTwoFactorCode(challenge.id, email, code);
  pruneTwoFactorChallenges(user);
  user.twoFactorChallenges.push(challenge);
  user.twoFactor = {
    ...getUserTwoFactorSettings(user),
    method: 'email',
    email,
    lastChallengeAt: challenge.createdAt,
  };
  return { challenge, code };
}

function verifyTwoFactorChallenge(user, challengeId, code, purpose) {
  pruneTwoFactorChallenges(user);
  const challenge = (user.twoFactorChallenges || []).find(
    (entry) => entry.id === String(challengeId || '').trim() && entry.purpose === String(purpose || '').trim()
  );
  if (!challenge) {
    throw new Error('Two-factor challenge was not found or has expired.');
  }
  if (Number(challenge.attempts || 0) >= Number(challenge.maxAttempts || TWO_FACTOR_CODE_MAX_ATTEMPTS)) {
    throw new Error('Too many two-factor attempts. Request a new code.');
  }
  challenge.attempts = Number(challenge.attempts || 0) + 1;
  const expectedHash = String(challenge.codeHash || '');
  const submittedHash = hashTwoFactorCode(challenge.id, challenge.email, String(code || '').replace(/\s+/g, ''));
  if (expectedHash.length !== submittedHash.length || !timingSafeEqual(Buffer.from(expectedHash), Buffer.from(submittedHash))) {
    throw new Error('Invalid two-factor code.');
  }
  challenge.consumedAt = nowIso();
  return challenge;
}

function makeSessionForUser(store, user) {
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
  return session;
}

async function sendTwoFactorEmail(toEmail, code, purpose) {
  requireTwoFactorEmailReady();
  const setup = String(purpose || '') === 'setup';
  const subject = setup ? `${TWO_FACTOR_APP_NAME} two-factor setup code` : `${TWO_FACTOR_APP_NAME} sign-in code`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TWO_FACTOR_RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: TWO_FACTOR_RESEND_FROM,
      to: [toEmail],
      subject,
      text: [
        `Your ${TWO_FACTOR_APP_NAME} verification code is ${code}.`,
        '',
        `This code expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes.`,
      ].join('\n'),
    }),
  });
  if (!response.ok) {
    throw new Error('Could not send two-factor email.');
  }
}

function createTotpUrl(user, secret) {
  const label = encodeURIComponent(`MediView:${user.username || user.email}`);
  const issuer = encodeURIComponent('MediView');
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&period=${TOTP_PERIOD_SECONDS}&digits=6`;
}

function createPublicUser(user) {
  const twoFactorStatus = getTwoFactorStatus(user);
  return {
    username: user.username || user.email,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    isSuperAdmin: isSuperAdminUser(user),
    twoFactorEnabled: Boolean(twoFactorStatus.available && twoFactorStatus.enabled),
    twoFactor: twoFactorStatus,
    whiteLabelAccountIds: Array.isArray(user.whiteLabelAccountIds) ? user.whiteLabelAccountIds : [],
    primaryWhiteLabelAccountId: user.primaryWhiteLabelAccountId || null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function createPublicWhiteLabelAccount(account) {
  return {
    id: account.id,
    name: account.name,
    slug: account.slug,
    status: account.status,
    deploymentMode: account.deploymentMode,
    plan: getWhiteLabelPlanConfig(account.plan),
    ownerEmail: account.ownerEmail || null,
    ownerName: account.ownerName || null,
    primaryDoctorEmail: account.primaryDoctorEmail || null,
    primaryDoctorName: account.primaryDoctorName || null,
    branding: {
      logoDataUrl: account.branding?.logoDataUrl || null,
      primaryColor: normalizeHexColor(account.branding?.primaryColor),
      appName: account.branding?.appName || account.name,
    },
    members: Array.isArray(account.members) ? account.members : [],
    dataGovernance: {
      deidentifiedExportsAllowed: Boolean(account.dataGovernance?.deidentifiedExportsAllowed),
      identifiableDataSaleAllowed: false,
      notes: account.dataGovernance?.notes || '',
    },
    customerProfile: {
      legalName: account.customerProfile?.legalName || '',
      contactName: account.customerProfile?.contactName || '',
      contactEmail: account.customerProfile?.contactEmail || '',
      contactPhone: account.customerProfile?.contactPhone || '',
      billingEmail: account.customerProfile?.billingEmail || '',
      serviceAddress: account.customerProfile?.serviceAddress || '',
    },
    subscription: {
      billingStatus: normalizeEnum(account.subscription?.billingStatus, WHITE_LABEL_BILLING_STATUSES, 'trial'),
      monthlyPrice: normalizeMonthlyPrice(account.subscription?.monthlyPrice),
      pricePerDoctorMonthly: normalizeMonthlyPrice(account.subscription?.pricePerDoctorMonthly),
      doctorSeats: normalizeDoctorSeatCount(account.subscription?.doctorSeats || 1),
      paymentSetupUrl: account.subscription?.paymentSetupUrl || '',
      paymentProvider: account.subscription?.paymentProvider || '',
      wordpressPaymentId: account.subscription?.wordpressPaymentId || '',
      paidAt: account.subscription?.paidAt || '',
      trialEndsAt: normalizeOptionalDate(account.subscription?.trialEndsAt),
      contractSignedAt: normalizeOptionalDate(account.subscription?.contractSignedAt),
    },
    features: {
      reportGeneration: Boolean(account.features?.reportGeneration ?? true),
      soapNotes: Boolean(account.features?.soapNotes ?? true),
      nextcloudReports: Boolean(account.features?.nextcloudReports ?? true),
      customBranding: Boolean(account.features?.customBranding ?? true),
      delegatedAccess: Boolean(account.features?.delegatedAccess ?? true),
      videoConsults: Boolean(account.features?.videoConsults),
      patientPortal: Boolean(account.features?.patientPortal),
      governedDataExports: Boolean(account.features?.governedDataExports),
    },
    onboarding: {
      launchStatus: normalizeEnum(account.onboarding?.launchStatus, WHITE_LABEL_LAUNCH_STATUSES, 'draft'),
      brandingComplete: Boolean(account.onboarding?.brandingComplete),
      primaryDoctorAssigned: Boolean(account.onboarding?.primaryDoctorAssigned),
      usersInvited: Boolean(account.onboarding?.usersInvited),
      nextcloudProvisioned: Boolean(account.onboarding?.nextcloudProvisioned),
      reportTemplatesConfigured: Boolean(account.onboarding?.reportTemplatesConfigured),
      customDomainConfigured: Boolean(account.onboarding?.customDomainConfigured),
      billingConfigured: Boolean(account.onboarding?.billingConfigured),
      complianceAcknowledged: Boolean(account.onboarding?.complianceAcknowledged),
      notes: account.onboarding?.notes || '',
    },
    clonePlan: {
      isolatedAuthStore: Boolean(account.clonePlan?.isolatedAuthStore),
      isolatedPacsStore: Boolean(account.clonePlan?.isolatedPacsStore),
      isolatedNextcloudFolder: Boolean(account.clonePlan?.isolatedNextcloudFolder),
      tenantScopedSharedInfra: Boolean(account.clonePlan?.tenantScopedSharedInfra ?? true),
      customDomain: account.clonePlan?.customDomain || '',
    },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function createPublicWhiteLabelSignupInvite(invite) {
  return {
    id: invite.id,
    token: invite.token,
    signupUrl: `/white-label/signup/${encodeURIComponent(invite.token)}`,
    recipientEmail: invite.recipientEmail || '',
    recipientName: invite.recipientName || '',
    organizationName: invite.organizationName || '',
    status: invite.status || 'active',
    createdByEmail: invite.createdByEmail || '',
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt || null,
    accountId: invite.accountId || null,
  };
}

function createPublicWhiteLabelEnrollment(invite) {
  return {
    invite: {
      recipientEmail: invite.recipientEmail || '',
      recipientName: invite.recipientName || '',
      organizationName: invite.organizationName || '',
      expiresAt: invite.expiresAt,
    },
    plans: getWhiteLabelSignupPlans(),
    customQuoteEmail: WHITE_LABEL_OPERATIONS_EMAIL,
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
        name: 'Sarai',
        role: 'admin',
        status: 'active',
        isSuperAdmin: true,
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
    whiteLabelAccounts: [],
    whiteLabelSignupInvites: [],
  };
}

function parseStoreJson(raw) {
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
    isSuperAdmin: Boolean(user.isSuperAdmin || (user.role === 'admin' && SUPER_ADMIN_EMAILS.has(normalizeEmail(user.email)))),
    whiteLabelAccountIds: Array.isArray(user.whiteLabelAccountIds) ? user.whiteLabelAccountIds : [],
    primaryWhiteLabelAccountId: user.primaryWhiteLabelAccountId || null,
    twoFactorEnabled: Boolean(user.twoFactorEnabled && user.twoFactorSecret),
    twoFactorSecret: user.twoFactorSecret || null,
    twoFactor: normalizeTwoFactorSettings(user.twoFactor),
    twoFactorChallenges: Array.isArray(user.twoFactorChallenges) ? user.twoFactorChallenges : [],
  }));
  parsed.cases = parsed.cases || [];
  parsed.messages = parsed.messages || [];
  parsed.calls = parsed.calls || [];
  parsed.whiteLabelAccounts = Array.isArray(parsed.whiteLabelAccounts)
    ? parsed.whiteLabelAccounts.map((account) => createPublicWhiteLabelAccount(account))
    : [];
  parsed.whiteLabelSignupInvites = Array.isArray(parsed.whiteLabelSignupInvites)
    ? parsed.whiteLabelSignupInvites
    : [];
  return parsed;
}

function readStore() {
  try {
    return parseStoreJson(readFileSync(DATA_FILE, 'utf8'));
  } catch (primaryError) {
    try {
      const backup = parseStoreJson(readFileSync(DATA_BACKUP_FILE, 'utf8'));
      writeStore(backup);
      return backup;
    } catch {
      console.error('Auth store load failed; seeding a new store.', primaryError);
    }
    const seeded = defaultStore();
    writeStore(seeded);
    return seeded;
  }
}

function writeStore(store) {
  const payload = JSON.stringify(store, null, 2);
  const tempFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempFile, payload);
  renameSync(tempFile, DATA_FILE);
  writeFileSync(DATA_BACKUP_FILE, payload);
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

function makePatientUsername(store, name, email) {
  const cleanPart = function (value) {
    return normalizeUsername(String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.')).replace(/^\.+|\.+$/g, '');
  };
  const emailPrefix = cleanPart(String(email || '').split('@')[0] || '');
  const namePrefix = cleanPart(name);
  const rawBase = emailPrefix || namePrefix || `patient.${Date.now()}`;
  const base = (rawBase.length >= 3 ? rawBase : `patient.${rawBase}`).slice(0, 28);
  let candidate = base;
  let suffix = 1;
  while (store.users.some((entry) => entry.username === candidate)) {
    candidate = `${base.slice(0, 24)}.${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function makeClientUsername(store, name, email) {
  const cleanPart = function (value) {
    return normalizeUsername(String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.')).replace(/^\.+|\.+$/g, '');
  };
  const emailPrefix = cleanPart(String(email || '').split('@')[0] || '');
  const namePrefix = cleanPart(name);
  const rawBase = emailPrefix || namePrefix || `client.${Date.now()}`;
  const base = (rawBase.length >= 3 ? rawBase : `client.${rawBase}`).slice(0, 28);
  let candidate = base;
  let suffix = 1;
  while (store.users.some((entry) => entry.username === candidate)) {
    candidate = `${base.slice(0, 24)}.${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function makeTemporaryPassword() {
  return `Patient${randomBytes(4).toString('hex')}A1`;
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

function normalizeCaseNextcloudShare(input) {
  if (!input || typeof input !== 'object') return null;
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    folder: String(input.folder || '').trim(),
    createdAt: String(input.createdAt || new Date().toISOString()).trim(),
    studyCount: Number(input.studyCount) || 0,
    reportCount: Number(input.reportCount) || 0,
    dicomExported: Number(input.dicomExported) || 0,
  };
}

function normalizeSoapNotes(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    subjective: String(input.subjective || '').trim(),
    objective: String(input.objective || '').trim(),
    assessment: String(input.assessment || '').trim(),
    plan: String(input.plan || '').trim(),
  };
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

function refreshSessionRecord(store, session) {
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  writeStore(store);
}

function requireAuth(store, req, res) {
  const user = getAuthenticatedUser(store, req);
  if (!user) {
    sendJson(res, 401, { error: 'Authentication required' });
    return null;
  }

  return user;
}

function isSuperAdminUser(user) {
  if (!user) return false;
  return Boolean(user.isSuperAdmin || (user.role === 'admin' && SUPER_ADMIN_EMAILS.has(normalizeEmail(user.email))));
}

function isWhiteLabelManager(user) {
  return Boolean(isSuperAdminUser(user) || user?.role === 'doctor');
}

function requireWhiteLabelManager(store, req, res) {
  const user = requireAuth(store, req, res);
  if (!user) return null;
  if (!isWhiteLabelManager(user)) {
    sendJson(res, 403, { error: 'White-label onboarding access required' });
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

function getWhiteLabelAccountMember(account, user) {
  const email = normalizeEmail(user && user.email);
  return (account.members || []).find((member) => normalizeEmail(member.email) === email) || null;
}

function canManageWhiteLabelAccount(user, account) {
  if (isSuperAdminUser(user)) return true;
  if (!account || user?.role !== 'doctor') return false;
  if (normalizeEmail(account.ownerEmail) === normalizeEmail(user.email)) return true;
  if (normalizeEmail(account.primaryDoctorEmail) === normalizeEmail(user.email)) return true;
  const member = getWhiteLabelAccountMember(account, user);
  return Boolean(member && ['owner', 'admin'].includes(normalizeAccessLevel(member.accessLevel)));
}

function filterVisibleWhiteLabelAccounts(accounts, user) {
  if (isSuperAdminUser(user)) return accounts || [];
  return (accounts || []).filter((account) => canManageWhiteLabelAccount(user, account));
}

function findWhiteLabelAccount(store, accountId) {
  return (store.whiteLabelAccounts || []).find((account) => account.id === accountId);
}

function findWhiteLabelSignupInvite(store, token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return null;
  return (store.whiteLabelSignupInvites || []).find((invite) => invite.token === cleanToken) || null;
}

function isWhiteLabelSignupInviteUsable(invite) {
  if (!invite) return false;
  if (String(invite.status || 'active') !== 'active') return false;
  if (invite.usedAt) return false;
  const expiresAt = new Date(invite.expiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function createWhiteLabelSignupInvite(body, actor) {
  const recipientEmail = normalizeEmail(body.recipientEmail || body.email);
  if (!recipientEmail) {
    throw new Error('Recipient email is required.');
  }
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + WHITE_LABEL_SIGNUP_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  return {
    id: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    recipientEmail,
    recipientName: String(body.recipientName || body.name || '').trim(),
    organizationName: String(body.organizationName || body.accountName || '').trim(),
    status: 'active',
    createdByEmail: normalizeEmail(actor && actor.email),
    createdAt,
    expiresAt,
    usedAt: null,
    accountId: null,
  };
}

function ensureUniqueWhiteLabelSlug(store, requestedSlug, currentAccountId = '') {
  const base = normalizeSlug(requestedSlug) || `account-${Date.now()}`;
  let candidate = base;
  let suffix = 2;
  while (
    (store.whiteLabelAccounts || []).some(
      (account) => account.slug === candidate && account.id !== currentAccountId
    )
  ) {
    candidate = `${base.slice(0, 54)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeWhiteLabelAccountPayload(store, body, existing = null, actor = null) {
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) {
    throw new Error('Account name is required.');
  }

  let primaryDoctorEmail = normalizeEmail(body.primaryDoctorEmail ?? existing?.primaryDoctorEmail ?? '');
  if (!isSuperAdminUser(actor) && actor?.role === 'doctor') {
    primaryDoctorEmail = normalizeEmail(actor.email);
  }
  let primaryDoctorName = String(body.primaryDoctorName ?? existing?.primaryDoctorName ?? '').trim();
  if (primaryDoctorEmail) {
    const doctor = store.users.find((user) => user.email === primaryDoctorEmail && user.role === 'doctor');
    if (!doctor) {
      throw new Error('Primary doctor must be an existing doctor account.');
    }
    primaryDoctorName = doctor.name;
  }

  const nextLogo =
    Object.prototype.hasOwnProperty.call(body, 'logoDataUrl') ||
    Object.prototype.hasOwnProperty.call(body, 'branding')
      ? normalizeLogoDataUrl(body.logoDataUrl ?? body.branding?.logoDataUrl ?? '')
      : existing?.branding?.logoDataUrl || null;
  const customerProfileBody = body.customerProfile || {};
  const subscriptionBody = body.subscription || {};
  const featuresBody = body.features || {};
  const onboardingBody = body.onboarding || {};

  return {
    id: existing?.id || randomUUID(),
    name,
    slug: ensureUniqueWhiteLabelSlug(store, body.slug ?? existing?.slug ?? name, existing?.id || ''),
    plan: normalizeWhiteLabelPlan(body.plan ?? existing?.plan),
    ownerEmail: existing?.ownerEmail || normalizeEmail(actor?.email) || null,
    ownerName: existing?.ownerName || String(actor?.name || '').trim() || null,
    status: ['active', 'paused', 'draft'].includes(String(body.status || existing?.status || '').toLowerCase())
      ? String(body.status || existing?.status).toLowerCase()
      : 'draft',
    deploymentMode: ['shared-server', 'dedicated-clone'].includes(
      String(body.deploymentMode || existing?.deploymentMode || '').toLowerCase()
    )
      ? String(body.deploymentMode || existing?.deploymentMode).toLowerCase()
      : 'shared-server',
    primaryDoctorEmail: primaryDoctorEmail || null,
    primaryDoctorName: primaryDoctorName || null,
    branding: {
      logoDataUrl: nextLogo,
      primaryColor: normalizeHexColor(body.primaryColor ?? body.branding?.primaryColor ?? existing?.branding?.primaryColor),
      appName: String(body.appName ?? body.branding?.appName ?? existing?.branding?.appName ?? name).trim() || name,
    },
    members: Array.isArray(existing?.members) ? existing.members : [],
    dataGovernance: {
      deidentifiedExportsAllowed: Boolean(
        body.deidentifiedExportsAllowed ?? existing?.dataGovernance?.deidentifiedExportsAllowed
      ),
      identifiableDataSaleAllowed: false,
      notes: String(body.dataGovernanceNotes ?? body.dataGovernance?.notes ?? existing?.dataGovernance?.notes ?? '').trim(),
    },
    customerProfile: {
      legalName: String(customerProfileBody.legalName ?? existing?.customerProfile?.legalName ?? name).trim(),
      contactName: String(customerProfileBody.contactName ?? existing?.customerProfile?.contactName ?? '').trim(),
      contactEmail: normalizeEmail(customerProfileBody.contactEmail ?? existing?.customerProfile?.contactEmail ?? ''),
      contactPhone: String(customerProfileBody.contactPhone ?? existing?.customerProfile?.contactPhone ?? '').trim(),
      billingEmail: normalizeEmail(customerProfileBody.billingEmail ?? existing?.customerProfile?.billingEmail ?? ''),
      serviceAddress: String(customerProfileBody.serviceAddress ?? existing?.customerProfile?.serviceAddress ?? '').trim(),
    },
    subscription: {
      billingStatus: normalizeEnum(
        subscriptionBody.billingStatus ?? existing?.subscription?.billingStatus,
        WHITE_LABEL_BILLING_STATUSES,
        'trial'
      ),
      monthlyPrice: normalizeMonthlyPrice(subscriptionBody.monthlyPrice, existing?.subscription?.monthlyPrice || ''),
      pricePerDoctorMonthly: normalizeMonthlyPrice(
        subscriptionBody.pricePerDoctorMonthly,
        existing?.subscription?.pricePerDoctorMonthly || ''
      ),
      doctorSeats: normalizeDoctorSeatCount(subscriptionBody.doctorSeats, existing?.subscription?.doctorSeats || 1),
      paymentSetupUrl: String(subscriptionBody.paymentSetupUrl ?? existing?.subscription?.paymentSetupUrl ?? '').trim(),
      trialEndsAt: normalizeOptionalDate(subscriptionBody.trialEndsAt ?? existing?.subscription?.trialEndsAt),
      contractSignedAt: normalizeOptionalDate(subscriptionBody.contractSignedAt ?? existing?.subscription?.contractSignedAt),
    },
    features: {
      reportGeneration: Boolean(featuresBody.reportGeneration ?? existing?.features?.reportGeneration ?? true),
      soapNotes: Boolean(featuresBody.soapNotes ?? existing?.features?.soapNotes ?? true),
      nextcloudReports: Boolean(featuresBody.nextcloudReports ?? existing?.features?.nextcloudReports ?? true),
      customBranding: Boolean(featuresBody.customBranding ?? existing?.features?.customBranding ?? true),
      delegatedAccess: Boolean(featuresBody.delegatedAccess ?? existing?.features?.delegatedAccess ?? true),
      videoConsults: Boolean(featuresBody.videoConsults ?? existing?.features?.videoConsults ?? false),
      patientPortal: Boolean(featuresBody.patientPortal ?? existing?.features?.patientPortal ?? false),
      governedDataExports: Boolean(
        featuresBody.governedDataExports ??
          existing?.features?.governedDataExports ??
          body.deidentifiedExportsAllowed ??
          false
      ),
    },
    onboarding: {
      launchStatus: normalizeEnum(
        onboardingBody.launchStatus ?? existing?.onboarding?.launchStatus,
        WHITE_LABEL_LAUNCH_STATUSES,
        'draft'
      ),
      brandingComplete: Boolean(onboardingBody.brandingComplete ?? existing?.onboarding?.brandingComplete ?? Boolean(nextLogo)),
      primaryDoctorAssigned: Boolean(
        onboardingBody.primaryDoctorAssigned ?? existing?.onboarding?.primaryDoctorAssigned ?? Boolean(primaryDoctorEmail)
      ),
      usersInvited: Boolean(onboardingBody.usersInvited ?? existing?.onboarding?.usersInvited ?? Boolean(existing?.members?.length)),
      nextcloudProvisioned: Boolean(onboardingBody.nextcloudProvisioned ?? existing?.onboarding?.nextcloudProvisioned ?? true),
      reportTemplatesConfigured: Boolean(
        onboardingBody.reportTemplatesConfigured ?? existing?.onboarding?.reportTemplatesConfigured ?? false
      ),
      customDomainConfigured: Boolean(
        onboardingBody.customDomainConfigured ??
          existing?.onboarding?.customDomainConfigured ??
          Boolean(body.clonePlan?.customDomain || existing?.clonePlan?.customDomain)
      ),
      billingConfigured: Boolean(onboardingBody.billingConfigured ?? existing?.onboarding?.billingConfigured ?? false),
      complianceAcknowledged: Boolean(
        onboardingBody.complianceAcknowledged ?? existing?.onboarding?.complianceAcknowledged ?? false
      ),
      notes: String(onboardingBody.notes ?? existing?.onboarding?.notes ?? '').trim(),
    },
    clonePlan: {
      isolatedAuthStore: Boolean(body.clonePlan?.isolatedAuthStore ?? existing?.clonePlan?.isolatedAuthStore ?? true),
      isolatedPacsStore: Boolean(body.clonePlan?.isolatedPacsStore ?? existing?.clonePlan?.isolatedPacsStore ?? true),
      isolatedNextcloudFolder: Boolean(
        body.clonePlan?.isolatedNextcloudFolder ?? existing?.clonePlan?.isolatedNextcloudFolder ?? true
      ),
      tenantScopedSharedInfra: Boolean(body.clonePlan?.tenantScopedSharedInfra ?? existing?.clonePlan?.tenantScopedSharedInfra ?? true),
      customDomain: String(body.clonePlan?.customDomain ?? existing?.clonePlan?.customDomain ?? '').trim(),
    },
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function createWhiteLabelAccountFromSignup(store, invite, body) {
  const organizationName = String(body.organizationName || invite.organizationName || '').trim();
  const contactName = String(body.contactName || invite.recipientName || '').trim();
  const contactEmail = normalizeEmail(body.contactEmail || invite.recipientEmail);
  const billingEmail = normalizeEmail(body.billingEmail || contactEmail);
  const password = String(body.password || '');
  const username = normalizeUsername(body.username || contactEmail.split('@')[0]);
  const plan = normalizeWhiteLabelPlan(body.plan);
  const doctorSeats = normalizeDoctorSeatCount(body.doctorSeats, 1);
  const monthlyPrice = calculateWhiteLabelMonthlyPrice(plan, doctorSeats);
  const pricePerDoctorMonthly = getWhiteLabelPlanPricing(plan).pricePerDoctorMonthly;

  if (!organizationName || !contactName || !contactEmail || !billingEmail) {
    throw new Error('Organization, contact, and billing details are required.');
  }

  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);

  if (store.users.some((entry) => normalizeEmail(entry.email) === contactEmail)) {
    throw new Error('A user with this email already exists.');
  }
  if (store.users.some((entry) => normalizeUsername(entry.username) === username)) {
    throw new Error('A user with this username already exists.');
  }

  const account = normalizeWhiteLabelAccountPayload(
    store,
    {
      name: organizationName,
      slug: organizationName,
      status: 'draft',
      deploymentMode: 'shared-server',
      plan,
      primaryDoctorEmail: null,
      appName: organizationName,
      customerProfile: {
        legalName: organizationName,
        contactName,
        contactEmail,
        contactPhone: String(body.contactPhone || '').trim(),
        billingEmail,
        serviceAddress: String(body.serviceAddress || '').trim(),
      },
      subscription: {
        billingStatus: 'pending_payment',
        monthlyPrice: String(monthlyPrice),
        pricePerDoctorMonthly: String(pricePerDoctorMonthly),
        doctorSeats,
        paymentSetupUrl: '',
        paymentProvider: WHITE_LABEL_PAYMENT_SETUP_URL ? 'wordpress' : '',
      },
      onboarding: {
        launchStatus: 'setup',
        billingConfigured: Boolean(WHITE_LABEL_PAYMENT_SETUP_URL),
        complianceAcknowledged: Boolean(body.complianceAcknowledged),
      },
    },
    null,
    null
  );

  const createdAt = nowIso();
  const user = {
    username,
    email: contactEmail,
    name: contactName,
    role: 'doctor',
    status: 'active',
    isSuperAdmin: false,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactor: {
      enabled: false,
      verifiedAt: null,
      method: 'email',
      email: contactEmail,
      lastChallengeAt: null,
      disabledAt: null,
    },
    twoFactorChallenges: [],
    passwordHash: hashPassword(password),
    createdAt,
    lastLoginAt: null,
    whiteLabelAccountIds: [],
    primaryWhiteLabelAccountId: null,
  };

  account.ownerEmail = contactEmail;
  account.ownerName = contactName;
  account.primaryDoctorEmail = contactEmail;
  account.primaryDoctorName = contactName;
  account.members = [
    {
      email: contactEmail,
      name: contactName,
      role: 'doctor',
      accessLevel: 'owner',
      invitedByEmail: invite.createdByEmail || '',
      createdAt,
    },
  ];

  attachWhiteLabelAccountToUser(user, account.id);
  account.onboarding.primaryDoctorAssigned = true;
  account.onboarding.usersInvited = true;
  account.subscription.paymentSetupUrl = buildWhiteLabelPaymentSetupUrl(account);
  account.updatedAt = nowIso();

  store.users.push(user);
  store.whiteLabelAccounts = store.whiteLabelAccounts || [];
  store.whiteLabelAccounts.push(account);
  invite.status = 'used';
  invite.usedAt = nowIso();
  invite.accountId = account.id;

  return { account, user };
}

function applyWhiteLabelPaymentCallback(store, body) {
  if (!WHITE_LABEL_PAYMENT_CALLBACK_SECRET) {
    throw new Error('Payment callback secret is not configured.');
  }
  const providedSecret = String(body.secret || body.callbackSecret || '').trim();
  if (providedSecret !== WHITE_LABEL_PAYMENT_CALLBACK_SECRET) {
    throw new Error('Invalid payment callback secret.');
  }

  const accountId = String(body.accountId || body.account_id || body.tenantId || body.tenant_id || '').trim();
  const account = findWhiteLabelAccount(store, accountId);
  if (!account) {
    throw new Error('White-label account not found.');
  }

  const status = normalizeEnum(
    body.billingStatus || body.billing_status || body.status,
    WHITE_LABEL_BILLING_STATUSES,
    'active'
  );
  const paidAt = String(body.paidAt || body.paid_at || nowIso()).trim();
  account.subscription = {
    ...(account.subscription || {}),
    billingStatus: status,
    paymentProvider: 'wordpress',
    wordpressPaymentId: String(body.paymentId || body.payment_id || body.orderId || body.order_id || '').trim(),
    paidAt,
  };
  account.onboarding = {
    ...(account.onboarding || {}),
    billingConfigured: status === 'active' || Boolean(account.onboarding && account.onboarding.billingConfigured),
    launchStatus: status === 'active' ? 'ready' : account.onboarding?.launchStatus || 'setup',
  };
  account.updatedAt = nowIso();
  return account;
}

function attachWhiteLabelAccountToUser(user, accountId) {
  const currentIds = Array.isArray(user.whiteLabelAccountIds) ? user.whiteLabelAccountIds : [];
  user.whiteLabelAccountIds = [...new Set([...currentIds, accountId])];
  user.primaryWhiteLabelAccountId = user.primaryWhiteLabelAccountId || accountId;
}

function detachWhiteLabelAccountFromUser(user, accountId) {
  const nextIds = (Array.isArray(user.whiteLabelAccountIds) ? user.whiteLabelAccountIds : []).filter(
    (id) => id !== accountId
  );
  user.whiteLabelAccountIds = nextIds;
  if (user.primaryWhiteLabelAccountId === accountId) {
    user.primaryWhiteLabelAccountId = nextIds[0] || null;
  }
}

function getAssignableWhiteLabelAccessLevel(actor, requestedAccessLevel) {
  const accessLevel = normalizeAccessLevel(requestedAccessLevel);
  if (isSuperAdminUser(actor)) return accessLevel;
  if (accessLevel === 'owner' || accessLevel === 'admin') return 'viewer';
  return accessLevel;
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

  const whiteLabelSignupMatch = url.pathname.match(/^\/white-label\/signup\/([^/]+)$/);
  if (req.method === 'GET' && whiteLabelSignupMatch) {
    const invite = findWhiteLabelSignupInvite(store, decodeURIComponent(whiteLabelSignupMatch[1]));
    if (!isWhiteLabelSignupInviteUsable(invite)) {
      sendJson(res, 404, { error: 'This signup link is invalid, expired, or already used.' });
      return;
    }
    sendJson(res, 200, createPublicWhiteLabelEnrollment(invite));
    return;
  }

  if (req.method === 'POST' && whiteLabelSignupMatch) {
    try {
      const invite = findWhiteLabelSignupInvite(store, decodeURIComponent(whiteLabelSignupMatch[1]));
      if (!isWhiteLabelSignupInviteUsable(invite)) {
        sendJson(res, 404, { error: 'This signup link is invalid, expired, or already used.' });
        return;
      }
      const body = await readJsonBody(req);
      const result = createWhiteLabelAccountFromSignup(store, invite, body);
      const session = makeSessionForUser(store, result.user);
      writeStore(store);
      sendJson(
        res,
        201,
        {
          account: createPublicWhiteLabelAccount(result.account),
          user: createPublicUser(result.user),
          paymentSetupUrl: result.account.subscription.paymentSetupUrl || '',
        },
        [makeSessionCookie(session.id)]
      );
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid signup request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/white-label/payment-callback') {
    try {
      const body = await readJsonBody(req);
      const account = applyWhiteLabelPaymentCallback(store, body);
      writeStore(store);
      sendJson(res, 200, { ok: true, account: createPublicWhiteLabelAccount(account) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid payment callback';
      const statusCode = message.includes('secret') ? 403 : 400;
      sendJson(res, statusCode, { error: message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/session') {
    const session = getSessionRecord(store, req);
    if (!session) {
      sendJson(res, 401, { error: 'No active session' }, [clearSessionCookie()]);
      return;
    }

    const user = store.users.find((entry) => entry.email === session.email);
    if (!user || user.status !== 'active') {
      sendJson(res, 401, { error: 'No active session' }, [clearSessionCookie()]);
      return;
    }

    refreshSessionRecord(store, session);
    sendJson(res, 200, { user: createPublicUser(user) }, [makeSessionCookie(session.id)]);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    try {
      const body = await readJsonBody(req);
      const identifier = normalizeUsername(body.username || body.email);
      const password = String(body.password || '');
      if (!enforceRateLimit(req, res, 'auth.login', identifier, AUTH_LOGIN_RATE_LIMIT_MAX, AUTH_LOGIN_RATE_LIMIT_WINDOW_MS)) {
        return;
      }
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

      const twoFactor = getUserTwoFactorSettings(user);
      if (TWO_FACTOR_AUTH_ENABLED && twoFactor.enabled) {
        if (twoFactor.method === 'totp') {
          if (!verifyTotp(user.twoFactorSecret, String(body.twoFactorCode || ''))) {
            sendJson(res, 401, { error: 'A valid 2FA code is required' });
            return;
          }
        } else {
          requireTwoFactorEmailReady();
          if (!enforceRateLimit(req, res, 'auth.2fa.login.send', user.email, TWO_FACTOR_SEND_RATE_LIMIT_MAX, TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS)) {
            return;
          }
          const pending = createTwoFactorChallenge(user, 'login');
          writeStore(store);
          await sendTwoFactorEmail(pending.challenge.email, pending.code, 'login');
          sendJson(res, 202, {
            twoFactorRequired: true,
            challengeId: pending.challenge.id,
            expiresAt: pending.challenge.expiresAt,
            method: pending.challenge.method,
            email: pending.challenge.email,
          });
          return;
        }
      }

      const session = makeSessionForUser(store, user);
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

  if (req.method === 'GET' && url.pathname === '/auth/2fa/status') {
    const user = requireAuth(store, req, res);
    if (!user) return;
    sendJson(res, 200, { twoFactor: getTwoFactorStatus(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/2fa/setup/start') {
    const user = requireAuth(store, req, res);
    if (!user) return;
    try {
      requireTwoFactorEmailReady();
      if (!enforceRateLimit(req, res, 'auth.2fa.setup.send', user.email, TWO_FACTOR_SEND_RATE_LIMIT_MAX, TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS)) {
        return;
      }
      const pending = createTwoFactorChallenge(user, 'setup');
      writeStore(store);
      await sendTwoFactorEmail(pending.challenge.email, pending.code, 'setup');
      sendJson(res, 202, {
        challengeId: pending.challenge.id,
        expiresAt: pending.challenge.expiresAt,
        method: pending.challenge.method,
        email: pending.challenge.email,
      });
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : 'Two-factor setup failed' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/2fa/setup/verify') {
    const user = requireAuth(store, req, res);
    if (!user) return;
    try {
      requireTwoFactorFrameworkReady();
      const body = await readJsonBody(req);
      if (!enforceRateLimit(req, res, 'auth.2fa.setup.verify', `${user.email}:${body.challengeId || body.challenge_id}`, TWO_FACTOR_VERIFY_RATE_LIMIT_MAX, TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS)) {
        return;
      }
      const challenge = verifyTwoFactorChallenge(user, body.challengeId || body.challenge_id, body.code, 'setup');
      user.twoFactor = {
        ...getUserTwoFactorSettings(user),
        enabled: true,
        verifiedAt: nowIso(),
        method: 'email',
        email: normalizeEmail(challenge.email),
        disabledAt: null,
      };
      user.twoFactorEnabled = true;
      user.twoFactorSecret = null;
      writeStore(store);
      sendJson(res, 200, { user: createPublicUser(user), twoFactor: getTwoFactorStatus(user) });
    } catch (error) {
      writeStore(store);
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not verify two-factor code' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/2fa/disable/start') {
    const user = requireAuth(store, req, res);
    if (!user) return;
    try {
      requireTwoFactorEmailReady();
      if (!enforceRateLimit(req, res, 'auth.2fa.disable.send', user.email, TWO_FACTOR_SEND_RATE_LIMIT_MAX, TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS)) {
        return;
      }
      if (!getUserTwoFactorSettings(user).enabled) {
        sendJson(res, 409, { error: 'Two-factor authentication is not enabled for this account' });
        return;
      }
      const pending = createTwoFactorChallenge(user, 'disable');
      writeStore(store);
      await sendTwoFactorEmail(pending.challenge.email, pending.code, 'disable');
      sendJson(res, 202, {
        challengeId: pending.challenge.id,
        expiresAt: pending.challenge.expiresAt,
        method: pending.challenge.method,
        email: pending.challenge.email,
      });
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : 'Could not send two-factor code' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/2fa/disable') {
    const user = requireAuth(store, req, res);
    if (!user) return;
    try {
      requireTwoFactorFrameworkReady();
      const body = await readJsonBody(req);
      if (!enforceRateLimit(req, res, 'auth.2fa.disable.verify', `${user.email}:${body.challengeId || body.challenge_id}`, TWO_FACTOR_VERIFY_RATE_LIMIT_MAX, TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS)) {
        return;
      }
      verifyTwoFactorChallenge(user, body.challengeId || body.challenge_id, body.code, 'disable');
      user.twoFactor = {
        ...getUserTwoFactorSettings(user),
        enabled: false,
        disabledAt: nowIso(),
      };
      user.twoFactorEnabled = false;
      user.twoFactorSecret = null;
      writeStore(store);
      sendJson(res, 200, { user: createPublicUser(user), twoFactor: getTwoFactorStatus(user) });
    } catch (error) {
      writeStore(store);
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not disable two-factor authentication' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/2fa/challenge/verify') {
    try {
      requireTwoFactorFrameworkReady();
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      if (!enforceRateLimit(req, res, 'auth.2fa.login.verify', `${email}:${body.challengeId || body.challenge_id}`, TWO_FACTOR_VERIFY_RATE_LIMIT_MAX, TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS)) {
        return;
      }
      const user = store.users.find((entry) => normalizeEmail(entry.email) === email);
      if (!user || user.status !== 'active') {
        sendJson(res, 404, { error: 'Two-factor challenge was not found or has expired.' });
        return;
      }
      verifyTwoFactorChallenge(user, body.challengeId || body.challenge_id, body.code, 'login');
      const session = makeSessionForUser(store, user);
      writeStore(store);
      sendJson(res, 200, { user: createPublicUser(user) }, [makeSessionCookie(session.id)]);
    } catch (error) {
      writeStore(store);
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not verify two-factor code' });
    }
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

      const user = {
        username,
        email,
        name,
        role,
        status: 'active',
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactor: {
          enabled: false,
          verifiedAt: null,
          method: 'email',
          email,
          lastChallengeAt: null,
          disabledAt: null,
        },
        twoFactorChallenges: [],
        passwordHash: hashPassword(password),
        createdAt: nowIso(),
        lastLoginAt: null,
      };

      store.users.push(user);
      writeStore(store);
      sendJson(res, 201, {
        user: createPublicUser(user),
        twoFactorSetup: null,
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/white-label/accounts') {
    const manager = requireWhiteLabelManager(store, req, res);
    if (!manager) return;
    const accounts = filterVisibleWhiteLabelAccounts(store.whiteLabelAccounts || [], manager);
    const visibleUserEmails = new Set(
      accounts.flatMap((account) => (account.members || []).map((member) => normalizeEmail(member.email)))
    );
    visibleUserEmails.add(normalizeEmail(manager.email));
    sendJson(res, 200, {
      accounts: accounts.map(createPublicWhiteLabelAccount),
      doctors: store.users
        .filter((user) => user.role === 'doctor' && (isSuperAdminUser(manager) || normalizeEmail(user.email) === normalizeEmail(manager.email)))
        .map(createPublicUser),
      users: store.users
        .filter((user) => isSuperAdminUser(manager) || visibleUserEmails.has(normalizeEmail(user.email)))
        .map(createPublicUser),
      signupInvites: isSuperAdminUser(manager)
        ? (store.whiteLabelSignupInvites || []).map(createPublicWhiteLabelSignupInvite)
        : [],
      signupPlans: getWhiteLabelSignupPlans(),
      customQuoteEmail: WHITE_LABEL_OPERATIONS_EMAIL,
      isSuperAdmin: isSuperAdminUser(manager),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/white-label/signup-invites') {
    const manager = requireWhiteLabelManager(store, req, res);
    if (!manager) return;
    if (!isSuperAdminUser(manager)) {
      sendJson(res, 403, { error: 'Only OCTELERAD admins can create private signup links.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const invite = createWhiteLabelSignupInvite(body, manager);
      store.whiteLabelSignupInvites = store.whiteLabelSignupInvites || [];
      store.whiteLabelSignupInvites.push(invite);
      writeStore(store);
      sendJson(res, 201, {
        invite: createPublicWhiteLabelSignupInvite(invite),
        plans: getWhiteLabelSignupPlans(),
        customQuoteEmail: WHITE_LABEL_OPERATIONS_EMAIL,
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid invite request' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/white-label/my-account') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    const accountIds = Array.isArray(user.whiteLabelAccountIds) ? user.whiteLabelAccountIds : [];
    const preferredAccountId = user.primaryWhiteLabelAccountId || accountIds[0] || '';
    const account =
      (preferredAccountId && findWhiteLabelAccount(store, preferredAccountId)) ||
      (store.whiteLabelAccounts || []).find((entry) =>
        (entry.members || []).some((member) => normalizeEmail(member.email) === normalizeEmail(user.email))
      ) ||
      null;

    if (!account) {
      sendJson(res, 200, { account: null });
      return;
    }

    const isMember = (account.members || []).some(
      (member) => normalizeEmail(member.email) === normalizeEmail(user.email)
    );
    if (!isSuperAdminUser(user) && !isMember) {
      sendJson(res, 403, { error: 'You do not have access to this white-label account' });
      return;
    }

    sendJson(res, 200, { account: createPublicWhiteLabelAccount(account) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/white-label/accounts') {
    const manager = requireWhiteLabelManager(store, req, res);
    if (!manager) return;

    try {
      const body = await readJsonBody(req);
      const account = normalizeWhiteLabelAccountPayload(store, body, null, manager);
      account.members = [
        {
          email: normalizeEmail(manager.email),
          name: manager.name,
          role: manager.role,
          accessLevel: 'owner',
          invitedByEmail: normalizeEmail(manager.email),
          createdAt: nowIso(),
        },
      ];
      attachWhiteLabelAccountToUser(manager, account.id);
      store.whiteLabelAccounts = store.whiteLabelAccounts || [];
      store.whiteLabelAccounts.push(account);
      writeStore(store);
      sendJson(res, 201, { account: createPublicWhiteLabelAccount(account) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const whiteLabelAccountMatch = url.pathname.match(/^\/white-label\/accounts\/([^/]+)$/);
  if (req.method === 'PATCH' && whiteLabelAccountMatch) {
    const manager = requireWhiteLabelManager(store, req, res);
    if (!manager) return;

    try {
      const accountId = decodeURIComponent(whiteLabelAccountMatch[1]);
      const account = findWhiteLabelAccount(store, accountId);
      if (!account) {
        sendJson(res, 404, { error: 'White-label account not found' });
        return;
      }
      if (!canManageWhiteLabelAccount(manager, account)) {
        sendJson(res, 403, { error: 'You do not have access to this white-label account' });
        return;
      }
      const body = await readJsonBody(req);
      const updated = normalizeWhiteLabelAccountPayload(store, body, account, manager);
      Object.assign(account, updated);
      writeStore(store);
      sendJson(res, 200, { account: createPublicWhiteLabelAccount(account) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const whiteLabelMemberMatch = url.pathname.match(/^\/white-label\/accounts\/([^/]+)\/members$/);
  if (req.method === 'POST' && whiteLabelMemberMatch) {
    const manager = requireWhiteLabelManager(store, req, res);
    if (!manager) return;

    try {
      const accountId = decodeURIComponent(whiteLabelMemberMatch[1]);
      const account = findWhiteLabelAccount(store, accountId);
      if (!account) {
        sendJson(res, 404, { error: 'White-label account not found' });
        return;
      }
      if (!canManageWhiteLabelAccount(manager, account)) {
        sendJson(res, 403, { error: 'You do not have access to this white-label account' });
        return;
      }

      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const name = String(body.name || '').trim();
      const username = normalizeUsername(body.username || email.split('@')[0]);
      const role = String(body.role || 'clinic').trim().toLowerCase();
      const accessLevel = getAssignableWhiteLabelAccessLevel(manager, body.accessLevel);
      let user = store.users.find((entry) => entry.email === email);

      if (!email || !['doctor', 'patient', 'clinic'].includes(role)) {
        sendJson(res, 400, { error: 'A valid email and role are required' });
        return;
      }

      if (!user) {
        const password = String(body.password || '');
        if (!name || !username || !password) {
          sendJson(res, 400, { error: 'New delegated users require name, username, and password' });
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

        if (store.users.some((entry) => entry.username === username)) {
          sendJson(res, 409, { error: 'A user with this username already exists' });
          return;
        }

        user = {
          username,
          email,
          name,
          role,
          status: 'active',
          twoFactorEnabled: false,
          twoFactorSecret: null,
          passwordHash: hashPassword(password),
          createdAt: nowIso(),
          lastLoginAt: null,
          whiteLabelAccountIds: [],
          primaryWhiteLabelAccountId: null,
        };
        store.users.push(user);
      }

      attachWhiteLabelAccountToUser(user, account.id);
      account.members = (account.members || []).filter((member) => member.email !== email);
      account.members.push({
        email: user.email,
        name: user.name,
        role: user.role,
        accessLevel,
        invitedByEmail: manager.email,
        createdAt: nowIso(),
      });
      account.updatedAt = nowIso();
      writeStore(store);
      sendJson(res, 200, {
        account: createPublicWhiteLabelAccount(account),
        user: createPublicUser(user),
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const whiteLabelMemberRemoveMatch = url.pathname.match(
    /^\/white-label\/accounts\/([^/]+)\/members\/remove$/
  );
  if (req.method === 'POST' && whiteLabelMemberRemoveMatch) {
    const manager = requireWhiteLabelManager(store, req, res);
    if (!manager) return;

    try {
      const accountId = decodeURIComponent(whiteLabelMemberRemoveMatch[1]);
      const account = findWhiteLabelAccount(store, accountId);
      if (!account) {
        sendJson(res, 404, { error: 'White-label account not found' });
        return;
      }
      if (!canManageWhiteLabelAccount(manager, account)) {
        sendJson(res, 403, { error: 'You do not have access to this white-label account' });
        return;
      }
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      account.members = (account.members || []).filter((member) => member.email !== email);
      const user = store.users.find((entry) => entry.email === email);
      if (user) detachWhiteLabelAccountFromUser(user, account.id);
      account.updatedAt = nowIso();
      writeStore(store);
      sendJson(res, 200, { account: createPublicWhiteLabelAccount(account) });
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

  if (req.method === 'GET' && url.pathname === '/care/clients') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    if (!['admin', 'doctor', 'clinic'].includes(user.role)) {
      sendJson(res, 403, { error: 'Doctor, admin, or clinic access required' });
      return;
    }

    const clients = store.users
      .filter((entry) => entry.role === 'clinic')
      .map((entry) => createPublicUser(entry))
      .sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, { clients });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/care/clients') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    if (!['admin', 'doctor', 'clinic'].includes(user.role)) {
      sendJson(res, 403, { error: 'Doctor, admin, or clinic access required' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const requestedUsername = normalizeUsername(body.username || '');
      const password = String(body.password || '').trim() || makeTemporaryPassword();

      if (!name || !email) {
        sendJson(res, 400, { error: 'Client name and email are required' });
        return;
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        sendJson(res, 400, { error: passwordError });
        return;
      }

      if (store.users.some((entry) => entry.email === email)) {
        sendJson(res, 409, { error: 'A client or user with this email already exists' });
        return;
      }

      const username = requestedUsername || makeClientUsername(store, name, email);
      const usernameError = validateUsername(username);
      if (usernameError) {
        sendJson(res, 400, { error: usernameError });
        return;
      }

      if (store.users.some((entry) => entry.username === username)) {
        sendJson(res, 409, { error: 'A user with this username already exists' });
        return;
      }

      const client = {
        username,
        email,
        name,
        role: 'clinic',
        status: 'active',
        twoFactorEnabled: false,
        twoFactorSecret: null,
        passwordHash: hashPassword(password),
        createdAt: nowIso(),
        lastLoginAt: null,
      };

      store.users.push(client);
      writeStore(store);
      sendJson(res, 201, {
        client: createPublicUser(client),
        temporaryPassword: password,
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/care/patients') {
    const user = requireAuth(store, req, res);
    if (!user) return;

    if (!['admin', 'doctor', 'clinic'].includes(user.role)) {
      sendJson(res, 403, { error: 'Doctor, admin, or clinic access required' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const requestedUsername = normalizeUsername(body.username || '');
      const password = String(body.password || '').trim() || makeTemporaryPassword();

      if (!name || !email) {
        sendJson(res, 400, { error: 'Patient name and email are required' });
        return;
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        sendJson(res, 400, { error: passwordError });
        return;
      }

      if (store.users.some((entry) => entry.email === email)) {
        sendJson(res, 409, { error: 'A patient or user with this email already exists' });
        return;
      }

      const username = requestedUsername || makePatientUsername(store, name, email);
      const usernameError = validateUsername(username);
      if (usernameError) {
        sendJson(res, 400, { error: usernameError });
        return;
      }

      if (store.users.some((entry) => entry.username === username)) {
        sendJson(res, 409, { error: 'A user with this username already exists' });
        return;
      }

      const patient = {
        username,
        email,
        name,
        role: 'patient',
        status: 'active',
        twoFactorEnabled: false,
        twoFactorSecret: null,
        passwordHash: hashPassword(password),
        createdAt: nowIso(),
        lastLoginAt: null,
      };

      store.users.push(patient);
      writeStore(store);
      sendJson(res, 201, {
        patient: createPatientSummary(store, patient),
        temporaryPassword: password,
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  const patientStatusMatch = url.pathname.match(/^\/care\/patients\/(.+)\/status$/);
  if (req.method === 'PATCH' && patientStatusMatch) {
    const user = requireAuth(store, req, res);
    if (!user) return;

    if (!['admin', 'doctor', 'clinic'].includes(user.role)) {
      sendJson(res, 403, { error: 'Doctor, admin, or clinic access required' });
      return;
    }

    try {
      const patientEmail = normalizeEmail(decodeURIComponent(patientStatusMatch[1]));
      const body = await readJsonBody(req);
      const status = String(body.status || '');
      const patient = store.users.find((entry) => entry.email === patientEmail && entry.role === 'patient');

      if (!patient) {
        sendJson(res, 404, { error: 'Patient account not found' });
        return;
      }

      if (!['active', 'suspended'].includes(status)) {
        sendJson(res, 400, { error: 'status must be active or suspended' });
        return;
      }

      patient.status = status;
      writeStore(store);
      sendJson(res, 200, { patient: createPatientSummary(store, patient) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
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
      const soapNotes = normalizeSoapNotes(body.soapNotes);
      const studyStack = normalizeCaseStudyStack(body.studyStack);
      const priorReports = normalizeCasePriorReports(body.priorReports);
      const nextcloudShare = normalizeCaseNextcloudShare(body.nextcloudShare);
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
        soapNotes,
        status: 'new',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        patientEmail: patient.email,
        patientName: patient.name,
        doctorEmail: user.email,
        doctorName: user.name,
        studyStack,
        priorReports,
        nextcloudShare,
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
