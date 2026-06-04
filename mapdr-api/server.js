const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const {
  buildCasePresentationCases,
  buildCaseStreamPresentationManifest,
} = require('./lib/caseStreamPresentation');
const {
  sortDicomSeries,
  sortDicomInstances,
} = require('./lib/dicomOrdering');
const {
  buildExternalPacsViewerUrl,
  buildOhifStudyViewerUrl,
} = require('./viewer-url');
let PgPool = null;
try {
  ({ Pool: PgPool } = require('pg'));
} catch (_) {
  PgPool = null;
}

const app = express();

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3001);
const HOST = sanitizeText(process.env.HOST || process.env.BIND_HOST || '127.0.0.1');
const JSON_LIMIT = process.env.JSON_LIMIT || '2mb';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15000);
const ORTHANC_UPLOAD_TIMEOUT_MS = Math.max(
  Number(process.env.ORTHANC_UPLOAD_TIMEOUT_MS || 120000),
  10000
);
const ORTHANC_UPLOAD_RETRIES = Math.min(
  Math.max(Number(process.env.ORTHANC_UPLOAD_RETRIES || 2), 0),
  5
);
const DICOM_REDACT_TEXT_ON_UPLOAD = parseBooleanEnv(
  process.env.DICOM_REDACT_TEXT_ON_UPLOAD,
  true
);
const DICOM_TRANSFER_SYNTAX_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const DICOM_TRANSFER_SYNTAX_JPEG2000_LOSSLESS = '1.2.840.10008.1.2.4.90';
const DICOM_TRANSFER_SYNTAX_JPEG2000 = '1.2.840.10008.1.2.4.91';
const DICOM_PIXEL_REDACTION_OCR = parseBooleanEnv(process.env.DICOM_PIXEL_REDACTION_OCR, false);
const DICOM_PIXEL_REDACTION_FIXED_MASK = parseBooleanEnv(process.env.DICOM_PIXEL_REDACTION_FIXED_MASK, true);
const DICOM_PIXEL_REDACTION_OCR_BORDER_MARGIN = Math.min(
  Math.max(Number(process.env.DICOM_PIXEL_REDACTION_OCR_BORDER_MARGIN || 0.18), 0.05),
  0.35
);
const DICOM_PIXEL_REDACTION_FIXED_MASKS = sanitizeText(
  process.env.DICOM_PIXEL_REDACTION_FIXED_MASKS ||
    '0,0,1,0.12;0,0.90,1,1;0,0,0.22,0.30;0.78,0,1,0.30'
);
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 4096);
const UPLOAD_MAX_FILES = Number(process.env.UPLOAD_MAX_FILES || 2000);
const DICOM_IN_MEMORY_MAX_MB = Math.max(Number(process.env.DICOM_IN_MEMORY_MAX_MB || 64), 8);
const DICOM_UPLOAD_CONCURRENCY = Math.min(
  Math.max(Number(process.env.DICOM_UPLOAD_CONCURRENCY || 12), 1),
  16
);
const TMP_STALE_HOURS = Math.min(
  Math.max(Number(process.env.TMP_STALE_HOURS || 24), 1),
  168
);
const TMP_CLEANUP_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.TMP_CLEANUP_INTERVAL_MS || 60 * 60 * 1000), 5 * 60 * 1000),
  24 * 60 * 60 * 1000
);
const SHARE_TTL_DAYS = Number(process.env.SHARE_TTL_DAYS || 7);
const APP_BASE_URL = sanitizeText(process.env.APP_BASE_URL);
const VIEWER_LINK_MODE = sanitizeText(process.env.VIEWER_LINK_MODE || 'ohif').toLowerCase();
const OHIF_VIEWER_BASE_URL = normalizeBaseUrl(process.env.OHIF_VIEWER_BASE_URL || '');
const EXTERNAL_PACS_BASE_URL = normalizeBaseUrl(process.env.EXTERNAL_PACS_BASE_URL || '');
const EXTERNAL_PACS_WATCH_PATH = sanitizeText(process.env.EXTERNAL_PACS_WATCH_PATH || '');
const VALID_VIEWER_LINK_MODES = new Set(['ohif', 'external-pacs-watch']);

const SERVER_IP = process.env.SERVER_IP || '127.0.0.1';
const OHIF_HOST = sanitizeText(process.env.OHIF_HOST);

const ORTHANC_URL = normalizeBaseUrl(process.env.ORTHANC_URL || 'http://127.0.0.1:8042');
const ORTHANC_USERNAME = process.env.ORTHANC_USERNAME || 'admin';
const ORTHANC_PASSWORD = process.env.ORTHANC_PASSWORD || '';

const NEXTCLOUD_URL = normalizeBaseUrl(process.env.NEXTCLOUD_URL || '');
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME || '';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || '';
const NEXTCLOUD_REJECT_UNAUTHORIZED = parseBooleanEnv(
  process.env.NEXTCLOUD_REJECT_UNAUTHORIZED,
  true
);
const DELETED_STUDY_RETENTION_DAYS = Math.min(
  Math.max(Number(process.env.DELETED_STUDY_RETENTION_DAYS || 7), 1),
  365
);
const DELETED_STUDY_SWEEP_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.DELETED_STUDY_SWEEP_INTERVAL_MS || 60 * 60 * 1000), 5 * 60 * 1000),
  24 * 60 * 60 * 1000
);
const ORTHANC_DELETE_RECONCILE_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.ORTHANC_DELETE_RECONCILE_INTERVAL_MS || 15 * 60 * 1000), 60 * 1000),
  24 * 60 * 60 * 1000
);

const NEXTCLOUD_DAV =
  NEXTCLOUD_URL && NEXTCLOUD_USERNAME
    ? `${NEXTCLOUD_URL}/remote.php/dav/files/${encodeURIComponent(NEXTCLOUD_USERNAME)}`
    : '';

const ALLOWED_ORIGINS = parseCsv(process.env.CORS_ALLOWED_ORIGINS || '');

const auth = {
  username: ORTHANC_USERNAME,
  password: ORTHANC_PASSWORD,
};

const nextcloudAuth = {
  username: NEXTCLOUD_USERNAME,
  password: NEXTCLOUD_PASSWORD,
};

const DATA_FILE = path.join(__dirname, 'studies.json');
const CASE_RECORDINGS_FILE = path.join(__dirname, 'case-recordings.json');
const MEDIA_DIR = path.join(__dirname, 'media');
const TMP_DIR = path.join(__dirname, 'tmp');
const CASE_STREAM_EXPORT_DIR = path.join(MEDIA_DIR, 'case-stream-exports');
const CASE_STREAM_LIBRARY_DIR = path.join(MEDIA_DIR, 'case-stream-library');
const CASE_RECORDINGS_DIR = path.join(MEDIA_DIR, 'case-recordings');
const CASE_REPORTS_DIR = path.join(MEDIA_DIR, 'case-reports');
const CASE_STREAM_JOBS_FILE = path.join(__dirname, 'case-stream-jobs.json');
const CASE_STREAM_LIBRARY_FILE = path.join(__dirname, 'case-stream-library.json');
const LIVE_CASE_SESSIONS_FILE = path.join(__dirname, 'live-case-sessions.json');
const DICOM_REDACT_SCRIPT = path.join(__dirname, 'scripts', 'redact_dicom.py');
const DICOM_UID_ISOLATE_SCRIPT = path.join(__dirname, 'scripts', 'isolate_dicom_uids.py');
const DICOM_PREVIEW_RENDER_SCRIPT = path.join(__dirname, 'scripts', 'render_dicom_preview.py');
const CASE_STREAM_MAX_CONCURRENT = Math.min(
  Math.max(Number(process.env.CASE_STREAM_MAX_CONCURRENT || 2), 1),
  4
);
const CASE_STREAM_DICOM_FRAME_CONCURRENCY = Math.min(
  Math.max(Number(process.env.CASE_STREAM_DICOM_FRAME_CONCURRENCY || 4), 1),
  12
);
const CASE_STREAM_X264_PRESET = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
].includes(String(process.env.CASE_STREAM_X264_PRESET || '').toLowerCase())
  ? String(process.env.CASE_STREAM_X264_PRESET).toLowerCase()
  : 'veryfast';
const CASE_STREAM_X264_CRF = Math.min(
  Math.max(Number(process.env.CASE_STREAM_X264_CRF || 16), 0),
  51
);
const CASE_STREAM_DICOM_PREVIEW_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.CASE_STREAM_DICOM_PREVIEW_TIMEOUT_MS || 5000), 1000),
  HTTP_TIMEOUT_MS
);
const CASE_STREAM_DICOM_MAX_CONSECUTIVE_FRAME_FAILURES = Math.min(
  Math.max(Number(process.env.CASE_STREAM_DICOM_MAX_CONSECUTIVE_FRAME_FAILURES || 3), 1),
  10
);
const CASE_STREAM_JOB_TTL_HOURS = Math.min(
  Math.max(Number(process.env.CASE_STREAM_JOB_TTL_HOURS || 24), 1),
  168
);
const CASE_STREAM_MAX_TOTAL_DURATION_SEC = Math.min(
  Math.max(Number(process.env.CASE_STREAM_MAX_TOTAL_DURATION_SEC || 7200), 60),
  24 * 60 * 60
);
const DICOM_CONVERSION_TOKEN_TTL_MINUTES = Math.min(
  Math.max(Number(process.env.DICOM_CONVERSION_TOKEN_TTL_MINUTES || 30), 5),
  240
);
const LIVE_CASE_STALE_MS = Math.min(
  Math.max(Number(process.env.LIVE_CASE_STALE_MS || 20000), 5000),
  5 * 60 * 1000
);
const AUTH_JWT_SECRET = sanitizeText(process.env.AUTH_JWT_SECRET);
const ALLOW_HEADER_AUTH = parseBooleanEnv(process.env.ALLOW_HEADER_AUTH, true);
const HEADER_AUTH_TRUSTED_PROXIES = parseCsv(
  process.env.HEADER_AUTH_TRUSTED_PROXIES || '127.0.0.1,::1,::ffff:127.0.0.1'
);
const AUTH_SESSION_COOKIE = sanitizeText(process.env.AUTH_SESSION_COOKIE || 'mediview_session');
const AUTH_SESSION_STORE_FILE = sanitizeText(
  process.env.AUTH_SESSION_STORE_FILE ||
    path.join(__dirname, '..', 'frontend', 'mediview-portal', 'server', 'auth-api', 'data', 'store.json')
);
const ENABLE_PG_DUAL_WRITE = parseBooleanEnv(process.env.ENABLE_PG_DUAL_WRITE, false);
const ENABLE_PG_READS = parseBooleanEnv(process.env.ENABLE_PG_READS, false);
const DATABASE_URL = sanitizeText(process.env.DATABASE_URL);
const ENABLE_LIVE_FINALIZE_QUEUE = parseBooleanEnv(process.env.ENABLE_LIVE_FINALIZE_QUEUE, true);
const LIVE_FINALIZE_QUEUE_FILE = path.join(__dirname, 'live-finalize-jobs.json');
const studiesFileCache = createJsonFileCache();
const caseRecordingsFileCache = createJsonFileCache();
const liveCaseSessionsFileCache = createJsonFileCache();

const uploadLimits = {
  fileSize: UPLOAD_MAX_MB * 1024 * 1024,
  files: UPLOAD_MAX_FILES,
};

ensureDir(MEDIA_DIR);
ensureDir(TMP_DIR);
ensureDir(CASE_STREAM_EXPORT_DIR);
ensureDir(CASE_STREAM_LIBRARY_DIR);
ensureDir(CASE_RECORDINGS_DIR);
ensureDir(CASE_REPORTS_DIR);
ensureFile(DATA_FILE, '[]');
ensureFile(CASE_STREAM_JOBS_FILE, '[]');
ensureFile(CASE_STREAM_LIBRARY_FILE, '[]');
ensureFile(LIVE_CASE_SESSIONS_FILE, '[]');
ensureFile(CASE_RECORDINGS_FILE, '[]');
ensureFile(LIVE_FINALIZE_QUEUE_FILE, '[]');
cleanupStaleTmpFiles();
const tmpCleanupTimer = setInterval(cleanupStaleTmpFiles, TMP_CLEANUP_INTERVAL_MS);
if (typeof tmpCleanupTimer.unref === 'function') {
  tmpCleanupTimer.unref();
}
const deletedStudySweepTimer = setInterval(sweepExpiredDeletedStudies, DELETED_STUDY_SWEEP_INTERVAL_MS);
if (typeof deletedStudySweepTimer.unref === 'function') {
  deletedStudySweepTimer.unref();
}
const orthancDeleteReconcileTimer = setInterval(
  reconcileStudiesDeletedFromOrthanc,
  ORTHANC_DELETE_RECONCILE_INTERVAL_MS
);
if (typeof orthancDeleteReconcileTimer.unref === 'function') {
  orthancDeleteReconcileTimer.unref();
}
setTimeout(sweepExpiredDeletedStudies, 30000).unref?.();
setTimeout(reconcileStudiesDeletedFromOrthanc, 60000).unref?.();

const caseStreamJobs = new Map();
const caseStreamJobQueue = [];
let caseStreamJobsInFlight = 0;
const dicomConversionCache = new Map();
const requestMetrics = {
  started_at: nowIso(),
  total_requests: 0,
  total_errors_5xx: 0,
  routes: new Map(),
};
const pgPool = ENABLE_PG_DUAL_WRITE && PgPool && DATABASE_URL ? new PgPool({ connectionString: DATABASE_URL }) : null;
let pgStudiesTechNotesColumnReady = false;

const orthancClient = axios.create({
  baseURL: ORTHANC_URL,
  auth: auth,
  timeout: HTTP_TIMEOUT_MS,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

const nextcloudClient = axios.create({
  timeout: HTTP_TIMEOUT_MS,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  httpsAgent: new https.Agent({ rejectUnauthorized: NEXTCLOUD_REJECT_UNAUTHORIZED }),
});

const pendingNextcloudExports = new Map();

const uploadDicom = multer({
  dest: TMP_DIR,
  limits: uploadLimits,
  fileFilter: function (req, file, cb) {
    if (looksLikeDicom(file)) {
      return cb(null, true);
    }
    cb(new Error('Invalid DICOM file upload.'));
  },
});

const uploadDicomPreconvert = multer({
  dest: TMP_DIR,
  limits: uploadLimits,
});

const uploadMp4 = multer({
  dest: TMP_DIR,
  limits: { ...uploadLimits, files: 1 },
  fileFilter: function (req, file, cb) {
    if (looksLikeMp4(file)) {
      return cb(null, true);
    }
    cb(new Error('Only MP4 video files are accepted.'));
  },
});

const uploadPdf = multer({
  dest: TMP_DIR,
  limits: { ...uploadLimits, files: 1 },
  fileFilter: function (req, file, cb) {
    if (looksLikePdf(file)) {
      return cb(null, true);
    }
    cb(new Error('Only PDF files are accepted.'));
  },
});

const uploadPdfBatch = multer({
  dest: TMP_DIR,
  limits: { ...uploadLimits, files: 20 },
  fileFilter: function (req, file, cb) {
    if (looksLikePdf(file)) {
      return cb(null, true);
    }
    cb(new Error('Only PDF files are accepted.'));
  },
});

const uploadCaseReportAttachment = multer({
  dest: TMP_DIR,
  limits: { ...uploadLimits, files: 1 },
  fileFilter: function (req, file, cb) {
    if (looksLikeCaseReportAttachment(file)) {
      return cb(null, true);
    }
    cb(new Error('Only PDF, image, text, and document report files are accepted.'));
  },
});

const uploadCaseRecording = multer({
  dest: TMP_DIR,
  limits: { ...uploadLimits, files: 1 },
  fileFilter: function (req, file, cb) {
    const original = sanitizeText(file && file.originalname).toLowerCase();
    const mime = sanitizeText(file && file.mimetype).toLowerCase();
    if (original.endsWith('.webm') || mime === 'video/webm') {
      return cb(null, true);
    }
    cb(new Error('Only WEBM recording files are accepted.'));
  },
});

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(function requestContext(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const startedAt = Date.now();

  req.requestId = String(requestId);
  req.startedAt = startedAt;
  res.setHeader('x-request-id', req.requestId);

  res.on('finish', function () {
    requestMetrics.total_requests += 1;
    if (res.statusCode >= 500) {
      requestMetrics.total_errors_5xx += 1;
    }
    const routeKey = `${req.method} ${req.path}`;
    const bucket = requestMetrics.routes.get(routeKey) || {
      count: 0,
      errors_5xx: 0,
      total_duration_ms: 0,
    };
    bucket.count += 1;
    if (res.statusCode >= 500) {
      bucket.errors_5xx += 1;
    }
    bucket.total_duration_ms += Date.now() - startedAt;
    requestMetrics.routes.set(routeKey, bucket);

    log('info', 'request.completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      ip: req.ip,
    });
  });

  next();
});

app.use(function secureHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) {
        return cb(null, true);
      }
      if (ALLOWED_ORIGINS.length > 0) {
        return cb(null, ALLOWED_ORIGINS.includes(origin));
      }
      if (NODE_ENV === 'production') {
        return cb(new Error('CORS origin is not allowed'));
      }
      return cb(null, true);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: JSON_LIMIT }));
app.use('/media', express.static(path.join(__dirname, 'media')));

warnInsecureDefaults();

function parseCsv(value) {
  return String(value)
    .split(',')
    .map(function (item) {
      return item.trim();
    })
    .filter(Boolean);
}

function sanitizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sanitizeMultilineText(value, maxLength) {
  if (value === null || value === undefined) return '';
  const limit = Number(maxLength) > 0 ? Number(maxLength) : 12000;
  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, limit);
}

function decodeBase64Url(segment) {
  const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function verifyHs256Jwt(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  let header = null;
  let payload = null;
  try {
    header = JSON.parse(decodeBase64Url(headerB64));
    payload = JSON.parse(decodeBase64Url(payloadB64));
  } catch (_) {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (expectedSignature !== signatureB64) return null;

  const exp = Number(payload.exp || 0);
  if (exp && Number.isFinite(exp) && Date.now() >= exp * 1000) return null;
  return payload;
}

function parseBooleanEnv(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return fallback;
}

function normalizeBaseUrl(value) {
  const clean = sanitizeText(value);
  if (!clean) return '';
  return clean.replace(/\/+$/, '');
}

function looksLikeDicom(file) {
  const original = sanitizeText(file && file.originalname).toLowerCase();
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  const hasKnownDicomExtension =
    original.endsWith('.dcm') ||
    original.endsWith('.dicom') ||
    original.endsWith('.ima') ||
    original.endsWith('.dicm') ||
    original.endsWith('.jp2') ||
    original.endsWith('.j2k') ||
    original.endsWith('.jpf') ||
    original.endsWith('.jpx');
  const hasKnownJpeg2000Mime =
    mime === 'image/jp2' ||
    mime === 'image/jpx' ||
    mime === 'image/jpeg2000' ||
    mime === 'video/jpeg2000';

  return (
    hasKnownDicomExtension ||
    hasKnownJpeg2000Mime ||
    mime.indexOf('dicom') !== -1 ||
    mime === 'application/octet-stream' ||
    mime === 'application/dicom'
  );
}

function isProbablyDicomBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return false;
  }

  if (buffer.length >= 132 && buffer.toString('ascii', 128, 132) === 'DICM') {
    return true;
  }

  const firstTagGroupLe = buffer.readUInt16LE(0);
  const firstTagGroupBe = buffer.readUInt16BE(0);

  return (
    firstTagGroupLe === 0x0002 ||
    firstTagGroupLe === 0x0008 ||
    firstTagGroupBe === 0x0002 ||
    firstTagGroupBe === 0x0008
  );
}

function parseBooleanFlag(value) {
  const text = sanitizeText(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function parseOptionalBooleanFlag(value) {
  const text = sanitizeText(value).toLowerCase();
  if (!text) return null;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return null;
}

function detectTransferSyntaxUid(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return '';
  }

  const knownTransferSyntaxes = [
    DICOM_TRANSFER_SYNTAX_JPEG2000_LOSSLESS,
    DICOM_TRANSFER_SYNTAX_JPEG2000,
    DICOM_TRANSFER_SYNTAX_EXPLICIT_LE,
    '1.2.840.10008.1.2',
  ];

  for (const uid of knownTransferSyntaxes) {
    if (buffer.includes(Buffer.from(uid))) {
      return uid;
    }
  }

  return '';
}

function isJpeg2000TransferSyntax(transferSyntaxUid) {
  return (
    transferSyntaxUid === DICOM_TRANSFER_SYNTAX_JPEG2000_LOSSLESS ||
    transferSyntaxUid === DICOM_TRANSFER_SYNTAX_JPEG2000
  );
}

function resolveInputFileBuffer(file) {
  if (file && Buffer.isBuffer(file.buffer)) {
    return file.buffer;
  }
  if (file && file.path) {
    return fs.readFileSync(file.path);
  }
  throw new Error('DICOM file payload is missing buffer/path.');
}

function resolveInputFileSize(file) {
  if (file && Buffer.isBuffer(file.buffer)) {
    return file.buffer.length;
  }
  if (file && file.path) {
    try {
      const stats = fs.statSync(file.path);
      return Number(stats.size) || 0;
    } catch (err) {
      return 0;
    }
  }
  return 0;
}

function readInputFileProbeBuffer(file, maxBytes) {
  const probeBytes = Math.max(Number(maxBytes) || 0, 4096);
  if (file && Buffer.isBuffer(file.buffer)) {
    return file.buffer.subarray(0, probeBytes);
  }
  if (file && file.path) {
    const fd = fs.openSync(file.path, 'r');
    try {
      const out = Buffer.allocUnsafe(probeBytes);
      const bytesRead = fs.readSync(fd, out, 0, probeBytes, 0);
      return out.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new Error('DICOM file payload is missing buffer/path.');
}

async function preconvertDicomFiles(files, options) {
  const opts = options || {};
  const convertJpeg2000ToDcm = opts.convertJpeg2000ToDcm !== false;
  const stagedFiles = [];
  const conversionDetails = [];
  const startedAt = Date.now();
  let inputBytes = 0;
  let outputBytes = 0;
  let transcodeDurationMs = 0;

  for (const f of files || []) {
    const originalName = sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown';
    const inputBuffer = resolveInputFileBuffer(f);
    inputBytes += inputBuffer.length;

    if (!isProbablyDicomBuffer(inputBuffer)) {
      throw makeAppError(
        'INVALID_DICOM_FILE',
        400,
        `File "${originalName}" does not appear to be a valid DICOM object.`
      );
    }

    const transferSyntaxUid = detectTransferSyntaxUid(inputBuffer);
    let outputBuffer = inputBuffer;
    let wasConverted = false;

    if (convertJpeg2000ToDcm && isJpeg2000TransferSyntax(transferSyntaxUid)) {
      const transcodeStartedAt = Date.now();
      outputBuffer = await transcodeDicomBufferViaOrthanc(
        inputBuffer,
        DICOM_TRANSFER_SYNTAX_EXPLICIT_LE
      );
      transcodeDurationMs += Date.now() - transcodeStartedAt;
      wasConverted = true;
    }
    outputBytes += outputBuffer.length;

    const outputName = originalName.replace(/\.[^/.]+$/u, '') + '.dcm';
    stagedFiles.push({
      originalname: outputName,
      mimetype: 'application/dicom',
      buffer: outputBuffer,
    });
    conversionDetails.push({
      name: originalName,
      converted: wasConverted,
      from_transfer_syntax: transferSyntaxUid || null,
      to_transfer_syntax: wasConverted ? DICOM_TRANSFER_SYNTAX_EXPLICIT_LE : transferSyntaxUid || null,
    });
  }

  const convertedCount = conversionDetails.filter(function (item) {
    return Boolean(item.converted);
  }).length;

  return {
    files: stagedFiles,
    totalCount: conversionDetails.length,
    convertedCount: convertedCount,
    conversionDetails: conversionDetails,
    timings: {
      total_ms: Date.now() - startedAt,
      transcode_ms: transcodeDurationMs,
      input_bytes: inputBytes,
      output_bytes: outputBytes,
    },
  };
}

function looksLikeMp4(file) {
  const original = sanitizeText(file && file.originalname).toLowerCase();
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  return original.endsWith('.mp4') || mime === 'video/mp4';
}

function looksLikePdf(file) {
  const original = sanitizeText(file && file.originalname).toLowerCase();
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  return original.endsWith('.pdf') || mime === 'application/pdf';
}

function looksLikeCaseReportAttachment(file) {
  const original = sanitizeText(file && file.originalname).toLowerCase();
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  const ext = path.extname(original);
  const allowedExtensions = new Set([
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.tif',
    '.tiff',
    '.txt',
    '.md',
    '.rtf',
    '.csv',
    '.doc',
    '.docx',
  ]);
  return (
    allowedExtensions.has(ext) ||
    mime === 'application/pdf' ||
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime === 'application/rtf' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureFile(filePath, defaultContent) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
}

function createJsonFileCache() {
  return {
    mtimeMs: -1,
    size: -1,
    value: null,
  };
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function readCachedJsonArray(filePath, cache, normalize, loadFailedEvent) {
  try {
    const stats = fs.statSync(filePath);
    if (cache.value && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) {
      return cloneJsonValue(cache.value);
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized = normalize(Array.isArray(parsed) ? parsed : []);
    cache.mtimeMs = stats.mtimeMs;
    cache.size = stats.size;
    cache.value = normalized;
    return cloneJsonValue(normalized);
  } catch (err) {
    log('error', loadFailedEvent, { message: err.message });
    return [];
  }
}

function updateCachedJsonArray(filePath, cache, value) {
  try {
    const stats = fs.statSync(filePath);
    cache.mtimeMs = stats.mtimeMs;
    cache.size = stats.size;
    cache.value = cloneJsonValue(value);
  } catch (err) {
    cache.mtimeMs = -1;
    cache.size = -1;
    cache.value = null;
  }
}

function normalizeStudies(studies) {
  return (studies || []).map(function (study) {
    const priorIds = Array.isArray(study && study.prior_study_ids)
      ? study.prior_study_ids
          .map(function (id) {
            return Number(id);
          })
          .filter(function (id) {
            return Number.isInteger(id) && id > 0;
          })
      : [];
    return {
      ...study,
      prior_study_ids: Array.from(new Set(priorIds)),
      case_reports: normalizeCaseReports(study),
    };
  });
}

function loadStudies() {
  return readCachedJsonArray(DATA_FILE, studiesFileCache, normalizeStudies, 'studies.load_failed');
}

function saveStudies(studies) {
  const normalized = normalizeStudies(studies);
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, DATA_FILE);
  updateCachedJsonArray(DATA_FILE, studiesFileCache, normalized);
}

function loadCaseRecordings() {
  return readCachedJsonArray(
    CASE_RECORDINGS_FILE,
    caseRecordingsFileCache,
    function (recordings) {
      return recordings;
    },
    'case_recordings.load_failed'
  );
}

function saveCaseRecordings(recordings) {
  const tempFile = `${CASE_RECORDINGS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(recordings, null, 2), 'utf8');
  fs.renameSync(tempFile, CASE_RECORDINGS_FILE);
  updateCachedJsonArray(CASE_RECORDINGS_FILE, caseRecordingsFileCache, recordings);
}

function nextId(studies) {
  if (!studies.length) return 1;
  return (
    Math.max.apply(
      null,
      studies.map(function (s) {
        return Number(s.id) || 0;
      })
    ) + 1
  );
}

function findStudy(studies, id) {
  return studies.find(function (s) {
    return String(s.id) === String(id);
  });
}

function findStudiesSharingOrthancStudyId(orthancStudyId, currentStudyId) {
  const cleanOrthancStudyId = sanitizeText(orthancStudyId);
  if (!cleanOrthancStudyId) return [];
  return loadStudies().filter(function (study) {
    return (
      sanitizeText(study && study.orthanc_study_id) === cleanOrthancStudyId &&
      String(study && study.id) !== String(currentStudyId)
    );
  });
}

function parseCookieHeader(headerValue) {
  return String(headerValue || '')
    .split(';')
    .reduce(function (acc, part) {
      const pieces = part.trim().split('=');
      const key = pieces.shift();
      if (!key) return acc;
      try {
        acc[key] = decodeURIComponent(pieces.join('='));
      } catch (_) {
        acc[key] = pieces.join('=');
      }
      return acc;
    }, {});
}

function isTrustedHeaderAuthRequest(req) {
  const remoteAddress =
    sanitizeText(req.socket && req.socket.remoteAddress) ||
    sanitizeText(req.connection && req.connection.remoteAddress);
  return HEADER_AUTH_TRUSTED_PROXIES.includes(remoteAddress);
}

function getSessionAuthContext(req) {
  if (!AUTH_SESSION_STORE_FILE || !fs.existsSync(AUTH_SESSION_STORE_FILE)) return null;

  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionId = sanitizeText(cookies[AUTH_SESSION_COOKIE]);
  if (!sessionId) return null;

  try {
    const store = JSON.parse(fs.readFileSync(AUTH_SESSION_STORE_FILE, 'utf8'));
    const sessions = Array.isArray(store.sessions) ? store.sessions : [];
    const users = Array.isArray(store.users) ? store.users : [];
    const session = sessions.find(function (entry) {
      return sanitizeText(entry && entry.id) === sessionId;
    });
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;

    const email = sanitizeText(session.email).toLowerCase();
    const user = users.find(function (entry) {
      return sanitizeText(entry && entry.email).toLowerCase() === email;
    });
    if (!user || sanitizeText(user.status) !== 'active') return null;

    return {
      email: email,
      role: sanitizeText(user.role).toLowerCase(),
      name: sanitizeText(user.name),
      isAuthenticated: Boolean(email),
      authSource: 'session',
    };
  } catch (err) {
    log('warn', 'auth.session_store_read_failed', { message: err.message });
    return null;
  }
}

function getStudyAccessContext(req) {
  const authHeader = sanitizeText(req.headers.authorization || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (AUTH_JWT_SECRET && bearerToken) {
    const claims = verifyHs256Jwt(bearerToken, AUTH_JWT_SECRET);
    if (claims) {
      const email = sanitizeText(claims.email || claims.sub).toLowerCase();
      const role = sanitizeText(claims.role || claims.user_role).toLowerCase();
      const name = sanitizeText(claims.name || claims.user_name);
      return {
        email: email,
        role: role,
        name: name,
        isAuthenticated: Boolean(email),
        authSource: 'jwt',
      };
    }
  }

  const sessionContext = getSessionAuthContext(req);
  if (sessionContext && sessionContext.isAuthenticated) {
    return sessionContext;
  }

  if (!ALLOW_HEADER_AUTH) {
    return {
      email: '',
      role: '',
      name: '',
      isAuthenticated: false,
      authSource: 'none',
    };
  }

  if (!isTrustedHeaderAuthRequest(req)) {
    return {
      email: '',
      role: '',
      name: '',
      isAuthenticated: false,
      authSource: 'untrusted_header',
    };
  }

  const userEmail = sanitizeText(
    req.headers['x-user-email'] || req.headers['x-auth-user'] || req.headers['x-user']
  ).toLowerCase();
  const userRole = sanitizeText(req.headers['x-user-role'] || req.headers['x-auth-role']).toLowerCase();
  const userName = sanitizeText(req.headers['x-user-name'] || req.headers['x-auth-name']);
  return {
    email: userEmail,
    role: userRole,
    name: userName,
    isAuthenticated: Boolean(userEmail),
    authSource: 'header',
  };
}

function canAccessStudyRecord(context, study) {
  if (!context || !context.isAuthenticated || !study) return false;
  if (context.role === 'admin') return true;
  if (context.role === 'doctor' || context.role === 'clinic') return true;
  if (context.role === 'patient') {
    const patientId = sanitizeText(study.patient_id).toLowerCase();
    return Boolean(patientId) && patientId === context.email;
  }
  return false;
}

function requireStudyRole(req, res, allowedRoles) {
  const context = getStudyAccessContext(req);
  if (!context.isAuthenticated) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return null;
  }
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    return context;
  }
  if (!allowedRoles.includes(context.role)) {
    sendError(res, 403, 'FORBIDDEN', 'You do not have access to this resource.');
    return null;
  }
  return context;
}

function sanitizeFolderName(value) {
  return (
    sanitizeText(value)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Unknown'
  );
}

function nowIso() {
  return new Date().toISOString();
}

function makeDicomConversionTokenExpiry() {
  return new Date(Date.now() + DICOM_CONVERSION_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
}

function clearExpiredDicomConversionCache() {
  const now = Date.now();
  for (const [token, entry] of dicomConversionCache.entries()) {
    const expiresAtMs = new Date(entry.expires_at || 0).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      dicomConversionCache.delete(token);
    }
  }
}

function cacheDicomConvertedFiles(files, metadata) {
  clearExpiredDicomConversionCache();
  const token = crypto.randomUUID();
  const expiresAt = makeDicomConversionTokenExpiry();

  dicomConversionCache.set(token, {
    files: files,
    metadata: metadata || {},
    created_at: nowIso(),
    expires_at: expiresAt,
  });

  return {
    token: token,
    expires_at: expiresAt,
  };
}

function consumeDicomConvertedFiles(token) {
  clearExpiredDicomConversionCache();
  const key = sanitizeText(token);
  if (!key) return null;

  const entry = dicomConversionCache.get(key);
  if (!entry) return null;

  dicomConversionCache.delete(key);
  return entry;
}

function saveCaseStreamJobs() {
  const jobs = Array.from(caseStreamJobs.values()).map(function (job) {
    return {
      id: job.id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at || null,
      completed_at: job.completed_at || null,
      cancelled_at: job.cancelled_at || null,
      cancel_requested_at: job.cancel_requested_at || null,
      requested_study_ids: Array.isArray(job.requested_study_ids) ? job.requested_study_ids : [],
      fps: Number(job.fps) || 15,
      max_frames: Number(job.max_frames) || 500,
      study_layouts: job.study_layouts && typeof job.study_layouts === 'object' ? job.study_layouts : {},
      output_path: sanitizeText(job.output_path) || null,
      filename: sanitizeText(job.filename) || null,
      file_size: Number(job.file_size) || 0,
      skipped_studies_count: Number(job.skipped_studies_count) || 0,
      skipped_studies: Array.isArray(job.skipped_studies) ? job.skipped_studies : [],
      skipped_frames: Array.isArray(job.skipped_frames) ? job.skipped_frames : [],
      source_summary: Array.isArray(job.source_summary) ? job.source_summary : [],
      duration_sec: Number(job.duration_sec) || 0,
      frames_rendered: Number(job.frames_rendered) || 0,
      progress_pct: Number(job.progress_pct) || 0,
      progress_message: sanitizeText(job.progress_message) || '',
      error: job.error || null,
      request_id: sanitizeText(job.request_id) || null,
      requested_ip: sanitizeText(job.requested_ip) || null,
      expires_at: job.expires_at || null,
      timeline: Array.isArray(job.timeline) ? job.timeline : [],
    };
  });

  const tempFile = `${CASE_STREAM_JOBS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(jobs, null, 2), 'utf8');
  fs.renameSync(tempFile, CASE_STREAM_JOBS_FILE);
}

function hydrateCaseStreamJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(CASE_STREAM_JOBS_FILE, 'utf8'));
    const items = Array.isArray(raw) ? raw : [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = sanitizeText(item.id);
      if (!id) continue;

      const job = {
        id: id,
        status: sanitizeText(item.status) || 'failed',
        created_at: sanitizeText(item.created_at) || nowIso(),
        updated_at: sanitizeText(item.updated_at) || nowIso(),
        started_at: sanitizeText(item.started_at) || null,
        completed_at: sanitizeText(item.completed_at) || null,
        cancelled_at: sanitizeText(item.cancelled_at) || null,
        cancel_requested_at: sanitizeText(item.cancel_requested_at) || null,
        requested_study_ids: Array.isArray(item.requested_study_ids) ? item.requested_study_ids : [],
        fps: Number(item.fps) || 15,
        max_frames: Number(item.max_frames) || 500,
        study_layouts: item.study_layouts && typeof item.study_layouts === 'object' ? item.study_layouts : {},
        output_path: sanitizeText(item.output_path) || null,
        filename: sanitizeText(item.filename) || null,
        file_size: Number(item.file_size) || 0,
        skipped_studies_count: Number(item.skipped_studies_count) || 0,
        skipped_studies: Array.isArray(item.skipped_studies) ? item.skipped_studies : [],
        skipped_frames: Array.isArray(item.skipped_frames) ? item.skipped_frames : [],
        source_summary: Array.isArray(item.source_summary) ? item.source_summary : [],
        duration_sec: Number(item.duration_sec) || 0,
        frames_rendered: Number(item.frames_rendered) || 0,
        progress_pct: Math.min(Math.max(Number(item.progress_pct) || 0, 0), 100),
        progress_message: sanitizeText(item.progress_message) || '',
        error: item.error || null,
        request_id: sanitizeText(item.request_id) || null,
        requested_ip: sanitizeText(item.requested_ip) || null,
        expires_at: sanitizeText(item.expires_at) || null,
        timeline: Array.isArray(item.timeline) ? item.timeline : [],
      };

      if (job.status === 'ready' && (!job.output_path || !fs.existsSync(job.output_path))) {
        job.status = 'failed';
        job.error = {
          code: 'OUTPUT_MISSING',
          message: 'Generated export file is missing. Please create a new case stream export.',
        };
        job.progress_pct = 0;
        job.progress_message = '';
      }

      if (job.status === 'processing' || job.status === 'queued') {
        job.status = 'queued';
        job.progress_pct = 0;
        job.progress_message = 'Queued after server restart...';
      }

      if (job.status === 'cancel_requested') {
        job.status = 'cancelled';
        job.cancelled_at = job.cancelled_at || nowIso();
        job.progress_message = 'Cancelled';
      }

      caseStreamJobs.set(job.id, job);
    }
  } catch (err) {
    log('error', 'case_stream.jobs_load_failed', { message: err.message });
  }
}

function loadCaseStreamLibrary() {
  try {
    const raw = JSON.parse(fs.readFileSync(CASE_STREAM_LIBRARY_FILE, 'utf8'));
    const items = Array.isArray(raw) ? raw : [];
    return items
      .filter(function (item) {
        return item && typeof item === 'object';
      })
      .map(function (item) {
        return {
          id: sanitizeText(item.id),
          job_id: sanitizeText(item.job_id),
          name: sanitizeText(item.name),
          created_at: sanitizeText(item.created_at) || nowIso(),
          updated_at: sanitizeText(item.updated_at) || nowIso(),
          filename: sanitizeText(item.filename) || null,
          file_path: sanitizeText(item.file_path) || null,
          file_size: Number(item.file_size) || 0,
          fps: Number(item.fps) || 0,
          requested_study_ids: Array.isArray(item.requested_study_ids) ? item.requested_study_ids : [],
          timeline: Array.isArray(item.timeline) ? item.timeline : [],
          skipped_studies_count: Number(item.skipped_studies_count) || 0,
          skipped_studies: Array.isArray(item.skipped_studies) ? item.skipped_studies : [],
          skipped_frames: Array.isArray(item.skipped_frames) ? item.skipped_frames : [],
          source_summary: Array.isArray(item.source_summary) ? item.source_summary : [],
          duration_sec: Number(item.duration_sec) || 0,
          frames_rendered: Number(item.frames_rendered) || 0,
        };
      })
      .filter(function (item) {
        return item.id && item.job_id && item.name;
      });
  } catch (err) {
    log('error', 'case_stream.library_load_failed', { message: err.message });
    return [];
  }
}

function saveCaseStreamLibrary(items) {
  const tempFile = `${CASE_STREAM_LIBRARY_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(Array.isArray(items) ? items : [], null, 2), 'utf8');
  fs.renameSync(tempFile, CASE_STREAM_LIBRARY_FILE);
}

function getCaseStreamLibraryDownloadPath(stream) {
  if (!stream) return '';
  const candidates = [];
  const filePath = sanitizeText(stream.file_path);
  if (filePath) candidates.push(filePath);

  const filename = sanitizeText(stream.filename);
  if (filename) {
    candidates.push(path.join(CASE_STREAM_LIBRARY_DIR, path.basename(filename)));
    candidates.push(path.join(CASE_STREAM_EXPORT_DIR, path.basename(filename)));
  }

  const jobId = sanitizeText(stream.job_id);
  if (jobId) {
    const job = caseStreamJobs.get(jobId);
    if (job && sanitizeText(job.output_path)) candidates.push(sanitizeText(job.output_path));
    candidates.push(path.join(CASE_STREAM_EXPORT_DIR, `case-stream-job-${jobId}.mp4`));
  }

  return candidates.find(function (candidate) {
    return candidate && fs.existsSync(candidate);
  }) || '';
}

function copyJobOutputToSavedStream(job, streamId) {
  const sourcePath = sanitizeText(job && job.output_path);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw makeAppError('OUTPUT_MISSING', 410, 'Generated export file is missing. Please create a new case stream export.');
  }
  const targetFilename = `case-stream-library-${sanitizeText(streamId)}.mp4`;
  const targetPath = path.join(CASE_STREAM_LIBRARY_DIR, targetFilename);
  fs.copyFileSync(sourcePath, targetPath);
  const stats = fs.statSync(targetPath);
  return {
    filename: targetFilename,
    file_path: targetPath,
    file_size: Number(stats.size) || 0,
  };
}

async function rebuildSavedCaseStream(stream) {
  if (!stream) {
    throw makeAppError('NOT_FOUND', 404, 'Saved stream not found.');
  }
  const studyIds = Array.isArray(stream.requested_study_ids) ? stream.requested_study_ids : [];
  if (studyIds.length === 0) {
    throw makeAppError('VALIDATION_ERROR', 400, 'Saved stream does not include study ids for repair.');
  }

  const requestedFrameCount = Array.isArray(stream.timeline)
    ? stream.timeline.reduce(function (total, item) {
        return total + (Number(item && item.frame_count) || 0);
      }, 0)
    : 0;
  const maxFrames = Math.min(Math.max(requestedFrameCount || 4000, 10), 12000);
  const context = resolveCaseStreamContext({
    study_ids: studyIds,
    fps: Number(stream.fps) || 24,
    max_frames: maxFrames,
  });
  const outputPath = path.join(CASE_STREAM_LIBRARY_DIR, `case-stream-library-${stream.id}.mp4`);
  const tempPath = path.join(CASE_STREAM_LIBRARY_DIR, `case-stream-library-${stream.id}.repairing.mp4`);
  try {
    fs.unlinkSync(tempPath);
  } catch (_) {}

  const result = await renderCaseStreamVideo(context.parsedBody, context.selectedStudies, tempPath);
  fs.renameSync(tempPath, outputPath);
  const stats = fs.statSync(outputPath);

  return {
    filename: path.basename(outputPath),
    file_path: outputPath,
    file_size: Number(stats.size) || 0,
    fps: context.parsedBody.fps,
    requested_study_ids: context.parsedBody.studyIds,
    timeline: Array.isArray(result.timeline) && result.timeline.length > 0 ? result.timeline : stream.timeline,
    skipped_studies_count: Array.isArray(result.skippedStudies) ? result.skippedStudies.length : 0,
    skipped_studies: Array.isArray(result.skippedStudies) ? result.skippedStudies : [],
    skipped_frames: Array.isArray(result.skippedFrames) ? result.skippedFrames : [],
    source_summary: Array.isArray(result.sourceSummary) ? result.sourceSummary : [],
    duration_sec: Number(result.durationSec || 0),
    frames_rendered: Number(result.framesRendered || 0),
  };
}

function loadLiveCaseSessions() {
  return readCachedJsonArray(
    LIVE_CASE_SESSIONS_FILE,
    liveCaseSessionsFileCache,
    function (items) {
      return items.filter(function (item) {
        return item && typeof item === 'object' && sanitizeText(item.id);
      });
    },
    'live_case.sessions_load_failed'
  );
}

function saveLiveCaseSessions(items) {
  const normalized = Array.isArray(items) ? items : [];
  const tempFile = `${LIVE_CASE_SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, LIVE_CASE_SESSIONS_FILE);
  updateCachedJsonArray(LIVE_CASE_SESSIONS_FILE, liveCaseSessionsFileCache, normalized);
}

function isLiveSessionActive(session, nowMs) {
  if (!session || session.ended_at) return false;
  const lastSeenMs = new Date(session.last_seen_at || session.started_at || 0).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return nowMs - lastSeenMs <= LIVE_CASE_STALE_MS;
}

function getActiveLiveSessions() {
  const sessions = loadLiveCaseSessions();
  const nowMs = Date.now();
  return sessions.filter(function (session) {
    return isLiveSessionActive(session, nowMs);
  });
}

function loadLiveFinalizeJobs() {
  if (pgPool) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LIVE_FINALIZE_QUEUE_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    log('error', 'live_finalize.jobs_load_failed', { message: err.message });
    return [];
  }
}

function saveLiveFinalizeJobs(items) {
  if (pgPool) return;
  const tempFile = `${LIVE_FINALIZE_QUEUE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(Array.isArray(items) ? items : [], null, 2), 'utf8');
  fs.renameSync(tempFile, LIVE_FINALIZE_QUEUE_FILE);
}

async function enqueueLiveFinalizeJob(payload) {
  if (pgPool) {
    const now = nowIso();
    const job = {
      id: crypto.randomUUID(),
      status: 'queued',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
      error: null,
      ...payload,
    };
    const sql = `
      INSERT INTO live_finalize_jobs
        (id, live_session_id, study_id, source_path, target_path, status, attempts, error, created_at, updated_at)
      VALUES
        ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)
    `;
    await pgPool.query(sql, [
      job.id,
      job.live_session_id,
      Number(job.study_id),
      job.source_path,
      job.target_path,
      job.status,
      Number(job.attempts || 0),
      null,
      job.created_at,
      job.updated_at,
    ]);
    return job;
  }
  const jobs = loadLiveFinalizeJobs();
  const now = nowIso();
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
    error: null,
    ...payload,
  };
  jobs.push(job);
  saveLiveFinalizeJobs(jobs);
  return job;
}

function updateLiveFinalizeJob(jobId, updater) {
  if (pgPool) return null;
  const jobs = loadLiveFinalizeJobs();
  const idx = jobs.findIndex(function (job) {
    return sanitizeText(job.id) === sanitizeText(jobId);
  });
  if (idx < 0) return null;
  const next = { ...jobs[idx] };
  updater(next);
  next.updated_at = nowIso();
  jobs[idx] = next;
  saveLiveFinalizeJobs(jobs);
  return next;
}

async function updateLiveFinalizeJobPg(jobId, updater) {
  if (!pgPool) return null;
  const result = await pgPool.query(
    `SELECT id, live_session_id, study_id, source_path, target_path, status, attempts, error, created_at, updated_at
     FROM live_finalize_jobs
     WHERE id = $1::uuid
     LIMIT 1`,
    [sanitizeText(jobId)]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const draft = {
    id: sanitizeText(row.id),
    live_session_id: sanitizeText(row.live_session_id),
    study_id: Number(row.study_id),
    source_path: sanitizeText(row.source_path),
    target_path: sanitizeText(row.target_path),
    status: sanitizeText(row.status),
    attempts: Number(row.attempts) || 0,
    error: sanitizeText(row.error) || null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
  };
  updater(draft);
  draft.updated_at = nowIso();
  await pgPool.query(
    `UPDATE live_finalize_jobs
     SET status=$2, attempts=$3, error=$4, updated_at=$5::timestamptz
     WHERE id=$1::uuid`,
    [draft.id, draft.status, Number(draft.attempts || 0), draft.error, draft.updated_at]
  );
  return draft;
}

async function processOneLiveFinalizeJob() {
  let job = null;
  if (pgPool) {
    const claim = await pgPool.query(
      `
      UPDATE live_finalize_jobs
      SET status = 'processing',
          attempts = attempts + 1,
          updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM live_finalize_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, live_session_id, study_id, source_path, target_path, status, attempts, error, created_at, updated_at
      `
    );
    if (claim.rows.length > 0) {
      const row = claim.rows[0];
      job = {
        id: sanitizeText(row.id),
        live_session_id: sanitizeText(row.live_session_id),
        study_id: Number(row.study_id),
        source_path: sanitizeText(row.source_path),
        target_path: sanitizeText(row.target_path),
        status: sanitizeText(row.status),
        attempts: Number(row.attempts) || 0,
        error: sanitizeText(row.error) || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
      };
    }
  } else {
    const jobs = loadLiveFinalizeJobs();
    const nowMs = Date.now();
    job = jobs.find(function (entry) {
      if (entry.status !== 'queued') return false;
      const nextAttemptMs = new Date(entry.next_attempt_at || 0).getTime();
      return !Number.isFinite(nextAttemptMs) || nextAttemptMs <= nowMs;
    });
  }
  if (!job) return false;

  if (!pgPool) {
    updateLiveFinalizeJob(job.id, function (draft) {
      draft.status = 'processing';
      draft.attempts = Number(draft.attempts || 0) + 1;
      draft.error = null;
    });
  }

  const studies = loadStudies();
  const study = findStudy(studies, job.study_id);
  const sessions = loadLiveCaseSessions();
  const session = sessions.find(function (entry) {
    return sanitizeText(entry.id) === sanitizeText(job.live_session_id);
  });

  if (!study || !session || !job.source_path || !fs.existsSync(job.source_path)) {
    if (session) {
      session.upload_in_progress = false;
      session.last_seen_at = nowIso();
      saveLiveCaseSessions(sessions);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteLiveSession(session);
      }
    }
    const updater = function (draft) {
      draft.status = 'failed';
      draft.error = 'Study/session/source missing for finalize job.';
    };
    if (pgPool) await updateLiveFinalizeJobPg(job.id, updater);
    else updateLiveFinalizeJob(job.id, updater);
    return true;
  }

  try {
    await runFfmpeg([
      '-y',
      '-fflags',
      '+genpts',
      '-i',
      job.source_path,
      '-vf',
      'setpts=PTS-STARTPTS',
      '-c:v',
      'libx264',
      '-preset',
      CASE_STREAM_X264_PRESET,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-avoid_negative_ts',
      'make_zero',
      '-c:a',
      'aac',
      job.target_path,
    ]);

    const filename = path.basename(job.target_path);
    const outputUrl = `/media/${filename}`;
    deleteLocalMediaFile(study.mp4_url);
    study.mp4_url = outputUrl;
    study.status = 'ready';
    touchStudy(study);
    saveStudies(studies);

    session.last_seen_at = nowIso();
    session.ended_at = session.ended_at || nowIso();
    session.finalized_at = nowIso();
    session.finalized_mp4_url = study.mp4_url;
    session.upload_in_progress = false;
    saveLiveCaseSessions(sessions);

    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
      pgDualWriteLiveSession(session);
    }

    const updater = function (draft) {
      draft.status = 'done';
      draft.error = null;
    };
    if (pgPool) await updateLiveFinalizeJobPg(job.id, updater);
    else updateLiveFinalizeJob(job.id, updater);
    scheduleNextcloudExport(study.id, 'live_recording_finalized');

    try {
      fs.unlinkSync(job.source_path);
    } catch (_) {}

    return true;
  } catch (err) {
    const attempts = Number(job.attempts || 0) + 1;
    const maxAttempts = Number(job.max_attempts || 5);
    const isTerminal = attempts >= maxAttempts;
    if (isTerminal) {
      session.upload_in_progress = false;
      session.last_seen_at = nowIso();
      saveLiveCaseSessions(sessions);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteLiveSession(session);
      }
    }
    const updater = function (draft) {
      draft.status = isTerminal ? 'failed' : 'queued';
      draft.error = sanitizeText(err.message) || 'ffmpeg failed';
    };
    if (pgPool) await updateLiveFinalizeJobPg(job.id, updater);
    else updateLiveFinalizeJob(job.id, updater);
    return true;
  }
}

async function ensurePgStudiesTechNotesColumn() {
  if (!pgPool || pgStudiesTechNotesColumnReady) return true;
  if (!pgStudiesTechNotesColumnReady) {
    try {
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS tech_notes TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_age TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_sex TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_zip TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS delete_permanent_after TIMESTAMPTZ');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS deleted_reason TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS nextcloud_export_status TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS nextcloud_deleted_at TIMESTAMPTZ');
      pgStudiesTechNotesColumnReady = true;
    } catch (err) {
      log('warn', 'pg_schema.tech_notes_column_failed', { message: err.message });
      return false;
    }
  }
  return true;
}

async function pgDualWriteStudy(study) {
  if (!pgPool || !study) return;
  await ensurePgStudiesTechNotesColumn();
  const sql = `
    INSERT INTO studies
      (id, patient_name, patient_id, patient_age, patient_sex, patient_zip, study_date, modality, notes, tech_notes, mp4_url, pdf_url, orthanc_patient_id, orthanc_study_id, dicom_count, status, share_token, share_expires_at, nextcloud_folder, nextcloud_url, prior_study_ids, created_at, updated_at, deleted_at, delete_permanent_after, deleted_reason, nextcloud_export_status, nextcloud_deleted_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::timestamptz,$23::timestamptz,$24::timestamptz,$25::timestamptz,$26,$27,$28::timestamptz)
    ON CONFLICT (id) DO UPDATE SET
      patient_name=EXCLUDED.patient_name,
      patient_id=EXCLUDED.patient_id,
      patient_age=EXCLUDED.patient_age,
      patient_sex=EXCLUDED.patient_sex,
      patient_zip=EXCLUDED.patient_zip,
      study_date=EXCLUDED.study_date,
      modality=EXCLUDED.modality,
      notes=EXCLUDED.notes,
      tech_notes=EXCLUDED.tech_notes,
      mp4_url=EXCLUDED.mp4_url,
      pdf_url=EXCLUDED.pdf_url,
      orthanc_patient_id=EXCLUDED.orthanc_patient_id,
      orthanc_study_id=EXCLUDED.orthanc_study_id,
      dicom_count=EXCLUDED.dicom_count,
      status=EXCLUDED.status,
      share_token=EXCLUDED.share_token,
      share_expires_at=EXCLUDED.share_expires_at,
      nextcloud_folder=EXCLUDED.nextcloud_folder,
      nextcloud_url=EXCLUDED.nextcloud_url,
      prior_study_ids=EXCLUDED.prior_study_ids,
      updated_at=EXCLUDED.updated_at,
      deleted_at=EXCLUDED.deleted_at,
      delete_permanent_after=EXCLUDED.delete_permanent_after,
      deleted_reason=EXCLUDED.deleted_reason,
      nextcloud_export_status=EXCLUDED.nextcloud_export_status,
      nextcloud_deleted_at=EXCLUDED.nextcloud_deleted_at
  `;
  const values = [
    Number(study.id),
    sanitizeText(study.patient_name),
    sanitizeText(study.patient_id) || null,
    sanitizeText(study.patient_age) || null,
    sanitizeText(study.patient_sex) || null,
    sanitizeText(study.patient_zip) || null,
    sanitizeText(study.study_date) || null,
    sanitizeText(study.modality) || null,
    sanitizeText(study.notes) || null,
    sanitizeMultilineText(study.tech_notes) || null,
    sanitizeText(study.mp4_url) || null,
    sanitizeText(study.pdf_url) || null,
    sanitizeText(study.orthanc_patient_id) || null,
    sanitizeText(study.orthanc_study_id) || null,
    Number(study.dicom_count) || 0,
    sanitizeText(study.status) || 'processing',
    sanitizeText(study.share_token) || null,
    sanitizeText(study.share_expires_at) || null,
    sanitizeText(study.nextcloud_folder) || null,
    sanitizeText(study.nextcloud_url) || null,
    JSON.stringify(Array.isArray(study.prior_study_ids) ? study.prior_study_ids : []),
    sanitizeText(study.created_at) || nowIso(),
    sanitizeText(study.updated_at) || nowIso(),
    sanitizeText(study.deleted_at) || null,
    sanitizeText(study.delete_permanent_after) || null,
    sanitizeText(study.deleted_reason) || null,
    sanitizeText(study.nextcloud_export_status) || null,
    sanitizeText(study.nextcloud_deleted_at) || null,
  ];
  try {
    await pgPool.query(sql, values);
  } catch (err) {
    log('warn', 'pg_dual_write.study_failed', { id: study.id, message: err.message });
  }
}

async function pgDualWriteLiveSession(session) {
  if (!pgPool || !session) return;
  const sql = `
    INSERT INTO live_case_sessions
      (id, study_id, started_by_email, started_by_name, started_at, last_seen_at, ended_at, finalized_at, finalized_mp4_url, upload_in_progress, updated_at)
    VALUES
      ($1::uuid,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8::timestamptz,$9,$10,$11::timestamptz)
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at=EXCLUDED.last_seen_at,
      ended_at=EXCLUDED.ended_at,
      finalized_at=EXCLUDED.finalized_at,
      finalized_mp4_url=EXCLUDED.finalized_mp4_url,
      upload_in_progress=EXCLUDED.upload_in_progress,
      updated_at=EXCLUDED.updated_at
  `;
  const values = [
    sanitizeText(session.id),
    Number(session.study_id),
    sanitizeText(session.started_by_email) || null,
    sanitizeText(session.started_by_name) || null,
    sanitizeText(session.started_at) || nowIso(),
    sanitizeText(session.last_seen_at) || nowIso(),
    sanitizeText(session.ended_at) || null,
    sanitizeText(session.finalized_at) || null,
    sanitizeText(session.finalized_mp4_url) || null,
    Boolean(session.upload_in_progress),
    nowIso(),
  ];
  try {
    await pgPool.query(sql, values);
  } catch (err) {
    log('warn', 'pg_dual_write.live_session_failed', { id: session.id, message: err.message });
  }
}

async function pgReadStudies() {
  if (!pgPool || !ENABLE_PG_READS) return null;
  await ensurePgStudiesTechNotesColumn();
  const sql = `
    SELECT
      id, patient_name, patient_id, patient_age, patient_sex, patient_zip, study_date, modality, notes, tech_notes, mp4_url, pdf_url,
      orthanc_patient_id, orthanc_study_id, dicom_count, status, created_at, updated_at,
      share_token, share_expires_at, nextcloud_folder, nextcloud_url, prior_study_ids,
      deleted_at, delete_permanent_after, deleted_reason, nextcloud_export_status, nextcloud_deleted_at
    FROM studies
    ORDER BY created_at DESC
  `;
  try {
    const result = await pgPool.query(sql);
    return result.rows.map(function (row) {
      return {
        id: Number(row.id),
        patient_name: sanitizeText(row.patient_name),
        patient_id: sanitizeText(row.patient_id) || null,
        patient_age: sanitizeText(row.patient_age) || null,
        patient_sex: sanitizeText(row.patient_sex) || null,
        patient_zip: sanitizeText(row.patient_zip) || null,
        study_date: sanitizeText(row.study_date) || null,
        modality: sanitizeText(row.modality) || null,
        notes: sanitizeText(row.notes) || null,
        tech_notes: sanitizeMultilineText(row.tech_notes) || null,
        mp4_url: sanitizeText(row.mp4_url) || null,
        pdf_url: sanitizeText(row.pdf_url) || null,
        orthanc_patient_id: sanitizeText(row.orthanc_patient_id) || null,
        orthanc_study_id: sanitizeText(row.orthanc_study_id) || null,
        dicom_count: Number(row.dicom_count) || 0,
        status: sanitizeText(row.status) || 'processing',
        created_at: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
        share_token: sanitizeText(row.share_token) || null,
        share_expires_at: row.share_expires_at ? new Date(row.share_expires_at).toISOString() : null,
        nextcloud_folder: sanitizeText(row.nextcloud_folder) || null,
        nextcloud_url: sanitizeText(row.nextcloud_url) || null,
        prior_study_ids: Array.isArray(row.prior_study_ids) ? row.prior_study_ids : [],
        deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
        delete_permanent_after: row.delete_permanent_after
          ? new Date(row.delete_permanent_after).toISOString()
          : null,
        deleted_reason: sanitizeText(row.deleted_reason) || null,
        nextcloud_export_status: sanitizeText(row.nextcloud_export_status) || null,
        nextcloud_deleted_at: row.nextcloud_deleted_at
          ? new Date(row.nextcloud_deleted_at).toISOString()
          : null,
      };
    });
  } catch (err) {
    log('warn', 'pg_reads.studies_failed', { message: err.message });
    return null;
  }
}

async function pgReadActiveLiveSessions() {
  if (!pgPool || !ENABLE_PG_READS) return null;
  const staleCutoff = new Date(Date.now() - LIVE_CASE_STALE_MS).toISOString();
  const sql = `
    SELECT id, study_id, started_at, last_seen_at, ended_at, started_by_email, started_by_name, finalized_at, finalized_mp4_url, upload_in_progress
    FROM live_case_sessions
    WHERE ended_at IS NULL
      AND last_seen_at >= $1::timestamptz
    ORDER BY started_at DESC
  `;
  try {
    const result = await pgPool.query(sql, [staleCutoff]);
    return result.rows.map(function (row) {
      return {
        id: sanitizeText(row.id),
        study_id: Number(row.study_id),
        started_at: row.started_at ? new Date(row.started_at).toISOString() : nowIso(),
        last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : nowIso(),
        ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
        started_by_email: sanitizeText(row.started_by_email) || null,
        started_by_name: sanitizeText(row.started_by_name) || null,
        finalized_at: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
        finalized_mp4_url: sanitizeText(row.finalized_mp4_url) || null,
        upload_in_progress: Boolean(row.upload_in_progress),
      };
    });
  } catch (err) {
    log('warn', 'pg_reads.live_sessions_failed', { message: err.message });
    return null;
  }
}

function makeAppError(code, status, message, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function touchStudy(study) {
  study.updated_at = nowIso();
}

function maybeHealStaleProcessingStudyStatus(studies, options) {
  const opts = options || {};
  const liveStudyIds = opts.liveStudyIds || new Set();
  const uploadInProgressStudyIds = opts.uploadInProgressStudyIds || new Set();
  const recordingStudyIds = opts.recordingStudyIds || new Set();
  let changed = false;

  for (const study of studies || []) {
    if (!study || sanitizeText(study.status).toLowerCase() !== 'processing') continue;
    const studyId = Number(study.id);
    const hasDicom = Boolean(sanitizeText(study.orthanc_study_id));
    const hasMp4 = Boolean(sanitizeText(study.mp4_url));
    const hasRecording = recordingStudyIds.has(studyId);
    const isLive = liveStudyIds.has(studyId);
    const finalizeInProgress = uploadInProgressStudyIds.has(studyId);

    if (!hasDicom && !isLive && !finalizeInProgress && (hasMp4 || hasRecording)) {
      study.status = 'ready';
      touchStudy(study);
      changed = true;
    }
  }

  return changed;
}

function makeStudyRecord(studies, body) {
  const created = nowIso();
  return {
    id: nextId(studies),
    patient_name: sanitizeText(body.patient_name),
    patient_id: sanitizeText(body.patient_id),
    patient_age: sanitizeText(body.patient_age || body.age),
    patient_sex: sanitizeText(body.patient_sex || body.sex),
    patient_zip: sanitizeText(body.patient_zip || body.zip_code || body.zip),
    study_date: sanitizeText(body.study_date),
    modality: sanitizeText(body.modality),
    notes: sanitizeText(body.notes),
    tech_notes: sanitizeMultilineText(body.tech_notes) || null,
    case_reports: [],
    mp4_url: null,
    pdf_url: null,
    dicom_count: 0,
    created_at: created,
    updated_at: created,
    status: 'ready',
    orthanc_patient_id: null,
    orthanc_study_id: null,
    share_token: null,
    share_expires_at: null,
    nextcloud_folder: null,
    nextcloud_url: null,
    prior_study_ids: [],
    deleted_at: null,
  };
}

function parsePriorStudyIds(input, currentStudyId) {
  if (!Array.isArray(input)) return [];
  const currentIdNum = Number(currentStudyId);
  const normalized = input
    .map(function (value) {
      return Number(value);
    })
    .filter(function (value) {
      return Number.isInteger(value) && value > 0 && value !== currentIdNum;
    });
  return Array.from(new Set(normalized));
}

function normalizePatientKey(study) {
  const patientId = sanitizeText(study && study.patient_id).toLowerCase();
  const patientName = sanitizeText(study && study.patient_name).toLowerCase();
  return {
    patientId: patientId,
    patientName: patientName,
    key: patientId || patientName || '',
  };
}

function isSamePatientStudy(left, right) {
  const leftKey = normalizePatientKey(left);
  const rightKey = normalizePatientKey(right);
  if (!leftKey.key || !rightKey.key) return false;
  if (leftKey.patientId && rightKey.patientId) {
    return leftKey.patientId === rightKey.patientId;
  }
  return leftKey.patientName === rightKey.patientName;
}

function cleanUploadedFile(file) {
  if (!file || !file.path) return;
  try {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  } catch (err) {
    log('warn', 'upload.tmp_cleanup_failed', { path: file.path, message: err.message });
  }
}

function cleanupUploadedFiles(files) {
  (files || []).forEach(cleanUploadedFile);
}

function cleanupStaleTmpFiles() {
  const cutoffMs = Date.now() - TMP_STALE_HOURS * 60 * 60 * 1000;
  let scanned = 0;
  let deleted = 0;
  let bytesDeleted = 0;

  try {
    for (const entry of fs.readdirSync(TMP_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(TMP_DIR, entry.name);
      let stats = null;
      try {
        stats = fs.statSync(filePath);
      } catch (_) {
        continue;
      }
      scanned += 1;
      if (stats.mtimeMs > cutoffMs) continue;
      try {
        fs.unlinkSync(filePath);
        deleted += 1;
        bytesDeleted += stats.size;
      } catch (err) {
        log('warn', 'upload.tmp_stale_cleanup_failed', {
          path: filePath,
          message: sanitizeText(err && err.message) || 'Cleanup failed.',
        });
      }
    }
  } catch (err) {
    log('warn', 'upload.tmp_stale_cleanup_scan_failed', {
      path: TMP_DIR,
      message: sanitizeText(err && err.message) || 'Scan failed.',
    });
    return;
  }

  if (deleted > 0) {
    log('info', 'upload.tmp_stale_cleanup_completed', {
      scanned_files: scanned,
      deleted_files: deleted,
      deleted_bytes: bytesDeleted,
      stale_hours: TMP_STALE_HOURS,
    });
  }
}

function makeShareToken() {
  return crypto.randomBytes(16).toString('hex');
}

function resolveOhifViewerBase(req) {
  if (OHIF_VIEWER_BASE_URL) {
    return OHIF_VIEWER_BASE_URL;
  }
  if (APP_BASE_URL) {
    return APP_BASE_URL;
  }

  if (OHIF_HOST) {
    if (/^https?:\/\//i.test(OHIF_HOST)) {
      return normalizeBaseUrl(OHIF_HOST);
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${proto}://${OHIF_HOST}:3000`;
  }

  const forwardedHost = req.headers['x-forwarded-host'];
  const hostHeader = forwardedHost || req.headers.host || '';
  const hostOnly = String(hostHeader).split(',')[0].trim().split(':')[0] || req.hostname || SERVER_IP;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';

  return `${proto}://${hostOnly}:3000`;
}

function resolveExternalPacsViewerBase(req) {
  if (EXTERNAL_PACS_BASE_URL) {
    return EXTERNAL_PACS_BASE_URL;
  }
  return resolveOhifViewerBase(req);
}

function isExternalPacsViewerMode() {
  return VIEWER_LINK_MODE === 'external-pacs-watch';
}

function resolveMediaAbsolutePath(fileUrl) {
  const relativePath = String(fileUrl || '').replace(/^\/+/, '');
  const absolutePath = path.resolve(__dirname, relativePath);

  if (!absolutePath.startsWith(MEDIA_DIR + path.sep)) {
    return null;
  }

  return absolutePath;
}

function deleteLocalMediaFile(fileUrl) {
  if (!fileUrl) return;
  const fullPath = resolveMediaAbsolutePath(fileUrl);
  if (!fullPath) return;

  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch (err) {
    log('warn', 'media.delete_failed', { path: fullPath, message: err.message });
  }
}

function moveSingleUploadedFile(file, prefix, fallbackExt, targetDir) {
  if (!file) {
    throw new Error('No file uploaded');
  }

  const ext = path.extname(file.originalname || '') || fallbackExt;
  const filename = `${prefix}-${Date.now()}${ext}`;
  const baseDir = targetDir || MEDIA_DIR;
  ensureDir(baseDir);
  const targetPath = path.join(baseDir, filename);
  const relativeMediaPath = path.relative(MEDIA_DIR, targetPath).split(path.sep).join('/');

  fs.renameSync(file.path, targetPath);
  const stat = fs.statSync(targetPath);

  return {
    filename: filename,
    url: `/media/${relativeMediaPath}`,
    size: stat.size,
    path: targetPath,
  };
}

function mediaUrlFromPath(filePath) {
  const relativeMediaPath = path.relative(MEDIA_DIR, filePath).split(path.sep).join('/');
  return `/media/${relativeMediaPath}`;
}

function normalizeCaseReports(study) {
  if (!study || !Array.isArray(study.case_reports)) return [];
  return study.case_reports
    .filter(function (report) {
      return report && typeof report === 'object' && sanitizeText(report.id);
    })
    .map(function (report) {
      return {
        id: sanitizeText(report.id),
        study_id: Number(report.study_id || study.id) || Number(study.id),
        case_label: sanitizeText(report.case_label) || makeCaseLabel(study),
        title: sanitizeText(report.title) || 'Report',
        report_type: sanitizeText(report.report_type) || 'file',
        created_at: sanitizeText(report.created_at) || nowIso(),
        uploaded_by: sanitizeText(report.uploaded_by) || null,
        filename: sanitizeText(report.filename) || null,
        file_size: Number(report.file_size) || 0,
        mime_type: sanitizeText(report.mime_type) || null,
        report_url: sanitizeText(report.report_url) || null,
        text: sanitizeMultilineText(report.text) || null,
      };
    });
}

function inferCaseReportType(file, explicitType, hasText) {
  const cleanType = sanitizeText(explicitType).toLowerCase();
  if (cleanType === 'pdf' || cleanType === 'image' || cleanType === 'text' || cleanType === 'notepad' || cleanType === 'document') {
    return cleanType;
  }
  if (hasText) return 'notepad';
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  const ext = path.extname(sanitizeText(file && file.originalname).toLowerCase());
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/') || ext === '.txt' || ext === '.md' || ext === '.csv') return 'text';
  return 'document';
}

function createTextReportFile(studyId, reportId, text) {
  ensureDir(CASE_REPORTS_DIR);
  const filename = `case-report-${studyId}-${reportId}.txt`;
  const targetPath = path.join(CASE_REPORTS_DIR, filename);
  fs.writeFileSync(targetPath, sanitizeMultilineText(text), 'utf8');
  const stats = fs.statSync(targetPath);
  return {
    filename: filename,
    path: targetPath,
    url: mediaUrlFromPath(targetPath),
    size: stats.size,
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

function validateRecordingUploadIntegrity(filePath, body) {
  const stat = fs.statSync(filePath);
  const expectedSizeRaw = sanitizeText(
    (body && (body.recording_size || body.recordingSize || body.expected_size || body.expectedSize)) || ''
  );
  const expectedSha256 = sanitizeText(
    (body && (body.recording_sha256 || body.recordingSha256 || body.expected_sha256 || body.expectedSha256)) || ''
  ).toLowerCase();

  if (!expectedSha256) {
    throw makeAppError(
      'RECORDING_INTEGRITY_REQUIRED',
      400,
      'Recording upload integrity checksum is required.'
    );
  }

  if (expectedSizeRaw) {
    const expectedSize = Number(expectedSizeRaw);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw makeAppError('RECORDING_INTEGRITY_INVALID', 400, 'Invalid recording integrity metadata.');
    }
    if (stat.size !== expectedSize) {
      throw makeAppError(
        'RECORDING_INTEGRITY_MISMATCH',
        400,
        'Recording upload integrity check failed. Uploaded video byte length did not match the source recording.',
        { expected_size: expectedSize, actual_size: stat.size }
      );
    }
  }

  if (expectedSha256) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw makeAppError('RECORDING_INTEGRITY_INVALID', 400, 'Invalid recording integrity metadata.');
    }
    const actualSha256 = sha256File(filePath);
    if (actualSha256 !== expectedSha256) {
      throw makeAppError(
        'RECORDING_INTEGRITY_MISMATCH',
        400,
        'Recording upload integrity check failed. Uploaded video checksum did not match the source recording.',
        { expected_sha256: expectedSha256, actual_sha256: actualSha256, actual_size: stat.size }
      );
    }
    return { size: stat.size, sha256: actualSha256 };
  }

  return { size: stat.size, sha256: null };
}

function consumeOrResolveDicomUploadFiles(req) {
  const conversionToken = sanitizeText(req.body && req.body.conversion_token);
  if (conversionToken) {
    const staged = consumeDicomConvertedFiles(conversionToken);
    if (!staged || !Array.isArray(staged.files) || staged.files.length === 0) {
      throw makeAppError(
        'DICOM_CONVERSION_TOKEN_INVALID',
        409,
        'Converted DICOM batch is missing or expired. Please click "Convert Now" again.'
      );
    }
    return staged.files;
  }

  return req.files || [];
}

async function uploadDicomFilesToOrthanc(files, options) {
  const opts = options || {};
  const convertJpeg2000ToDcm = Boolean(opts.convertJpeg2000ToDcm);
  const dicomUidNamespace = sanitizeText(opts.dicomUidNamespace);
  const redactTextOnUpload =
    typeof opts.redactTextOnUpload === 'boolean'
      ? opts.redactTextOnUpload
      : DICOM_REDACT_TEXT_ON_UPLOAD;
  let orthancPatientId = null;
  let orthancStudyId = null;
  let uploadedCount = 0;
  let convertedCount = 0;
  let redactedCount = 0;
  let redactionFailedCount = 0;
  const convertedFiles = [];
  const redactionFailedFiles = [];
  const failedFiles = [];
  const inMemoryByteCap = DICOM_IN_MEMORY_MAX_MB * 1024 * 1024;
  const startedAt = Date.now();
  const timings = {
    probe_ms: 0,
    transcode_ms: 0,
    redaction_ms: 0,
    orthanc_upload_ms: 0,
  };
  let totalBytes = 0;

  const filesToProcess = Array.isArray(files) ? files : [];
  const workerCount = Math.min(DICOM_UPLOAD_CONCURRENCY, Math.max(filesToProcess.length, 1));
  let nextIndex = 0;

  async function processOneFile(f) {
    try {
      const probeStartedAt = Date.now();
      const probeBuffer = readInputFileProbeBuffer(f, 128 * 1024);
      if (!isProbablyDicomBuffer(probeBuffer)) {
        throw makeAppError('INVALID_DICOM_FILE', 400, 'File does not appear to be a valid DICOM object.');
      }
      const transferSyntaxUid = detectTransferSyntaxUid(probeBuffer);
      const fileSize = resolveInputFileSize(f);
      timings.probe_ms += Date.now() - probeStartedAt;
      totalBytes += fileSize > 0 ? fileSize : 0;
      const canProcessInMemory = fileSize > 0 ? fileSize <= inMemoryByteCap : true;
      const shouldAttemptTransforms = canProcessInMemory && (convertJpeg2000ToDcm || redactTextOnUpload);
      let uploadBuffer = null;

      if (convertJpeg2000ToDcm && isJpeg2000TransferSyntax(transferSyntaxUid) && shouldAttemptTransforms) {
        try {
          const sourceBuffer = resolveInputFileBuffer(f);
          const transcodeStartedAt = Date.now();
          uploadBuffer = await transcodeDicomBufferViaOrthanc(
            sourceBuffer,
            DICOM_TRANSFER_SYNTAX_EXPLICIT_LE
          );
          timings.transcode_ms += Date.now() - transcodeStartedAt;
          convertedCount += 1;
          convertedFiles.push({
            name: sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown',
            from_transfer_syntax: transferSyntaxUid,
            to_transfer_syntax: DICOM_TRANSFER_SYNTAX_EXPLICIT_LE,
          });
        } catch (conversionErr) {
          log('warn', 'dicom.transcode_failed_fallback_original', {
            filename: sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown',
            transfer_syntax: transferSyntaxUid || null,
            error: extractAxiosError(conversionErr),
          });
        }
      }

      if (shouldAttemptTransforms && !uploadBuffer) {
        uploadBuffer = resolveInputFileBuffer(f);
      }

      let finalUploadBuffer = uploadBuffer;
      if (redactTextOnUpload && shouldAttemptTransforms) {
        try {
          const redactionStartedAt = Date.now();
          finalUploadBuffer = await redactDicomBufferBeforeUpload(uploadBuffer);
          timings.redaction_ms += Date.now() - redactionStartedAt;
          redactedCount += 1;
        } catch (redactionErr) {
          redactionFailedCount += 1;
          redactionFailedFiles.push({
            name: sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown',
            reason: normalizeUploadErrorMessage(redactionErr),
          });
          log('warn', 'dicom.redaction_failed_fallback_original', {
            filename: sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown',
            error: extractAxiosError(redactionErr),
          });
          finalUploadBuffer = uploadBuffer;
        }
      }

      if (!canProcessInMemory && (convertJpeg2000ToDcm || redactTextOnUpload)) {
        log('warn', 'dicom.transforms_skipped_large_file', {
          filename: sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown',
          file_size_bytes: fileSize,
          in_memory_cap_bytes: inMemoryByteCap,
        });
      }

      let isolatedUpload = null;
      const orthancUploadStartedAt = Date.now();
      let response = null;
      try {
        if (dicomUidNamespace) {
          isolatedUpload = await isolateDicomUidsBeforeUpload(
            finalUploadBuffer && Buffer.isBuffer(finalUploadBuffer) ? finalUploadBuffer : null,
            f && f.path ? f.path : '',
            dicomUidNamespace
          );
          response = await uploadDicomFilePathToOrthanc(isolatedUpload.outputPath);
        } else {
          response =
            finalUploadBuffer && Buffer.isBuffer(finalUploadBuffer)
              ? await uploadDicomBufferToOrthanc(finalUploadBuffer)
              : f && f.path
                ? await uploadDicomFilePathToOrthanc(f.path)
                : (() => {
                      throw new Error('DICOM file payload is missing buffer/path.');
                    })();
        }
      } finally {
        timings.orthanc_upload_ms += Date.now() - orthancUploadStartedAt;
        if (isolatedUpload) {
          isolatedUpload.cleanup();
        }
      }

      if (response && response.data) {
        orthancPatientId = response.data.ParentPatient || orthancPatientId;
        orthancStudyId = response.data.ParentStudy || orthancStudyId;
        uploadedCount += 1;
      }
    } catch (err) {
      failedFiles.push({
        name: sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown',
        reason: normalizeUploadErrorMessage(err),
      });
    }
  }

  const workers = Array.from({ length: workerCount }, function () {
    return (async function worker() {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= filesToProcess.length) {
          break;
        }
        await processOneFile(filesToProcess[currentIndex]);
      }
    })();
  });

  await Promise.all(workers);

  if (uploadedCount === 0) {
    throw makeAppError(
      'ORTHANC_UPLOAD_FAILED',
      502,
      'Orthanc rejected all uploaded DICOM files.',
      {
        failed_files_count: failedFiles.length,
        failed_files: failedFiles.slice(0, 20),
      }
    );
  }

  return {
    orthancPatientId: orthancPatientId,
    orthancStudyId: orthancStudyId,
    uploadedCount: uploadedCount,
    convertedCount: convertedCount,
    redactedCount: redactedCount,
    redactionFailedCount: redactionFailedCount,
    convertedFiles: convertedFiles,
    redactionFailedFiles: redactionFailedFiles,
    failedFiles: failedFiles,
    timings: {
      ...timings,
      total_ms: Date.now() - startedAt,
      total_bytes: totalBytes,
      file_count: filesToProcess.length,
      worker_count: workerCount,
    },
  };
}

async function safeDeleteOrthancInstance(instanceId) {
  const cleanId = sanitizeText(instanceId);
  if (!cleanId) return;

  try {
    await orthancClient.delete(`/instances/${cleanId}`);
  } catch (err) {
    log('warn', 'dicom.temp_instance_cleanup_failed', {
      instance_id: cleanId,
      message: sanitizeText(err && err.message) || 'Cleanup failed.',
    });
  }
}

async function runPythonScript(scriptPath, args, label) {
  return await new Promise(function (resolve, reject) {
    const child = spawn('python3', [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', function (chunk) {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', function (chunk) {
      stderr += String(chunk || '');
    });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code === 0) {
        return resolve({
          stdout: stdout,
          stderr: stderr,
        });
      }
      reject(new Error(`${label} failed (${code}): ${stderr || stdout || 'unknown error'}`));
    });
  });
}

async function isolateDicomUidsBeforeUpload(buffer, inputFilePath, namespace) {
  const cleanNamespace = sanitizeText(namespace);
  if (!cleanNamespace) {
    throw new Error('DICOM UID isolation namespace is required.');
  }

  const inputPath = buffer && Buffer.isBuffer(buffer)
    ? path.join(TMP_DIR, `uid-isolate-input-${crypto.randomUUID()}.dcm`)
    : sanitizeText(inputFilePath);
  const outputPath = path.join(TMP_DIR, `uid-isolate-output-${crypto.randomUUID()}.dcm`);
  const ownsInput = Boolean(buffer && Buffer.isBuffer(buffer));

  if (ownsInput) {
    fs.writeFileSync(inputPath, buffer);
  }

  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('DICOM file payload is missing buffer/path.');
  }

  try {
    await runPythonScript(
      DICOM_UID_ISOLATE_SCRIPT,
      ['--input', inputPath, '--output', outputPath, '--namespace', cleanNamespace],
      'isolate_dicom_uids.py'
    );
    const probeBuffer = fs.readFileSync(outputPath, { flag: 'r' }).subarray(0, 1024 * 128);
    if (!isProbablyDicomBuffer(probeBuffer)) {
      throw new Error('DICOM UID isolation output is not a valid DICOM payload.');
    }
    return {
      outputPath: outputPath,
      cleanup: function () {
        try {
          if (ownsInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch (err) {
          log('warn', 'dicom.uid_isolate_tmp_cleanup_failed', {
            path: inputPath,
            message: sanitizeText(err && err.message) || 'Cleanup failed.',
          });
        }
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (err) {
          log('warn', 'dicom.uid_isolate_tmp_cleanup_failed', {
            path: outputPath,
            message: sanitizeText(err && err.message) || 'Cleanup failed.',
          });
        }
      },
    };
  } catch (err) {
    try {
      if (ownsInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch (_) {}
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (_) {}
    throw err;
  }
}

async function runDicomRedactScript(buffer) {
  const inputPath = path.join(TMP_DIR, `redact-input-${crypto.randomUUID()}.dcm`);
  const outputPath = path.join(TMP_DIR, `redact-output-${crypto.randomUUID()}.dcm`);
  fs.writeFileSync(inputPath, buffer);

  try {
    const args = [
      DICOM_REDACT_SCRIPT,
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--enable-ocr',
      DICOM_PIXEL_REDACTION_OCR ? '1' : '0',
      '--enable-fixed-mask',
      DICOM_PIXEL_REDACTION_FIXED_MASK ? '1' : '0',
      '--fixed-masks',
      DICOM_PIXEL_REDACTION_FIXED_MASKS,
      '--ocr-border-margin',
      String(DICOM_PIXEL_REDACTION_OCR_BORDER_MARGIN),
    ];

    const result = await runPythonScript(DICOM_REDACT_SCRIPT, args.slice(1), 'redact_dicom.py');

    const redactedBuffer = fs.readFileSync(outputPath);
    if (!isProbablyDicomBuffer(redactedBuffer)) {
      throw new Error('Python redaction output is not a valid DICOM payload.');
    }

    return redactedBuffer;
  } finally {
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch (err) {
      log('warn', 'dicom.redact_tmp_cleanup_failed', {
        path: inputPath,
        message: sanitizeText(err && err.message) || 'Cleanup failed.',
      });
    }
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (err) {
      log('warn', 'dicom.redact_tmp_cleanup_failed', {
        path: outputPath,
        message: sanitizeText(err && err.message) || 'Cleanup failed.',
      });
    }
  }
}

async function redactDicomBufferBeforeUpload(buffer) {
  try {
    return await runDicomRedactScript(buffer);
  } catch (err) {
    const transferSyntaxUid = detectTransferSyntaxUid(buffer);
    if (
      isJpeg2000TransferSyntax(transferSyntaxUid) ||
      transferSyntaxUid !== DICOM_TRANSFER_SYNTAX_EXPLICIT_LE
    ) {
      try {
        const transcoded = await transcodeDicomBufferViaOrthanc(
          buffer,
          DICOM_TRANSFER_SYNTAX_EXPLICIT_LE
        );
        return await runDicomRedactScript(transcoded);
      } catch (retryErr) {
        throw makeAppError(
          'DICOM_REDACTION_FAILED',
          502,
          'Failed to redact uploaded DICOM before ingest.',
          extractAxiosError(retryErr)
        );
      }
    }

    throw makeAppError(
      'DICOM_REDACTION_FAILED',
      502,
      'Failed to redact uploaded DICOM before ingest.',
      extractAxiosError(err)
    );
  }
}

async function transcodeDicomBufferViaOrthanc(buffer, targetTransferSyntaxUid) {
  const uploaded = await uploadDicomBufferToOrthanc(buffer);
  const instanceId = sanitizeText(uploaded && uploaded.data && uploaded.data.ID);

  if (!instanceId) {
    throw new Error('Orthanc did not return a temporary instance ID for transcoding.');
  }

  try {
    const response = await orthancClient.get(`/instances/${instanceId}/file`, {
      responseType: 'arraybuffer',
      params: {
        transcode: targetTransferSyntaxUid,
      },
      timeout: ORTHANC_UPLOAD_TIMEOUT_MS,
    });
    const transcoded = Buffer.from(response.data || '');

    if (!isProbablyDicomBuffer(transcoded)) {
      throw new Error('Orthanc returned an invalid transcoded DICOM payload.');
    }

    return transcoded;
  } finally {
    try {
      await orthancClient.delete(`/instances/${instanceId}`);
    } catch (cleanupErr) {
      log('warn', 'dicom.transcode_temp_cleanup_failed', {
        instance_id: instanceId,
        message: sanitizeText(cleanupErr && cleanupErr.message) || 'Cleanup failed.',
      });
    }
  }
}

async function uploadDicomBufferToOrthanc(buffer) {
  let lastError = null;

  for (let attempt = 0; attempt <= ORTHANC_UPLOAD_RETRIES; attempt += 1) {
    try {
      return await orthancClient.post('/instances', buffer, {
        headers: { 'Content-Type': 'application/dicom' },
        timeout: ORTHANC_UPLOAD_TIMEOUT_MS,
      });
    } catch (err) {
      lastError = err;
      const shouldRetry = isRetryableOrthancUploadError(err);
      const hasNextAttempt = attempt < ORTHANC_UPLOAD_RETRIES;

      if (!shouldRetry || !hasNextAttempt) {
        throw err;
      }

      await wait(250 * Math.pow(2, attempt));
    }
  }

  throw lastError || new Error('Orthanc upload failed.');
}

async function uploadDicomFilePathToOrthanc(filePath) {
  let lastError = null;

  for (let attempt = 0; attempt <= ORTHANC_UPLOAD_RETRIES; attempt += 1) {
    try {
      const stream = fs.createReadStream(filePath);
      return await orthancClient.post('/instances', stream, {
        headers: { 'Content-Type': 'application/dicom' },
        timeout: ORTHANC_UPLOAD_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
    } catch (err) {
      lastError = err;
      const shouldRetry = isRetryableOrthancUploadError(err);
      const hasNextAttempt = attempt < ORTHANC_UPLOAD_RETRIES;

      if (!shouldRetry || !hasNextAttempt) {
        throw err;
      }

      await wait(250 * Math.pow(2, attempt));
    }
  }

  throw lastError || new Error('Orthanc upload failed.');
}

function isRetryableOrthancUploadError(err) {
  if (!err) return false;

  const code = sanitizeText(err.code);
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return true;
  }

  const status = Number(err.response && err.response.status);
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  return false;
}

function normalizeUploadErrorMessage(err) {
  if (!err) return 'Unknown error';

  const status = Number(err.response && err.response.status);
  const data = err.response && err.response.data;

  if (data && typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed) return trimmed.slice(0, 180);
  }

  if (data && typeof data === 'object') {
    const text = sanitizeText(data.Message || data.message || data.error || data.Status);
    if (text) return text.slice(0, 180);
  }

  const code = sanitizeText(err.code);
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return 'Timed out while Orthanc was reading the DICOM file';
  }
  if (status) return `HTTP ${status}`;
  return sanitizeText(err.message) || 'Unknown error';
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function fetchStudyInstanceIds(orthancStudyId) {
  const response = await orthancClient.get(`/studies/${orthancStudyId}`);
  const seriesIds = Array.isArray(response.data && response.data.Series) ? response.data.Series : [];
  const seriesResponses = await Promise.all(
    seriesIds.map(function (seriesId) {
      return orthancClient.get(`/series/${seriesId}`);
    })
  );

  const sortedSeries = sortDicomSeries(
    seriesResponses.map(function (seriesResponse) {
      return seriesResponse.data || {};
    })
  );
  const orderedInstanceIds = [];

  for (const seriesRecord of sortedSeries) {
    const series = seriesRecord.series || {};
    const seriesTags = series.MainDicomTags || {};
    const modality = sanitizeText(seriesTags.Modality).toUpperCase();
    if (['SR', 'PR', 'KO', 'DOC'].includes(modality)) {
      continue;
    }
    const rawInstanceIds = Array.isArray(series.Instances) ? series.Instances : [];
    const instanceResponses = await Promise.all(
      rawInstanceIds.map(function (instanceId) {
        return orthancClient
          .get(`/instances/${instanceId}`)
          .then(function (instanceResponse) {
            return {
              ID: instanceId,
              ...instanceResponse.data,
            };
          })
          .catch(function () {
            return { ID: instanceId };
          });
      })
    );
    const sortedInstances = sortDicomInstances(instanceResponses, seriesRecord.ordering);
    sortedInstances.forEach(function (record) {
      const id = sanitizeText((record.instance && record.instance.ID) || '');
      if (id) orderedInstanceIds.push(id);
    });
  }

  return orderedInstanceIds;
}

async function fetchOrthancInstanceFrameCount(instanceId) {
  try {
    const response = await orthancClient.get(`/instances/${instanceId}`);
    const tags = (response && response.data && response.data.MainDicomTags) || {};
    const rawFrameCount =
      tags.NumberOfFrames ||
      tags['Number of Frames'] ||
      tags['0028,0008'] ||
      response.data.NumberOfFrames;
    const frameCount = Number(rawFrameCount);
    return Number.isFinite(frameCount) && frameCount > 0 ? Math.floor(frameCount) : 1;
  } catch (_) {
    return 1;
  }
}

async function fetchOrthancPreviewImage(instanceId, frame) {
  const frameNumber = Math.max(Number(frame) || 0, 0);
  const previewEndpoints = [
    `/instances/${instanceId}/frames/${frameNumber}/image-uint8`,
    `/instances/${instanceId}/frames/${frameNumber}/preview`,
  ];
  if (frameNumber === 0) {
    previewEndpoints.push(`/instances/${instanceId}/image-uint8`, `/instances/${instanceId}/preview`);
  }
  const attempts = [];
  let lastError = null;

  for (const endpoint of previewEndpoints) {
    try {
      const response = await orthancClient.get(endpoint, {
        responseType: 'arraybuffer',
        timeout: CASE_STREAM_DICOM_PREVIEW_TIMEOUT_MS,
        headers: {
          Accept: 'image/png,image/jpeg,*/*',
        },
      });
      const payload = Buffer.from(response.data || '');
      if (payload.length === 0) {
        throw new Error('Orthanc returned an empty preview payload.');
      }

      return {
        buffer: payload,
        contentType: response.headers['content-type'] || 'image/png',
        endpoint: endpoint,
      };
    } catch (err) {
      lastError = err;
      attempts.push({
        endpoint: endpoint,
        error: normalizeUploadErrorMessage(err),
      });
    }
  }

  throw makeAppError('ORTHANC_PREVIEW_FAILED', 502, 'Orthanc could not render a preview image.', {
    instance_id: instanceId,
    frame: frameNumber,
    attempts: attempts,
    last_error: extractAxiosError(lastError),
  });
}

async function renderOrthancPreviewImageWithPython(instanceId, frame) {
  const cleanInstanceId = sanitizeText(instanceId);
  const frameNumber = Math.max(Number(frame) || 0, 0);
  const inputPath = path.join(TMP_DIR, `dicom-preview-input-${crypto.randomUUID()}.dcm`);
  const outputPath = path.join(TMP_DIR, `dicom-preview-output-${crypto.randomUUID()}.png`);

  try {
    const response = await orthancClient.get(`/instances/${cleanInstanceId}/file`, {
      responseType: 'arraybuffer',
    });
    fs.writeFileSync(inputPath, Buffer.from(response.data));
    await runPythonScript(
      DICOM_PREVIEW_RENDER_SCRIPT,
      ['--input', inputPath, '--output', outputPath, '--frame', String(frameNumber)],
      'render_dicom_preview.py'
    );
    return {
      buffer: fs.readFileSync(outputPath),
      contentType: 'image/png',
    };
  } finally {
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch (_) {}
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (_) {}
  }
}

function runFfmpeg(args, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let canceled = false;
    let cancelTimer = null;

    if (typeof opts.shouldCancel === 'function') {
      cancelTimer = setInterval(function () {
        if (!opts.shouldCancel()) return;
        if (canceled) return;
        canceled = true;
        try {
          process.kill('SIGTERM');
        } catch (killErr) {
          reject(killErr);
        }
      }, 400);
      cancelTimer.unref();
    }

    process.stderr.on('data', function (chunk) {
      stderr += String(chunk || '');
    });

    process.on('error', function (err) {
      if (cancelTimer) clearInterval(cancelTimer);
      reject(err);
    });

    process.on('close', function (code) {
      if (cancelTimer) clearInterval(cancelTimer);
      if (canceled) {
        reject(makeAppError('JOB_CANCELLED', 409, 'Case stream export was cancelled.'));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed with code ${code}. ${stderr.slice(-1200)}`));
    });
  });
}

async function normalizeWebmRecordingTimestamps(filePath) {
  const sourcePath = sanitizeText(filePath);
  if (!sourcePath || !fs.existsSync(sourcePath)) return false;

  const outputPath = path.join(
    path.dirname(sourcePath),
    `${path.basename(sourcePath, path.extname(sourcePath))}.normalized-${crypto.randomUUID()}.webm`
  );

  try {
    await runFfmpeg([
      '-y',
      '-fflags',
      '+genpts',
      '-i',
      sourcePath,
      '-vf',
      'setpts=PTS-STARTPTS',
      '-af',
      'asetpts=PTS-STARTPTS',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '4',
      '-row-mt',
      '1',
      '-c:a',
      'libopus',
      '-avoid_negative_ts',
      'make_zero',
      outputPath,
    ]);

    fs.renameSync(outputPath, sourcePath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (_) {}
    log('warn', 'recording.timestamp_normalize_failed', {
      path: sourcePath,
      message: sanitizeText(err && err.message) || 'ffmpeg normalization failed',
    });
    return false;
  }
}

function parseCaseStreamBody(body) {
  const payload = body || {};
  const rawIds = Array.isArray(payload.study_ids)
    ? payload.study_ids
    : Array.isArray(payload.studyIds)
      ? payload.studyIds
      : [];
  const uniqueStudyIds = Array.from(
    new Set(
      rawIds
        .map(function (value) {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        })
        .filter(function (value) {
          return value !== null;
        })
    )
  );

  const fps = Math.min(Math.max(Number(payload.fps) || 24, 1), 60);
  const maxFrames = Math.min(Math.max(Number(payload.max_frames) || 4000, 10), 12000);
  const rawLayouts = payload.study_layouts && typeof payload.study_layouts === 'object' ? payload.study_layouts : {};
  const studyLayouts = {};

  Object.keys(rawLayouts).forEach(function (key) {
    const studyId = Number(key);
    if (!Number.isFinite(studyId)) return;
    const raw = rawLayouts[key] || {};
    const mode = sanitizeText(raw.mode).toLowerCase();
    const normalizedMode = mode === 'fill' || mode === 'manual' ? mode : 'fit';
    const crop = raw.crop && typeof raw.crop === 'object' ? raw.crop : {};
    const x = Math.min(Math.max(Number(crop.x) || 0, 0), 0.95);
    const y = Math.min(Math.max(Number(crop.y) || 0, 0), 0.95);
    const width = Math.min(Math.max(Number(crop.width) || 1, 0.05), 1);
    const height = Math.min(Math.max(Number(crop.height) || 1, 0.05), 1);

    studyLayouts[String(studyId)] = {
      mode: normalizedMode,
      crop: {
        x: Math.min(x, 1 - width),
        y: Math.min(y, 1 - height),
        width: width,
        height: height,
      },
    };
  });

  return {
    studyIds: uniqueStudyIds,
    fps: fps,
    maxFrames: maxFrames,
    studyLayouts: studyLayouts,
  };
}

function resolveCaseStreamContext(body) {
  const parsedBody = parseCaseStreamBody(body);

  if (parsedBody.studyIds.length === 0) {
    throw makeAppError('VALIDATION_ERROR', 400, 'Please select at least one study.');
  }

  const studies = loadStudies();
  const selectedStudies = parsedBody.studyIds
    .map(function (studyId) {
      return findStudy(studies, studyId);
    })
    .filter(Boolean);

  if (selectedStudies.length !== parsedBody.studyIds.length) {
    throw makeAppError('NOT_FOUND', 404, 'One or more selected studies were not found.');
  }

  return {
    parsedBody,
    selectedStudies,
  };
}

function getCaseStreamPublicJob(job) {
  const isTerminal =
    job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled';

  return {
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at || null,
    requested_study_ids: job.requested_study_ids,
    fps: job.fps,
    max_frames: job.max_frames,
    timeline: Array.isArray(job.timeline) ? job.timeline : [],
    skipped_studies_count: Number(job.skipped_studies_count || 0),
    skipped_studies: Array.isArray(job.skipped_studies) ? job.skipped_studies : [],
    skipped_frames: Array.isArray(job.skipped_frames) ? job.skipped_frames : [],
    source_summary: Array.isArray(job.source_summary) ? job.source_summary : [],
    duration_sec: Number(job.duration_sec || 0),
    progress_pct: Math.min(Math.max(Number(job.progress_pct) || 0, 0), 100),
    progress_message: sanitizeText(job.progress_message) || '',
    cancel_requested: Boolean(job.cancel_requested_at),
    error: job.error || null,
    can_cancel: !isTerminal && !job.cancel_requested_at,
    download_url:
      job.status === 'ready'
        ? `/api/case-stream/jobs/${encodeURIComponent(job.id)}/download`
        : null,
  };
}

function touchJob(job) {
  job.updated_at = nowIso();
  saveCaseStreamJobs();
}

function setJobProgress(job, pct, message) {
  job.progress_pct = Math.min(Math.max(Number(pct) || 0, 0), 100);
  job.progress_message = sanitizeText(message);
  touchJob(job);
}

function cleanupCaseStreamJobs() {
  const now = Date.now();
  const ttlMs = CASE_STREAM_JOB_TTL_HOURS * 60 * 60 * 1000;

  for (const [jobId, job] of caseStreamJobs.entries()) {
    const updatedMs = new Date(job.updated_at || job.created_at).getTime();
    const isTerminal =
      job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled';
    const shouldDelete = isTerminal && Number.isFinite(updatedMs) && now - updatedMs > ttlMs;

    if (!shouldDelete) continue;

    if (job.output_path && fs.existsSync(job.output_path)) {
      try {
        fs.unlinkSync(job.output_path);
      } catch (err) {
        log('warn', 'case_stream.job_cleanup_failed', {
          job_id: jobId,
          output_path: job.output_path,
          message: err.message,
        });
      }
    }

    caseStreamJobs.delete(jobId);
    saveCaseStreamJobs();
  }
}

setInterval(cleanupCaseStreamJobs, 5 * 60 * 1000).unref();

function normalizeCaseStreamJobError(err) {
  if (err && err.code && err.status) {
    return {
      code: String(err.code),
      status: Number(err.status),
      message: String(err.message || 'Case stream export failed.'),
      details: err.details,
    };
  }

  if (err && err.code === 'ENOENT') {
    return {
      code: 'FFMPEG_NOT_INSTALLED',
      status: 503,
      message: 'ffmpeg is not installed on the API server. Install ffmpeg to export case streams.',
      details: null,
    };
  }

  return {
    code: 'CASE_STREAM_EXPORT_FAILED',
    status: 502,
    message: 'Failed to export case stream.',
    details: extractAxiosError(err),
  };
}

async function renderCaseStreamVideo(parsedBody, selectedStudies, outputPath, options) {
  const opts = options || {};
  const shouldCancel =
    typeof opts.shouldCancel === 'function' ? opts.shouldCancel : function () {
      return false;
    };
  const onProgress =
    typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

  const exportId = crypto.randomUUID();
  const workDir = path.join(TMP_DIR, `case-stream-${exportId}`);
  const concatFilePath = path.join(workDir, 'segments.txt');
  ensureDir(workDir);

  let frameIndex = 0;
  let totalDurationSec = 0;
  const skippedStudies = [];
  const skippedFrames = [];
  const sourceSummary = [];
  const segmentPaths = [];
  const timeline = [];

  onProgress(1, 'Preparing case stream...');

  try {
    for (let studyIndex = 0; studyIndex < selectedStudies.length; studyIndex += 1) {
      const study = selectedStudies[studyIndex];
      if (shouldCancel()) {
        throw makeAppError('JOB_CANCELLED', 409, 'Case stream export was cancelled.');
      }

      onProgress(
        Math.floor((studyIndex / Math.max(selectedStudies.length, 1)) * 70),
        `Preparing media for ${makeCaseLabel(study)}...`
      );

      const studyFrameBudget = parsedBody.maxFrames;
      const sourceResults = await renderCaseStreamStudySegments(
        study,
        parsedBody,
        workDir,
        shouldCancel,
        skippedFrames,
        studyFrameBudget,
        segmentPaths.length
      );

      if (!Array.isArray(sourceResults) || sourceResults.length === 0) {
        skippedStudies.push({
          study_id: study.id,
          orthanc_study_id: sanitizeText(study.orthanc_study_id) || null,
          mp4_url: sanitizeText(study.mp4_url) || null,
          pdf_url: sanitizeText(study.pdf_url) || null,
          error: 'No streamable media was available for this study.',
        });
        continue;
      }

      for (const sourceResult of sourceResults) {
        if (!sourceResult || !sourceResult.segmentPath) continue;
        const timelineStartSec = timeline.length > 0 ? Number(timeline[timeline.length - 1].end_sec) : 0;
        const timelineDurationSec =
          Number(sourceResult.renderedDurationSec) > 0
            ? Number(sourceResult.renderedDurationSec)
            : Number(sourceResult.frameCount || 0) / parsedBody.fps;
        if (totalDurationSec + timelineDurationSec > CASE_STREAM_MAX_TOTAL_DURATION_SEC) {
          throw makeAppError(
            'CASE_STREAM_DURATION_LIMIT',
            413,
            `Case stream rendered duration exceeds the configured ${CASE_STREAM_MAX_TOTAL_DURATION_SEC}s limit.`,
            {
              study_id: study.id,
              max_total_duration_sec: CASE_STREAM_MAX_TOTAL_DURATION_SEC,
            }
          );
        }
        const timelineEndSec = timelineStartSec + timelineDurationSec;
        totalDurationSec += timelineDurationSec;
        timeline.push({
          index: timeline.length,
          study_id: study.id,
          label: sourceResult.label,
          source_type: sourceResult.sourceType || 'unknown',
          recording_count: Number(sourceResult.recordingCount || 0),
          frame_count: sourceResult.frameCount,
          source_duration_sec: Number((Number(sourceResult.sourceDurationSec || 0)).toFixed(3)),
          rendered_duration_sec: Number(timelineDurationSec.toFixed(3)),
          truncated: Boolean(sourceResult.truncated),
          start_sec: Number(timelineStartSec.toFixed(3)),
          end_sec: Number(timelineEndSec.toFixed(3)),
        });
        sourceSummary.push({
          study_id: study.id,
          source_type: sourceResult.sourceType || 'unknown',
          recording_count: Number(sourceResult.recordingCount || 0),
          source_duration_sec: Number((Number(sourceResult.sourceDurationSec || 0)).toFixed(3)),
          rendered_duration_sec: Number(timelineDurationSec.toFixed(3)),
          frame_count: Number(sourceResult.frameCount || 0),
          truncated: Boolean(sourceResult.truncated),
        });
        segmentPaths.push(sourceResult.segmentPath);
        frameIndex += Number(sourceResult.frameCount) || 0;
      }
    }

    if (segmentPaths.length === 0) {
      throw makeAppError(
        'NO_STREAMABLE_MEDIA',
        409,
        'No streamable media was available for selected studies.',
        {
          skipped_studies: skippedStudies,
          skipped_frames: skippedFrames.slice(0, 20),
        }
      );
    }

    onProgress(90, 'Finalizing combined MP4...');

    if (segmentPaths.length === 1) {
      await runFfmpeg([
        '-y',
        '-i',
        segmentPaths[0],
        '-an',
        ...getCaseStreamX264Args(),
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(parsedBody.fps),
        '-movflags',
        '+faststart',
        outputPath,
      ], { shouldCancel: shouldCancel });
    } else {
      const concatArgs = ['-y'];
      const concatInputs = [];
      const concatFilters = [];
      segmentPaths.forEach(function (segmentPath, index) {
        concatArgs.push('-i', segmentPath);
        concatFilters.push(`[${index}:v:0]setsar=1[v${index}]`);
        concatInputs.push(`[v${index}]`);
      });
      concatArgs.push(
        '-filter_complex',
        `${concatFilters.join(';')};${concatInputs.join('')}concat=n=${segmentPaths.length}:v=1:a=0[v]`,
        '-map',
        '[v]',
        '-an',
        ...getCaseStreamX264Args(),
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(parsedBody.fps),
        '-movflags',
        '+faststart',
        outputPath
      );
      await runFfmpeg(concatArgs, { shouldCancel: shouldCancel });
    }

    const finalDurationSec = await probeMediaDurationSeconds(outputPath);
    if (finalDurationSec && timeline.length > 0) {
      const normalizedFinalDurationSec = Number(finalDurationSec.toFixed(3));
      const lastTimeline = timeline[timeline.length - 1];
      const lastRenderedDurationSec = Math.max(
        normalizedFinalDurationSec - Number(lastTimeline.start_sec || 0),
        1 / parsedBody.fps
      );
      lastTimeline.end_sec = normalizedFinalDurationSec;
      lastTimeline.rendered_duration_sec = Number(lastRenderedDurationSec.toFixed(3));
      lastTimeline.frame_count = Math.max(1, Math.round(lastRenderedDurationSec * parsedBody.fps));

      const lastSummary = sourceSummary[sourceSummary.length - 1];
      if (lastSummary && Number(lastSummary.study_id) === Number(lastTimeline.study_id)) {
        lastSummary.rendered_duration_sec = lastTimeline.rendered_duration_sec;
        lastSummary.frame_count = lastTimeline.frame_count;
      }

      totalDurationSec = normalizedFinalDurationSec;
      frameIndex = Math.max(1, Math.round(normalizedFinalDurationSec * parsedBody.fps));
    }

    onProgress(100, 'Completed');

    return {
      fps: parsedBody.fps,
      timeline: timeline,
      skippedStudies: skippedStudies,
      skippedFrames: skippedFrames,
      sourceSummary: sourceSummary,
      durationSec: Number(totalDurationSec.toFixed(3)),
      framesRendered: frameIndex,
    };
  } finally {
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch (err) {
      log('warn', 'case_stream.cleanup_dir_failed', { path: workDir, message: err.message });
    }
  }
}

const CASE_STREAM_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.ts']);
const CASE_STREAM_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

function getCaseStreamMediaExtension(fileUrl) {
  return path.extname(sanitizeText(fileUrl) || '').toLowerCase();
}

function getCaseStreamStudyLayout(parsedBody, study) {
  const layouts = (parsedBody && parsedBody.studyLayouts) || {};
  const key = String(study && study.id);
  return layouts[key] || { mode: 'fit', crop: { x: 0, y: 0, width: 1, height: 1 } };
}

function buildCaseStreamNormalizeFilter(layout) {
  const mode = sanitizeText(layout && layout.mode).toLowerCase();
  const crop = (layout && layout.crop) || {};

  if (mode === 'fill') {
    return 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1';
  }

  if (mode === 'manual') {
    const x = Math.min(Math.max(Number(crop.x) || 0, 0), 0.95);
    const y = Math.min(Math.max(Number(crop.y) || 0, 0), 0.95);
    const width = Math.min(Math.max(Number(crop.width) || 1, 0.05), 1);
    const height = Math.min(Math.max(Number(crop.height) || 1, 0.05), 1);
    const safeX = Math.min(x, 1 - width);
    const safeY = Math.min(y, 1 - height);
    return [
      `crop=iw*${width.toFixed(4)}:ih*${height.toFixed(4)}:iw*${safeX.toFixed(4)}:ih*${safeY.toFixed(4)}`,
      'scale=1920:1080:force_original_aspect_ratio=decrease',
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
      'setsar=1',
    ].join(',');
  }

  return 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
}

function buildCaseStreamLabelFilter(lines, layout) {
  const labelLines = Array.isArray(lines)
    ? lines
        .map(function (line) {
          return sanitizeText(line);
        })
        .filter(Boolean)
    : [];
  const label = escapeDrawtextValue(labelLines.join('\n') || ' ');
  const defaultFontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontPart = fs.existsSync(defaultFontFile) ? `fontfile=${escapeDrawtextValue(defaultFontFile)}:` : '';
  const normalizedFrameFilter = buildCaseStreamNormalizeFilter(layout);
  const textFilter = `drawtext=${fontPart}text='${label}':x=(w-text_w)/2:y=24:fontsize=30:line_spacing=8:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14`;
  return `${normalizedFrameFilter},${textFilter}`;
}

function makeCaseLabelFilter(study, parsedBody) {
  const patientName = sanitizeText(study && study.patient_name) || `Case ${study.id}`;
  const datePart = sanitizeText(study && study.study_date);
  const modalityPart = sanitizeText(study && study.modality);
  const suffix = [datePart, modalityPart].filter(Boolean).join(' | ');
  const lineOne = patientName;
  const lineTwo = suffix || ' ';
  return buildCaseStreamLabelFilter([lineOne, lineTwo], getCaseStreamStudyLayout(parsedBody, study));
}

function getCaseStreamX264Args() {
  return [
    '-c:v',
    'libx264',
    '-preset',
    CASE_STREAM_X264_PRESET,
    '-crf',
    String(CASE_STREAM_X264_CRF),
  ];
}

function makeCaseMediaLabel(study, mediaLabel) {
  const baseLabel = makeCaseLabel(study);
  const suffix = sanitizeText(mediaLabel);
  return suffix ? `${baseLabel} | ${suffix}` : baseLabel;
}

function probeMediaDurationSeconds(filePath) {
  return new Promise(function (resolve) {
    const process = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let output = '';
    let finished = false;

    process.stdout.on('data', function (chunk) {
      output += String(chunk || '');
    });

    process.on('error', function () {
      if (finished) return;
      finished = true;
      resolve(null);
    });

    process.on('close', function (code) {
      if (finished) return;
      finished = true;
      if (code !== 0) {
        resolve(null);
        return;
      }
      const duration = Number(String(output || '').trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
  });
}

async function renderStudyDicomSegment(
  study,
  parsedBody,
  workDir,
  shouldCancel,
  skippedFrames,
  frameBudget,
  segmentIndex
) {
  if (!study.orthanc_study_id) {
    return null;
  }

  const duplicateOrthancStudies = findStudiesSharingOrthancStudyId(study.orthanc_study_id, study.id);
  if (duplicateOrthancStudies.length > 0) {
    return {
      skipped: true,
      error:
        'This DICOM source is shared by multiple app cases and was skipped to prevent cross-case image mixing. Re-upload the partitioned case to isolate its DICOM study.',
    };
  }

  const caseFramesDir = path.join(workDir, `study-${study.id}`);
  ensureDir(caseFramesDir);
  let caseFrameIndex = 0;

  let instanceIds = [];
  try {
    instanceIds = await fetchStudyInstanceIds(study.orthanc_study_id);
  } catch (err) {
    return {
      skipped: true,
      error: extractAxiosError(err),
    };
  }

  async function fetchPreviewFrames(frameTasks) {
    const results = new Array(frameTasks.length);
    let nextTaskIndex = 0;
    const workerCount = Math.min(CASE_STREAM_DICOM_FRAME_CONCURRENCY, frameTasks.length);
    const workers = Array.from({ length: workerCount }, async function () {
      while (true) {
        if (shouldCancel()) {
          throw makeAppError('JOB_CANCELLED', 409, 'Case stream export was cancelled.');
        }
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        if (taskIndex >= frameTasks.length) {
          return;
        }
        const task = frameTasks[taskIndex];
        try {
          const response = await fetchOrthancPreviewImage(task.instanceId, task.frame);
          results[taskIndex] = {
            ok: true,
            buffer: response.buffer,
            instanceId: task.instanceId,
            frame: task.frame,
          };
        } catch (err) {
          results[taskIndex] = {
            ok: false,
            instanceId: task.instanceId,
            frame: task.frame,
            error: extractAxiosError(err),
          };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  for (const instanceId of instanceIds) {
    if (shouldCancel()) {
      throw makeAppError('JOB_CANCELLED', 409, 'Case stream export was cancelled.');
    }

    if (caseFrameIndex >= frameBudget) {
      break;
    }

    const instanceFrameCount = await fetchOrthancInstanceFrameCount(instanceId);
    const frameTasks = [];
    for (let frame = 0; frame < instanceFrameCount && caseFrameIndex + frameTasks.length < frameBudget; frame += 1) {
      frameTasks.push({ instanceId: instanceId, frame: frame });
    }

    if (frameTasks.length === 0) {
      continue;
    }

    const frameResults = await fetchPreviewFrames(frameTasks);
    let consecutiveFrameFailures = 0;
    for (const frameResult of frameResults) {
      if (shouldCancel()) {
        throw makeAppError('JOB_CANCELLED', 409, 'Case stream export was cancelled.');
      }

      if (frameResult && frameResult.ok) {
        const frameName = `${String(caseFrameIndex + 1).padStart(6, '0')}.png`;
        const framePath = path.join(caseFramesDir, frameName);
        fs.writeFileSync(framePath, frameResult.buffer);
        caseFrameIndex += 1;
        consecutiveFrameFailures = 0;
        continue;
      }

      consecutiveFrameFailures += 1;
      skippedFrames.push({
        study_id: study.id,
        instance_id: frameResult ? frameResult.instanceId : instanceId,
        frame: frameResult ? frameResult.frame : null,
        error: frameResult ? frameResult.error : 'Preview frame fetch failed.',
      });
      if (consecutiveFrameFailures >= CASE_STREAM_DICOM_MAX_CONSECUTIVE_FRAME_FAILURES) {
        break;
      }
    }
  }

  if (caseFrameIndex === 0) {
    return {
      skipped: true,
      error: 'No preview frames found for this study.',
    };
  }

  const segmentPath = path.join(workDir, `segment-${String(segmentIndex + 1).padStart(4, '0')}.mp4`);
  await runFfmpeg([
    '-y',
    '-framerate',
    String(parsedBody.fps),
    '-i',
    path.join(caseFramesDir, '%06d.png'),
    '-vf',
    makeCaseLabelFilter(study, parsedBody),
    '-an',
    ...getCaseStreamX264Args(),
    '-x264-params',
    `fps=${parsedBody.fps}/1:force-cfr=1`,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(parsedBody.fps),
    segmentPath,
  ], { shouldCancel: shouldCancel });

  return {
    segmentPath: segmentPath,
    frameCount: caseFrameIndex,
    label: makeCaseLabel(study),
  };
}

async function renderStudyVideoSegment(study, parsedBody, workDir, shouldCancel, frameBudget, segmentIndex) {
  if (!study.mp4_url) {
    return null;
  }

  return renderStudyMediaVideoSegment(
    study,
    parsedBody,
    workDir,
    shouldCancel,
    frameBudget,
    segmentIndex,
    study.mp4_url,
    'MP4'
  );
}

async function renderStudyMediaVideoSegment(
  study,
  parsedBody,
  workDir,
  shouldCancel,
  frameBudget,
  segmentIndex,
  mediaUrl,
  mediaLabel
) {
  if (!mediaUrl) {
    return null;
  }

  const localPath = resolveMediaAbsolutePath(mediaUrl);
  if (!localPath || !fs.existsSync(localPath)) {
    return {
      skipped: true,
      error: `${sanitizeText(mediaLabel) || 'Video'} file is missing or inaccessible.`,
    };
  }

  const durationSeconds = await probeMediaDurationSeconds(localPath);
  const numericFrameBudget = Number(frameBudget);
  const hasFrameBudget =
    Number.isFinite(numericFrameBudget) &&
    numericFrameBudget > 0 &&
    numericFrameBudget < Number.MAX_SAFE_INTEGER;
  const maxDurationSeconds = hasFrameBudget
    ? Math.max(numericFrameBudget / parsedBody.fps, 1 / parsedBody.fps)
    : null;
  const renderDurationSeconds =
    durationSeconds && maxDurationSeconds
      ? Math.min(durationSeconds, maxDurationSeconds)
      : durationSeconds || maxDurationSeconds || null;
  const label = makeCaseMediaLabel(study, sanitizeText(mediaLabel) || 'Video');
  const segmentPath = path.join(workDir, `segment-${String(segmentIndex + 1).padStart(4, '0')}.mp4`);

  const args = [
    '-y',
    '-fflags',
    '+genpts',
    '-i',
    localPath,
    '-vf',
    `setpts=PTS-STARTPTS,${buildCaseStreamLabelFilter([label], getCaseStreamStudyLayout(parsedBody, study))}`,
    '-an',
  ];

  if (renderDurationSeconds) {
    args.push('-t', String(renderDurationSeconds));
  }

  args.push(
    ...getCaseStreamX264Args(),
    '-pix_fmt',
    'yuv420p',
    '-avoid_negative_ts',
    'make_zero',
    '-r',
    String(parsedBody.fps),
    segmentPath,
  );

  await runFfmpeg(args, { shouldCancel: shouldCancel });

  const probedRenderedDurationSec = await probeMediaDurationSeconds(segmentPath);
  const renderedDurationSec = probedRenderedDurationSec || renderDurationSeconds;

  if (!renderedDurationSec) {
    return {
      skipped: true,
      error: `${sanitizeText(mediaLabel) || 'Video'} duration could not be determined after rendering.`,
    };
  }

  return {
    segmentPath: segmentPath,
    frameCount: Math.max(1, Math.round(renderedDurationSec * parsedBody.fps)),
    label: label,
    sourceType: sanitizeText(mediaLabel).toLowerCase().indexOf('screen recording') === 0 ? 'recording' : 'video',
    recordingCount: sanitizeText(mediaLabel).toLowerCase().indexOf('screen recording') === 0 ? 1 : 0,
    sourceDurationSec: durationSeconds || renderedDurationSec,
    renderedDurationSec: renderedDurationSec,
    truncated: Boolean(durationSeconds && renderedDurationSec < durationSeconds - 0.05),
  };
}

function getCaseStreamRecordingsForStudy(study) {
  const studyId = Number(study && study.id);
  if (!Number.isFinite(studyId) || studyId <= 0) {
    return [];
  }

  return loadCaseRecordings()
    .filter(function (record) {
      return Number(record && record.studyId) === studyId && Boolean(sanitizeText(record && record.recording_url));
    })
    .sort(function (left, right) {
      return new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
    });
}

async function renderStudyRecordingSegment(
  study,
  recording,
  parsedBody,
  workDir,
  shouldCancel,
  frameBudget,
  segmentIndex,
  recordingIndex
) {
  const labelSuffix = `Screen Recording ${recordingIndex + 1}`;
  return renderStudyMediaVideoSegment(
    study,
    parsedBody,
    workDir,
    shouldCancel,
    frameBudget,
    segmentIndex,
    recording && recording.recording_url,
    labelSuffix
  );
}

async function renderStudyPdfSegment(study, parsedBody, workDir, shouldCancel, frameBudget, segmentIndex) {
  if (!study.pdf_url) {
    return null;
  }

  const localPath = resolveMediaAbsolutePath(study.pdf_url);
  if (!localPath || !fs.existsSync(localPath)) {
    return {
      skipped: true,
      error: 'PDF file is missing or inaccessible.',
    };
  }

  const maxDurationSeconds = Math.max(frameBudget / parsedBody.fps, 1 / parsedBody.fps);
  const durationSeconds = Math.min(4, maxDurationSeconds);
  const label = makeCaseMediaLabel(study, 'PDF');
  const segmentPath = path.join(workDir, `segment-${String(segmentIndex + 1).padStart(4, '0')}.mp4`);

  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=1920x1080:r=${parsedBody.fps}`,
    '-t',
    String(durationSeconds),
    '-vf',
    buildCaseStreamLabelFilter([label, path.basename(localPath)], getCaseStreamStudyLayout(parsedBody, study)),
    '-an',
    ...getCaseStreamX264Args(),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(parsedBody.fps),
    segmentPath,
  ], { shouldCancel: shouldCancel });

  return {
    segmentPath: segmentPath,
    frameCount: Math.max(1, Math.min(frameBudget, Math.round(durationSeconds * parsedBody.fps))),
    label: label,
  };
}

async function renderCaseStreamStudySegments(study, parsedBody, workDir, shouldCancel, skippedFrames, frameBudget, segmentIndex) {
  const results = [];
  let remainingFrameBudget = Math.max(Number(frameBudget) || 0, 1);
  let nextSegmentIndex = segmentIndex;
  const recordings = getCaseStreamRecordingsForStudy(study);
  let remainingSourceSlots = (study.orthanc_study_id ? 1 : 0) +
    (study.mp4_url ? 1 : 0) +
    recordings.length +
    (study.pdf_url ? 1 : 0);

  function acceptResult(result) {
    if (!result || !result.segmentPath) return false;
    results.push(result);
    remainingFrameBudget = Math.max(remainingFrameBudget - (Number(result.frameCount) || 0), 0);
    nextSegmentIndex += 1;
    return true;
  }

  function nextSourceFrameBudget() {
    remainingSourceSlots = Math.max(remainingSourceSlots - 1, 0);
    if (remainingFrameBudget <= 1) return 1;
    const reserveFrames = Math.min(remainingFrameBudget - 1, remainingSourceSlots * parsedBody.fps);
    const availableFrames = Math.max(1, remainingFrameBudget - reserveFrames);
    if (remainingSourceSlots > 0) {
      return Math.max(1, Math.min(availableFrames, parsedBody.fps * 8));
    }
    return availableFrames;
  }

  if (recordings.length > 0) {
    for (let recordingIndex = 0; recordingIndex < recordings.length; recordingIndex += 1) {
      try {
        const recordingResult = await renderStudyRecordingSegment(
          study,
          recordings[recordingIndex],
          parsedBody,
          workDir,
          shouldCancel,
          Number.POSITIVE_INFINITY,
          nextSegmentIndex,
          recordingIndex
        );
        acceptResult(recordingResult);
        if (recordingResult && recordingResult.error) {
          log('warn', 'case_stream.recording_source_failed', {
            study_id: study.id,
            recording_id: sanitizeText(recordings[recordingIndex] && recordings[recordingIndex].id) || null,
            error: recordingResult.error,
          });
        }
      } catch (err) {
        log('warn', 'case_stream.recording_source_failed', {
          study_id: study.id,
          recording_id: sanitizeText(recordings[recordingIndex] && recordings[recordingIndex].id) || null,
          error: extractAxiosError(err),
        });
      }
    }

    if (results.length > 0) {
      return results;
    }
  }

  if (study.orthanc_study_id) {
    try {
      const dicomResult = await renderStudyDicomSegment(
        study,
        parsedBody,
        workDir,
        shouldCancel,
        skippedFrames,
        nextSourceFrameBudget(),
        nextSegmentIndex
      );
      acceptResult(dicomResult);
      if (dicomResult && dicomResult.error) {
        log('warn', 'case_stream.dicom_source_failed', {
          study_id: study.id,
          error: dicomResult.error,
        });
      }
    } catch (err) {
      log('warn', 'case_stream.dicom_source_failed', {
        study_id: study.id,
        error: extractAxiosError(err),
      });
    }
  }

  if (remainingFrameBudget > 0) {
    try {
      const videoResult = await renderStudyVideoSegment(
        study,
        parsedBody,
        workDir,
        shouldCancel,
        nextSourceFrameBudget(),
        nextSegmentIndex
      );
      acceptResult(videoResult);
      if (videoResult && videoResult.error) {
        log('warn', 'case_stream.mp4_source_failed', {
          study_id: study.id,
          error: videoResult.error,
        });
      }
    } catch (err) {
      log('warn', 'case_stream.mp4_source_failed', {
        study_id: study.id,
        error: extractAxiosError(err),
      });
    }
  }

  if (remainingFrameBudget > 0) {
    try {
      const pdfResult = await renderStudyPdfSegment(
        study,
        parsedBody,
        workDir,
        shouldCancel,
        nextSourceFrameBudget(),
        nextSegmentIndex
      );
      acceptResult(pdfResult);
      if (pdfResult && pdfResult.error) {
        log('warn', 'case_stream.pdf_source_failed', {
          study_id: study.id,
          error: pdfResult.error,
        });
      }
    } catch (err) {
      log('warn', 'case_stream.pdf_source_failed', {
        study_id: study.id,
        error: extractAxiosError(err),
      });
    }
  }

  if (results.length > 0) {
    return results;
  }

  return [
    await renderStudyFallbackSegment(
      study,
      parsedBody,
      workDir,
      shouldCancel,
      frameBudget,
      segmentIndex,
      'No attached media was available.'
    ),
  ];
}

async function renderCaseStreamStudySegment(study, parsedBody, workDir, shouldCancel, skippedFrames, frameBudget, segmentIndex) {
  const results = await renderCaseStreamStudySegments(
    study,
    parsedBody,
    workDir,
    shouldCancel,
    skippedFrames,
    frameBudget,
    segmentIndex
  );
  return results[0] || null;
}

async function renderStudyFallbackSegment(
  study,
  parsedBody,
  workDir,
  shouldCancel,
  frameBudget,
  segmentIndex,
  reason
) {
  const maxDurationSeconds = Math.max(frameBudget / parsedBody.fps, 1 / parsedBody.fps);
  const durationSeconds = Math.min(4, maxDurationSeconds);
  const label = makeCaseMediaLabel(study, 'Fallback');
  const segmentPath = path.join(workDir, `segment-${String(segmentIndex + 1).padStart(4, '0')}.mp4`);

  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=1920x1080:r=${parsedBody.fps}`,
    '-t',
    String(durationSeconds),
    '-vf',
    buildCaseStreamLabelFilter([label, sanitizeText(reason) || ''], getCaseStreamStudyLayout(parsedBody, study)),
    '-an',
    ...getCaseStreamX264Args(),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(parsedBody.fps),
    '-movflags',
    '+faststart',
    segmentPath,
  ], { shouldCancel: shouldCancel });

  return {
    segmentPath: segmentPath,
    frameCount: Math.max(1, Math.min(frameBudget, Math.round(durationSeconds * parsedBody.fps))),
    label: label,
  };
}

function enqueueCaseStreamJob(jobId) {
  if (!caseStreamJobQueue.includes(jobId)) {
    caseStreamJobQueue.push(jobId);
  }
  processCaseStreamJobQueue();
}

function processCaseStreamJobQueue() {
  while (caseStreamJobsInFlight < CASE_STREAM_MAX_CONCURRENT && caseStreamJobQueue.length > 0) {
    const nextJobId = caseStreamJobQueue.shift();
    const job = caseStreamJobs.get(nextJobId);
    if (!job || job.status !== 'queued') {
      continue;
    }

    caseStreamJobsInFlight += 1;
    runCaseStreamJob(job)
      .catch(function () {})
      .finally(function () {
        caseStreamJobsInFlight -= 1;
        processCaseStreamJobQueue();
      });
  }
}

async function runCaseStreamJob(job) {
  if (job.cancel_requested_at) {
    job.status = 'cancelled';
    job.cancelled_at = nowIso();
    setJobProgress(job, 0, 'Cancelled');
    return;
  }

  job.status = 'processing';
  job.started_at = nowIso();
  setJobProgress(job, Number(job.progress_pct) || 0, 'Starting export...');

  try {
    const context = resolveCaseStreamContext({
      study_ids: job.requested_study_ids,
      max_frames: job.max_frames,
      fps: job.fps,
      study_layouts: job.study_layouts,
    });

    const outputPath = path.join(CASE_STREAM_EXPORT_DIR, `case-stream-job-${job.id}.mp4`);
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    const result = await renderCaseStreamVideo(context.parsedBody, context.selectedStudies, outputPath, {
      shouldCancel: function () {
        return Boolean(job.cancel_requested_at);
      },
      onProgress: function (pct, message) {
        setJobProgress(job, pct, message);
      },
    });
    const stats = fs.statSync(outputPath);

    job.status = 'ready';
    job.completed_at = nowIso();
    job.output_path = outputPath;
    job.filename = `case-stream-${job.id}.mp4`;
    job.file_size = stats.size;
    job.timeline = Array.isArray(result.timeline) ? result.timeline : [];
    job.skipped_studies_count = result.skippedStudies.length;
    job.skipped_studies = Array.isArray(result.skippedStudies) ? result.skippedStudies : [];
    job.skipped_frames = Array.isArray(result.skippedFrames) ? result.skippedFrames : [];
    job.source_summary = Array.isArray(result.sourceSummary) ? result.sourceSummary : [];
    job.duration_sec = Number(result.durationSec || 0);
    job.frames_rendered = Number(result.framesRendered || 0);
    job.expires_at = new Date(Date.now() + CASE_STREAM_JOB_TTL_HOURS * 60 * 60 * 1000).toISOString();
    job.error = null;
    setJobProgress(job, 100, 'Completed');
    return;
  } catch (err) {
    const normalized = normalizeCaseStreamJobError(err);
    if (normalized.code === 'JOB_CANCELLED' || job.cancel_requested_at) {
      job.status = 'cancelled';
      job.cancelled_at = nowIso();
      job.completed_at = job.cancelled_at;
      job.error = null;
      setJobProgress(job, Number(job.progress_pct) || 0, 'Cancelled');
      return;
    }

    job.status = 'failed';
    job.completed_at = nowIso();
    job.error = {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    };
    setJobProgress(job, Number(job.progress_pct) || 0, 'Failed');
  }
}

function restoreCaseStreamJobQueue() {
  hydrateCaseStreamJobs();

  for (const job of caseStreamJobs.values()) {
    if (job.status === 'queued' || job.status === 'processing') {
      job.status = 'queued';
      if (!job.progress_message) {
        job.progress_message = 'Queued';
      }
      enqueueCaseStreamJob(job.id);
    }
  }

  saveCaseStreamJobs();
}

restoreCaseStreamJobQueue();

if (ENABLE_LIVE_FINALIZE_QUEUE) {
  setInterval(function () {
    processOneLiveFinalizeJob().catch(function (err) {
      log('error', 'live_finalize.job_loop_failed', { message: err.message });
    });
  }, 1000).unref();
}

function escapeDrawtextValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function makeCaseLabel(study) {
  const patientName = sanitizeText(study && study.patient_name) || `Case ${study.id}`;
  const datePart = sanitizeText(study && study.study_date);
  const modalityPart = sanitizeText(study && study.modality);
  const suffix = [datePart, modalityPart].filter(Boolean).join(' | ');
  return suffix ? `${patientName} | ${suffix}` : patientName;
}

function concatListEntry(filePath) {
  return `file '${String(filePath).replace(/'/g, "'\\''")}'`;
}

async function deleteOrthancStudy(orthancStudyId) {
  if (!orthancStudyId) return;

  try {
    await orthancClient.delete(`/studies/${orthancStudyId}`);
  } catch (err) {
    log('warn', 'orthanc.study_delete_failed', {
      orthanc_study_id: orthancStudyId,
      error: extractAxiosError(err),
    });
  }
}

async function orthancStudyExists(orthancStudyId) {
  const cleanId = sanitizeText(orthancStudyId);
  if (!cleanId) return false;

  try {
    await orthancClient.get(`/studies/${cleanId}`);
    return true;
  } catch (err) {
    const status = err && err.response && err.response.status;
    if (status === 404) return false;
    throw err;
  }
}

function validateStudyPayload(body) {
  const hasCore =
    sanitizeText(body.patient_name) ||
    sanitizeText(body.patient_id) ||
    sanitizeText(body.study_date) ||
    sanitizeText(body.modality);

  if (!hasCore) {
    return 'At least one study field is required (patient_name, patient_id, study_date, modality).';
  }

  return null;
}

function requireNextcloudConfig() {
  if (!NEXTCLOUD_URL || !NEXTCLOUD_USERNAME || !NEXTCLOUD_PASSWORD || !NEXTCLOUD_DAV) {
    return 'Nextcloud integration is not configured. Set NEXTCLOUD_URL, NEXTCLOUD_USERNAME, and NEXTCLOUD_PASSWORD.';
  }
  return null;
}

async function ncCreateFolder(remotePath) {
  try {
    await nextcloudClient.request({
      method: 'MKCOL',
      url: NEXTCLOUD_DAV + remotePath,
      auth: nextcloudAuth,
    });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status !== 405 && status !== 409) {
      throw err;
    }
  }
}

async function ncUploadFile(remotePath, localPath) {
  const stream = fs.createReadStream(localPath);

  await nextcloudClient.put(NEXTCLOUD_DAV + remotePath, stream, {
    auth: nextcloudAuth,
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  });
}

async function ncUploadBuffer(remotePath, buffer, contentType) {
  await nextcloudClient.put(NEXTCLOUD_DAV + remotePath, buffer, {
    auth: nextcloudAuth,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
    },
  });
}

async function ncUploadStream(remotePath, stream, contentType) {
  await nextcloudClient.put(NEXTCLOUD_DAV + remotePath, stream, {
    auth: nextcloudAuth,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
    },
  });
}

async function ncDeletePath(remotePath) {
  const cleanPath = sanitizeText(remotePath);
  if (!cleanPath) return false;

  try {
    await nextcloudClient.request({
      method: 'DELETE',
      url: NEXTCLOUD_DAV + cleanPath,
      auth: nextcloudAuth,
    });
    return true;
  } catch (err) {
    const status = err && err.response && err.response.status;
    if (status === 404) return false;
    throw err;
  }
}

async function ncCreateShare(remotePath) {
  const params = new URLSearchParams({
    path: remotePath,
    shareType: '3',
    permissions: '1',
  });

  const response = await nextcloudClient.post(
    `${NEXTCLOUD_URL}/ocs/v2.php/apps/files_sharing/api/v1/shares`,
    params.toString(),
    {
      auth: nextcloudAuth,
      headers: {
        'OCS-APIRequest': 'true',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data && response.data.ocs && response.data.ocs.data
    ? response.data.ocs.data.url
    : null;
}

function getCaseCloudFolder(study) {
  const caseName = sanitizeFolderName(
    sanitizeText(study && study.patient_name) ||
      sanitizeText(study && study.patient_id) ||
      `Case_${study && study.id ? study.id : Date.now()}`
  );
  return `/Cases/${caseName}`;
}

function getStudyDeletedPurgeAt(study) {
  const explicit = sanitizeText(study && study.delete_permanent_after);
  if (explicit) return explicit;

  const deletedAt = sanitizeText(study && study.deleted_at);
  const deletedMs = new Date(deletedAt || 0).getTime();
  if (!Number.isFinite(deletedMs) || deletedMs <= 0) return null;
  return new Date(deletedMs + DELETED_STUDY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function isDeletedStudyRetentionExpired(study) {
  const purgeAt = getStudyDeletedPurgeAt(study);
  if (!purgeAt) return false;
  const purgeMs = new Date(purgeAt).getTime();
  return Number.isFinite(purgeMs) && purgeMs <= Date.now();
}

async function deleteStudyNextcloudFolder(study, reason) {
  if (!study || !NEXTCLOUD_URL || !NEXTCLOUD_USERNAME || !NEXTCLOUD_PASSWORD || !NEXTCLOUD_DAV) {
    return false;
  }

  const folder = sanitizeText(study.nextcloud_folder) || getCaseCloudFolder(study);
  if (!folder || folder === '/Cases' || !folder.startsWith('/Cases/')) return false;

  try {
    const deleted = await ncDeletePath(folder);
    study.nextcloud_folder = null;
    study.nextcloud_url = null;
    study.nextcloud_export_status = 'deleted';
    study.nextcloud_deleted_at = nowIso();
    study.nextcloud_export_error = null;
    log('info', 'nextcloud.case_folder_deleted', {
      study_id: study.id,
      reason: sanitizeText(reason),
      folder: folder,
      existed: deleted,
    });
    return deleted;
  } catch (err) {
    study.nextcloud_export_status = 'delete_error';
    study.nextcloud_export_error = sanitizeText(err && err.message) || 'Nextcloud delete failed.';
    log('warn', 'nextcloud.case_folder_delete_failed', {
      study_id: study.id,
      reason: sanitizeText(reason),
      folder: folder,
      error: extractAxiosError(err),
    });
    return false;
  }
}

function cancelPendingNextcloudExport(studyId) {
  const cleanStudyId = Number(studyId);
  const timer = pendingNextcloudExports.get(cleanStudyId);
  if (!timer) return;
  clearTimeout(timer);
  pendingNextcloudExports.delete(cleanStudyId);
}

async function softDeleteStudyAcrossPlatforms(studies, study, reason) {
  if (!study) return null;

  cancelPendingNextcloudExport(study.id);

  const deletedAt = sanitizeText(study.deleted_at) || nowIso();
  study.deleted_at = deletedAt;
  study.delete_permanent_after =
    sanitizeText(study.delete_permanent_after) ||
    new Date(new Date(deletedAt).getTime() + DELETED_STUDY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  study.status = 'deleted';
  study.deleted_reason = sanitizeText(reason) || 'case_deleted';

  await deleteStudyNextcloudFolder(study, reason);
  await deleteOrthancStudy(study.orthanc_study_id);

  touchStudy(study);
  saveStudies(studies);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
  }

  log('info', 'study.soft_deleted_across_platforms', {
    study_id: study.id,
    reason: sanitizeText(reason),
    purge_after: study.delete_permanent_after,
  });

  return study;
}

async function pgDeleteStudy(studyId) {
  if (!pgPool) return;
  try {
    await pgPool.query('DELETE FROM studies WHERE id = $1', [Number(studyId)]);
  } catch (err) {
    log('warn', 'pg_delete.study_failed', { id: studyId, message: err.message });
  }
}

async function permanentlyDeleteStudyRecord(studies, study, reason) {
  if (!study) return false;

  cancelPendingNextcloudExport(study.id);
  await deleteStudyNextcloudFolder(study, reason || 'permanent_delete');

  deleteLocalMediaFile(study.mp4_url);
  deleteLocalMediaFile(study.pdf_url);
  normalizeCaseReports(study).forEach(function (report) {
    deleteLocalMediaFile(report.report_url);
  });

  const recordings = loadCaseRecordings();
  const keepRecordings = [];
  for (const record of recordings) {
    const sameStudy = Number(record && record.studyId) === Number(study.id);
    if (sameStudy) {
      deleteLocalMediaFile(record && record.recording_url);
    } else {
      keepRecordings.push(record);
    }
  }
  saveCaseRecordings(keepRecordings);

  await deleteOrthancStudy(study.orthanc_study_id);

  const remaining = studies.filter(function (s) {
    return String(s.id) !== String(study.id);
  });
  saveStudies(remaining);
  await pgDeleteStudy(study.id);

  log('info', 'study.permanently_deleted', {
    study_id: study.id,
    reason: sanitizeText(reason),
  });

  return true;
}

let deletedStudySweepInFlight = false;
async function sweepExpiredDeletedStudies() {
  if (deletedStudySweepInFlight) return;
  deletedStudySweepInFlight = true;
  try {
    const studies = loadStudies();
    const expired = studies.filter(function (study) {
      return sanitizeText(study && study.deleted_at) && isDeletedStudyRetentionExpired(study);
    });

    for (const study of expired) {
      const latest = loadStudies();
      const current = findStudy(latest, study.id);
      if (current && sanitizeText(current.deleted_at) && isDeletedStudyRetentionExpired(current)) {
        await permanentlyDeleteStudyRecord(latest, current, 'deleted_retention_expired');
      }
    }

    if (expired.length > 0) {
      log('info', 'study.deleted_retention_sweep_completed', { checked: studies.length, expired: expired.length });
    }
  } catch (err) {
    log('error', 'study.deleted_retention_sweep_failed', { error: extractAxiosError(err) });
  } finally {
    deletedStudySweepInFlight = false;
  }
}

let orthancDeleteReconcileInFlight = false;
async function reconcileStudiesDeletedFromOrthanc() {
  if (orthancDeleteReconcileInFlight) return;
  orthancDeleteReconcileInFlight = true;
  try {
    const studies = loadStudies().filter(function (study) {
      return sanitizeText(study && study.orthanc_study_id) && !sanitizeText(study && study.deleted_at);
    });

    for (const study of studies) {
      let exists = true;
      try {
        exists = await orthancStudyExists(study.orthanc_study_id);
      } catch (err) {
        log('warn', 'orthanc.delete_reconcile_check_failed', {
          study_id: study.id,
          orthanc_study_id: study.orthanc_study_id,
          error: extractAxiosError(err),
        });
        continue;
      }

      if (!exists) {
        const latest = loadStudies();
        const current = findStudy(latest, study.id);
        if (current && !sanitizeText(current.deleted_at)) {
          await softDeleteStudyAcrossPlatforms(latest, current, 'orthanc_missing');
        }
      }
    }
  } catch (err) {
    log('error', 'orthanc.delete_reconcile_failed', { error: extractAxiosError(err) });
  } finally {
    orthancDeleteReconcileInFlight = false;
  }
}

function getMediaExportName(prefix, fileUrl, fallbackExt) {
  const cleanPrefix = sanitizeFolderName(prefix || 'file');
  const originalName = sanitizeFolderName(path.basename(sanitizeText(fileUrl || '')));
  if (originalName && originalName !== 'Unknown') {
    return originalName;
  }
  return `${cleanPrefix}${fallbackExt || ''}`;
}

function getStudyCloudMetadata(study, recordings) {
  return {
    exported_at: nowIso(),
    study: {
      id: study.id,
      patient_name: study.patient_name || null,
      patient_id: study.patient_id || null,
      patient_age: study.patient_age || null,
      patient_sex: study.patient_sex || null,
      patient_zip: study.patient_zip || null,
      study_date: study.study_date || null,
      modality: study.modality || null,
      status: study.status || null,
      dicom_count: study.dicom_count || 0,
      orthanc_patient_id: study.orthanc_patient_id || null,
      orthanc_study_id: study.orthanc_study_id || null,
      created_at: study.created_at || null,
      updated_at: study.updated_at || null,
    },
    media: {
      mp4_url: study.mp4_url || null,
      pdf_url: study.pdf_url || null,
      report_count: normalizeCaseReports(study).length,
      recording_count: recordings.length,
    },
  };
}

async function exportStudyDicomToNextcloud(study, studyPath) {
  if (!study.orthanc_study_id) return 0;

  const instanceIds = await fetchStudyInstanceIds(study.orthanc_study_id);
  if (!instanceIds.length) return 0;

  await ncCreateFolder(`${studyPath}/dicom`);

  let exported = 0;
  for (let index = 0; index < instanceIds.length; index += 1) {
    const instanceId = instanceIds[index];
    const response = await orthancClient.get(`/instances/${instanceId}/file`, {
      responseType: 'stream',
      timeout: ORTHANC_UPLOAD_TIMEOUT_MS,
    });
    const fileName = `instance-${String(index + 1).padStart(5, '0')}-${sanitizeFolderName(instanceId)}.dcm`;
    await ncUploadStream(`${studyPath}/dicom/${fileName}`, response.data, 'application/dicom');
    exported += 1;
  }

  return exported;
}

async function exportStudyToNextcloud(studyId, opts) {
  const configError = requireNextcloudConfig();
  if (configError) {
    throw makeAppError('NEXTCLOUD_NOT_CONFIGURED', 503, configError);
  }

  const studies = loadStudies();
  const study = findStudy(studies, studyId);
  if (!study) {
    throw makeAppError('NOT_FOUND', 404, 'Study not found.');
  }

  const studyPath = getCaseCloudFolder(study);
  const recordings = loadCaseRecordings().filter(function (record) {
    return Number(record && record.studyId) === Number(study.id);
  });
  const reports = normalizeCaseReports(study);

  await ncCreateFolder('/Cases');
  await ncCreateFolder(studyPath);
  await ncCreateFolder(`${studyPath}/reports`);
  await ncCreateFolder(`${studyPath}/recordings`);
  await ncCreateFolder(`${studyPath}/attachments`);

  const notesText = [
    `Case: ${sanitizeText(study.patient_name) || `Case ${study.id}`}`,
    `Study ID: ${study.id}`,
    `Study date: ${sanitizeText(study.study_date) || ''}`,
    `Modality: ${sanitizeText(study.modality) || ''}`,
    '',
    'Notes:',
    sanitizeMultilineText(study.notes) || '',
    '',
    'Tech notes:',
    sanitizeMultilineText(study.tech_notes) || '',
    '',
  ].join('\n');
  await ncUploadBuffer(`${studyPath}/tech-notes.txt`, Buffer.from(notesText, 'utf8'), 'text/plain; charset=utf-8');
  await ncUploadBuffer(
    `${studyPath}/metadata.json`,
    Buffer.from(JSON.stringify(getStudyCloudMetadata(study, recordings), null, 2), 'utf8'),
    'application/json'
  );

  if (study.mp4_url) {
    const localPath = resolveMediaAbsolutePath(study.mp4_url);
    if (localPath && fs.existsSync(localPath)) {
      await ncUploadFile(`${studyPath}/video-${study.id}.mp4`, localPath);
    }
  }

  if (study.pdf_url) {
    const localPath = resolveMediaAbsolutePath(study.pdf_url);
    if (localPath && fs.existsSync(localPath)) {
      await ncUploadFile(`${studyPath}/reports/study-report-${study.id}.pdf`, localPath);
    }
  }

  for (const report of reports) {
    const localPath = resolveMediaAbsolutePath(report.report_url);
    if (!localPath || !fs.existsSync(localPath)) continue;
    const ext = path.extname(report.filename || localPath) || '.txt';
    const name = getMediaExportName(`report-${report.id}`, report.filename || report.report_url, ext);
    await ncUploadFile(`${studyPath}/reports/${name}`, localPath);
  }

  for (const recording of recordings) {
    const localPath = resolveMediaAbsolutePath(recording.recording_url);
    if (!localPath || !fs.existsSync(localPath)) continue;
    const ext = path.extname(recording.filename || localPath) || '.webm';
    const name = getMediaExportName(`recording-${recording.id}`, recording.filename || recording.recording_url, ext);
    await ncUploadFile(`${studyPath}/recordings/${name}`, localPath);
  }

  const dicomExported = await exportStudyDicomToNextcloud(study, studyPath);
  const shareUrl = await ncCreateShare(studyPath);

  study.nextcloud_folder = studyPath;
  study.nextcloud_url = shareUrl;
  study.nextcloud_exported_at = nowIso();
  study.nextcloud_export_status = 'ready';
  touchStudy(study);
  saveStudies(studies);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
  }

  log('info', 'nextcloud.export_completed', {
    study_id: study.id,
    reason: sanitizeText(opts && opts.reason),
    folder: studyPath,
    reports: reports.length,
    recordings: recordings.length,
    dicom_exported: dicomExported,
  });

  return {
    ok: true,
    success: true,
    folder: studyPath,
    url: shareUrl,
    dicom_exported: dicomExported,
    study: study,
  };
}

function scheduleNextcloudExport(studyId, reason) {
  const cleanStudyId = Number(studyId);
  if (!Number.isFinite(cleanStudyId) || cleanStudyId <= 0) return;
  if (!NEXTCLOUD_URL || !NEXTCLOUD_USERNAME || !NEXTCLOUD_PASSWORD) return;

  const previous = pendingNextcloudExports.get(cleanStudyId);
  if (previous) {
    clearTimeout(previous);
  }

  const timer = setTimeout(function () {
    pendingNextcloudExports.delete(cleanStudyId);
    exportStudyToNextcloud(cleanStudyId, { reason: reason || 'auto' }).catch(function (err) {
      const studies = loadStudies();
      const study = findStudy(studies, cleanStudyId);
      if (study) {
        study.nextcloud_export_status = 'error';
        study.nextcloud_export_error = sanitizeText(err && err.message) || 'Export failed.';
        touchStudy(study);
        saveStudies(studies);
      }
      log('error', 'nextcloud.auto_export_failed', {
        study_id: cleanStudyId,
        reason: sanitizeText(reason),
        error: extractAxiosError(err),
      });
    });
  }, 15000);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  pendingNextcloudExports.set(cleanStudyId, timer);
}

function extractAxiosError(err) {
  if (!err) return 'Unknown error';
  if (err.code && err.status) {
    return err.details !== undefined ? err.details : err.message || 'Unknown error';
  }
  if (err.response && err.response.data) return err.response.data;
  return err.message || 'Unknown error';
}

function sendError(res, statusCode, code, message, details) {
  const payload = {
    ok: false,
    error: {
      code: code,
      message: message,
    },
  };

  if (details !== undefined) {
    payload.error.details = details;
  }

  return res.status(statusCode).json(payload);
}

function formatUploadLimitLabel(maxMb) {
  if (!Number.isFinite(maxMb) || maxMb <= 0) return `${maxMb}MB`;
  if (maxMb >= 1024) {
    const gb = maxMb / 1024;
    const rounded = Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
    return `${rounded}GB`;
  }
  return `${maxMb}MB`;
}

function log(level, event, fields) {
  const entry = {
    ts: nowIso(),
    level: level,
    event: event,
    ...fields,
  };

  if (level === 'error') {
    console.error(JSON.stringify(entry));
    return;
  }

  console.log(JSON.stringify(entry));
}

function warnInsecureDefaults() {
  if (!ORTHANC_PASSWORD) {
    log('warn', 'config.orthanc_password_missing', {
      message: 'ORTHANC_PASSWORD is empty. Orthanc requests may fail unless anonymous access is enabled.',
    });
  }

  if (!NEXTCLOUD_URL || !NEXTCLOUD_USERNAME || !NEXTCLOUD_PASSWORD) {
    log('warn', 'config.nextcloud_not_configured', {
      message: 'Nextcloud export route will return 503 until NEXTCLOUD_* env vars are set.',
    });
  }

  if (ALLOWED_ORIGINS.length === 0) {
    log('warn', 'config.cors_open', {
      message: 'CORS is open to all origins. Set CORS_ALLOWED_ORIGINS for production.',
    });
  }
}

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get(
  '/api/health',
  asyncHandler(async function (req, res) {
    try {
      const response = await orthancClient.get('/system');
      return res.json({
        ok: true,
        service: 'mapdr-api',
        env: NODE_ENV,
        orthanc: {
          ok: true,
          details: response.data,
        },
      });
    } catch (err) {
      return sendError(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Orthanc health check failed.', extractAxiosError(err));
    }
  })
);

app.get(
  '/api/ready',
  asyncHandler(async function (req, res) {
    let orthancOk = false;

    try {
      await orthancClient.get('/system');
      orthancOk = true;
    } catch (err) {
      orthancOk = false;
    }

    if (!orthancOk) {
      return sendError(res, 503, 'NOT_READY', 'Service is not ready: Orthanc unreachable.');
    }

    return res.json({
      ok: true,
      ready: true,
      env: NODE_ENV,
    });
  })
);

app.get('/api/metrics', function (req, res) {
  const context = requireStudyRole(req, res, ['admin']);
  if (!context) return;

  const lines = [];
  lines.push('# HELP mapdr_api_requests_total Total API requests observed');
  lines.push('# TYPE mapdr_api_requests_total counter');
  lines.push(`mapdr_api_requests_total ${requestMetrics.total_requests}`);
  lines.push('# HELP mapdr_api_errors_5xx_total Total API 5xx responses observed');
  lines.push('# TYPE mapdr_api_errors_5xx_total counter');
  lines.push(`mapdr_api_errors_5xx_total ${requestMetrics.total_errors_5xx}`);
  lines.push('# HELP mapdr_api_route_requests_total Requests per route');
  lines.push('# TYPE mapdr_api_route_requests_total counter');
  lines.push('# HELP mapdr_api_route_avg_duration_ms Average response time per route in milliseconds');
  lines.push('# TYPE mapdr_api_route_avg_duration_ms gauge');

  for (const [routeKey, bucket] of requestMetrics.routes.entries()) {
    const safeRoute = routeKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const avgDuration = bucket.count > 0 ? bucket.total_duration_ms / bucket.count : 0;
    lines.push(`mapdr_api_route_requests_total{route="${safeRoute}"} ${bucket.count}`);
    lines.push(`mapdr_api_route_avg_duration_ms{route="${safeRoute}"} ${avgDuration.toFixed(2)}`);
    lines.push(`mapdr_api_route_errors_5xx_total{route="${safeRoute}"} ${bucket.errors_5xx}`);
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return res.send(lines.join('\n') + '\n');
});

app.post('/api/studies', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  try {
    const validationError = validateStudyPayload(req.body || {});
    if (validationError) {
      return sendError(res, 400, 'VALIDATION_ERROR', validationError);
    }

    const studies = loadStudies();
    const study = makeStudyRecord(studies, req.body || {});

    studies.push(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }

    return res.json(study);
  } catch (err) {
    return sendError(res, 500, 'STUDY_CREATE_FAILED', 'Failed to create study.', err.message);
  }
});

app.post(
  '/api/dicom/preconvert-jpeg2000',
  uploadDicomPreconvert.array('dicom_files'),
  asyncHandler(async function (req, res) {
    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No DICOM files uploaded for conversion.');
    }

    const convertJpeg2000ToDcm = parseBooleanFlag(req.body && req.body.convert_jpeg2000_to_dcm);

    try {
      const conversion = await preconvertDicomFiles(req.files, {
        convertJpeg2000ToDcm: convertJpeg2000ToDcm,
      });
      log('info', 'dicom.preconvert.completed', {
        requestId: req.requestId,
        files_received: req.files.length,
        receive_ms: Date.now() - (req.startedAt || Date.now()),
        converted_count: conversion.convertedCount,
        timings: conversion.timings,
      });
      const cached = cacheDicomConvertedFiles(conversion.files, {
        total_count: conversion.totalCount,
        converted_count: conversion.convertedCount,
        request_id: req.requestId,
        requested_ip: req.ip,
      });

      cleanupUploadedFiles(req.files);

      return res.json({
        ok: true,
        conversion_token: cached.token,
        conversion_expires_at: cached.expires_at,
        dicom_total_count: conversion.totalCount,
        dicom_converted_count: conversion.convertedCount,
        dicom_converted_files: conversion.conversionDetails
          .filter(function (item) {
            return Boolean(item.converted);
          })
          .slice(0, 20),
        dicom_preconvert_timings: conversion.timings,
      });
    } catch (err) {
      cleanupUploadedFiles(req.files);
      if (err && err.code && err.status) {
        return sendError(res, err.status, err.code, err.message, err.details);
      }
      return sendError(res, 502, 'DICOM_PRECONVERT_FAILED', 'Failed to convert selected DICOM files.', extractAxiosError(err));
    }
  })
);

app.post(
  '/api/studies/:id/dicom',
  uploadDicom.array('dicom_files'),
  asyncHandler(async function (req, res) {
    const receiveMs = Date.now() - (req.startedAt || Date.now());
    const convertJpeg2000ToDcm = parseBooleanFlag(req.body && req.body.convert_jpeg2000_to_dcm);
    const redactTextOnUpload = parseOptionalBooleanFlag(req.body && req.body.redact_text_on_upload);
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }

    let uploadFiles = [];
    try {
      uploadFiles = consumeOrResolveDicomUploadFiles(req);
    } catch (resolveErr) {
      cleanupUploadedFiles(req.files);
      return sendError(
        res,
        resolveErr.status || 409,
        resolveErr.code || 'DICOM_UPLOAD_SOURCE_INVALID',
        resolveErr.message || 'No DICOM files uploaded.'
      );
    }

    if (!uploadFiles || uploadFiles.length === 0) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 400, 'VALIDATION_ERROR', 'No DICOM files uploaded.');
    }

    log('info', 'dicom.upload.received', {
      requestId: req.requestId,
      study_id: String(req.params.id),
      files_received: uploadFiles.length,
      uploaded_bytes: uploadFiles.reduce(function (sum, file) {
        return sum + Math.max(resolveInputFileSize(file), 0);
      }, 0),
      receive_ms: receiveMs,
      convert_jpeg2000_to_dcm: convertJpeg2000ToDcm,
      redact_text_on_upload: redactTextOnUpload,
    });

    try {
      const result = await uploadDicomFilesToOrthanc(uploadFiles, {
        convertJpeg2000ToDcm: convertJpeg2000ToDcm,
        redactTextOnUpload: redactTextOnUpload,
        dicomUidNamespace: `mapdr-study-${study.id}`,
      });
      log('info', 'dicom.upload.orthanc_completed', {
        requestId: req.requestId,
        study_id: String(req.params.id),
        uploaded_count: result.uploadedCount,
        failed_count: result.failedFiles.length,
        converted_count: result.convertedCount,
        redacted_count: result.redactedCount,
        redaction_failed_count: result.redactionFailedCount,
        timings: result.timings,
      });

      study.orthanc_patient_id = result.orthancPatientId || study.orthanc_patient_id;
      study.orthanc_study_id = result.orthancStudyId || study.orthanc_study_id;
      study.dicom_count = (study.dicom_count || 0) + result.uploadedCount;
      study.status = 'ready';
      touchStudy(study);

      saveStudies(studies);
      cleanupUploadedFiles(req.files);
      scheduleNextcloudExport(study.id, 'dicom_upload');

      return res.json({
        ok: true,
        success: true,
        orthanc_patient_id: study.orthanc_patient_id,
        orthanc_study_id: study.orthanc_study_id,
        dicom_count: study.dicom_count,
        dicom_converted_count: result.convertedCount || 0,
        dicom_redacted_count: result.redactedCount || 0,
        dicom_redaction_failed_count: result.redactionFailedCount || 0,
        dicom_converted_files: (result.convertedFiles || []).slice(0, 20),
        dicom_redaction_failed_files: (result.redactionFailedFiles || []).slice(0, 20),
        dicom_failed_count: result.failedFiles.length,
        dicom_failed_files: result.failedFiles.slice(0, 20),
        dicom_upload_timings: {
          receive_ms: receiveMs,
          ...(result.timings || {}),
        },
        study: study,
      });
    } catch (err) {
      cleanupUploadedFiles(req.files);
      study.status = 'error';
      touchStudy(study);
      saveStudies(studies);

      return sendError(res, 502, 'ORTHANC_UPLOAD_FAILED', 'Failed to upload DICOM files to Orthanc.', extractAxiosError(err));
    }
  })
);

app.post('/api/studies/:id/mp4', uploadMp4.single('mp4_file'), function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    cleanUploadedFile(req.file);
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }

  if (!req.file) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No MP4 file uploaded.');
  }

  try {
    deleteLocalMediaFile(study.mp4_url);
    const moved = moveSingleUploadedFile(req.file, `study-${study.id}-video`, '.mp4');
    study.mp4_url = moved.url;
    study.status = 'ready';
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    scheduleNextcloudExport(study.id, 'mp4_upload');

    return res.json({
      ok: true,
      success: true,
      mp4_url: study.mp4_url,
      study: study,
    });
  } catch (err) {
    cleanUploadedFile(req.file);
    return sendError(res, 500, 'MP4_UPLOAD_FAILED', 'Failed to process MP4 upload.', err.message);
  }
});

app.post('/api/studies/:id/pdf', uploadPdf.single('pdf_file'), function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    cleanUploadedFile(req.file);
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }

  if (!req.file) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No PDF file uploaded.');
  }

  try {
    deleteLocalMediaFile(study.pdf_url);
    const moved = moveSingleUploadedFile(req.file, `study-${study.id}-report`, '.pdf');
    study.pdf_url = moved.url;
    touchStudy(study);
    saveStudies(studies);
    scheduleNextcloudExport(study.id, 'pdf_upload');

    return res.json({
      ok: true,
      success: true,
      pdf_url: study.pdf_url,
      study: study,
    });
  } catch (err) {
    cleanUploadedFile(req.file);
    return sendError(res, 500, 'PDF_UPLOAD_FAILED', 'Failed to process PDF upload.', err.message);
  }
});

app.post(
  '/api/upload-dicom',
  uploadDicom.array('dicom_files'),
  asyncHandler(async function (req, res) {
    const receiveMs = Date.now() - (req.startedAt || Date.now());
    const convertJpeg2000ToDcm = parseBooleanFlag(req.body && req.body.convert_jpeg2000_to_dcm);
    const redactTextOnUpload = parseOptionalBooleanFlag(req.body && req.body.redact_text_on_upload);
    let uploadFiles = [];
    try {
      uploadFiles = consumeOrResolveDicomUploadFiles(req);
    } catch (resolveErr) {
      cleanupUploadedFiles(req.files);
      return sendError(
        res,
        resolveErr.status || 409,
        resolveErr.code || 'DICOM_UPLOAD_SOURCE_INVALID',
        resolveErr.message || 'No DICOM files uploaded.'
      );
    }

    if (!uploadFiles || uploadFiles.length === 0) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 400, 'VALIDATION_ERROR', 'No DICOM files uploaded.');
    }

    const studies = loadStudies();
    const study = makeStudyRecord(studies, req.body || {});
    log('info', 'dicom.upload.received', {
      requestId: req.requestId,
      study_id: String(study.id),
      files_received: uploadFiles.length,
      uploaded_bytes: uploadFiles.reduce(function (sum, file) {
        return sum + Math.max(resolveInputFileSize(file), 0);
      }, 0),
      receive_ms: receiveMs,
      convert_jpeg2000_to_dcm: convertJpeg2000ToDcm,
      redact_text_on_upload: redactTextOnUpload,
      legacy_route: true,
    });

    try {
      const result = await uploadDicomFilesToOrthanc(uploadFiles, {
        convertJpeg2000ToDcm: convertJpeg2000ToDcm,
        redactTextOnUpload: redactTextOnUpload,
        dicomUidNamespace: `mapdr-study-${study.id}`,
      });
      log('info', 'dicom.upload.orthanc_completed', {
        requestId: req.requestId,
        study_id: String(study.id),
        uploaded_count: result.uploadedCount,
        failed_count: result.failedFiles.length,
        converted_count: result.convertedCount,
        redacted_count: result.redactedCount,
        redaction_failed_count: result.redactionFailedCount,
        timings: result.timings,
        legacy_route: true,
      });

      study.orthanc_patient_id = result.orthancPatientId;
      study.orthanc_study_id = result.orthancStudyId;
      study.dicom_count = result.uploadedCount;
      study.status = 'ready';
      touchStudy(study);

      studies.push(study);
      saveStudies(studies);
      cleanupUploadedFiles(req.files);
      scheduleNextcloudExport(study.id, 'dicom_upload_legacy');

      return res.json({
        ok: true,
        study_id: study.id,
        orthanc_patient_id: study.orthanc_patient_id,
        orthanc_study_id: study.orthanc_study_id,
        dicom_count: study.dicom_count,
        dicom_converted_count: result.convertedCount || 0,
        dicom_redacted_count: result.redactedCount || 0,
        dicom_redaction_failed_count: result.redactionFailedCount || 0,
        dicom_converted_files: (result.convertedFiles || []).slice(0, 20),
        dicom_redaction_failed_files: (result.redactionFailedFiles || []).slice(0, 20),
        dicom_failed_count: result.failedFiles.length,
        dicom_failed_files: result.failedFiles.slice(0, 20),
        dicom_upload_timings: {
          receive_ms: receiveMs,
          ...(result.timings || {}),
        },
        study: study,
      });
    } catch (err) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 502, 'ORTHANC_UPLOAD_FAILED', 'Failed to upload DICOM files to Orthanc.', extractAxiosError(err));
    }
  })
);

app.post('/api/upload-mp4/:id', uploadMp4.single('mp4_file'), function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    cleanUploadedFile(req.file);
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }

  if (!req.file) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No MP4 file uploaded.');
  }

  try {
    deleteLocalMediaFile(study.mp4_url);
    const moved = moveSingleUploadedFile(req.file, `study-${study.id}-video`, '.mp4');
    study.mp4_url = moved.url;
    study.status = 'ready';
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    scheduleNextcloudExport(study.id, 'mp4_upload_legacy');

    return res.json({
      ok: true,
      mp4_url: study.mp4_url,
      study: study,
    });
  } catch (err) {
    cleanUploadedFile(req.file);
    return sendError(res, 500, 'MP4_UPLOAD_FAILED', 'Failed to process MP4 upload.', err.message);
  }
});

app.get('/api/live-cases/active', asyncHandler(async function (req, res) {
  const context = getStudyAccessContext(req);
  const requesterEmail = sanitizeText(req.query.started_by_email).toLowerCase();
  let sessions = (await pgReadActiveLiveSessions()) || getActiveLiveSessions();
  if (requesterEmail && context.isAuthenticated) {
    sessions = sessions.filter(function (session) {
      return sanitizeText(session.started_by_email).toLowerCase() === requesterEmail;
    });
  } else if (requesterEmail) {
    sessions = [];
  }
  sessions = sessions.sort(function (left, right) {
    return new Date(right.started_at || 0).getTime() - new Date(left.started_at || 0).getTime();
  });
  return res.json({
    ok: true,
    sessions: sessions,
  });
}));

app.post('/api/live-cases/start', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const studies = loadStudies();
  const sessions = loadLiveCaseSessions();

  let study = null;
  const requestedStudyId = Number(req.body && req.body.study_id);
  if (Number.isFinite(requestedStudyId) && requestedStudyId > 0) {
    study = findStudy(studies, requestedStudyId);
    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found for live share.');
    }
  } else {
    study = makeStudyRecord(studies, req.body || {});
    study.status = 'processing';
    touchStudy(study);
    studies.push(study);
    saveStudies(studies);
  }

  const now = nowIso();
  const session = {
    id: crypto.randomUUID(),
    study_id: study.id,
    started_at: now,
    last_seen_at: now,
    ended_at: null,
    started_by_email: sanitizeText(req.body && req.body.started_by_email) || null,
    started_by_name: sanitizeText(req.body && req.body.started_by_name) || null,
    finalized_at: null,
    finalized_mp4_url: null,
    upload_in_progress: false,
  };

  sessions.push(session);
  saveLiveCaseSessions(sessions);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
    pgDualWriteLiveSession(session);
  }

  return res.status(201).json({
    ok: true,
    session: session,
    study: {
      ...study,
      live_streaming: true,
    },
  });
});

app.post('/api/live-cases/:sessionId/heartbeat', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const sessionId = sanitizeText(req.params.sessionId);
  const sessions = loadLiveCaseSessions();
  const session = sessions.find(function (entry) {
    return entry.id === sessionId;
  });

  if (!session) {
    return sendError(res, 404, 'NOT_FOUND', 'Live session not found.');
  }

  if (!session.ended_at) {
    session.last_seen_at = nowIso();
    saveLiveCaseSessions(sessions);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteLiveSession(session);
    }
  }

  return res.json({ ok: true, session: session });
});

app.post('/api/live-cases/:sessionId/stop', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const sessionId = sanitizeText(req.params.sessionId);
  const sessions = loadLiveCaseSessions();
  const session = sessions.find(function (entry) {
    return entry.id === sessionId;
  });

  if (!session) {
    return sendError(res, 404, 'NOT_FOUND', 'Live session not found.');
  }

  session.last_seen_at = nowIso();
  session.ended_at = nowIso();
  saveLiveCaseSessions(sessions);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteLiveSession(session);
  }

  return res.json({ ok: true, session: session });
});

app.get('/api/live-cases/finalize-jobs/:jobId', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const jobId = sanitizeText(req.params.jobId);
  if (pgPool) {
    pgPool
      .query(
        `SELECT id, live_session_id, study_id, source_path, target_path, status, attempts, error, created_at, updated_at
         FROM live_finalize_jobs
         WHERE id = $1::uuid
         LIMIT 1`,
        [jobId]
      )
      .then(function (result) {
        if (!result.rows.length) {
          return sendError(res, 404, 'NOT_FOUND', 'Finalize job not found.');
        }
        return res.json({ ok: true, job: result.rows[0] });
      })
      .catch(function (err) {
        return sendError(res, 500, 'DB_QUERY_FAILED', 'Failed to query finalize job.', { message: err.message });
      });
    return;
  }
  const jobs = loadLiveFinalizeJobs();
  const job = jobs.find(function (entry) {
    return sanitizeText(entry.id) === jobId;
  });
  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Finalize job not found.');
  }
  return res.json({ ok: true, job: job });
});

app.get('/api/live-cases/finalize-jobs', function (req, res) {
  const context = requireStudyRole(req, res, ['admin']);
  if (!context) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  if (pgPool) {
    pgPool
      .query(
        `SELECT id, live_session_id, study_id, source_path, target_path, status, attempts, error, created_at, updated_at
         FROM live_finalize_jobs
         ORDER BY updated_at DESC
         LIMIT $1`,
        [limit]
      )
      .then(function (result) {
        return res.json({ ok: true, jobs: result.rows });
      })
      .catch(function (err) {
        return sendError(res, 500, 'DB_QUERY_FAILED', 'Failed to list finalize jobs.', { message: err.message });
      });
    return;
  }

  const jobs = loadLiveFinalizeJobs()
    .slice()
    .sort(function (a, b) {
      return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    })
    .slice(0, limit);
  return res.json({ ok: true, jobs: jobs });
});

app.post('/api/live-cases/finalize-jobs/:jobId/retry', function (req, res) {
  const context = requireStudyRole(req, res, ['admin']);
  if (!context) return;
  const jobId = sanitizeText(req.params.jobId);

  if (pgPool) {
    pgPool
      .query(
        `UPDATE live_finalize_jobs
         SET status = 'queued', error = NULL, updated_at = NOW()
         WHERE id = $1::uuid
         RETURNING id, status, attempts, updated_at`,
        [jobId]
      )
      .then(function (result) {
        if (!result.rows.length) {
          return sendError(res, 404, 'NOT_FOUND', 'Finalize job not found.');
        }
        return res.json({ ok: true, job: result.rows[0] });
      })
      .catch(function (err) {
        return sendError(res, 500, 'DB_UPDATE_FAILED', 'Failed to retry finalize job.', { message: err.message });
      });
    return;
  }

  const updated = updateLiveFinalizeJob(jobId, function (draft) {
    draft.status = 'queued';
    draft.error = null;
  });
  if (!updated) {
    return sendError(res, 404, 'NOT_FOUND', 'Finalize job not found.');
  }
  return res.json({ ok: true, job: updated });
});

app.post(
  '/api/live-cases/:sessionId/upload-recording',
  uploadCaseRecording.single('recording_file'),
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) return;
    const sessionId = sanitizeText(req.params.sessionId);
    const sessions = loadLiveCaseSessions();
    const session = sessions.find(function (entry) {
      return entry.id === sessionId;
    });

    if (!session) {
      cleanUploadedFile(req.file);
      return sendError(res, 404, 'NOT_FOUND', 'Live session not found.');
    }

    if (!req.file || !req.file.path) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No recording file uploaded.');
    }

    const studies = loadStudies();
    const study = findStudy(studies, session.study_id);
    if (!study) {
      cleanUploadedFile(req.file);
      return sendError(res, 404, 'NOT_FOUND', 'Study not found for live session.');
    }

    const outputFilename = `study-${study.id}-live-${Date.now()}.mp4`;
    const outputPath = path.join(MEDIA_DIR, outputFilename);
    const outputUrl = `/media/${outputFilename}`;
    let stagedSourcePath = null;

    try {
      if (session.finalized_at && session.finalized_mp4_url) {
        return res.json({
          ok: true,
          idempotent: true,
          mp4_url: session.finalized_mp4_url,
          study: {
            ...study,
            live_streaming: false,
          },
          session: session,
        });
      }

      if (session.upload_in_progress) {
        return sendError(res, 409, 'LIVE_RECORDING_FINALIZE_IN_PROGRESS', 'Live recording finalize is already in progress.');
      }

      session.upload_in_progress = true;
      session.last_seen_at = nowIso();
      saveLiveCaseSessions(sessions);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteLiveSession(session);
      }

      if (ENABLE_LIVE_FINALIZE_QUEUE) {
        stagedSourcePath = path.join(
          TMP_DIR,
          `live-finalize-${session.id}-${Date.now()}.webm`
        );
        fs.renameSync(req.file.path, stagedSourcePath);
        validateRecordingUploadIntegrity(stagedSourcePath, req.body);
        const queuedJob = await enqueueLiveFinalizeJob({
          live_session_id: session.id,
          study_id: study.id,
          source_path: stagedSourcePath,
          target_path: outputPath,
        });
        return res.status(202).json({
          ok: true,
          queued: true,
          job: queuedJob,
          session: session,
          study: {
            ...study,
            live_streaming: false,
          },
        });
      }

      validateRecordingUploadIntegrity(req.file.path, req.body);
      await runFfmpeg([
        '-y',
        '-fflags',
        '+genpts',
        '-i',
        req.file.path,
        '-vf',
        'setpts=PTS-STARTPTS',
        '-c:v',
        'libx264',
        '-preset',
        CASE_STREAM_X264_PRESET,
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-avoid_negative_ts',
        'make_zero',
        '-c:a',
        'aac',
        outputPath,
      ]);

      deleteLocalMediaFile(study.mp4_url);
      study.mp4_url = outputUrl;
      study.status = 'ready';
      touchStudy(study);
      saveStudies(studies);

      session.last_seen_at = nowIso();
      session.ended_at = session.ended_at || nowIso();
      session.finalized_at = nowIso();
      session.finalized_mp4_url = study.mp4_url;
      session.upload_in_progress = false;
      saveLiveCaseSessions(sessions);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteStudy(study);
        pgDualWriteLiveSession(session);
      }
      scheduleNextcloudExport(study.id, 'live_recording_upload');

      return res.json({
        ok: true,
        mp4_url: study.mp4_url,
        study: {
          ...study,
          live_streaming: false,
        },
        session: session,
      });
    } catch (err) {
      session.upload_in_progress = false;
      session.last_seen_at = nowIso();
      saveLiveCaseSessions(sessions);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteLiveSession(session);
      }
      log('error', 'live_case.upload_recording_failed', { message: err.message, sessionId: session.id, studyId: study.id });
      if (stagedSourcePath) {
        try {
          fs.unlinkSync(stagedSourcePath);
        } catch (_) {}
      }
      return sendError(res, err.status || 500, err.code || 'LIVE_RECORDING_CONVERT_FAILED', err.status ? err.message : 'Failed to convert live recording to MP4.', {
        message: sanitizeText(err.message),
      });
    } finally {
      if (!ENABLE_LIVE_FINALIZE_QUEUE) {
        cleanUploadedFile(req.file);
      }
      try {
        fs.unlinkSync(outputPath + '.tmp');
      } catch (_) {}
    }
  })
);

app.get('/api/studies', asyncHandler(async function (req, res) {
  const search = sanitizeText(req.query.search).toLowerCase();
  const includeDeleted = parseBooleanFlag(req.query && req.query.include_deleted);
  const deletedOnly = parseBooleanFlag(req.query && req.query.deleted_only);
  let studies = (await pgReadStudies()) || loadStudies();
  const recordings = loadCaseRecordings();
  const recordingCountByStudyId = new Map();
  recordings.forEach(function (record) {
    const studyId = Number(record && record.studyId);
    if (!Number.isFinite(studyId) || studyId <= 0) return;
    recordingCountByStudyId.set(studyId, (recordingCountByStudyId.get(studyId) || 0) + 1);
  });
  const recordingStudyIds = new Set(
    recordings
      .map(function (record) {
        return Number(record && record.studyId);
      })
      .filter(function (id) {
        return Number.isFinite(id) && id > 0;
      })
  );
  const allLiveSessions = loadLiveCaseSessions();
  const uploadInProgressStudyIds = new Set(
    allLiveSessions
      .filter(function (session) {
        return Boolean(session && session.upload_in_progress);
      })
      .map(function (session) {
        return Number(session.study_id);
      })
      .filter(function (id) {
        return Number.isFinite(id) && id > 0;
      })
  );
  const activeLiveSessions = (await pgReadActiveLiveSessions()) || getActiveLiveSessions();
  const liveStudyIds = new Set(
    activeLiveSessions
      .map(function (session) {
        return Number(session.study_id);
      })
      .filter(function (id) {
        return Number.isFinite(id) && id > 0;
      })
  );
  const healed = maybeHealStaleProcessingStudyStatus(studies, {
    liveStudyIds: liveStudyIds,
    uploadInProgressStudyIds: uploadInProgressStudyIds,
    recordingStudyIds: recordingStudyIds,
  });
  if (healed) {
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      studies.forEach(function (study) {
        pgDualWriteStudy(study);
      });
    }
  }

  if (search) {
    studies = studies.filter(function (s) {
      return [s.patient_name, s.patient_id, s.modality, s.notes]
        .filter(Boolean)
        .some(function (v) {
          return String(v).toLowerCase().indexOf(search) !== -1;
        });
    });
  }

  studies = studies.filter(function (study) {
    const isDeleted = Boolean(sanitizeText(study.deleted_at));
    if (deletedOnly) return isDeleted;
    if (includeDeleted) return true;
    return !isDeleted;
  });

  studies.sort(function (a, b) {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return res.json(
    studies.map(function (study) {
      return {
        ...study,
        live_streaming: liveStudyIds.has(Number(study.id)),
        has_recording: recordingStudyIds.has(Number(study.id)),
        recording_count: recordingCountByStudyId.get(Number(study.id)) || 0,
      };
    })
  );
}));

app.get('/api/studies/:id/priors', function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }

  const priorIds = Array.isArray(study.prior_study_ids) ? study.prior_study_ids : [];
  const priorStudies = priorIds
    .map(function (priorId) {
      return findStudy(studies, priorId);
    })
    .filter(Boolean);

  return res.json({
    study_id: study.id,
    prior_study_ids: priorIds,
    priors: priorStudies,
  });
});

app.put('/api/studies/:id/priors', function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }

  const priorStudyIds = parsePriorStudyIds(req.body && req.body.prior_study_ids, study.id);
  const missingId = priorStudyIds.find(function (priorId) {
    return !findStudy(studies, priorId);
  });

  if (missingId) {
    return sendError(res, 400, 'VALIDATION_ERROR', `Prior study ${missingId} does not exist.`);
  }

  const mismatchedPrior = priorStudyIds.find(function (priorId) {
    const priorStudy = findStudy(studies, priorId);
    return priorStudy && !isSamePatientStudy(study, priorStudy);
  });

  if (mismatchedPrior) {
    return sendError(
      res,
      400,
      'VALIDATION_ERROR',
      `Prior study ${mismatchedPrior} belongs to a different patient and cannot be linked.`
    );
  }

  study.prior_study_ids = priorStudyIds;
  touchStudy(study);
  saveStudies(studies);

  const priors = priorStudyIds
    .map(function (priorId) {
      return findStudy(studies, priorId);
    })
    .filter(Boolean);

  return res.json({
    ok: true,
    study_id: study.id,
    prior_study_ids: study.prior_study_ids,
    priors: priors,
    study: study,
  });
});

app.put('/api/studies/:id/tech-notes', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (sanitizeText(study.deleted_at)) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
  }

  study.tech_notes = sanitizeMultilineText(req.body && req.body.tech_notes) || null;
  touchStudy(study);
  saveStudies(studies);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
  }
  scheduleNextcloudExport(study.id, 'tech_notes_update');

  return res.json({
    ok: true,
    study: study,
  });
});

app.get(
  '/api/studies/:id',
  asyncHandler(async function (req, res) {
    const includeDeleted = parseBooleanFlag(req.query && req.query.include_deleted);
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (sanitizeText(study.deleted_at) && !includeDeleted) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    const recordingStudyIds = new Set(
      loadCaseRecordings()
        .map(function (record) {
          return Number(record && record.studyId);
        })
        .filter(function (id) {
          return Number.isFinite(id) && id > 0;
        })
    );
    const activeLiveSessions = getActiveLiveSessions();
    const liveStudyIds = new Set(
      activeLiveSessions
        .map(function (session) {
          return Number(session.study_id);
        })
        .filter(function (id) {
          return Number.isFinite(id) && id > 0;
        })
    );
    const uploadInProgressStudyIds = new Set(
      loadLiveCaseSessions()
        .filter(function (session) {
          return Boolean(session && session.upload_in_progress);
        })
        .map(function (session) {
          return Number(session.study_id);
        })
        .filter(function (id) {
          return Number.isFinite(id) && id > 0;
        })
    );
    const healed = maybeHealStaleProcessingStudyStatus([study], {
      liveStudyIds: liveStudyIds,
      uploadInProgressStudyIds: uploadInProgressStudyIds,
      recordingStudyIds: recordingStudyIds,
    });
    if (healed) {
      saveStudies(studies);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteStudy(study);
      }
    }

    let orthanc = null;

    if (study.orthanc_study_id) {
      try {
        const response = await orthancClient.get(`/studies/${study.orthanc_study_id}`);
        orthanc = response.data;
      } catch (err) {
        orthanc = {
          error: extractAxiosError(err),
        };
      }
    }

    return res.json({
      ok: true,
      study: study,
      orthanc: orthanc,
    });
  })
);

app.delete(
  '/api/studies/:id',
  asyncHandler(async function (req, res) {
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }

    if (sanitizeText(study.deleted_at)) {
      return res.json({
        ok: true,
        success: true,
        already_deleted: true,
        purge_after: getStudyDeletedPurgeAt(study),
      });
    }

    await softDeleteStudyAcrossPlatforms(studies, study, 'api_delete');

    return res.json({
      ok: true,
      success: true,
      purge_after: getStudyDeletedPurgeAt(study),
    });
  })
);

app.post('/api/studies/:id/restore', function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);
  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  study.deleted_at = null;
  study.delete_permanent_after = null;
  study.deleted_reason = null;
  if (study.status === 'deleted') {
    study.status = 'ready';
  }
  touchStudy(study);
  saveStudies(studies);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
  }
  return res.json({ ok: true, study: study });
});

app.delete(
  '/api/studies/:id/permanent',
  asyncHandler(async function (req, res) {
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }

    await permanentlyDeleteStudyRecord(studies, study, 'api_permanent_delete');

    return res.json({
      ok: true,
      success: true,
      permanently_deleted: true,
    });
  })
);

app.get('/api/case-recordings', function (req, res) {
  const context = getStudyAccessContext(req);

  const studyId = sanitizeText(req.query.studyId);
  const caseId = sanitizeText(req.query.caseId);
  if (!studyId && !caseId) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'studyId or caseId is required.');
  }

  const studies = loadStudies();
  const targetStudy = studyId ? findStudy(studies, studyId) : null;

  if (studyId && !targetStudy) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (targetStudy && context.isAuthenticated && !canAccessStudyRecord(context, targetStudy)) {
    return sendError(res, 403, 'FORBIDDEN', 'You are not allowed to access this case.');
  }

  const recordings = loadCaseRecordings()
    .filter(function (entry) {
      if (studyId && String(entry.studyId) !== String(studyId)) return false;
      if (caseId && sanitizeText(entry.caseId) !== caseId) return false;
      if (targetStudy && String(entry.studyId) === String(targetStudy.id)) return true;
      if (studyId || caseId) return true;
      return false;
    })
    .sort(function (a, b) {
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.json({ ok: true, recordings: recordings });
});

app.post(
  '/api/case-recordings/upload',
  uploadCaseRecording.single('recording_file'),
  async function (req, res) {
    const context = getStudyAccessContext(req);
    if (!context.isAuthenticated) {
      cleanUploadedFile(req.file);
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const studies = loadStudies();
    const caseId = sanitizeText(req.body && req.body.caseId);
    const studyId = sanitizeText(req.body && req.body.studyId);
    const studyInstanceUID = sanitizeText(req.body && req.body.studyInstanceUID);
    const patientId = sanitizeText(req.body && req.body.patientId);
    const uploadedBy = sanitizeText(req.body && req.body.uploadedBy) || context.email;

    const study = findStudy(studies, studyId);
    if (!study) {
      cleanUploadedFile(req.file);
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (!canAccessStudyRecord(context, study)) {
      cleanUploadedFile(req.file);
      return sendError(res, 403, 'FORBIDDEN', 'You are not allowed to upload for this case.');
    }
    if (!req.file) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No recording file uploaded.');
    }

    let moved = null;
    try {
      moved = moveSingleUploadedFile(req.file, `case-recording-${study.id}-${Date.now()}`, '.webm', CASE_RECORDINGS_DIR);
      const integrity = validateRecordingUploadIntegrity(moved.path, req.body);
      const normalized = await normalizeWebmRecordingTimestamps(moved.path);
      if (normalized) {
        moved.size = fs.statSync(moved.path).size;
      }
      const recordings = loadCaseRecordings();
      const record = {
        id: crypto.randomUUID(),
        caseId: caseId || null,
        studyId: Number(study.id),
        studyInstanceUID: studyInstanceUID || null,
        patientId: patientId || sanitizeText(study.patient_id) || null,
        uploadedBy: uploadedBy || context.email,
        uploaderRole: context.role || null,
        created_at: nowIso(),
        recording_url: moved.url,
        filename: moved.filename,
        file_size: Number(moved.size) || 0,
        sha256: integrity.sha256 || null,
        timestamps_normalized: normalized,
      };
      recordings.push(record);
      saveCaseRecordings(recordings);
      study.status = 'ready';
      touchStudy(study);
      saveStudies(studies);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteStudy(study);
      }
      scheduleNextcloudExport(study.id, 'case_recording_upload');

      return res.json({ ok: true, recording: record });
    } catch (err) {
      if (moved && moved.path) {
        try {
          fs.unlinkSync(moved.path);
        } catch (_) {}
      }
      cleanUploadedFile(req.file);
      return sendError(
        res,
        err.status || 500,
        err.code || 'CASE_RECORDING_UPLOAD_FAILED',
        err.status ? err.message : 'Failed to process case recording upload.',
        err.details || err.message
      );
    }
  }
);

app.post('/api/case-reports/upload', uploadPdfBatch.array('pdf_files'), function (req, res) {
  if (!req.files || req.files.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No PDF files uploaded.');
  }

  try {
    const reports = req.files.map(function (file, index) {
      const moved = moveSingleUploadedFile(
        file,
        `case-report-${Date.now()}-${index + 1}`,
        '.pdf',
        CASE_REPORTS_DIR
      );
      return {
        report_url: moved.url,
        filename: moved.filename,
        file_size: Number(moved.size) || 0,
        created_at: nowIso(),
      };
    });

    return res.json({ ok: true, reports: reports });
  } catch (err) {
    cleanupUploadedFiles(req.files);
    return sendError(res, 500, 'CASE_REPORT_UPLOAD_FAILED', 'Failed to upload case report PDFs.', err.message);
  }
});

app.get('/api/studies/:id/reports', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);
  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
  }

  return res.json({
    ok: true,
    study_id: study.id,
    reports: normalizeCaseReports(study),
  });
});

app.post(
  '/api/studies/:id/reports',
  uploadCaseReportAttachment.single('report_file'),
  function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) {
      cleanUploadedFile(req.file);
      return;
    }

    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);
    if (!study) {
      cleanUploadedFile(req.file);
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (!canAccessStudyRecord(context, study)) {
      cleanUploadedFile(req.file);
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
    }

    const textReport = sanitizeMultilineText(req.body && req.body.text_report);
    if (!req.file && !textReport) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Upload a report file or enter report text.');
    }

    const reportId = crypto.randomUUID();
    const reportType = inferCaseReportType(req.file, req.body && req.body.report_type, Boolean(textReport));
    const caseLabel = sanitizeText(req.body && req.body.case_label) || makeCaseLabel(study);
    const title = sanitizeText(req.body && req.body.title) || `${caseLabel} report`;
    let moved = null;

    try {
      if (req.file) {
        moved = moveSingleUploadedFile(req.file, `case-report-${study.id}-${reportId}`, '.txt', CASE_REPORTS_DIR);
      } else {
        moved = createTextReportFile(study.id, reportId, textReport);
      }

      const report = {
        id: reportId,
        study_id: Number(study.id),
        case_label: caseLabel,
        title: title,
        report_type: reportType,
        created_at: nowIso(),
        uploaded_by: context.email || null,
        filename: moved.filename,
        file_size: Number(moved.size) || 0,
        mime_type: req.file ? sanitizeText(req.file.mimetype) || null : 'text/plain',
        report_url: moved.url,
        text: textReport || null,
      };

      study.case_reports = normalizeCaseReports(study);
      study.case_reports.push(report);
      touchStudy(study);
      saveStudies(studies);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteStudy(study);
      }
      scheduleNextcloudExport(study.id, 'case_report_upload');

      return res.status(201).json({
        ok: true,
        report: report,
        reports: study.case_reports,
        study: study,
      });
    } catch (err) {
      cleanUploadedFile(req.file);
      if (moved && moved.path) {
        try {
          fs.unlinkSync(moved.path);
        } catch (_) {}
      }
      return sendError(res, 500, 'CASE_REPORT_SAVE_FAILED', 'Failed to save report for this case.', err.message);
    }
  }
);

app.post('/api/studies/:id/share', function (req, res) {
  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }

  const requestedDays = Number(req.body && req.body.expires_in_days);
  const expiresInDays = Number.isFinite(requestedDays)
    ? Math.min(Math.max(requestedDays, 1), 365)
    : SHARE_TTL_DAYS;

  study.share_token = makeShareToken();
  study.share_expires_at = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  touchStudy(study);

  saveStudies(studies);

  return res.json({
    ok: true,
    token: study.share_token,
    share_url: `/shared/${study.share_token}`,
    expires_at: study.share_expires_at,
  });
});

app.get('/api/shared/:token', function (req, res) {
  const studies = loadStudies();
  const study = studies.find(function (s) {
    return s.share_token === req.params.token;
  });

  if (!study) {
    return sendError(res, 404, 'INVALID_SHARE', 'Invalid or expired share link.');
  }

  if (study.share_expires_at && new Date(study.share_expires_at).getTime() < Date.now()) {
    return sendError(res, 404, 'INVALID_SHARE', 'Invalid or expired share link.');
  }

  return res.json(study);
});

app.post(
  '/api/studies/:id/export-nextcloud',
  asyncHandler(async function (req, res) {
    try {
      const result = await exportStudyToNextcloud(req.params.id, { reason: 'manual_export' });
      return res.json(result);
    } catch (err) {
      log('error', 'nextcloud.export_failed', {
        study_id: sanitizeText(req.params.id),
        error: extractAxiosError(err),
      });
      const status = err && err.status ? err.status : 502;
      const code = err && err.code ? err.code : 'NEXTCLOUD_EXPORT_FAILED';
      return sendError(res, status, code, 'Failed to export study to Nextcloud.', extractAxiosError(err));
    }
  })
);

app.get(
  '/api/viewer-link/:id',
  asyncHandler(async function (req, res) {
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }

    if (!VALID_VIEWER_LINK_MODES.has(VIEWER_LINK_MODE)) {
      return sendError(
        res,
        500,
        'VIEWER_LINK_MODE_INVALID',
        'Viewer link mode is not configured correctly.',
        { mode: VIEWER_LINK_MODE }
      );
    }

    if (!study.orthanc_study_id) {
      return sendError(res, 409, 'NO_DICOM_LINKED', 'No DICOM study is linked to this case yet.');
    }

    try {
      const response = await orthancClient.get(`/studies/${study.orthanc_study_id}`);
      const tags = (response && response.data && response.data.MainDicomTags) || {};
      const uid =
        tags &&
        tags.StudyInstanceUID
          ? tags.StudyInstanceUID
          : null;
      const accessionNumber = tags && tags.AccessionNumber ? tags.AccessionNumber : '';

      if (!uid) {
        return sendError(res, 409, 'MISSING_STUDY_UID', 'No StudyInstanceUID found for this case in Orthanc.');
      }

      if (isExternalPacsViewerMode()) {
        const caseLabelParts = [
          sanitizeText(study.patient_name),
          sanitizeText(study.modality),
          sanitizeText(study.study_date),
        ].filter(Boolean);
        const externalViewerUrl = buildExternalPacsViewerUrl(
          resolveExternalPacsViewerBase(req),
          EXTERNAL_PACS_WATCH_PATH,
          {
            mode: 'viewer',
            embedded: '1',
            studyId: study.id,
            orthancStudyId: study.orthanc_study_id,
            studyInstanceUid: uid,
            active_study_id: uid,
            active_accession: accessionNumber,
            patientId: study.patient_id,
            active_patient_token: study.patient_id,
            patientName: study.patient_name,
            modality: study.modality,
            studyDate: study.study_date,
            active_case_label: caseLabelParts.join(' | '),
          }
        );

        return res.json({
          ok: true,
          viewer_url: externalViewerUrl,
        });
      }

      let ohifViewerUrl = '';
      try {
        ohifViewerUrl = buildOhifStudyViewerUrl(resolveOhifViewerBase(req), uid);
      } catch (err) {
        return sendError(
          res,
          500,
          'VIEWER_BASE_INVALID',
          'Viewer base URL is not configured correctly.',
          { reason: err.message }
        );
      }

      return res.json({
        ok: true,
        viewer_url: ohifViewerUrl,
      });
    } catch (err) {
      return sendError(res, 502, 'ORTHANC_LOOKUP_FAILED', 'Failed to resolve DICOM study in Orthanc.', extractAxiosError(err));
    }
  })
);

app.get(
  '/api/studies/:id/dicom-instances',
  asyncHandler(async function (req, res) {
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }

    if (!study.orthanc_study_id) {
      return sendError(res, 409, 'NO_DICOM_LINKED', 'No DICOM study is linked to this case yet.');
    }

    try {
      const instances = await fetchStudyInstanceIds(study.orthanc_study_id);

      return res.json({
        ok: true,
        study_id: study.id,
        total: instances.length,
        instances: instances.map(function (instanceId, index) {
          return {
            instance_id: instanceId,
            index: index + 1,
          };
        }),
      });
    } catch (err) {
      return sendError(res, 502, 'ORTHANC_LOOKUP_FAILED', 'Failed to fetch DICOM instances from Orthanc.', extractAxiosError(err));
    }
  })
);

app.post(
  '/api/case-stream/export',
  asyncHandler(async function (req, res) {
    const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!authContext) return;
    let context = null;
    try {
      context = resolveCaseStreamContext(req.body);
    } catch (err) {
      if (err && err.code && err.status) {
        return sendError(res, err.status, err.code, err.message, err.details);
      }
      throw err;
    }

    const outputPath = path.join(TMP_DIR, `case-stream-sync-${crypto.randomUUID()}.mp4`);

    try {
      const result = await renderCaseStreamVideo(
        context.parsedBody,
        context.selectedStudies,
        outputPath
      );

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="case-stream-${Date.now()}.mp4"`);
      res.setHeader('x-case-stream-fps', String(result.fps));
      res.setHeader('x-case-stream-duration-sec', String(result.durationSec || 0));
      if (result.skippedStudies.length > 0) {
        res.setHeader('x-case-stream-skipped-studies', String(result.skippedStudies.length));
      }

      return res.sendFile(outputPath, function () {
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (err) {
          log('warn', 'case_stream.cleanup_output_failed', { path: outputPath, message: err.message });
        }
      });
    } catch (err) {
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch (cleanupErr) {
          log('warn', 'case_stream.cleanup_output_failed', { path: outputPath, message: cleanupErr.message });
        }
      }

      const normalized = normalizeCaseStreamJobError(err);
      return sendError(
        res,
        normalized.status,
        normalized.code,
        normalized.message,
        normalized.details
      );
    }
  })
);

app.post(
  '/api/case-stream/jobs',
  asyncHandler(async function (req, res) {
    const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!authContext) return;
    let context = null;
    try {
      context = resolveCaseStreamContext(req.body);
    } catch (err) {
      if (err && err.code && err.status) {
        return sendError(res, err.status, err.code, err.message, err.details);
      }
      throw err;
    }

    const jobId = crypto.randomUUID();
    const createdAt = nowIso();
    const job = {
      id: jobId,
      status: 'queued',
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      completed_at: null,
      cancelled_at: null,
      cancel_requested_at: null,
      requested_study_ids: context.parsedBody.studyIds,
      fps: context.parsedBody.fps,
      max_frames: context.parsedBody.maxFrames,
      study_layouts: context.parsedBody.studyLayouts,
      output_path: null,
      filename: null,
      file_size: 0,
      skipped_studies_count: 0,
      skipped_studies: [],
      skipped_frames: [],
      source_summary: [],
      duration_sec: 0,
      frames_rendered: 0,
      progress_pct: 0,
      progress_message: 'Queued',
      error: null,
      request_id: req.requestId,
      requested_ip: req.ip,
      expires_at: null,
    };

    caseStreamJobs.set(jobId, job);
    saveCaseStreamJobs();
    enqueueCaseStreamJob(jobId);

    return res.status(202).json({
      ok: true,
      job: getCaseStreamPublicJob(job),
    });
  })
);

app.get('/api/case-stream/jobs/:jobId', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const jobId = sanitizeText(req.params.jobId);
  const job = caseStreamJobs.get(jobId);

  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }

  return res.json({
    ok: true,
    job: getCaseStreamPublicJob(job),
  });
});

app.post('/api/case-stream/jobs/:jobId/cancel', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const jobId = sanitizeText(req.params.jobId);
  const job = caseStreamJobs.get(jobId);

  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }

  if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') {
    return res.json({
      ok: true,
      already_terminal: true,
      job: getCaseStreamPublicJob(job),
    });
  }

  job.cancel_requested_at = nowIso();

  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.cancelled_at = nowIso();
    job.progress_message = 'Cancelled';
    for (let i = caseStreamJobQueue.length - 1; i >= 0; i -= 1) {
      if (caseStreamJobQueue[i] === job.id) {
        caseStreamJobQueue.splice(i, 1);
      }
    }
  } else {
    job.progress_message = 'Cancellation requested...';
  }

  touchJob(job);

  return res.json({
    ok: true,
    cancelled: true,
    job: getCaseStreamPublicJob(job),
  });
});

app.get('/api/case-stream/jobs/:jobId/download', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const jobId = sanitizeText(req.params.jobId);
  const job = caseStreamJobs.get(jobId);

  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }

  if (job.status !== 'ready') {
    return sendError(res, 409, 'JOB_NOT_READY', 'Case stream is not ready for download yet.', {
      status: job.status,
    });
  }

  if (!job.output_path || !fs.existsSync(job.output_path)) {
    job.status = 'failed';
    job.error = {
      code: 'OUTPUT_MISSING',
      message: 'Generated export file is missing. Please create a new case stream export.',
    };
    touchJob(job);
    return sendError(res, 410, 'OUTPUT_MISSING', 'Generated export file is missing. Please create a new case stream export.');
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${sanitizeText(job.filename) || `case-stream-${job.id}.mp4`}"`
  );
  res.setHeader('x-case-stream-job-id', job.id);
  res.setHeader('x-case-stream-fps', String(job.fps));
  res.setHeader('x-case-stream-skipped-studies', String(job.skipped_studies_count || 0));
  res.setHeader('x-case-stream-duration-sec', String(job.duration_sec || 0));

  return res.sendFile(job.output_path);
});

app.get('/api/case-stream/library/:streamId/download', function (req, res) {
  const streamId = sanitizeText(req.params.streamId);
  const stream = loadCaseStreamLibrary().find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  const filePath = getCaseStreamLibraryDownloadPath(stream);
  if (!filePath) {
    return sendError(res, 410, 'OUTPUT_MISSING', 'Saved stream video is missing. Please recreate and save this stream.');
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${sanitizeText(stream.filename) || `case-stream-${stream.id}.mp4`}"`
  );
  res.setHeader('x-case-stream-id', stream.id);
  res.setHeader('x-case-stream-fps', String(stream.fps || 0));
  res.setHeader('x-case-stream-duration-sec', String(stream.duration_sec || 0));
  return res.sendFile(filePath);
});

app.get('/api/case-stream/library', function (req, res) {
  const items = loadCaseStreamLibrary()
    .map(function (item) {
      const videoAvailable = Boolean(getCaseStreamLibraryDownloadPath(item));
      return {
        ...item,
        video_available: videoAvailable,
        download_url: videoAvailable ? `/api/case-stream/library/${encodeURIComponent(item.id)}/download` : null,
        presentation_case_count: buildCasePresentationCases(item.timeline).length,
      };
    })
    .sort(function (left, right) {
      const leftTs = new Date(left.created_at || 0).getTime();
      const rightTs = new Date(right.created_at || 0).getTime();
      return rightTs - leftTs;
    });

  return res.json({
    ok: true,
    streams: items,
  });
});

app.get('/api/case-stream/library/:streamId/presentation', function (req, res) {
  const streamId = sanitizeText(req.params.streamId);
  const stream = loadCaseStreamLibrary().find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  const job = caseStreamJobs.get(stream.job_id) || {
    id: stream.job_id,
    status: 'ready',
    output_path: getCaseStreamLibraryDownloadPath(stream),
    fps: stream.fps,
    timeline: stream.timeline,
  };
  if (job.status !== 'ready') {
    return sendError(res, 409, 'JOB_NOT_READY', 'Case stream is not ready for presentation yet.', {
      status: job.status,
    });
  }

  const streamFilePath = getCaseStreamLibraryDownloadPath(stream);
  if (!streamFilePath) {
    job.status = 'failed';
    job.error = {
      code: 'OUTPUT_MISSING',
      message: 'Saved stream video is missing. Please recreate and save this stream.',
    };
    if (caseStreamJobs.has(stream.job_id)) touchJob(job);
    return sendError(res, 410, 'OUTPUT_MISSING', 'Saved stream video is missing. Please recreate and save this stream.');
  }

  const presentation = buildCaseStreamPresentationManifest(stream, job, {
    videoUrl: `/api/case-stream/library/${encodeURIComponent(stream.id)}/download`,
  });
  if (!presentation.case_count) {
    return sendError(res, 409, 'NO_PRESENTABLE_CASES', 'This stream does not include case timing data for presentation.');
  }

  return res.json({
    ok: true,
    presentation: presentation,
  });
});

app.post(
  '/api/case-stream/library/:streamId/repair',
  asyncHandler(async function (req, res) {
    const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!authContext) return;
    const streamId = sanitizeText(req.params.streamId);
    const streams = loadCaseStreamLibrary();
    const stream = streams.find(function (item) {
      return item.id === streamId;
    });

    if (!stream) {
      return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
    }

    const forceRepair = parseBooleanFlag(req.query && req.query.force);
    const existingPath = getCaseStreamLibraryDownloadPath(stream);
    if (existingPath && !forceRepair) {
      return res.json({
        ok: true,
        repaired: false,
        stream: {
          ...stream,
          video_available: true,
          download_url: `/api/case-stream/library/${encodeURIComponent(stream.id)}/download`,
          presentation_case_count: buildCasePresentationCases(stream.timeline).length,
        },
      });
    }

    const rebuilt = await rebuildSavedCaseStream(stream);
    stream.filename = rebuilt.filename;
    stream.file_path = rebuilt.file_path;
    stream.file_size = rebuilt.file_size;
    stream.fps = rebuilt.fps;
    stream.requested_study_ids = rebuilt.requested_study_ids;
    stream.timeline = rebuilt.timeline;
    stream.skipped_studies_count = Number(rebuilt.skipped_studies_count || 0);
    stream.skipped_studies = Array.isArray(rebuilt.skipped_studies) ? rebuilt.skipped_studies : [];
    stream.skipped_frames = Array.isArray(rebuilt.skipped_frames) ? rebuilt.skipped_frames : [];
    stream.source_summary = Array.isArray(rebuilt.source_summary) ? rebuilt.source_summary : [];
    stream.duration_sec = Number(rebuilt.duration_sec || 0);
    stream.frames_rendered = Number(rebuilt.frames_rendered || 0);
    stream.updated_at = nowIso();
    saveCaseStreamLibrary(streams);

    return res.json({
      ok: true,
      repaired: true,
      stream: {
        ...stream,
        video_available: true,
        download_url: `/api/case-stream/library/${encodeURIComponent(stream.id)}/download`,
        presentation_case_count: buildCasePresentationCases(stream.timeline).length,
      },
    });
  })
);

app.post('/api/case-stream/library', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const jobId = sanitizeText(req.body && req.body.job_id);
  const name = sanitizeText(req.body && req.body.name);

  if (!jobId || !name) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Both job_id and name are required.');
  }

  const job = caseStreamJobs.get(jobId);
  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }

  if (job.status !== 'ready') {
    return sendError(res, 409, 'JOB_NOT_READY', 'Case stream is not ready to save.', {
      status: job.status,
    });
  }

  if (!job.output_path || !fs.existsSync(job.output_path)) {
    return sendError(res, 410, 'OUTPUT_MISSING', 'Generated export file is missing. Please create a new case stream export.');
  }

  const streams = loadCaseStreamLibrary();
  const existing = streams.find(function (item) {
    return item.job_id === jobId;
  });

  if (existing) {
    const savedFile = copyJobOutputToSavedStream(job, existing.id);
    existing.name = name;
    existing.updated_at = nowIso();
    existing.filename = savedFile.filename;
    existing.file_path = savedFile.file_path;
    existing.file_size = savedFile.file_size;
    existing.fps = Number(job.fps) || existing.fps || 0;
    existing.requested_study_ids = Array.isArray(job.requested_study_ids) ? job.requested_study_ids : [];
    existing.timeline = Array.isArray(job.timeline) ? job.timeline : [];
    existing.skipped_studies_count = Number(job.skipped_studies_count || 0);
    existing.skipped_studies = Array.isArray(job.skipped_studies) ? job.skipped_studies : [];
    existing.skipped_frames = Array.isArray(job.skipped_frames) ? job.skipped_frames : [];
    existing.source_summary = Array.isArray(job.source_summary) ? job.source_summary : [];
    existing.duration_sec = Number(job.duration_sec || 0);
    existing.frames_rendered = Number(job.frames_rendered || 0);
    saveCaseStreamLibrary(streams);
    return res.json({
      ok: true,
      stream: {
        ...existing,
        video_available: true,
        download_url: `/api/case-stream/library/${encodeURIComponent(existing.id)}/download`,
        presentation_case_count: buildCasePresentationCases(existing.timeline).length,
      },
    });
  }

  const createdAt = nowIso();
  const streamId = crypto.randomUUID();
  const savedFile = copyJobOutputToSavedStream(job, streamId);
  const item = {
    id: streamId,
    job_id: jobId,
    name: name,
    created_at: createdAt,
    updated_at: createdAt,
    filename: savedFile.filename,
    file_path: savedFile.file_path,
    file_size: savedFile.file_size,
    fps: Number(job.fps) || 0,
    requested_study_ids: Array.isArray(job.requested_study_ids) ? job.requested_study_ids : [],
    timeline: Array.isArray(job.timeline) ? job.timeline : [],
    skipped_studies_count: Number(job.skipped_studies_count || 0),
    skipped_studies: Array.isArray(job.skipped_studies) ? job.skipped_studies : [],
    skipped_frames: Array.isArray(job.skipped_frames) ? job.skipped_frames : [],
    source_summary: Array.isArray(job.source_summary) ? job.source_summary : [],
    duration_sec: Number(job.duration_sec || 0),
    frames_rendered: Number(job.frames_rendered || 0),
  };

  streams.push(item);
  saveCaseStreamLibrary(streams);

  return res.status(201).json({
    ok: true,
    stream: {
      ...item,
      video_available: true,
      download_url: `/api/case-stream/library/${encodeURIComponent(item.id)}/download`,
      presentation_case_count: buildCasePresentationCases(item.timeline).length,
    },
  });
});

app.delete('/api/case-stream/library/:streamId', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const streamId = sanitizeText(req.params.streamId);
  const streams = loadCaseStreamLibrary();
  const next = streams.filter(function (item) {
    return item.id !== streamId;
  });

  if (next.length === streams.length) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  saveCaseStreamLibrary(next);
  return res.json({ ok: true, deleted: true });
});

app.get(
  '/api/dicom-instances/:instanceId/screenshot',
  asyncHandler(async function (req, res) {
    const instanceId = sanitizeText(req.params.instanceId);
    const frameParam = sanitizeText(req.query.frame || '0');
    const asDownload = sanitizeText(req.query.download) === '1';
    const frame = Number(frameParam);

    if (!instanceId) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Missing instance id.');
    }

    if (!Number.isInteger(frame) || frame < 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid frame number.');
    }

    try {
      let response;
      try {
        response = await fetchOrthancPreviewImage(instanceId, frame);
      } catch (previewErr) {
        response = await renderOrthancPreviewImageWithPython(instanceId, frame);
      }
      const contentType = response.contentType || 'image/png';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', asDownload ? `attachment; filename="dicom-${instanceId}-frame-${frame}.png"` : 'inline');
      return res.send(response.buffer);
    } catch (err) {
      return sendError(res, 502, 'SCREENSHOT_FAILED', 'Failed to generate DICOM screenshot.', extractAxiosError(err));
    }
  })
);

app.use(function notFound(req, res) {
  return sendError(res, 404, 'NOT_FOUND', 'Route not found.');
});

app.use(function globalErrorHandler(err, req, res, next) {
  const isMulter = err && err.name === 'MulterError';
  const isUploadValidationError =
    err &&
    typeof err.message === 'string' &&
    (err.message === 'Invalid DICOM file upload.' ||
      err.message === 'Only MP4 video files are accepted.' ||
      err.message === 'Only PDF files are accepted.');

  if (isMulter && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(
      res,
      413,
      'UPLOAD_TOO_LARGE',
      `File exceeds upload limit (${formatUploadLimitLabel(UPLOAD_MAX_MB)}).`
    );
  }

  if (isMulter) {
    return sendError(res, 400, 'UPLOAD_FAILED', err.message);
  }

  if (isUploadValidationError) {
    return sendError(res, 400, 'UPLOAD_FAILED', err.message);
  }

  if (err && err.message === 'CORS origin not allowed') {
    return sendError(res, 403, 'CORS_FORBIDDEN', 'Origin is not allowed by CORS policy.');
  }

  log('error', 'request.failed', {
    requestId: req && req.requestId,
    message: err && err.message,
    stack: NODE_ENV === 'production' ? undefined : err && err.stack,
  });

  return sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error.');
});

const server = app.listen(PORT, HOST, function () {
  log('info', 'server.started', {
    host: HOST,
    port: PORT,
    env: NODE_ENV,
    orthanc_url: ORTHANC_URL,
    nextcloud_enabled: Boolean(NEXTCLOUD_URL && NEXTCLOUD_USERNAME && NEXTCLOUD_PASSWORD),
    cors_allowlist_count: ALLOWED_ORIGINS.length,
    pg_dual_write_enabled: ENABLE_PG_DUAL_WRITE,
    pg_reads_enabled: ENABLE_PG_READS,
    live_finalize_queue_enabled: ENABLE_LIVE_FINALIZE_QUEUE,
    jwt_auth_enabled: Boolean(AUTH_JWT_SECRET),
    header_auth_enabled: ALLOW_HEADER_AUTH,
  });
});
const serverKeepAliveTimer = setInterval(function () {
  // Keep the PM2-managed API process resident in restricted service environments.
}, 60 * 60 * 1000);

function shutdown(signal) {
  log('info', 'server.shutdown_signal', { signal: signal });
  clearInterval(serverKeepAliveTimer);
  clearInterval(deletedStudySweepTimer);
  clearInterval(orthancDeleteReconcileTimer);

  server.close(function () {
    const finishExit = function () {
      log('info', 'server.stopped', { signal: signal });
      process.exit(0);
    };
    if (pgPool) {
      pgPool
        .end()
        .then(finishExit)
        .catch(function () {
          finishExit();
        });
      return;
    }
    finishExit();
  });

  setTimeout(function () {
    log('error', 'server.shutdown_forced', { signal: signal });
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', function () {
  shutdown('SIGTERM');
});

process.on('SIGINT', function () {
  shutdown('SIGINT');
});
