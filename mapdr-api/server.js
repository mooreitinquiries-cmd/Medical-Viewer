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
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 60000);
const ORTHANC_UPLOAD_TIMEOUT_MS = Math.max(
  Number(process.env.ORTHANC_UPLOAD_TIMEOUT_MS || 900000),
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
const UPLOAD_MAX_FILES = Number(process.env.UPLOAD_MAX_FILES || 5000);
const VIDEO_UPLOAD_MAX_MB = Math.min(
  Math.max(Number(process.env.VIDEO_UPLOAD_MAX_MB || Math.min(UPLOAD_MAX_MB, 4096)), 1),
  UPLOAD_MAX_MB
);
const VIDEO_PROCESSING_CONCURRENCY = Math.min(
  Math.max(Number(process.env.VIDEO_PROCESSING_CONCURRENCY || 1), 1),
  4
);
const VIDEO_HLS_MIN_DURATION_SEC = Math.min(
  Math.max(Number(process.env.VIDEO_HLS_MIN_DURATION_SEC || 180), 60),
  600
);
const VIDEO_HLS_SEGMENT_SEC = 2;
const DICOM_IN_MEMORY_MAX_MB = Math.max(Number(process.env.DICOM_IN_MEMORY_MAX_MB || 512), 64);
const DICOM_UPLOAD_CONCURRENCY = Math.min(
  Math.max(Number(process.env.DICOM_UPLOAD_CONCURRENCY || 2), 1),
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
const PATIENT_LOOKUP_BASE_URL = normalizeBaseUrl(
  process.env.PATIENT_LOOKUP_BASE_URL || 'https://pacs.octelerad.com'
);
const DEFAULT_STREAM_ASSIGNED_MD_NAME = sanitizeText(process.env.DEFAULT_STREAM_ASSIGNED_MD_NAME || 'Sarai');
const DEFAULT_STREAM_ASSIGNED_MD_EMAIL = sanitizeText(process.env.DEFAULT_STREAM_ASSIGNED_MD_EMAIL || 'admin').toLowerCase();
const SOAP_TEMPLATE_LOGO_PATH = sanitizeText(process.env.SOAP_TEMPLATE_LOGO_PATH) ||
  path.join(__dirname, '..', 'docker', 'ohif-orthanc', 'logo.png');
const PLAYWRIGHT_MODULE_PATH = sanitizeText(process.env.PLAYWRIGHT_MODULE_PATH) ||
  path.join(__dirname, '..', 'frontend', 'mediview-portal', 'node_modules', 'playwright');
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
const GRIST_BASE_URL = normalizeBaseUrl(process.env.GRIST_BASE_URL || '');
const GRIST_API_KEY = process.env.GRIST_API_KEY || '';
const GRIST_DOC_ID = sanitizeText(process.env.GRIST_DOC_ID || '');
const GRIST_COMPLETED_CASES_TABLE_ID = sanitizeText(process.env.GRIST_COMPLETED_CASES_TABLE_ID || 'TEST_Sheet').replace(/[^A-Za-z0-9_]/g, '_');
const GRIST_COMPLETED_CASES_TABLE_NAME = sanitizeText(process.env.GRIST_COMPLETED_CASES_TABLE_NAME || 'TEST Sheet');
const GRIST_REPORT_CODES_TABLE_ID = sanitizeText(process.env.GRIST_REPORT_CODES_TABLE_ID || 'Report_Codes').replace(/[^A-Za-z0-9_]/g, '_');
const GRIST_REPORT_CODES_TABLE_NAME = sanitizeText(process.env.GRIST_REPORT_CODES_TABLE_NAME || 'Report Codes');
const GRIST_REPORT_CODES_DOC_ID = sanitizeText(process.env.GRIST_REPORT_CODES_DOC_ID || GRIST_DOC_ID);
const GRIST_REPORT_CODES_MONTH_KEY = sanitizeText(process.env.GRIST_REPORT_CODES_MONTH_KEY || '');
const GRIST_ACRONYM_DOC_ID = sanitizeText(process.env.GRIST_ACRONYM_DOC_ID || '');
const GRIST_ACRONYM_TABLE_ID = sanitizeText(process.env.GRIST_ACRONYM_TABLE_ID || '').replace(/[^A-Za-z0-9_]/g, '_');
const GRIST_ACRONYM_TABLE_IDS = String(process.env.GRIST_ACRONYM_TABLE_IDS || GRIST_ACRONYM_TABLE_ID || '')
  .split(',')
  .map(function (item) { return item.trim().replace(/[^A-Za-z0-9_]/g, '_'); })
  .filter(Boolean);
const GRIST_PROXY_BASIC_USERNAME = process.env.GRIST_PROXY_BASIC_USERNAME || '';
const GRIST_PROXY_BASIC_PASSWORD = process.env.GRIST_PROXY_BASIC_PASSWORD || '';
const GRIST_ACRONYM_SYNC_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.GRIST_ACRONYM_SYNC_INTERVAL_MS || 60 * 60 * 1000), 5 * 60 * 1000),
  24 * 60 * 60 * 1000
);
const GRIST_ACRONYM_INITIAL_SYNC_DELAY_MS = Math.min(
  Math.max(Number(process.env.GRIST_ACRONYM_INITIAL_SYNC_DELAY_MS || 2 * 60 * 1000), 10 * 1000),
  GRIST_ACRONYM_SYNC_INTERVAL_MS
);
const DELETED_STUDY_RETENTION_DAYS = Math.min(
  Math.max(Number(process.env.DELETED_STUDY_RETENTION_DAYS || 7), 1),
  365
);
const DELETED_STUDY_SWEEP_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.DELETED_STUDY_SWEEP_INTERVAL_MS || 60 * 60 * 1000), 5 * 60 * 1000),
  24 * 60 * 60 * 1000
);
const SELF_DOWNLOAD_PLAN_RETENTION_DAYS = Math.min(
  Math.max(Number(process.env.SELF_DOWNLOAD_PLAN_RETENTION_DAYS || 7), 1),
  90
);
const TENANT_RETENTION_SWEEP_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.TENANT_RETENTION_SWEEP_INTERVAL_MS || 60 * 60 * 1000), 5 * 60 * 1000),
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
const REVENUE_ADJUSTMENTS_FILE = path.join(__dirname, 'revenue-adjustments.json');
const FORM_SUBMISSIONS_FILE = path.join(__dirname, 'form-submissions.json');
const ACRONYM_DATABASE_FILE = path.join(__dirname, 'acronym-database.json');
const TENANT_AUDIT_LOG_FILE = path.join(__dirname, 'tenant-audit-log.jsonl');
const ORTHANC_STORAGE_CACHE_FILE = path.join(__dirname, 'orthanc-storage-cache.json');
const GRIST_COMPLETED_CASES_QUEUE_FILE = path.join(__dirname, 'grist-completed-cases-queue.json');
const GRIST_REPORT_CODES_QUEUE_FILE = path.join(__dirname, 'grist-report-codes-queue.json');
const MEDIA_DIR = path.join(__dirname, 'media');
const TMP_DIR = path.join(__dirname, 'tmp');
const CASE_STREAM_EXPORT_DIR = path.join(MEDIA_DIR, 'case-stream-exports');
const CASE_STREAM_LIBRARY_DIR = path.join(MEDIA_DIR, 'case-stream-library');
const CASE_STREAM_FRAME_CACHE_DIR = path.join(MEDIA_DIR, 'case-stream-frame-cache');
const CASE_RECORDINGS_DIR = path.join(MEDIA_DIR, 'case-recordings');
const CASE_REPORTS_DIR = path.join(MEDIA_DIR, 'case-reports');
const VIDEO_THUMBNAILS_DIR = path.join(MEDIA_DIR, 'video-thumbnails');
const VIDEO_HLS_DIR = path.join(MEDIA_DIR, 'hls');
const CASE_STREAM_JOBS_FILE = path.join(__dirname, 'case-stream-jobs.json');
const CASE_STREAM_LIBRARY_FILE = path.join(__dirname, 'case-stream-library.json');
const LIVE_CASE_SESSIONS_FILE = path.join(__dirname, 'live-case-sessions.json');
const UPLOADED_VIDEO_JOBS_FILE = path.join(__dirname, 'uploaded-video-jobs.json');
const STORAGE_MONITOR_PATH = process.env.STORAGE_MONITOR_PATH || __dirname;
const STORAGE_WARNING_USED_PERCENT = Math.min(
  Math.max(Number(process.env.STORAGE_WARNING_USED_PERCENT || 10), 0),
  100
);
const DICOM_REDACT_SCRIPT = path.join(__dirname, 'scripts', 'redact_dicom.py');
const DICOM_UID_ISOLATE_SCRIPT = path.join(__dirname, 'scripts', 'isolate_dicom_uids.py');
const DICOM_PREVIEW_RENDER_SCRIPT = path.join(__dirname, 'scripts', 'render_dicom_preview.py');
const DICOM_JPEG2000_WRAP_SCRIPT = path.join(__dirname, 'scripts', 'jpeg2000_to_dicom.py');
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
  Math.max(Number(process.env.CASE_STREAM_X264_CRF || 20), 0),
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
const FORM_SUBMISSIONS_API_KEY = sanitizeText(process.env.FORM_SUBMISSIONS_API_KEY);
const FORM_SUBMISSIONS_SOURCE_BASE_URL = normalizeBaseUrl(
  process.env.FORM_SUBMISSIONS_SOURCE_BASE_URL || 'https://formchapter1.octelerad.com'
);
const FORM_SUBMISSIONS_SOURCE_LIST_PATH = sanitizeText(
  process.env.FORM_SUBMISSIONS_SOURCE_LIST_PATH || '/api/admin/submissions'
);
const FORM_SUBMISSIONS_SOURCE_DETAIL_PATH = sanitizeText(
  process.env.FORM_SUBMISSIONS_SOURCE_DETAIL_PATH || '/api/admin/submissions/:id'
);
const FORM_SUBMISSIONS_SOURCE_USERNAME = sanitizeText(process.env.FORM_SUBMISSIONS_SOURCE_USERNAME || '');
const FORM_SUBMISSIONS_SOURCE_PASSWORD = process.env.FORM_SUBMISSIONS_SOURCE_PASSWORD || '';
const FORM_SUBMISSIONS_SOURCE_COOKIE = process.env.FORM_SUBMISSIONS_SOURCE_COOKIE || '';
const FORM_SUBMISSIONS_SOURCE_BEARER_TOKEN = process.env.FORM_SUBMISSIONS_SOURCE_BEARER_TOKEN || '';
const FORM_SUBMISSIONS_SOURCE_API_KEY = process.env.FORM_SUBMISSIONS_SOURCE_API_KEY || '';
const FORM_SUBMISSIONS_SOURCE_PAGE_LIMIT = Math.min(
  Math.max(Number(process.env.FORM_SUBMISSIONS_SOURCE_PAGE_LIMIT || 100), 1),
  500
);
const FORM_SUBMISSIONS_SOURCE_MAX_PAGES = Math.min(
  Math.max(Number(process.env.FORM_SUBMISSIONS_SOURCE_MAX_PAGES || 200), 1),
  1000
);
const FORM_SUBMISSIONS_SOURCE_FETCH_DETAILS = parseBooleanEnv(
  process.env.FORM_SUBMISSIONS_SOURCE_FETCH_DETAILS,
  true
);
const AUTH_SESSION_COOKIE = sanitizeText(process.env.AUTH_SESSION_COOKIE || 'mediview_session');
const AUTH_SESSION_STORE_FILE = sanitizeText(
  process.env.AUTH_SESSION_STORE_FILE ||
    path.join(__dirname, '..', 'frontend', 'mediview-portal', 'server', 'auth-api', 'data', 'store.json')
);
const TWO_FACTOR_AUTH_ENABLED = parseBooleanEnv(process.env.TWO_FACTOR_AUTH_ENABLED, false);
const TWO_FACTOR_CODE_SECRET = process.env.TWO_FACTOR_CODE_SECRET || AUTH_JWT_SECRET || '';
const TWO_FACTOR_CODE_TTL_MINUTES = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_CODE_TTL_MINUTES || 10), 2),
  30
);
const TWO_FACTOR_CODE_MAX_ATTEMPTS = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_CODE_MAX_ATTEMPTS || 5), 1),
  10
);
const TWO_FACTOR_RESEND_API_KEY = process.env.TWO_FACTOR_RESEND_API_KEY || process.env.RESEND_API_KEY || '';
const TWO_FACTOR_RESEND_FROM = sanitizeText(process.env.TWO_FACTOR_RESEND_FROM || process.env.RESEND_FROM || '');
const TWO_FACTOR_APP_NAME = sanitizeText(process.env.TWO_FACTOR_APP_NAME || 'MAPDR');
const TWO_FACTOR_SEND_RATE_LIMIT_MAX = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_SEND_RATE_LIMIT_MAX || 3), 1),
  20
);
const TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000), 60 * 1000),
  60 * 60 * 1000
);
const TWO_FACTOR_VERIFY_RATE_LIMIT_MAX = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_VERIFY_RATE_LIMIT_MAX || 8), 1),
  50
);
const TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS = Math.min(
  Math.max(Number(process.env.TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000), 60 * 1000),
  60 * 60 * 1000
);
const ENABLE_PG_DUAL_WRITE = parseBooleanEnv(process.env.ENABLE_PG_DUAL_WRITE, false);
const ENABLE_PG_READS = parseBooleanEnv(process.env.ENABLE_PG_READS, false);
const DATABASE_URL = sanitizeText(process.env.DATABASE_URL);
const ENABLE_LIVE_FINALIZE_QUEUE = parseBooleanEnv(process.env.ENABLE_LIVE_FINALIZE_QUEUE, true);
const LIVE_FINALIZE_QUEUE_FILE = path.join(__dirname, 'live-finalize-jobs.json');
const studiesFileCache = createJsonFileCache();
const caseRecordingsFileCache = createJsonFileCache();
const revenueAdjustmentsFileCache = createJsonFileCache();
const formSubmissionsFileCache = createJsonFileCache();
const acronymDatabaseFileCache = createJsonFileCache();
const liveCaseSessionsFileCache = createJsonFileCache();
const uploadedVideoJobsFileCache = createJsonFileCache();
const gristCompletedCasesQueueFileCache = createJsonFileCache();
const gristReportCodesQueueFileCache = createJsonFileCache();
let acronymDatabaseSyncInFlight = false;
let acronymDatabaseSyncTimer = null;
let acronymDatabaseInitialSyncTimer = null;

const uploadLimits = {
  fileSize: UPLOAD_MAX_MB * 1024 * 1024,
  files: UPLOAD_MAX_FILES,
};

ensureDir(MEDIA_DIR);
ensureDir(TMP_DIR);
ensureDir(CASE_STREAM_EXPORT_DIR);
ensureDir(CASE_STREAM_LIBRARY_DIR);
ensureDir(CASE_STREAM_FRAME_CACHE_DIR);
ensureDir(CASE_RECORDINGS_DIR);
ensureDir(CASE_REPORTS_DIR);
ensureDir(VIDEO_THUMBNAILS_DIR);
ensureDir(VIDEO_HLS_DIR);
ensureFile(DATA_FILE, '[]');
ensureFile(CASE_STREAM_JOBS_FILE, '[]');
ensureFile(CASE_STREAM_LIBRARY_FILE, '[]');
ensureFile(LIVE_CASE_SESSIONS_FILE, '[]');
ensureFile(UPLOADED_VIDEO_JOBS_FILE, '[]');
ensureFile(CASE_RECORDINGS_FILE, '[]');
ensureFile(REVENUE_ADJUSTMENTS_FILE, '[]');
ensureFile(FORM_SUBMISSIONS_FILE, '[]');
ensureFile(ACRONYM_DATABASE_FILE, '[]');
ensureFile(TENANT_AUDIT_LOG_FILE, '');
ensureFile(ORTHANC_STORAGE_CACHE_FILE, '{}');
ensureFile(LIVE_FINALIZE_QUEUE_FILE, '[]');
ensureFile(GRIST_COMPLETED_CASES_QUEUE_FILE, '[]');
ensureFile(GRIST_REPORT_CODES_QUEUE_FILE, '[]');
cleanupStaleTmpFiles();
const tmpCleanupTimer = setInterval(cleanupStaleTmpFiles, TMP_CLEANUP_INTERVAL_MS);
if (typeof tmpCleanupTimer.unref === 'function') {
  tmpCleanupTimer.unref();
}
const deletedStudySweepTimer = setInterval(sweepExpiredDeletedStudies, DELETED_STUDY_SWEEP_INTERVAL_MS);
if (typeof deletedStudySweepTimer.unref === 'function') {
  deletedStudySweepTimer.unref();
}
const tenantRetentionSweepTimer = setInterval(sweepTenantPlanRetention, TENANT_RETENTION_SWEEP_INTERVAL_MS);
if (typeof tenantRetentionSweepTimer.unref === 'function') {
  tenantRetentionSweepTimer.unref();
}
const orthancDeleteReconcileTimer = setInterval(
  reconcileStudiesDeletedFromOrthanc,
  ORTHANC_DELETE_RECONCILE_INTERVAL_MS
);
if (typeof orthancDeleteReconcileTimer.unref === 'function') {
  orthancDeleteReconcileTimer.unref();
}
setTimeout(sweepExpiredDeletedStudies, 30000).unref?.();
setTimeout(sweepTenantPlanRetention, 45000).unref?.();
setTimeout(reconcileStudiesDeletedFromOrthanc, 60000).unref?.();
startAcronymDatabaseSyncSchedule();

const caseStreamJobs = new Map();
const caseStreamJobQueue = [];
let caseStreamJobsInFlight = 0;
const uploadedVideoJobQueue = [];
let uploadedVideoJobsInFlight = 0;
const dicomConversionCache = new Map();
const videoAccessTokenCache = new Map();
const rateLimitBuckets = new Map();
const VIDEO_ACCESS_TOKEN_TTL_MINUTES = 240;
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
const gristClient = axios.create({
  timeout: HTTP_TIMEOUT_MS,
});
let gristCompletedCasesTableReady = false;
let gristCompletedCasesFlushInFlight = false;
let gristReportCodesTableReady = false;
let gristReportCodesFlushInFlight = false;

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
  limits: { ...uploadLimits, fileSize: VIDEO_UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: function (req, file, cb) {
    if (looksLikeVideoUpload(file)) {
      return cb(null, true);
    }
    cb(new Error('Only video files are accepted.'));
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

const uploadDictationAudio = multer({
  dest: TMP_DIR,
  limits: { ...uploadLimits, files: 1 },
  fileFilter: function (req, file, cb) {
    const original = sanitizeText(file && file.originalname).toLowerCase();
    const mime = sanitizeText(file && file.mimetype).toLowerCase();
    if (
      mime.startsWith('audio/') ||
      mime === 'video/webm' ||
      original.endsWith('.webm') ||
      original.endsWith('.m4a') ||
      original.endsWith('.mp3') ||
      original.endsWith('.wav') ||
      original.endsWith('.ogg')
    ) {
      return cb(null, true);
    }
    cb(new Error('Only browser audio recordings are accepted.'));
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
app.use(
  '/media',
  express.static(path.join(__dirname, 'media'), {
    setHeaders: function (res, filePath) {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'private, max-age=60');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      }
    },
  })
);

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

function extractPatientIdentifierFromLookup(value) {
  const text = sanitizeText(value);
  if (!text) return '';
  const match = text.match(/(?:^|\/)lookup_([^/?#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return match[1];
  }
}

function normalizePatientIdentifier(value) {
  const fromLookup = extractPatientIdentifierFromLookup(value);
  const raw = sanitizeText(fromLookup || value);
  if (!raw) return '';
  return raw
    .replace(/^lookup_/i, '')
    .replace(/[\s/\\?#]+/g, '')
    .slice(0, 128);
}

function buildPatientLookupUrl(patientIdentifier) {
  const cleanIdentifier = normalizePatientIdentifier(patientIdentifier);
  if (!cleanIdentifier || !PATIENT_LOOKUP_BASE_URL) return null;
  return `${PATIENT_LOOKUP_BASE_URL}/lookup_${encodeURIComponent(cleanIdentifier)}`;
}

function pickPatientIdentifierFromFields(fields) {
  return normalizePatientIdentifier(
    pickFirstFormValue(fields || [], [
      'patientidentifier',
      'patientid',
      'globalpatientid',
      'globalpatientidentifier',
      'immutablepatientid',
      'lookup',
      'lookupurl',
      'patientlookupurl',
      'activepatienttoken',
    ])
  );
}

function getPatientIdentifierFromPayload(body, fields) {
  const payload = body || {};
  return normalizePatientIdentifier(
    payload.patient_identifier ||
      payload.patientIdentifier ||
      payload.global_patient_identifier ||
      payload.globalPatientIdentifier ||
      payload.global_patient_id ||
      payload.globalPatientId ||
      payload.patient_id ||
      payload.patientId ||
      payload.active_patient_token ||
      payload.activePatientToken ||
      payload.patient_lookup_url ||
      payload.patientLookupUrl ||
      payload.lookup_url ||
      payload.lookupUrl ||
      pickPatientIdentifierFromFields(fields)
  );
}

function makeGeneratedPatientIdentifier(seed) {
  const cleanSeed = sanitizeText(seed);
  if (cleanSeed) {
    return `pat_${crypto.createHash('sha256').update(cleanSeed).digest('hex').slice(0, 32)}`;
  }
  return `pat_${crypto.randomUUID()}`;
}

function validatePatientIdentifierPolicy(patientIdentifier, values) {
  const cleanIdentifier = normalizePatientIdentifier(patientIdentifier);
  const source = values || {};
  if (!cleanIdentifier) {
    return 'Patient identifier is required. Use the immutable global identifier from the patient lookup URL, not name, email, DOB, or MRN.';
  }

  if (cleanIdentifier.includes('@')) {
    return 'Patient identifier cannot be an email address.';
  }

  if (/^\d{4}-?\d{2}-?\d{2}$/.test(cleanIdentifier)) {
    return 'Patient identifier cannot be a date of birth.';
  }

  const disallowed = [
    source.patient_name,
    source.name,
    source.email,
    source.patient_email,
    source.patientEmail,
    source.patient_dob,
    source.dob,
    source.mrn,
    source.MRN,
    source.medical_record_number,
    source.medicalRecordNumber,
  ]
    .map(function (value) {
      return sanitizeText(value).toLowerCase();
    })
    .filter(Boolean);

  if (disallowed.includes(cleanIdentifier.toLowerCase())) {
    return 'Patient identifier must not be the patient name, email, DOB, or MRN.';
  }

  return null;
}

function enrichPatientIdentity(record) {
  const patientIdentifier = normalizePatientIdentifier(record && record.patient_id);
  if (!record || !patientIdentifier) return record;
  record.patient_id = patientIdentifier;
  record.patient_identifier = patientIdentifier;
  record.patient_lookup_url = buildPatientLookupUrl(patientIdentifier);
  return record;
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

function sanitizeLimitedText(value, maxLength) {
  const text = sanitizeText(value).replace(/[\x00-\x1F\x7F]/g, '');
  const limit = Number(maxLength) > 0 ? Number(maxLength) : 256;
  return text.slice(0, limit);
}

function normalizeReadingLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const latitude = Number(source.latitude ?? source.lat);
  const longitude = Number(source.longitude ?? source.lng ?? source.lon);
  return {
    country: sanitizeLimitedText(source.country, 96) || null,
    state: sanitizeLimitedText(source.state || source.region || source.province, 96) || null,
    zip_code: sanitizeLimitedText(source.zip_code || source.zipCode || source.zip || source.postal_code || source.postalCode, 32) || null,
    address: sanitizeLimitedText(source.address || source.street_address || source.streetAddress, 512) || null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
}

function hasReadingLocationDetails(location) {
  return Boolean(
    location &&
      (location.country || location.state || location.zip_code || location.address || location.latitude !== null || location.longitude !== null)
  );
}

function normalizeBrowserContext(req, value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ip: getClientIp(req),
    user_agent: sanitizeLimitedText(source.user_agent || source.userAgent || (req && req.headers && req.headers['user-agent']), 512) || null,
    timezone: sanitizeLimitedText(source.timezone, 96) || null,
    language: sanitizeLimitedText(source.language, 64) || null,
    platform: sanitizeLimitedText(source.platform, 128) || null,
  };
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

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
    original.endsWith('.jpx') ||
    original.endsWith('.j2c');
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

function hasJpeg2000ExtensionOrMime(file) {
  const original = sanitizeText(file && file.originalname).toLowerCase();
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  return (
    original.endsWith('.jp2') ||
    original.endsWith('.j2k') ||
    original.endsWith('.jpf') ||
    original.endsWith('.jpx') ||
    original.endsWith('.j2c') ||
    mime === 'image/jp2' ||
    mime === 'image/jpx' ||
    mime === 'image/jpeg2000' ||
    mime === 'video/jpeg2000'
  );
}

function isProbablyRawJpeg2000Buffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }

  const hasJp2Signature =
    buffer.length >= 12 &&
    buffer.readUInt32BE(0) === 0x0000000c &&
    buffer.toString('ascii', 4, 8) === 'jP  ' &&
    buffer[8] === 0x0d &&
    buffer[9] === 0x0a &&
    buffer[10] === 0x87 &&
    buffer[11] === 0x0a;

  const hasCodestreamSignature = buffer[0] === 0xff && buffer[1] === 0x4f && buffer[2] === 0xff && buffer[3] === 0x51;
  return hasJp2Signature || hasCodestreamSignature;
}

function looksLikeRawJpeg2000(file, probeBuffer) {
  return hasJpeg2000ExtensionOrMime(file) || isProbablyRawJpeg2000Buffer(probeBuffer);
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

  for (const [index, f] of (files || []).entries()) {
    const originalName = sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown';
    let inputBuffer = resolveInputFileBuffer(f);
    inputBytes += inputBuffer.length;

    if (!isProbablyDicomBuffer(inputBuffer)) {
      if (!looksLikeRawJpeg2000(f, inputBuffer.subarray(0, Math.min(inputBuffer.length, 128 * 1024)))) {
        throw makeAppError(
          'INVALID_DICOM_FILE',
          400,
          `File "${originalName}" does not appear to be a valid DICOM or JPEG2000 object.`
        );
      }

      const transcodeStartedAt = Date.now();
      inputBuffer = await wrapRawJpeg2000AsDicom(f, {
        namespace: 'mapdr-preconvert-jpeg2000',
        instanceNumber: index + 1,
      });
      transcodeDurationMs += Date.now() - transcodeStartedAt;
    }

    const transferSyntaxUid = detectTransferSyntaxUid(inputBuffer);
    let outputBuffer = inputBuffer;
    let wasConverted = !isProbablyDicomBuffer(resolveInputFileBuffer(f));

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

function looksLikeVideoUpload(file) {
  const original = sanitizeText(file && file.originalname).toLowerCase();
  const mime = sanitizeText(file && file.mimetype).toLowerCase();
  const ext = path.extname(original);
  return (
    looksLikeMp4(file) ||
    mime.startsWith('video/') ||
    ['.mov', '.m4v', '.webm', '.mkv', '.avi'].includes(ext)
  );
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
    const tenantId = normalizeTenantId(
      study && (study.tenant_id || study.tenantId || study.white_label_account_id || study.whiteLabelAccountId)
    );
    const patientIdentifier = normalizePatientIdentifier(
      study &&
        (study.patient_id ||
          study.patient_identifier ||
          study.patientIdentifier ||
          study.global_patient_identifier ||
          study.patient_lookup_url)
    );
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
      tenant_id: tenantId || null,
      tenantId: tenantId || null,
      white_label_account_id: tenantId || null,
      data_plan: sanitizeText(study && study.data_plan) || getStudyRetentionConfig(study).plan_id,
      hosted_by_octelerad: Boolean(
        Object.prototype.hasOwnProperty.call(study || {}, 'hosted_by_octelerad')
          ? study.hosted_by_octelerad
          : getStudyRetentionConfig(study).hostedByOctelerad
      ),
      customer_download_required_by:
        sanitizeText(study && study.customer_download_required_by) || getStudyRetentionConfig(study).purgeAfter,
      patient_id: patientIdentifier || null,
      patient_identifier: patientIdentifier || null,
      patient_lookup_url: buildPatientLookupUrl(patientIdentifier),
      prior_study_ids: Array.from(new Set(priorIds)),
      case_reports: normalizeCaseReports(study),
      video_processing_status: sanitizeText(study && study.video_processing_status) || null,
      video_processing_error: sanitizeText(study && study.video_processing_error) || null,
      video_processing_job_id: sanitizeText(study && study.video_processing_job_id) || null,
      video_metadata:
        study && study.video_metadata && typeof study.video_metadata === 'object'
          ? study.video_metadata
          : null,
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

function normalizeRevenueAdjustments(entries) {
  return (entries || [])
    .map(function (entry) {
      const amount = Number(entry && entry.amount);
      return {
        id: sanitizeText(entry && entry.id) || crypto.randomUUID(),
        date: sanitizeText(entry && entry.date),
        amount: Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0,
        label: sanitizeText(entry && entry.label) || 'Manual revenue',
        client_name: sanitizeText(entry && entry.client_name) || null,
        subclient: sanitizeText(entry && entry.subclient) || null,
        notes: sanitizeMultilineText(entry && entry.notes, 2000) || null,
        created_by_email: sanitizeText(entry && entry.created_by_email) || null,
        created_by_name: sanitizeText(entry && entry.created_by_name) || null,
        created_at: sanitizeText(entry && entry.created_at) || nowIso(),
        updated_at: sanitizeText(entry && entry.updated_at) || sanitizeText(entry && entry.created_at) || nowIso(),
      };
    })
    .filter(function (entry) {
      return /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && Number.isFinite(entry.amount);
    });
}

function loadRevenueAdjustments() {
  return readCachedJsonArray(
    REVENUE_ADJUSTMENTS_FILE,
    revenueAdjustmentsFileCache,
    normalizeRevenueAdjustments,
    'revenue_adjustments.load_failed'
  );
}

function saveRevenueAdjustments(entries) {
  const normalized = normalizeRevenueAdjustments(entries);
  const tempFile = `${REVENUE_ADJUSTMENTS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, REVENUE_ADJUSTMENTS_FILE);
  updateCachedJsonArray(REVENUE_ADJUSTMENTS_FILE, revenueAdjustmentsFileCache, normalized);
}

function sanitizeFormJsonValue(value, depth) {
  if (depth > 8) return null;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(function (item) {
      return sanitizeFormJsonValue(item, depth + 1);
    });
  }
  if (typeof value === 'object') {
    return Object.keys(value)
      .slice(0, 500)
      .reduce(function (result, key) {
        const cleanKey = sanitizeText(key).slice(0, 120);
        if (!cleanKey) return result;
        result[cleanKey] = sanitizeFormJsonValue(value[key], depth + 1);
        return result;
      }, {});
  }
  if (typeof value === 'string') return sanitizeMultilineText(value, 12000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return sanitizeText(value).slice(0, 12000);
}

function flattenFormValues(value, prefix, result) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach(function (item, index) {
      flattenFormValues(item, prefix ? `${prefix}.${index}` : String(index), result);
    });
    return;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(function (key) {
      flattenFormValues(value[key], prefix ? `${prefix}.${key}` : key, result);
    });
    return;
  }
  result.push({
    key: prefix,
    value: sanitizeText(value),
  });
}

function normalizeSubmissionType(value, payload) {
  const explicitType = sanitizeText(value).toLowerCase();
  if (['patient', 'clinic', 'other'].includes(explicitType)) return explicitType;
  if (['client', 'facility', 'practice'].includes(explicitType)) return 'clinic';

  const source = JSON.stringify(payload || {}).toLowerCase();
  if (source.includes('clinic') || source.includes('facility') || source.includes('practice')) return 'clinic';
  if (source.includes('patient')) return 'patient';
  return 'other';
}

function pickFirstFormValue(fields, names) {
  const loweredNames = names.map(function (name) {
    return name.toLowerCase();
  });
  const found = fields.find(function (field) {
    const key = sanitizeText(field.key).toLowerCase().replace(/[\s_-]+/g, '');
    return loweredNames.some(function (name) {
      return key === name || key.endsWith(`.${name}`);
    });
  });
  return found ? sanitizeText(found.value) : '';
}

function normalizeFormFieldKey(value) {
  return sanitizeText(value).toLowerCase().replace(/[\s_.-]+/g, '');
}

function extractFirstUrlFromText(value) {
  const text = sanitizeText(value);
  if (!text) return '';
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[),.;]+$/, '') : '';
}

function pickFirstFormUrl(fields, names) {
  const loweredNames = names.map(function (name) {
    return normalizeFormFieldKey(name);
  });
  const direct = (fields || []).find(function (field) {
    const key = normalizeFormFieldKey(field.key);
    return loweredNames.some(function (name) {
      return key === name || key.endsWith(name) || key.includes(name);
    });
  });
  if (direct) return extractFirstUrlFromText(direct.value) || sanitizeText(direct.value);

  const cloudField = (fields || []).find(function (field) {
    const key = normalizeFormFieldKey(field.key);
    const value = sanitizeText(field.value);
    return key.includes('nextcloud') || /https?:\/\/cloud\.octelerad\.pserv/i.test(value);
  });
  return cloudField ? extractFirstUrlFromText(cloudField.value) : '';
}

function buildNextcloudFolderBrowserUrl(folder) {
  if (!NEXTCLOUD_URL) return null;
  const cleanFolder = sanitizeText(folder);
  if (!cleanFolder) return null;
  const url = new URL(`${NEXTCLOUD_URL}/apps/files/files`);
  url.searchParams.set('dir', cleanFolder);
  return url.toString();
}

function getStudyNextcloudUrl(study) {
  return (
    sanitizeText(study && study.nextcloud_url) ||
    buildNextcloudFolderBrowserUrl(study && study.nextcloud_folder) ||
    null
  );
}

function normalizeSearchToken(value) {
  return sanitizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findMatchingFormSubmissionStudy(submission, studies) {
  const patientIdentifier = normalizePatientIdentifier(submission && submission.patient_identifier).toLowerCase();
  const displayNameToken = normalizeSearchToken(submission && submission.display_name);
  const fields = Array.isArray(submission && submission.fields) ? submission.fields : [];
  const possibleStudyIds = [
    pickFirstFormValue(fields, ['studyid', 'study_id', 'caseid', 'case_id']),
    submission && submission.study_id,
  ]
    .map(function (value) {
      return sanitizeText(value);
    })
    .filter(Boolean);

  const candidates = (studies || []).filter(function (study) {
    if (!getStudyNextcloudUrl(study)) return false;
    const studyId = sanitizeText(study && study.id);
    if (studyId && possibleStudyIds.includes(studyId)) return true;
    if (patientIdentifier && normalizePatientIdentifier(study && study.patient_id).toLowerCase() === patientIdentifier) {
      return true;
    }
    const studyNameToken = normalizeSearchToken(study && study.patient_name);
    return Boolean(displayNameToken && studyNameToken && studyNameToken.includes(displayNameToken));
  });

  return candidates.sort(function (left, right) {
    return new Date(right.updated_at || right.created_at || 0).getTime() -
      new Date(left.updated_at || left.created_at || 0).getTime();
  })[0] || null;
}

function makeFormSubmissionSummary(submission, studies) {
  const fields = Array.isArray(submission && submission.fields) ? submission.fields : [];
  const explicitNextcloudUrl =
    sanitizeText(submission && submission.nextcloud_study_url) ||
    pickFirstFormUrl(fields, [
      'nextcloud_study_url',
      'nextcloud_url',
      'nextcloud',
      'study_nextcloud_url',
      'study_url',
      'study_link',
      'cloud_link',
      'cloud_url',
    ]);
  const matchedStudy = explicitNextcloudUrl ? null : findMatchingFormSubmissionStudy(submission, studies);
  const nextcloudStudyUrl = explicitNextcloudUrl || getStudyNextcloudUrl(matchedStudy) || null;
  return {
    submitted_name: sanitizeText(submission && submission.display_name) || 'Submission',
    submission_subject_type: sanitizeText(submission && submission.type).toLowerCase() || 'other',
    submitted_at: sanitizeText(submission && submission.created_at) || null,
    nextcloud_study_url: nextcloudStudyUrl,
    matched_study_id: matchedStudy ? sanitizeText(matchedStudy.id) : null,
    matched_study_name: matchedStudy ? sanitizeText(matchedStudy.patient_name) : null,
  };
}

function enrichFormSubmissionForResponse(submission, studies) {
  return {
    ...submission,
    ...makeFormSubmissionSummary(submission, studies),
  };
}

function buildFormSubmissionSearchIndex(submission, fields) {
  return [
    submission.id,
    submission.type,
    submission.patient_identifier,
    submission.patient_lookup_url,
    submission.nextcloud_study_url,
    submission.display_name,
    submission.email,
    submission.phone,
    submission.source,
    submission.form_name,
    submission.created_at,
    fields
      .map(function (field) {
        return `${field.key} ${field.value}`;
      })
      .join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function normalizeFormSubmissions(entries) {
  return (entries || [])
    .map(function (entry) {
      const payload =
        entry && entry.payload && typeof entry.payload === 'object'
          ? sanitizeFormJsonValue(entry.payload, 0)
          : {};
      const fields = [];
      flattenFormValues(payload, '', fields);
      const createdAt = sanitizeText(entry && entry.created_at) || nowIso();
      const type = normalizeSubmissionType(entry && entry.type, payload);
      const displayName =
        sanitizeText(entry && entry.display_name) ||
        pickFirstFormValue(fields, ['patientname', 'clinicname', 'fullname', 'name', 'contactname']) ||
        `${type.charAt(0).toUpperCase()}${type.slice(1)} submission`;
      const normalizedId = sanitizeText(entry && entry.id) || crypto.randomUUID();
      const normalized = {
        id: normalizedId,
        type: type,
        patient_identifier:
          getPatientIdentifierFromPayload(entry || {}, fields) ||
          (type === 'patient' ? makeGeneratedPatientIdentifier(normalizedId) : null),
        display_name: displayName,
        email:
          sanitizeText(entry && entry.email) ||
          pickFirstFormValue(fields, ['email', 'patientemail', 'clinicemail', 'contactemail']) ||
          null,
        phone:
          sanitizeText(entry && entry.phone) ||
          pickFirstFormValue(fields, ['phone', 'phonenumber', 'patientphone', 'clinicphone']) ||
          null,
        source: sanitizeText(entry && entry.source) || 'formchapter1.octelerad.com',
        form_name: sanitizeText(entry && entry.form_name) || null,
        nextcloud_study_url:
          sanitizeText(entry && entry.nextcloud_study_url) ||
          pickFirstFormUrl(fields, [
            'nextcloud_study_url',
            'nextcloud_url',
            'nextcloud',
            'study_nextcloud_url',
            'study_url',
            'study_link',
            'cloud_link',
            'cloud_url',
          ]) ||
          null,
        payload: payload,
        fields: fields,
        created_at: createdAt,
        updated_at: sanitizeText(entry && entry.updated_at) || createdAt,
        received_from_ip: sanitizeText(entry && entry.received_from_ip) || null,
        request_id: sanitizeText(entry && entry.request_id) || null,
        idempotency_key: sanitizeText(entry && entry.idempotency_key) || null,
      };
      normalized.patient_lookup_url = buildPatientLookupUrl(normalized.patient_identifier);
      normalized.search_index = buildFormSubmissionSearchIndex(normalized, fields);
      return normalized;
    })
    .sort(function (left, right) {
      return new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime();
    });
}

function loadFormSubmissions() {
  return readCachedJsonArray(
    FORM_SUBMISSIONS_FILE,
    formSubmissionsFileCache,
    normalizeFormSubmissions,
    'form_submissions.load_failed'
  );
}

function saveFormSubmissions(entries) {
  const normalized = normalizeFormSubmissions(entries);
  const tempFile = `${FORM_SUBMISSIONS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, FORM_SUBMISSIONS_FILE);
  updateCachedJsonArray(FORM_SUBMISSIONS_FILE, formSubmissionsFileCache, normalized);
}

function validateFormSubmissionApiKey(req) {
  if (!FORM_SUBMISSIONS_API_KEY) return true;
  const authHeader = sanitizeText(req.headers.authorization || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const submittedKey = sanitizeText(req.headers['x-form-submissions-key'] || req.headers['x-api-key']) || bearerToken;
  if (!submittedKey) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(submittedKey), Buffer.from(FORM_SUBMISSIONS_API_KEY));
  } catch (_) {
    return false;
  }
}

function makeFormSubmissionRecord(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawPayload =
    body.fields && typeof body.fields === 'object'
      ? body.fields
      : body.payload && typeof body.payload === 'object'
        ? body.payload
        : body;
  const payload = sanitizeFormJsonValue(rawPayload, 0) || {};
  const fields = [];
  flattenFormValues(payload, '', fields);
  const type = normalizeSubmissionType(body.type || body.submission_type || body.category, payload);
  const id = crypto.randomUUID();
  const displayName =
    sanitizeText(body.display_name || body.displayName || body.name) ||
    pickFirstFormValue(fields, ['patientname', 'clinicname', 'fullname', 'name', 'contactname']) ||
    `${type.charAt(0).toUpperCase()}${type.slice(1)} submission`;
  const now = nowIso();
  const record = {
    id: id,
    type: type,
    patient_identifier:
      getPatientIdentifierFromPayload(body, fields) ||
      (type === 'patient' ? makeGeneratedPatientIdentifier(id) : null),
    display_name: displayName,
    email:
      sanitizeText(body.email) ||
      pickFirstFormValue(fields, ['email', 'patientemail', 'clinicemail', 'contactemail']) ||
      null,
    phone:
      sanitizeText(body.phone) ||
      pickFirstFormValue(fields, ['phone', 'phonenumber', 'patientphone', 'clinicphone']) ||
      null,
    source: sanitizeText(body.source || body.source_site) || 'formchapter1.octelerad.com',
    form_name: sanitizeText(body.form_name || body.formName || body.form) || null,
    nextcloud_study_url:
      sanitizeText(body.nextcloud_study_url || body.nextcloudUrl || body.nextcloud_url || body.study_url || body.studyUrl) ||
      pickFirstFormUrl(fields, [
        'nextcloud_study_url',
        'nextcloud_url',
        'nextcloud',
        'study_nextcloud_url',
        'study_url',
        'study_link',
        'cloud_link',
        'cloud_url',
      ]) ||
      null,
    payload: payload,
    fields: fields,
    created_at: now,
    updated_at: now,
    received_from_ip: sanitizeText(req.ip) || null,
    request_id: sanitizeText(req.requestId) || null,
  };
  record.patient_lookup_url = buildPatientLookupUrl(record.patient_identifier);
  record.search_index = buildFormSubmissionSearchIndex(record, fields);
  return record;
}

function getFormSubmissionSourceHeaders(cookieHeader) {
  const headers = {
    Accept: 'application/json',
  };
  if (FORM_SUBMISSIONS_SOURCE_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${FORM_SUBMISSIONS_SOURCE_BEARER_TOKEN}`;
  }
  if (FORM_SUBMISSIONS_SOURCE_API_KEY) {
    headers['x-api-key'] = FORM_SUBMISSIONS_SOURCE_API_KEY;
  }
  if (cookieHeader || FORM_SUBMISSIONS_SOURCE_COOKIE) {
    headers.Cookie = cookieHeader || FORM_SUBMISSIONS_SOURCE_COOKIE;
  }
  return headers;
}

function joinUrl(baseUrl, requestPath) {
  const cleanPath = sanitizeText(requestPath || '').replace(/^\/+/, '');
  return `${normalizeBaseUrl(baseUrl)}/${cleanPath}`;
}

function collectSetCookieHeader(value) {
  if (!value) return '';
  const cookies = Array.isArray(value) ? value : [value];
  return cookies
    .map(function (cookie) {
      return String(cookie).split(';')[0].trim();
    })
    .filter(Boolean)
    .join('; ');
}

async function getFormSubmissionSourceCookie() {
  if (FORM_SUBMISSIONS_SOURCE_COOKIE) return FORM_SUBMISSIONS_SOURCE_COOKIE;
  if (!FORM_SUBMISSIONS_SOURCE_USERNAME || !FORM_SUBMISSIONS_SOURCE_PASSWORD) return '';

  const loginUrl = joinUrl(FORM_SUBMISSIONS_SOURCE_BASE_URL, '/api/auth/staff-login');
  const response = await axios.post(
    loginUrl,
    {
      username: FORM_SUBMISSIONS_SOURCE_USERNAME,
      password: FORM_SUBMISSIONS_SOURCE_PASSWORD,
    },
    {
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: function () {
        return true;
      },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Form source login failed (${response.status}).`);
  }
  return collectSetCookieHeader(response.headers && response.headers['set-cookie']);
}

function extractRemoteSubmissionItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.submissions)) return payload.submissions;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.submission && typeof payload.submission === 'object') return [payload.submission];
  return [];
}

function extractRemoteTotal(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const value = Number(payload.total || payload.count || payload.total_count || payload.totalCount);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function fetchRemoteFormSubmissionsPage(offset, limit, cookieHeader) {
  const listUrl = new URL(joinUrl(FORM_SUBMISSIONS_SOURCE_BASE_URL, FORM_SUBMISSIONS_SOURCE_LIST_PATH));
  if (!listUrl.searchParams.has('offset')) listUrl.searchParams.set('offset', String(offset));
  if (!listUrl.searchParams.has('limit')) listUrl.searchParams.set('limit', String(limit));
  const response = await axios.get(listUrl.toString(), {
    timeout: HTTP_TIMEOUT_MS,
    headers: getFormSubmissionSourceHeaders(cookieHeader),
  });
  const payload = response.data;
  const items = extractRemoteSubmissionItems(payload);
  return {
    items: items,
    total: extractRemoteTotal(payload, offset + items.length),
  };
}

async function fetchRemoteFormSubmissionDetail(id, cookieHeader) {
  if (!FORM_SUBMISSIONS_SOURCE_FETCH_DETAILS || !FORM_SUBMISSIONS_SOURCE_DETAIL_PATH || !id) return null;
  const detailPath = FORM_SUBMISSIONS_SOURCE_DETAIL_PATH.replace(':id', encodeURIComponent(id));
  const response = await axios.get(joinUrl(FORM_SUBMISSIONS_SOURCE_BASE_URL, detailPath), {
    timeout: HTTP_TIMEOUT_MS,
    headers: getFormSubmissionSourceHeaders(cookieHeader),
  });
  const items = extractRemoteSubmissionItems(response.data);
  return items[0] || response.data || null;
}

function normalizeRemoteFormSubmission(item) {
  const sourceItem = item && typeof item === 'object' ? item : {};
  const sourceId = sanitizeText(sourceItem.id || sourceItem.submission_id || sourceItem.submissionId);
  const kind = sanitizeText(sourceItem.kind || sourceItem.type || sourceItem.form_type || sourceItem.formType);
  const payload =
    sourceItem.payload && typeof sourceItem.payload === 'object'
      ? sourceItem.payload
      : sourceItem.data && typeof sourceItem.data === 'object'
        ? sourceItem.data
        : sourceItem;
  const createdAt =
    sanitizeText(sourceItem.receivedAt || sourceItem.received_at || sourceItem.created_at || sourceItem.submittedAt) ||
    nowIso();
  return {
    id: sourceId ? `formchapter1:${sourceId}` : crypto.randomUUID(),
    type: normalizeSubmissionType(kind, payload),
    patient_identifier:
      getPatientIdentifierFromPayload(sourceItem, []) ||
      getPatientIdentifierFromPayload(payload, []),
    display_name: sanitizeText(sourceItem.title || sourceItem.display_name || sourceItem.name),
    email: sanitizeText(sourceItem.email || sourceItem.contact_email) || null,
    phone: sanitizeText(sourceItem.phone || sourceItem.contact_phone) || null,
    source: 'formchapter1.octelerad.com',
    form_name:
      sanitizeText(sourceItem.form_name || sourceItem.formName) ||
      (kind === 'patient' ? 'Patient intake' : kind === 'partner' || kind === 'clinic' ? 'Clinic registration' : null),
    payload: payload,
    created_at: createdAt,
    updated_at: sanitizeText(sourceItem.updated_at || sourceItem.updatedAt) || createdAt,
    received_from_ip: sanitizeText(sourceItem.ip || sourceItem.received_from_ip) || null,
    request_id: sourceId || null,
  };
}

function mergeFormSubmissions(existingEntries, incomingEntries) {
  const byId = new Map();
  normalizeFormSubmissions(existingEntries).forEach(function (entry) {
    byId.set(entry.id, entry);
  });

  let created = 0;
  let updated = 0;
  normalizeFormSubmissions(incomingEntries).forEach(function (entry) {
    if (byId.has(entry.id)) {
      updated += 1;
    } else {
      created += 1;
    }
    byId.set(entry.id, entry);
  });

  const submissions = normalizeFormSubmissions(Array.from(byId.values()));
  return {
    submissions: submissions,
    created: created,
    updated: updated,
  };
}

function makeUpcomingPatientRecord(submission) {
  const fields = Array.isArray(submission && submission.fields) ? submission.fields : [];
  const patientIdentifier = normalizePatientIdentifier(submission && submission.patient_identifier);
  return {
    id: sanitizeText(submission && submission.id),
    patient_identifier: patientIdentifier || null,
    patient_lookup_url: buildPatientLookupUrl(patientIdentifier),
    name:
      sanitizeText(submission && submission.display_name) ||
      pickFirstFormValue(fields, ['patientname', 'fullname', 'name']) ||
      'Upcoming patient',
    email: sanitizeText(submission && submission.email) || pickFirstFormValue(fields, ['email', 'patientemail']) || null,
    phone:
      sanitizeText(submission && submission.phone) ||
      pickFirstFormValue(fields, ['phone', 'phonenumber', 'patientphone']) ||
      null,
    source: sanitizeText(submission && submission.source) || null,
    form_name: sanitizeText(submission && submission.form_name) || null,
    submitted_at: sanitizeText(submission && submission.created_at) || null,
    updated_at: sanitizeText(submission && submission.updated_at) || null,
    fields: fields,
    payload: submission && submission.payload && typeof submission.payload === 'object' ? submission.payload : {},
  };
}

function listUpcomingPatientRecords(options) {
  const limit = Math.min(Math.max(Number(options && options.limit) || 50, 1), 250);
  const query = sanitizeText(options && options.query).toLowerCase();
  return loadFormSubmissions()
    .filter(function (submission) {
      return sanitizeText(submission && submission.type).toLowerCase() === 'patient';
    })
    .map(makeUpcomingPatientRecord)
    .filter(function (patient) {
      if (!query) return true;
      return [
        patient.name,
        patient.email,
        patient.phone,
        patient.patient_identifier,
        patient.form_name,
        patient.source,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    })
    .sort(function (left, right) {
      return new Date(right.submitted_at || 0).getTime() - new Date(left.submitted_at || 0).getTime();
    })
    .slice(0, limit);
}

async function pullAllFormSubmissionsFromSource() {
  if (
    !FORM_SUBMISSIONS_SOURCE_BASE_URL ||
    (!FORM_SUBMISSIONS_SOURCE_COOKIE &&
      !FORM_SUBMISSIONS_SOURCE_BEARER_TOKEN &&
      !FORM_SUBMISSIONS_SOURCE_API_KEY &&
      (!FORM_SUBMISSIONS_SOURCE_USERNAME || !FORM_SUBMISSIONS_SOURCE_PASSWORD))
  ) {
    throw new Error('Configure form submission source credentials before syncing.');
  }

  const cookieHeader = await getFormSubmissionSourceCookie();
  const remoteItems = [];
  let offset = 0;
  let total = null;

  for (let page = 0; page < FORM_SUBMISSIONS_SOURCE_MAX_PAGES; page += 1) {
    const pageResult = await fetchRemoteFormSubmissionsPage(offset, FORM_SUBMISSIONS_SOURCE_PAGE_LIMIT, cookieHeader);
    const items = pageResult.items;
    total = pageResult.total;
    if (!items.length) break;
    for (const item of items) {
      const sourceId = sanitizeText(item && (item.id || item.submission_id || item.submissionId));
      const detail = await fetchRemoteFormSubmissionDetail(sourceId, cookieHeader).catch(function (err) {
        log('warn', 'form_submissions.detail_fetch_failed', {
          id: sourceId,
          error: err.message,
        });
        return null;
      });
      remoteItems.push(normalizeRemoteFormSubmission(detail || item));
    }
    offset += items.length;
    if (total !== null && offset >= total) break;
    if (items.length < FORM_SUBMISSIONS_SOURCE_PAGE_LIMIT) break;
  }

  const currentEntries = loadFormSubmissions();
  const merged = mergeFormSubmissions(currentEntries, remoteItems);
  saveFormSubmissions(merged.submissions);
  return {
    fetched: remoteItems.length,
    created: merged.created,
    updated: merged.updated,
    total: merged.submissions.length,
  };
}

function normalizeUploadedVideoJobs(jobs) {
  return (jobs || []).map(function (job) {
    return {
      id: sanitizeText(job && job.id) || crypto.randomUUID(),
      study_id: Number(job && job.study_id) || 0,
      source_path: sanitizeText(job && job.source_path),
      original_name: sanitizeText(job && job.original_name) || null,
      source: sanitizeText(job && job.source) || 'video_upload',
      status: sanitizeText(job && job.status) || 'queued',
      error: sanitizeText(job && job.error) || null,
      created_at: sanitizeText(job && job.created_at) || nowIso(),
      updated_at: sanitizeText(job && job.updated_at) || nowIso(),
    };
  });
}

function loadUploadedVideoJobs() {
  return readCachedJsonArray(
    UPLOADED_VIDEO_JOBS_FILE,
    uploadedVideoJobsFileCache,
    normalizeUploadedVideoJobs,
    'uploaded_video_jobs.load_failed'
  );
}

function saveUploadedVideoJobs(jobs) {
  const normalized = normalizeUploadedVideoJobs(jobs);
  const tempFile = `${UPLOADED_VIDEO_JOBS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, UPLOADED_VIDEO_JOBS_FILE);
  updateCachedJsonArray(UPLOADED_VIDEO_JOBS_FILE, uploadedVideoJobsFileCache, normalized);
}

function updateUploadedVideoJob(jobId, updater) {
  const jobs = loadUploadedVideoJobs();
  const idx = jobs.findIndex(function (job) {
    return sanitizeText(job.id) === sanitizeText(jobId);
  });
  if (idx < 0) return null;
  const next = { ...jobs[idx] };
  updater(next);
  next.updated_at = nowIso();
  jobs[idx] = next;
  saveUploadedVideoJobs(jobs);
  return next;
}

const studyRealtimeSubscribers = new Set();
const studyPresenceById = new Map();
const STUDY_PRESENCE_STALE_MS = 45 * 1000;
const STUDY_REALTIME_HEARTBEAT_MS = 15000;

function getStudyPresenceMap(studyId, createIfMissing) {
  const key = String(Number(studyId) || 0);
  let map = studyPresenceById.get(key);
  if (!map && createIfMissing) {
    map = new Map();
    studyPresenceById.set(key, map);
  }
  return map || null;
}

function normalizeStudyPresenceMode(value) {
  const mode = sanitizeText(value).toLowerCase();
  if (mode === 'editing' || mode === 'signoff' || mode === 'viewing') return mode;
  return 'viewing';
}

function normalizeStudyPresenceEntry(entry) {
  return {
    client_id: sanitizeText(entry && entry.client_id),
    email: sanitizeText(entry && entry.email) || null,
    name: sanitizeText(entry && entry.name) || null,
    role: sanitizeText(entry && entry.role) || null,
    mode: normalizeStudyPresenceMode(entry && entry.mode),
    last_seen_at: sanitizeText(entry && entry.last_seen_at) || nowIso(),
    connected_at: sanitizeText(entry && entry.connected_at) || nowIso(),
  };
}

function pruneStudyPresence(studyId) {
  const map = getStudyPresenceMap(studyId, false);
  if (!map) return false;

  const now = Date.now();
  let changed = false;
  for (const [clientId, entry] of map.entries()) {
    const seenAt = new Date(entry && entry.last_seen_at ? entry.last_seen_at : 0).getTime();
    if (!seenAt || now - seenAt > STUDY_PRESENCE_STALE_MS) {
      map.delete(clientId);
      changed = true;
    }
  }

  if (map.size === 0) {
    studyPresenceById.delete(String(Number(studyId) || 0));
  }

  return changed;
}

function listStudyPresence(studyId) {
  pruneStudyPresence(studyId);
  const map = getStudyPresenceMap(studyId, false);
  if (!map) return [];
  return Array.from(map.values())
    .map(normalizeStudyPresenceEntry)
    .sort(function (left, right) {
      const leftTs = new Date(left.last_seen_at || 0).getTime();
      const rightTs = new Date(right.last_seen_at || 0).getTime();
      return rightTs - leftTs;
    });
}

function upsertStudyPresence(studyId, payload) {
  const clientId = sanitizeText(payload && payload.client_id);
  if (!clientId) {
    throw makeAppError('VALIDATION_ERROR', 400, 'client_id is required.');
  }

  const map = getStudyPresenceMap(studyId, true);
  const next = normalizeStudyPresenceEntry({
    client_id: clientId,
    email: payload && payload.email,
    name: payload && payload.name,
    role: payload && payload.role,
    mode: payload && payload.mode,
    last_seen_at: nowIso(),
    connected_at: payload && payload.connected_at,
  });
  const prev = map.get(clientId);
  map.set(clientId, next);
  return {
    changed:
      !prev ||
      prev.email !== next.email ||
      prev.name !== next.name ||
      prev.role !== next.role ||
      prev.mode !== next.mode,
    presence: listStudyPresence(studyId),
    entry: next,
  };
}

function removeStudyPresence(studyId, clientId) {
  const map = getStudyPresenceMap(studyId, false);
  if (!map) return false;
  const removed = map.delete(sanitizeText(clientId));
  if (map.size === 0) {
    studyPresenceById.delete(String(Number(studyId) || 0));
  }
  return removed;
}

function sendStudyRealtimeEvent(target, eventName, payload) {
  try {
    target.res.write(`event: ${eventName}\n`);
    target.res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
  } catch (err) {
    target.closed = true;
  }
}

function makeStudyRealtimeSnapshot(study, options) {
  const opts = options || {};
  const studyId = Number(study && study.id);
  const recordings = loadCaseRecordings().filter(function (record) {
    return Number(record && record.studyId) === studyId;
  });
  recordings.sort(function (a, b) {
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
  return {
    study_id: studyId,
    study: study ? { ...study } : null,
    event: 'snapshot',
    scope: opts.scope || 'study',
    recordings_count: recordings.length,
    latest_recording: recordings[0] || null,
    presence: listStudyPresence(studyId),
    updated_at: sanitizeText(study && study.updated_at) || nowIso(),
  };
}

function publishStudyRealtimeEvent(study, eventName, payload) {
  const studyId = Number(study && study.id);
  if (!Number.isFinite(studyId) || studyId <= 0) return;
  pruneStudyPresence(studyId);
  const message = {
    event: eventName,
    study_id: studyId,
    study: study ? { ...study } : null,
    presence: listStudyPresence(studyId),
    updated_at: sanitizeText(study && study.updated_at) || nowIso(),
    ...(payload && typeof payload === 'object' ? payload : {}),
  };

  for (const client of studyRealtimeSubscribers) {
    if (client.closed) continue;
    if (client.studyId && client.studyId !== studyId) continue;
    sendStudyRealtimeEvent(client, eventName, message);
  }
}

function registerStudyRealtimeClient(client) {
  studyRealtimeSubscribers.add(client);
}

function unregisterStudyRealtimeClient(client) {
  client.closed = true;
  studyRealtimeSubscribers.delete(client);
}

function makeStudyVersionConflictError(study, baseUpdatedAt) {
  return makeAppError('STUDY_VERSION_CONFLICT', 409, 'This study changed on another device. Reload before saving again.', {
    study_id: Number(study && study.id) || null,
    current_updated_at: sanitizeText(study && study.updated_at) || null,
    base_updated_at: sanitizeText(baseUpdatedAt) || null,
  });
}

function assertStudyVersion(study, body) {
  const baseUpdatedAt = sanitizeText(body && (body.base_updated_at || body.baseUpdatedAt));
  if (!baseUpdatedAt) return;
  const currentUpdatedAt = sanitizeText(study && study.updated_at);
  if (currentUpdatedAt && currentUpdatedAt !== baseUpdatedAt) {
    throw makeStudyVersionConflictError(study, baseUpdatedAt);
  }
}

function normalizeAcronymCode(value) {
  return sanitizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeAcronymDatabase(entries) {
  const seen = new Set();
  return (entries || [])
    .map(function (entry) {
      const code = normalizeAcronymCode(entry && entry.code);
      const diagnosis = sanitizeMultilineText(entry && entry.diagnosis, 50000);
      const aliases = compactUniqueTokens([
        code,
        ...(Array.isArray(entry && entry.aliases) ? entry.aliases : []),
      ]).map(normalizeAcronymCode).filter(Boolean);
      return {
        code: code,
        diagnosis: diagnosis,
        aliases: aliases,
        chapter: sanitizeText(entry && entry.chapter),
        client: sanitizeText(entry && entry.client),
        source_doc_id: sanitizeText(entry && entry.source_doc_id),
        source_table_id: sanitizeText(entry && entry.source_table_id),
        source_record_id: sanitizeText(entry && entry.source_record_id),
        synced_at: sanitizeText(entry && entry.synced_at),
      };
    })
    .filter(function (entry) {
      if (!entry.code || !entry.diagnosis || seen.has(entry.code)) return false;
      seen.add(entry.code);
      return true;
    })
    .sort(function (a, b) {
      return a.code.localeCompare(b.code);
    });
}

function loadAcronymDatabase() {
  return readCachedJsonArray(
    ACRONYM_DATABASE_FILE,
    acronymDatabaseFileCache,
    normalizeAcronymDatabase,
    'acronym.database.load_failed'
  );
}

function saveAcronymDatabase(entries) {
  const normalized = normalizeAcronymDatabase(entries);
  const tempFile = `${ACRONYM_DATABASE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, ACRONYM_DATABASE_FILE);
  updateCachedJsonArray(ACRONYM_DATABASE_FILE, acronymDatabaseFileCache, normalized);
  return normalized;
}

function findAcronymEntry(code) {
  const normalizedCode = normalizeAcronymCode(code);
  if (!normalizedCode) return null;
  return loadAcronymDatabase().find(function (entry) {
    return entry.code === normalizedCode || (entry.aliases || []).includes(normalizedCode);
  }) || null;
}

function makeGristProxyAuth(options) {
  const username = sanitizeText(options && options.username) || GRIST_PROXY_BASIC_USERNAME;
  const password = options && Object.prototype.hasOwnProperty.call(options, 'password')
    ? String(options.password || '')
    : GRIST_PROXY_BASIC_PASSWORD;
  if (!username || !password) return null;
  return { username: username, password: password };
}

function makeGristProxyHeaders() {
  if (GRIST_API_KEY) return getGristHeaders();
  return { 'Content-Type': 'application/json' };
}

function extractAcronymEntriesFromGristRecord(record, tableId, docId, syncedAt) {
  const fields = (record && record.fields) || {};
  const diagnosis = sanitizeMultilineText(fields.F || fields.Diagnosis || fields.Report || fields.Template, 50000);
  if (!diagnosis) return [];

  const aliases = compactUniqueTokens([
    fields.E,
    fields.H,
    fields.Code,
    fields.Acronym,
  ]).map(normalizeAcronymCode).filter(Boolean);
  if (aliases.length === 0) return [];

  return aliases.map(function (code) {
    return {
      code: code,
      diagnosis: diagnosis,
      aliases: aliases,
      chapter: sanitizeText(fields.A || fields.Chapter),
      client: sanitizeText(fields.B || fields.Client),
      source_doc_id: sanitizeText(docId),
      source_table_id: sanitizeText(tableId),
      source_record_id: String(record && record.id ? record.id : ''),
      synced_at: syncedAt,
    };
  });
}

async function fetchGristAcronymTables(options) {
  const docId = sanitizeText(options && options.docId) || GRIST_ACRONYM_DOC_ID;
  const baseUrl = normalizeBaseUrl((options && options.baseUrl) || GRIST_BASE_URL);
  if (!baseUrl || !docId) {
    throw makeAppError('GRIST_ACRONYM_NOT_CONFIGURED', 503, 'Grist acronym document is not configured.');
  }
  const authOption = makeGristProxyAuth(options);
  const response = await gristClient.get(
    `${baseUrl}/api/docs/${encodeURIComponent(docId)}/tables`,
    {
      headers: makeGristProxyHeaders(),
      auth: authOption || undefined,
    }
  );
  const tables = response.data && Array.isArray(response.data.tables) ? response.data.tables : [];
  const configured = options && Array.isArray(options.tableIds) && options.tableIds.length
    ? options.tableIds
    : GRIST_ACRONYM_TABLE_IDS;
  const allowed = new Set(configured.map(function (tableId) {
    return sanitizeText(tableId);
  }).filter(Boolean));
  return tables
    .map(function (table) {
      return sanitizeText(table && table.id);
    })
    .filter(function (tableId) {
      return tableId && (allowed.size === 0 || allowed.has(tableId));
    });
}

async function syncAcronymDatabaseFromGrist(options) {
  const docId = sanitizeText(options && options.docId) || GRIST_ACRONYM_DOC_ID;
  const baseUrl = normalizeBaseUrl((options && options.baseUrl) || GRIST_BASE_URL);
  const tableIds = await fetchGristAcronymTables(options || {});
  const syncedAt = nowIso();
  const entries = [];
  const authOption = makeGristProxyAuth(options);

  for (const tableId of tableIds) {
    const response = await gristClient.get(
      `${baseUrl}/api/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(tableId)}/records`,
      {
        headers: makeGristProxyHeaders(),
        auth: authOption || undefined,
      }
    );
    const records = response.data && Array.isArray(response.data.records) ? response.data.records : [];
    records.forEach(function (record) {
      entries.push(...extractAcronymEntriesFromGristRecord(record, tableId, docId, syncedAt));
    });
  }

  const saved = saveAcronymDatabase(entries);
  return {
    ok: true,
    synced_at: syncedAt,
    doc_id: docId,
    table_count: tableIds.length,
    acronym_count: saved.length,
  };
}

async function refreshAcronymDatabase(reason, options) {
  if (acronymDatabaseSyncInFlight) return null;
  acronymDatabaseSyncInFlight = true;
  try {
    const result = await syncAcronymDatabaseFromGrist(options || {});
    log('info', 'acronym.database_refreshed', {
      reason: sanitizeText(reason) || 'manual',
      doc_id: result.doc_id,
      table_count: result.table_count,
      acronym_count: result.acronym_count,
    });
    return result;
  } catch (err) {
    log('warn', 'acronym.database_refresh_failed', {
      reason: sanitizeText(reason) || 'manual',
      error: extractAxiosError(err),
    });
    return null;
  } finally {
    acronymDatabaseSyncInFlight = false;
  }
}

function startAcronymDatabaseSyncSchedule() {
  if (acronymDatabaseSyncTimer || acronymDatabaseInitialSyncTimer) return;
  acronymDatabaseInitialSyncTimer = setTimeout(function () {
    refreshAcronymDatabase('startup').catch(function () {});
    acronymDatabaseSyncTimer = setInterval(function () {
      refreshAcronymDatabase('interval').catch(function () {});
    }, GRIST_ACRONYM_SYNC_INTERVAL_MS);
    if (acronymDatabaseSyncTimer && typeof acronymDatabaseSyncTimer.unref === 'function') {
      acronymDatabaseSyncTimer.unref();
    }
  }, GRIST_ACRONYM_INITIAL_SYNC_DELAY_MS);
  if (acronymDatabaseInitialSyncTimer && typeof acronymDatabaseInitialSyncTimer.unref === 'function') {
    acronymDatabaseInitialSyncTimer.unref();
  }
}

function normalizeGristCompletedCaseRows(rows) {
  return (rows || [])
    .map(function (row) {
      return {
        Code: sanitizeText(row && row.Code),
        StudyName: sanitizeText(row && row.StudyName),
        Modality: sanitizeText(row && row.Modality),
        NextcloudLink: sanitizeText(row && row.NextcloudLink),
        StudyId: sanitizeText(row && row.StudyId),
        PatientId: normalizePatientIdentifier(row && row.PatientId),
        PatientLookupUrl: sanitizeText(row && row.PatientLookupUrl),
        PatientName: sanitizeText(row && row.PatientName),
        PatientEmail: sanitizeText(row && row.PatientEmail),
        CaseTitle: sanitizeText(row && row.CaseTitle),
        PackageFolder: sanitizeText(row && row.PackageFolder),
        ExportedAt: sanitizeText(row && row.ExportedAt),
        DicomExported: Number(row && row.DicomExported) || 0,
      };
    })
    .filter(function (row) {
      return row.Code && row.NextcloudLink;
    });
}

function loadGristCompletedCasesQueue() {
  return readCachedJsonArray(
    GRIST_COMPLETED_CASES_QUEUE_FILE,
    gristCompletedCasesQueueFileCache,
    normalizeGristCompletedCaseRows,
    'grist.completed_cases_queue.load_failed'
  );
}

function saveGristCompletedCasesQueue(rows) {
  const normalized = normalizeGristCompletedCaseRows(rows);
  const tempFile = `${GRIST_COMPLETED_CASES_QUEUE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, GRIST_COMPLETED_CASES_QUEUE_FILE);
  updateCachedJsonArray(GRIST_COMPLETED_CASES_QUEUE_FILE, gristCompletedCasesQueueFileCache, normalized);
}

function isGristConfigured() {
  return Boolean(GRIST_BASE_URL && GRIST_API_KEY && GRIST_DOC_ID && GRIST_COMPLETED_CASES_TABLE_ID);
}

function getStudyNameForCompletedCaseCode(study) {
  return (
    sanitizeText(study && study.patient_id) ||
    sanitizeText(study && study.patient_name) ||
    `Study_${study && study.id ? study.id : Date.now()}`
  );
}

function buildCompletedCaseCode(studyName, modality, nextcloudLink) {
  return `OCTR - .${sanitizeText(studyName) || 'UNKNOWN'} - ..${sanitizeText(modality) || 'UNKNOWN'} - ...${sanitizeText(nextcloudLink)}`;
}

function makeGristCompletedCaseRows(selectedStudies, body, shareUrl, packagePath, dicomExportedByStudy) {
  const exportedAt = nowIso();
  return (selectedStudies || []).map(function (entry) {
    const study = entry.study || {};
    const studyName = getStudyNameForCompletedCaseCode(study);
    const modality = sanitizeText(study.modality) || 'UNKNOWN';
    return {
      Code: buildCompletedCaseCode(studyName, modality, shareUrl),
      StudyName: studyName,
      Modality: modality,
      NextcloudLink: sanitizeText(shareUrl),
      StudyId: String(study.id || ''),
      PatientId: normalizePatientIdentifier(study.patient_id),
      PatientLookupUrl: buildPatientLookupUrl(study.patient_id),
      PatientName: sanitizeText(body && body.patientName) || sanitizeText(study.patient_name),
      PatientEmail: sanitizeText(body && body.patientEmail),
      CaseTitle: sanitizeText(body && body.title),
      PackageFolder: sanitizeText(packagePath),
      ExportedAt: exportedAt,
      DicomExported: Number(dicomExportedByStudy && dicomExportedByStudy[study.id]) || 0,
    };
  });
}

function getGristHeaders() {
  return {
    Authorization: `Bearer ${GRIST_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function ensureGristCompletedCasesTable() {
  if (gristCompletedCasesTableReady) return;
  if (!isGristConfigured()) {
    throw makeAppError('GRIST_NOT_CONFIGURED', 503, 'Grist integration is not configured.');
  }

  const tablesUrl = `${GRIST_BASE_URL}/api/docs/${encodeURIComponent(GRIST_DOC_ID)}/tables`;
  const response = await gristClient.get(tablesUrl, { headers: getGristHeaders() });
  const tables = response.data && Array.isArray(response.data.tables) ? response.data.tables : [];
  const exists = tables.some(function (table) {
    return table && table.id === GRIST_COMPLETED_CASES_TABLE_ID;
  });

  if (!exists) {
    await gristClient.post(
      tablesUrl,
      {
        tables: [
          {
            id: GRIST_COMPLETED_CASES_TABLE_ID,
            columns: [
              { id: 'Code', fields: { type: 'Text', label: 'OCTR Code' } },
              { id: 'StudyName', fields: { type: 'Text', label: 'Study Name' } },
              { id: 'Modality', fields: { type: 'Text', label: 'Study Modality' } },
              { id: 'NextcloudLink', fields: { type: 'Text', label: 'Nextcloud Study Details' } },
              { id: 'StudyId', fields: { type: 'Text', label: 'Study ID' } },
              { id: 'PatientId', fields: { type: 'Text', label: 'Patient ID' } },
              { id: 'PatientLookupUrl', fields: { type: 'Text', label: 'Patient Lookup URL' } },
              { id: 'PatientName', fields: { type: 'Text', label: 'Patient Name' } },
              { id: 'PatientEmail', fields: { type: 'Text', label: 'Patient Email' } },
              { id: 'CaseTitle', fields: { type: 'Text', label: 'Case Title' } },
              { id: 'PackageFolder', fields: { type: 'Text', label: 'Nextcloud Folder' } },
              { id: 'ExportedAt', fields: { type: 'Text', label: 'Exported At' } },
              { id: 'DicomExported', fields: { type: 'Numeric', label: 'DICOM Exported' } },
            ],
          },
        ],
      },
      { headers: getGristHeaders() }
    );
    log('info', 'grist.completed_cases_table_created', {
      doc_id: GRIST_DOC_ID,
      table_id: GRIST_COMPLETED_CASES_TABLE_ID,
      requested_name: GRIST_COMPLETED_CASES_TABLE_NAME,
    });
  }

  gristCompletedCasesTableReady = true;
}

async function appendGristCompletedCaseRows(rows) {
  const normalized = normalizeGristCompletedCaseRows(rows);
  if (normalized.length === 0) return { appended: 0 };
  await ensureGristCompletedCasesTable();
  await gristClient.post(
    `${GRIST_BASE_URL}/api/docs/${encodeURIComponent(GRIST_DOC_ID)}/tables/${encodeURIComponent(GRIST_COMPLETED_CASES_TABLE_ID)}/records`,
    {
      records: normalized.map(function (row) {
        return { fields: row };
      }),
    },
    { headers: getGristHeaders() }
  );
  return { appended: normalized.length };
}

async function flushGristCompletedCasesQueue() {
  if (gristCompletedCasesFlushInFlight || !isGristConfigured()) return;
  const queued = loadGristCompletedCasesQueue();
  if (queued.length === 0) return;

  gristCompletedCasesFlushInFlight = true;
  try {
    const result = await appendGristCompletedCaseRows(queued);
    saveGristCompletedCasesQueue([]);
    log('info', 'grist.completed_cases_queue_flushed', { appended: result.appended });
  } catch (err) {
    log('warn', 'grist.completed_cases_queue_flush_failed', { error: extractAxiosError(err) });
  } finally {
    gristCompletedCasesFlushInFlight = false;
  }
}

async function logCompletedCasesToGrist(rows) {
  const normalized = normalizeGristCompletedCaseRows(rows);
  if (normalized.length === 0) return;

  if (!isGristConfigured()) {
    saveGristCompletedCasesQueue([...loadGristCompletedCasesQueue(), ...normalized]);
    log('warn', 'grist.completed_cases_not_configured', {
      queued: normalized.length,
      table_id: GRIST_COMPLETED_CASES_TABLE_ID,
      requested_name: GRIST_COMPLETED_CASES_TABLE_NAME,
    });
    return;
  }

  try {
    await flushGristCompletedCasesQueue();
    const result = await appendGristCompletedCaseRows(normalized);
    log('info', 'grist.completed_cases_logged', {
      appended: result.appended,
      doc_id: GRIST_DOC_ID,
      table_id: GRIST_COMPLETED_CASES_TABLE_ID,
      requested_name: GRIST_COMPLETED_CASES_TABLE_NAME,
    });
  } catch (err) {
    gristCompletedCasesTableReady = false;
    saveGristCompletedCasesQueue([...loadGristCompletedCasesQueue(), ...normalized]);
    log('warn', 'grist.completed_cases_log_failed', {
      queued: normalized.length,
      error: extractAxiosError(err),
    });
  }
}

function normalizeGristReportCodeRows(rows) {
  return (rows || [])
    .map(function (row) {
      return {
        ReportCode: sanitizeText(row && row.ReportCode),
        OctrCode: sanitizeText(row && row.OctrCode),
        RawCaseLog: sanitizeMultilineText(row && row.RawCaseLog),
        ClientCode: sanitizeText(row && row.ClientCode),
        ClientName: sanitizeText(row && row.ClientName),
        Tier: sanitizeText(row && row.Tier),
        Chapter: sanitizeText(row && row.Chapter),
        BodyRegion: sanitizeText(row && row.BodyRegion),
        PatientLog: sanitizeText(row && row.PatientLog),
        AcronymCodes: sanitizeText(row && row.AcronymCodes),
        DiagnosisCodes: sanitizeText(row && row.DiagnosisCodes),
        StudyId: sanitizeText(row && row.StudyId),
        StudyName: sanitizeText(row && row.StudyName),
        PatientName: sanitizeText(row && row.PatientName),
        PatientId: sanitizeText(row && row.PatientId),
        Modality: sanitizeText(row && row.Modality),
        StudyDate: sanitizeText(row && row.StudyDate),
        Status: sanitizeText(row && row.Status),
        SignedCompleteAt: sanitizeText(row && row.SignedCompleteAt),
        SignedBy: sanitizeText(row && row.SignedBy),
        NextcloudLink: sanitizeText(row && row.NextcloudLink),
        MonthlySheetDocId: sanitizeText(row && row.MonthlySheetDocId),
        MonthlySheetMonth: sanitizeText(row && row.MonthlySheetMonth),
        MonthlySheetRowId: sanitizeText(row && row.MonthlySheetRowId),
        AcronymDocId: sanitizeText(row && row.AcronymDocId),
        SyncDirection: sanitizeText(row && row.SyncDirection),
        SyncStatus: sanitizeText(row && row.SyncStatus),
        SyncMessage: sanitizeText(row && row.SyncMessage),
        SheetSyncedAt: sanitizeText(row && row.SheetSyncedAt),
        Source: sanitizeText(row && row.Source),
        CreatedAt: sanitizeText(row && row.CreatedAt),
        ReportTextPresent: Number(row && row.ReportTextPresent) || 0,
      };
    })
    .filter(function (row) {
      return row.ReportCode && row.StudyId;
    });
}

function loadGristReportCodesQueue() {
  return readCachedJsonArray(
    GRIST_REPORT_CODES_QUEUE_FILE,
    gristReportCodesQueueFileCache,
    normalizeGristReportCodeRows,
    'grist.report_codes_queue.load_failed'
  );
}

function saveGristReportCodesQueue(rows) {
  const normalized = normalizeGristReportCodeRows(rows);
  const tempFile = `${GRIST_REPORT_CODES_QUEUE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, GRIST_REPORT_CODES_QUEUE_FILE);
  updateCachedJsonArray(GRIST_REPORT_CODES_QUEUE_FILE, gristReportCodesQueueFileCache, normalized);
}

function isGristReportCodesConfigured() {
  return Boolean(GRIST_BASE_URL && GRIST_API_KEY && GRIST_REPORT_CODES_DOC_ID && GRIST_REPORT_CODES_TABLE_ID);
}

function getReportCodeLinkForStudy(study) {
  return sanitizeText(study && (study.nextcloud_url || study.nextcloud_folder)) || 'PENDING_EXPORT';
}

function buildReportCodeForStudy(study) {
  const studyName = getStudyNameForCompletedCaseCode(study);
  const modality = sanitizeText(study && study.modality) || 'UNKNOWN';
  return buildCompletedCaseCode(studyName, modality, getReportCodeLinkForStudy(study));
}

function compactUniqueTokens(tokens) {
  const seen = new Set();
  return (tokens || [])
    .map(function (token) {
      return sanitizeText(token).toUpperCase();
    })
    .filter(function (token) {
      if (!token || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

function getReportCodeSourceText(study) {
  return [
    study && study.patient_name,
    study && study.patient_id,
    study && study.notes,
    study && study.tech_notes,
    study && study.radiologist_notes,
    study && study.radiology_report,
  ]
    .map(function (value) {
      return sanitizeMultilineText(value);
    })
    .filter(Boolean)
    .join('\n');
}

function extractOctrCaseLogParts(study) {
  const raw = getReportCodeSourceText(study);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const octrMatch = normalized.match(/\b\d{3,}\s*\.?\s*OCTR[A-Z0-9]+(?:\.[A-Z0-9]+)?\b/i);
  const octrCode = octrMatch ? octrMatch[0].replace(/\s+/g, '').toUpperCase() : '';
  const allCapsTokens = compactUniqueTokens(normalized.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || []);
  const acronymCodes = allCapsTokens.filter(function (token) {
    return token !== 'OCTR' && !/^OCTR[A-Z0-9]+$/.test(token) && !/^CH\d+$/i.test(token) && !/^TIER\d+$/i.test(token);
  });
  const diagnosisCodes = acronymCodes.filter(function (token) {
    return /(NOR|CYS|FIB|LIM|COM|HYP|MEG|LES|LIV|KID|PEL|ABD|VEN|ART|MR|CT|US)$/.test(token);
  });
  const tierMatch = normalized.match(/\bTier\s*([0-9A-Za-z]+)\b/i) || normalized.match(/\bTIER([0-9A-Za-z]+)\b/i);
  const chapterMatch = normalized.match(/\bCh(?:apter)?\s*([0-9A-Za-z]+)\b/i) || normalized.match(/\bCH([0-9A-Za-z]+)\b/i);

  return {
    octrCode: octrCode,
    rawCaseLog: raw,
    tier: tierMatch ? `Tier${sanitizeText(tierMatch[1])}` : '',
    chapter: chapterMatch ? `Ch${sanitizeText(chapterMatch[1])}` : '',
    acronymCodes: acronymCodes.join(' '),
    diagnosisCodes: diagnosisCodes.join(' '),
  };
}

function makeGristReportCodeRowsForStudy(study, source) {
  if (!study || !study.id) return [];
  const reportText = sanitizeMultilineText(study.radiology_report);
  const caseLog = extractOctrCaseLogParts(study);
  return [
    {
      ReportCode: buildReportCodeForStudy(study),
      OctrCode: caseLog.octrCode,
      RawCaseLog: caseLog.rawCaseLog,
      ClientCode: '',
      ClientName: '',
      Tier: caseLog.tier,
      Chapter: caseLog.chapter,
      BodyRegion: sanitizeText(study.modality),
      PatientLog: caseLog.octrCode || sanitizeText(study.patient_name),
      AcronymCodes: caseLog.acronymCodes,
      DiagnosisCodes: caseLog.diagnosisCodes,
      StudyId: String(study.id || ''),
      StudyName: getStudyNameForCompletedCaseCode(study),
      PatientName: sanitizeText(study.patient_name),
      PatientId: sanitizeText(study.patient_id),
      Modality: sanitizeText(study.modality) || 'UNKNOWN',
      StudyDate: sanitizeText(study.study_date),
      Status: sanitizeText(study.status),
      SignedCompleteAt: sanitizeText(study.completed_at),
      SignedBy: sanitizeText(study.completed_by_name) || sanitizeText(study.completed_by_email),
      NextcloudLink: sanitizeText(study.nextcloud_url),
      MonthlySheetDocId: GRIST_REPORT_CODES_DOC_ID,
      MonthlySheetMonth: GRIST_REPORT_CODES_MONTH_KEY,
      MonthlySheetRowId: '',
      AcronymDocId: GRIST_ACRONYM_DOC_ID,
      SyncDirection: 'software_to_sheet',
      SyncStatus: 'pending',
      SyncMessage: '',
      SheetSyncedAt: '',
      Source: sanitizeText(source) || 'study_signoff',
      CreatedAt: nowIso(),
      ReportTextPresent: reportText ? 1 : 0,
    },
  ];
}

async function ensureGristReportCodesTable() {
  if (gristReportCodesTableReady) return;
  if (!isGristReportCodesConfigured()) {
    throw makeAppError('GRIST_NOT_CONFIGURED', 503, 'Grist integration is not configured.');
  }

  const tablesUrl = `${GRIST_BASE_URL}/api/docs/${encodeURIComponent(GRIST_REPORT_CODES_DOC_ID)}/tables`;
  const response = await gristClient.get(tablesUrl, { headers: getGristHeaders() });
  const tables = response.data && Array.isArray(response.data.tables) ? response.data.tables : [];
  const exists = tables.some(function (table) {
    return table && table.id === GRIST_REPORT_CODES_TABLE_ID;
  });

  if (!exists) {
    await gristClient.post(
      tablesUrl,
      {
        tables: [
          {
            id: GRIST_REPORT_CODES_TABLE_ID,
            columns: [
              { id: 'ReportCode', fields: { type: 'Text', label: 'Report Code' } },
              { id: 'OctrCode', fields: { type: 'Text', label: 'OCTR Code' } },
              { id: 'RawCaseLog', fields: { type: 'Text', label: 'Raw Case Log' } },
              { id: 'ClientCode', fields: { type: 'Text', label: 'Client Code' } },
              { id: 'ClientName', fields: { type: 'Text', label: 'Client Name' } },
              { id: 'Tier', fields: { type: 'Text', label: 'Tier' } },
              { id: 'Chapter', fields: { type: 'Text', label: 'Chapter' } },
              { id: 'BodyRegion', fields: { type: 'Text', label: 'Body Region' } },
              { id: 'PatientLog', fields: { type: 'Text', label: 'Patient Log' } },
              { id: 'AcronymCodes', fields: { type: 'Text', label: 'Acronym Codes' } },
              { id: 'DiagnosisCodes', fields: { type: 'Text', label: 'Diagnosis Codes' } },
              { id: 'StudyId', fields: { type: 'Text', label: 'Study ID' } },
              { id: 'StudyName', fields: { type: 'Text', label: 'Study Name' } },
              { id: 'PatientName', fields: { type: 'Text', label: 'Patient Name' } },
              { id: 'PatientId', fields: { type: 'Text', label: 'Patient ID' } },
              { id: 'Modality', fields: { type: 'Text', label: 'Modality' } },
              { id: 'StudyDate', fields: { type: 'Text', label: 'Study Date' } },
              { id: 'Status', fields: { type: 'Text', label: 'Status' } },
              { id: 'SignedCompleteAt', fields: { type: 'Text', label: 'Signed Complete At' } },
              { id: 'SignedBy', fields: { type: 'Text', label: 'Signed By' } },
              { id: 'NextcloudLink', fields: { type: 'Text', label: 'Nextcloud Link' } },
              { id: 'MonthlySheetDocId', fields: { type: 'Text', label: 'Monthly Sheet Doc ID' } },
              { id: 'MonthlySheetMonth', fields: { type: 'Text', label: 'Monthly Sheet Month' } },
              { id: 'MonthlySheetRowId', fields: { type: 'Text', label: 'Monthly Sheet Row ID' } },
              { id: 'AcronymDocId', fields: { type: 'Text', label: 'Acronym Doc ID' } },
              { id: 'SyncDirection', fields: { type: 'Text', label: 'Sync Direction' } },
              { id: 'SyncStatus', fields: { type: 'Text', label: 'Sync Status' } },
              { id: 'SyncMessage', fields: { type: 'Text', label: 'Sync Message' } },
              { id: 'SheetSyncedAt', fields: { type: 'Text', label: 'Sheet Synced At' } },
              { id: 'Source', fields: { type: 'Text', label: 'Source' } },
              { id: 'CreatedAt', fields: { type: 'Text', label: 'Created At' } },
              { id: 'ReportTextPresent', fields: { type: 'Numeric', label: 'Report Text Present' } },
            ],
          },
        ],
      },
      { headers: getGristHeaders() }
    );
    log('info', 'grist.report_codes_table_created', {
      doc_id: GRIST_REPORT_CODES_DOC_ID,
      table_id: GRIST_REPORT_CODES_TABLE_ID,
      requested_name: GRIST_REPORT_CODES_TABLE_NAME,
    });
  }

  gristReportCodesTableReady = true;
}

async function appendGristReportCodeRows(rows) {
  const normalized = normalizeGristReportCodeRows(rows);
  if (normalized.length === 0) return { appended: 0 };
  await ensureGristReportCodesTable();
  await gristClient.post(
    `${GRIST_BASE_URL}/api/docs/${encodeURIComponent(GRIST_REPORT_CODES_DOC_ID)}/tables/${encodeURIComponent(GRIST_REPORT_CODES_TABLE_ID)}/records`,
    {
      records: normalized.map(function (row) {
        return { fields: row };
      }),
    },
    { headers: getGristHeaders() }
  );
  return { appended: normalized.length };
}

async function flushGristReportCodesQueue() {
  if (gristReportCodesFlushInFlight || !isGristReportCodesConfigured()) return;
  const queued = loadGristReportCodesQueue();
  if (queued.length === 0) return;

  gristReportCodesFlushInFlight = true;
  try {
    const result = await appendGristReportCodeRows(queued);
    saveGristReportCodesQueue([]);
    log('info', 'grist.report_codes_queue_flushed', { appended: result.appended });
  } catch (err) {
    log('warn', 'grist.report_codes_queue_flush_failed', { error: extractAxiosError(err) });
  } finally {
    gristReportCodesFlushInFlight = false;
  }
}

async function logReportCodesToGrist(rows) {
  const normalized = normalizeGristReportCodeRows(rows);
  if (normalized.length === 0) return;

  if (!isGristReportCodesConfigured()) {
    saveGristReportCodesQueue([...loadGristReportCodesQueue(), ...normalized]);
    log('warn', 'grist.report_codes_not_configured', {
      queued: normalized.length,
      table_id: GRIST_REPORT_CODES_TABLE_ID,
      requested_name: GRIST_REPORT_CODES_TABLE_NAME,
    });
    return;
  }

  try {
    await flushGristReportCodesQueue();
    const result = await appendGristReportCodeRows(normalized);
    log('info', 'grist.report_codes_logged', {
      appended: result.appended,
      doc_id: GRIST_REPORT_CODES_DOC_ID,
      table_id: GRIST_REPORT_CODES_TABLE_ID,
      requested_name: GRIST_REPORT_CODES_TABLE_NAME,
    });
  } catch (err) {
    gristReportCodesTableReady = false;
    saveGristReportCodesQueue([...loadGristReportCodesQueue(), ...normalized]);
    log('warn', 'grist.report_codes_log_failed', {
      queued: normalized.length,
      error: extractAxiosError(err),
    });
  }
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
  if (HEADER_AUTH_TRUSTED_PROXIES.includes(remoteAddress)) return true;

  const origin = sanitizeText(req.headers.origin);
  return Boolean(origin && ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin));
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
    if (!session) return null;

    const email = sanitizeText(session.email).toLowerCase();
    const user = users.find(function (entry) {
      return sanitizeText(entry && entry.email).toLowerCase() === email;
    });
    if (!user || sanitizeText(user.status) !== 'active') return null;
    const tenantAccessLevel = getUserTenantAccessLevelFromStore(store, user);

    return {
      email: email,
      role: sanitizeText(user.role).toLowerCase(),
      name: sanitizeText(user.name),
      is_super_admin: Boolean(user.isSuperAdmin),
      white_label_account_ids: normalizeTenantIdList(user.whiteLabelAccountIds || user.white_label_account_ids),
      primary_white_label_account_id:
        normalizeTenantId(user.primaryWhiteLabelAccountId || user.primary_white_label_account_id) || null,
      white_label_access_level: tenantAccessLevel,
      patient_identifier:
        normalizePatientIdentifier(
          user.patient_identifier ||
            user.patientIdentifier ||
            user.patient_id ||
            user.patientId ||
            session.patient_identifier ||
            session.patientIdentifier ||
            session.patient_id ||
            session.patientId
        ) || null,
      patient_lookup_url: buildPatientLookupUrl(
        user.patient_identifier ||
          user.patientIdentifier ||
          user.patient_id ||
          user.patientId ||
          session.patient_identifier ||
          session.patientIdentifier ||
          session.patient_id ||
          session.patientId
      ),
      isAuthenticated: Boolean(email),
      authSource: 'session',
    };
  } catch (err) {
    log('warn', 'auth.session_store_read_failed', { message: err.message });
    return null;
  }
}

function readAuthStoreForUpdate() {
  if (!AUTH_SESSION_STORE_FILE) {
    throw makeAppError('AUTH_STORE_NOT_CONFIGURED', 503, 'Auth session store is not configured.');
  }
  if (!fs.existsSync(AUTH_SESSION_STORE_FILE)) {
    throw makeAppError('AUTH_STORE_NOT_FOUND', 503, 'Auth session store file was not found.');
  }
  try {
    const store = JSON.parse(fs.readFileSync(AUTH_SESSION_STORE_FILE, 'utf8'));
    if (!Array.isArray(store.users)) store.users = [];
    if (!Array.isArray(store.sessions)) store.sessions = [];
    return store;
  } catch (err) {
    throw makeAppError('AUTH_STORE_READ_FAILED', 500, 'Failed to read auth store.', { message: err.message });
  }
}

function writeAuthStore(store) {
  const dir = path.dirname(AUTH_SESSION_STORE_FILE);
  const tempFile = `${AUTH_SESSION_STORE_FILE}.tmp`;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
    fs.renameSync(tempFile, AUTH_SESSION_STORE_FILE);
  } catch (err) {
    throw makeAppError('AUTH_STORE_WRITE_FAILED', 500, 'Failed to write auth store.', { message: err.message });
  }
}

function findAuthStoreUser(store, email) {
  const cleanEmail = sanitizeText(email).toLowerCase();
  if (!cleanEmail) return null;
  return (Array.isArray(store && store.users) ? store.users : []).find(function (entry) {
    return sanitizeText(entry && entry.email).toLowerCase() === cleanEmail;
  }) || null;
}

function getAuthStoreUserForContext(context) {
  const store = readAuthStoreForUpdate();
  const user = findAuthStoreUser(store, context && context.email);
  if (!user || sanitizeText(user.status) !== 'active') {
    throw makeAppError('UNAUTHORIZED', 401, 'Authentication required.');
  }
  return { store: store, user: user };
}

function normalizeTwoFactorSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  const method = sanitizeText(settings.method || settings.channel || 'email').toLowerCase() || 'email';
  return {
    enabled: Boolean(settings.enabled),
    verified_at: sanitizeText(settings.verified_at || settings.verifiedAt) || null,
    method: method === 'email' ? 'email' : method,
    email: sanitizeText(settings.email).toLowerCase() || null,
    last_challenge_at: sanitizeText(settings.last_challenge_at || settings.lastChallengeAt) || null,
    disabled_at: sanitizeText(settings.disabled_at || settings.disabledAt) || null,
  };
}

function getTwoFactorStatusForUser(user) {
  const settings = normalizeTwoFactorSettings(user && (user.twoFactor || user.two_factor));
  return {
    available: Boolean(TWO_FACTOR_AUTH_ENABLED),
    configured: Boolean(TWO_FACTOR_AUTH_ENABLED && TWO_FACTOR_CODE_SECRET && TWO_FACTOR_RESEND_API_KEY && TWO_FACTOR_RESEND_FROM),
    enabled: Boolean(settings.enabled),
    verified: Boolean(settings.enabled && settings.verified_at),
    method: settings.method || 'email',
    email: settings.email || sanitizeText(user && user.email).toLowerCase() || null,
    last_challenge_at: settings.last_challenge_at || null,
  };
}

function requireTwoFactorFrameworkReady() {
  if (!TWO_FACTOR_AUTH_ENABLED) {
    throw makeAppError('TWO_FACTOR_DISABLED', 503, 'Two-factor authentication is not enabled yet.');
  }
  if (!TWO_FACTOR_CODE_SECRET) {
    throw makeAppError('TWO_FACTOR_SECRET_NOT_CONFIGURED', 503, 'Two-factor code secret is not configured.');
  }
}

function requireTwoFactorEmailProviderReady() {
  requireTwoFactorFrameworkReady();
  if (!TWO_FACTOR_RESEND_API_KEY || !TWO_FACTOR_RESEND_FROM) {
    throw makeAppError('TWO_FACTOR_EMAIL_NOT_CONFIGURED', 503, 'Two-factor email delivery is not configured yet.');
  }
}

function makeTwoFactorCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashTwoFactorCode(challengeId, email, code) {
  return crypto
    .createHmac('sha256', TWO_FACTOR_CODE_SECRET)
    .update([sanitizeText(challengeId), sanitizeText(email).toLowerCase(), sanitizeText(code)].join(':'))
    .digest('hex');
}

function pruneTwoFactorChallenges(user) {
  const nowMs = Date.now();
  const challenges = Array.isArray(user.twoFactorChallenges || user.two_factor_challenges)
    ? (user.twoFactorChallenges || user.two_factor_challenges)
    : [];
  user.twoFactorChallenges = challenges.filter(function (entry) {
    const expiresAtMs = new Date(entry && entry.expires_at || 0).getTime();
    return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs && !sanitizeText(entry.consumed_at);
  }).slice(-5);
  delete user.two_factor_challenges;
}

function createTwoFactorChallenge(user, purpose) {
  const email = sanitizeText(user && user.email).toLowerCase();
  const code = makeTwoFactorCode();
  const challenge = {
    id: crypto.randomUUID(),
    purpose: sanitizeText(purpose) || 'login',
    method: 'email',
    email: email,
    code_hash: null,
    attempts: 0,
    max_attempts: TWO_FACTOR_CODE_MAX_ATTEMPTS,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000).toISOString(),
    consumed_at: null,
  };
  challenge.code_hash = hashTwoFactorCode(challenge.id, email, code);
  pruneTwoFactorChallenges(user);
  user.twoFactorChallenges.push(challenge);
  user.twoFactor = {
    ...normalizeTwoFactorSettings(user.twoFactor || user.two_factor),
    method: 'email',
    email: email,
    last_challenge_at: challenge.created_at,
  };
  delete user.two_factor;
  return { challenge: challenge, code: code };
}

function findTwoFactorChallenge(user, challengeId, purpose) {
  pruneTwoFactorChallenges(user);
  const cleanChallengeId = sanitizeText(challengeId);
  const cleanPurpose = sanitizeText(purpose);
  return (user.twoFactorChallenges || []).find(function (entry) {
    return (
      sanitizeText(entry && entry.id) === cleanChallengeId &&
      (!cleanPurpose || sanitizeText(entry && entry.purpose) === cleanPurpose)
    );
  }) || null;
}

function verifyTwoFactorChallenge(user, challengeId, code, purpose) {
  const challenge = findTwoFactorChallenge(user, challengeId, purpose);
  if (!challenge) {
    throw makeAppError('TWO_FACTOR_CHALLENGE_NOT_FOUND', 404, 'Two-factor challenge was not found or has expired.');
  }
  if (Number(challenge.attempts || 0) >= Number(challenge.max_attempts || TWO_FACTOR_CODE_MAX_ATTEMPTS)) {
    throw makeAppError('TWO_FACTOR_TOO_MANY_ATTEMPTS', 429, 'Too many two-factor attempts. Request a new code.');
  }
  challenge.attempts = Number(challenge.attempts || 0) + 1;
  const expectedHash = sanitizeText(challenge.code_hash);
  const submittedHash = hashTwoFactorCode(challenge.id, challenge.email, sanitizeText(code));
  if (!timingSafeEqualText(expectedHash, submittedHash)) {
    throw makeAppError('TWO_FACTOR_CODE_INVALID', 400, 'Invalid two-factor code.');
  }
  challenge.consumed_at = nowIso();
  return challenge;
}

function issueTwoFactorVerificationToken(user, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto
    .createHmac('sha256', TWO_FACTOR_CODE_SECRET)
    .update(token)
    .digest('hex');
  const verification = {
    id: crypto.randomUUID(),
    purpose: sanitizeText(purpose) || 'login',
    token_hash: tokenHash,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000).toISOString(),
    consumed_at: null,
  };
  const existing = Array.isArray(user.twoFactorVerifications) ? user.twoFactorVerifications : [];
  user.twoFactorVerifications = existing
    .filter(function (entry) {
      const expiresAtMs = new Date(entry && entry.expires_at || 0).getTime();
      return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() && !sanitizeText(entry.consumed_at);
    })
    .slice(-5);
  user.twoFactorVerifications.push(verification);
  return {
    id: verification.id,
    token: token,
    expires_at: verification.expires_at,
  };
}

async function sendTwoFactorEmail(toEmail, code, purpose) {
  requireTwoFactorEmailProviderReady();
  const cleanPurpose = sanitizeText(purpose);
  const subject = cleanPurpose === 'setup'
    ? `${TWO_FACTOR_APP_NAME} two-factor setup code`
    : `${TWO_FACTOR_APP_NAME} sign-in code`;
  const text = [
    `Your ${TWO_FACTOR_APP_NAME} verification code is ${code}.`,
    '',
    `This code expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes.`,
  ].join('\n');
  await axios.post(
    'https://api.resend.com/emails',
    {
      from: TWO_FACTOR_RESEND_FROM,
      to: [toEmail],
      subject: subject,
      text: text,
    },
    {
      headers: {
        Authorization: `Bearer ${TWO_FACTOR_RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: HTTP_TIMEOUT_MS,
    }
  );
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
        is_super_admin: parseBooleanFlag(claims.is_super_admin || claims.isSuperAdmin),
        white_label_account_ids: normalizeTenantIdList(
          claims.white_label_account_ids || claims.whiteLabelAccountIds || claims.tenant_ids || claims.tenantIds
        ),
        primary_white_label_account_id:
          normalizeTenantId(
            claims.primary_white_label_account_id ||
              claims.primaryWhiteLabelAccountId ||
              claims.primary_tenant_id ||
              claims.primaryTenantId
          ) || null,
        white_label_access_level:
          normalizeWhiteLabelAccessLevel(
            claims.white_label_access_level || claims.whiteLabelAccessLevel || claims.tenant_access_level || claims.tenantAccessLevel
          ) || null,
        patient_identifier:
          normalizePatientIdentifier(
            claims.patient_identifier ||
              claims.patientIdentifier ||
              claims.patient_id ||
              claims.patientId ||
              claims.active_patient_token ||
              claims.activePatientToken
          ) || null,
        patient_lookup_url: buildPatientLookupUrl(
          claims.patient_identifier ||
            claims.patientIdentifier ||
            claims.patient_id ||
            claims.patientId ||
            claims.active_patient_token ||
            claims.activePatientToken
        ),
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
  const tenantIds = normalizeTenantIdList(
    req.headers['x-white-label-account-ids'] || req.headers['x-tenant-ids'] || req.headers['x-tenant-id']
  );
  const primaryTenantId =
    normalizeTenantId(
      req.headers['x-primary-white-label-account-id'] || req.headers['x-primary-tenant-id'] || tenantIds[0]
    ) || null;
  const patientIdentifier = normalizePatientIdentifier(
    req.headers['x-patient-identifier'] ||
      req.headers['x-patient-id'] ||
      req.headers['x-active-patient-token']
  );
  return {
    email: userEmail,
    role: userRole,
    name: userName,
    is_super_admin: parseBooleanFlag(req.headers['x-user-super-admin'] || req.headers['x-is-super-admin']),
    white_label_account_ids: tenantIds,
    primary_white_label_account_id: primaryTenantId,
    white_label_access_level:
      normalizeWhiteLabelAccessLevel(req.headers['x-white-label-access-level'] || req.headers['x-tenant-access-level']) || null,
    patient_identifier: patientIdentifier || null,
    patient_lookup_url: buildPatientLookupUrl(patientIdentifier),
    isAuthenticated: Boolean(userEmail),
    authSource: 'header',
  };
}

function normalizeTenantId(value) {
  const clean = sanitizeText(value).toLowerCase();
  if (!clean) return '';
  return clean.replace(/[^a-z0-9._:-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function normalizeTenantIdList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(
    new Set(
      raw
        .map(function (entry) {
          return normalizeTenantId(entry);
        })
        .filter(Boolean)
    )
  );
}

function normalizeWhiteLabelAccessLevel(value) {
  const clean = sanitizeText(value).toLowerCase();
  if (clean === 'owner' || clean === 'admin' || clean === 'uploader' || clean === 'viewer') return clean;
  return '';
}

function getUserTenantAccessLevelFromStore(store, user) {
  if (!store || !user) return null;
  if (user.isSuperAdmin) return 'owner';
  const email = sanitizeText(user.email).toLowerCase();
  const primaryTenantId = normalizeTenantId(user.primaryWhiteLabelAccountId || user.primary_white_label_account_id);
  const accountIds = normalizeTenantIdList(user.whiteLabelAccountIds || user.white_label_account_ids);
  const accounts = Array.isArray(store.whiteLabelAccounts) ? store.whiteLabelAccounts : [];
  const preferredIds = primaryTenantId ? [primaryTenantId, ...accountIds.filter(function (id) { return id !== primaryTenantId; })] : accountIds;
  for (const tenantId of preferredIds) {
    const account = accounts.find(function (entry) {
      return normalizeTenantId(entry && entry.id) === tenantId;
    });
    const member = account && Array.isArray(account.members)
      ? account.members.find(function (entry) {
          return sanitizeText(entry && entry.email).toLowerCase() === email;
        })
      : null;
    const level = normalizeWhiteLabelAccessLevel(member && member.accessLevel);
    if (level) return level;
  }
  return accountIds.length > 0 ? 'viewer' : null;
}

function getStudyTenantId(study) {
  return normalizeTenantId(
    study && (study.tenant_id || study.tenantId || study.white_label_account_id || study.whiteLabelAccountId)
  );
}

function isGlobalStudyOperator(context) {
  if (!context || !context.isAuthenticated) return false;
  if (context.role === 'admin') return true;
  const tenantIds = normalizeTenantIdList(context.white_label_account_ids);
  return tenantIds.length === 0 && (context.role === 'doctor' || context.role === 'clinic');
}

function canAccessTenant(context, tenantId) {
  const cleanTenantId = normalizeTenantId(tenantId);
  if (!cleanTenantId) return true;
  if (isGlobalStudyOperator(context)) return true;
  return normalizeTenantIdList(context && context.white_label_account_ids).includes(cleanTenantId);
}

function hasWhiteLabelActionPermission(context, action) {
  if (!context || !context.isAuthenticated) return false;
  if (context.role === 'admin' || context.is_super_admin) return true;
  const tenantIds = normalizeTenantIdList(context.white_label_account_ids);
  if (tenantIds.length === 0) return context.role === 'doctor' || context.role === 'clinic';
  const level = normalizeWhiteLabelAccessLevel(context.white_label_access_level) || 'viewer';
  if (level === 'owner') return true;
  if (level === 'admin') {
    return ['manage_users', 'configure_branding', 'upload', 'edit', 'report', 'export', 'delete', 'governance', 'stream_manage'].includes(action);
  }
  if (level === 'uploader') {
    return ['upload', 'edit', 'report', 'export', 'stream_manage'].includes(action);
  }
  if (level === 'viewer') {
    return action === 'view';
  }
  return false;
}

function requireWhiteLabelAction(context, res, action, message) {
  if (hasWhiteLabelActionPermission(context, action)) return true;
  sendError(res, 403, 'FORBIDDEN', message || 'Your white-label account does not allow this action.');
  return false;
}

function getDefaultTenantIdForContext(context, body) {
  const requested = normalizeTenantId(
    body && (body.tenant_id || body.tenantId || body.white_label_account_id || body.whiteLabelAccountId)
  );
  if (requested && canAccessTenant(context, requested)) return requested;
  if (requested && !canAccessTenant(context, requested)) {
    throw makeAppError('FORBIDDEN', 403, 'You cannot create cases for that white-label tenant.');
  }
  return normalizeTenantId(context && context.primary_white_label_account_id) ||
    normalizeTenantIdList(context && context.white_label_account_ids)[0] ||
    null;
}

function assignStudyTenant(study, tenantId) {
  const cleanTenantId = normalizeTenantId(tenantId);
  study.tenant_id = cleanTenantId || null;
  study.tenantId = cleanTenantId || null;
  study.white_label_account_id = cleanTenantId || null;
  return study;
}

function filterStudiesForContext(studies, context) {
  return (studies || []).filter(function (study) {
    return canAccessStudyRecord(context, study);
  });
}

function readAuthStoreSnapshot() {
  if (!AUTH_SESSION_STORE_FILE || !fs.existsSync(AUTH_SESSION_STORE_FILE)) {
    return { users: [], whiteLabelAccounts: [] };
  }
  try {
    const store = JSON.parse(fs.readFileSync(AUTH_SESSION_STORE_FILE, 'utf8'));
    return {
      users: Array.isArray(store.users) ? store.users : [],
      whiteLabelAccounts: Array.isArray(store.whiteLabelAccounts) ? store.whiteLabelAccounts : [],
    };
  } catch (err) {
    log('warn', 'tenant.auth_store_read_failed', { message: err.message });
    return { users: [], whiteLabelAccounts: [] };
  }
}

function normalizeWhiteLabelPlanId(value) {
  if (value && typeof value === 'object') {
    return normalizeWhiteLabelPlanId(value.id || value.name || value.plan);
  }
  const clean = sanitizeText(value).toLowerCase();
  if (clean === 'hosted_retention') return 'hosted_retention';
  return 'self_download_7_day';
}

function getTenantAccount(tenantId) {
  const cleanTenantId = normalizeTenantId(tenantId);
  if (!cleanTenantId) return null;
  const store = readAuthStoreSnapshot();
  return (store.whiteLabelAccounts || []).find(function (account) {
    return normalizeTenantId(account && account.id) === cleanTenantId;
  }) || null;
}

function getTenantPlanConfig(tenantId) {
  const account = getTenantAccount(tenantId);
  const planId = normalizeWhiteLabelPlanId(account && account.plan);
  if (planId === 'hosted_retention') {
    return {
      id: 'hosted_retention',
      label: 'Hosted 6-month storage',
      hostedByOctelerad: true,
      requiresCustomerDownload: false,
      retentionDays: 180,
    };
  }
  return {
    id: 'self_download_7_day',
    label: 'Use only - customer downloads within 7 days',
    hostedByOctelerad: false,
    requiresCustomerDownload: true,
    retentionDays: SELF_DOWNLOAD_PLAN_RETENTION_DAYS,
  };
}

function getStudyRetentionConfig(study) {
  const tenantId = getStudyTenantId(study);
  if (!tenantId) {
    return {
      tenant_id: null,
      plan_id: 'internal',
      hostedByOctelerad: true,
      requiresCustomerDownload: false,
      retentionDays: null,
      purgeAfter: null,
    };
  }

  const plan = getTenantPlanConfig(tenantId);
  const createdAt = sanitizeText(study && study.created_at) || nowIso();
  const createdMs = new Date(createdAt).getTime();
  const explicitDeadline = sanitizeText(study && study.customer_download_required_by);
  const computedPurgeAfter =
    plan.requiresCustomerDownload && Number.isFinite(createdMs)
      ? new Date(createdMs + plan.retentionDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const purgeAfter = plan.requiresCustomerDownload ? explicitDeadline || computedPurgeAfter : null;

  return {
    tenant_id: tenantId,
    plan_id: plan.id,
    hostedByOctelerad: plan.hostedByOctelerad,
    requiresCustomerDownload: plan.requiresCustomerDownload,
    retentionDays: plan.retentionDays,
    purgeAfter: purgeAfter,
  };
}

function applyStudyRetentionPolicy(study) {
  if (!study) return false;
  const retention = getStudyRetentionConfig(study);
  const previous = {
    data_plan: sanitizeText(study.data_plan) || null,
    customer_download_required_by: sanitizeText(study.customer_download_required_by) || null,
  };
  study.data_plan = retention.plan_id;
  study.hosted_by_octelerad = Boolean(retention.hostedByOctelerad);
  study.customer_download_required_by = retention.purgeAfter;
  study.retention_policy_applied_at = nowIso();
  return (
    previous.data_plan !== (study.data_plan || null) ||
    previous.customer_download_required_by !== (study.customer_download_required_by || null)
  );
}

function appendTenantAuditEvent(event, fields) {
  const entry = {
    ts: nowIso(),
    event: sanitizeText(event) || 'tenant.event',
    tenant_id: normalizeTenantId(fields && fields.tenant_id) || null,
    study_id: fields && fields.study_id !== undefined ? Number(fields.study_id) || null : null,
    actor_email: sanitizeText(fields && fields.actor_email).toLowerCase() || null,
    actor_role: sanitizeText(fields && fields.actor_role).toLowerCase() || null,
    action: sanitizeText(fields && fields.action) || null,
    result: sanitizeText(fields && fields.result) || 'ok',
    details: fields && fields.details && typeof fields.details === 'object' ? fields.details : {},
  };
  try {
    fs.appendFileSync(TENANT_AUDIT_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log('warn', 'tenant.audit_log_write_failed', {
      event: entry.event,
      tenant_id: entry.tenant_id,
      message: err.message,
    });
  }
}

function readTenantAuditEvents(limit) {
  const max = Math.min(Math.max(Number(limit) || 250, 1), 1000);
  try {
    if (!fs.existsSync(TENANT_AUDIT_LOG_FILE)) return [];
    const raw = fs.readFileSync(TENANT_AUDIT_LOG_FILE, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-max)
      .map(function (line) {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch (err) {
    log('warn', 'tenant.audit_log_read_failed', { message: err.message });
    return [];
  }
}

function makeEmptyTenantGovernanceSummary(account) {
  const tenantId = normalizeTenantId(account && account.id);
  const plan = tenantId ? getTenantPlanConfig(tenantId) : {
    id: 'internal',
    label: 'Internal',
    hostedByOctelerad: true,
    requiresCustomerDownload: false,
    retentionDays: null,
  };
  return {
    tenant_id: tenantId || null,
    name: sanitizeText(account && account.name) || (tenantId ? tenantId : 'Internal OCTELERAD'),
    slug: sanitizeText(account && account.slug) || null,
    status: sanitizeText(account && account.status) || 'active',
    plan_id: plan.id,
    plan_label: plan.label,
    hosted_by_octelerad: Boolean(plan.hostedByOctelerad),
    requires_customer_download: Boolean(plan.requiresCustomerDownload),
    retention_days: plan.retentionDays,
    study_count: 0,
    active_study_count: 0,
    deleted_study_count: 0,
    dicom_count: 0,
    local_media_bytes: 0,
    orthanc_storage_bytes: 0,
    orthanc_uncompressed_bytes: 0,
    total_storage_bytes: 0,
    orthanc_storage_cached_count: 0,
    orthanc_storage_missing_count: 0,
    orthanc_storage_error_count: 0,
    nextcloud_exported_count: 0,
    due_within_24h_count: 0,
    overdue_count: 0,
    downloaded_count: 0,
    oldest_download_deadline: null,
    newest_study_at: null,
  };
}

function addStudyToTenantGovernanceSummary(summary, study, recordings, orthancStorageCache) {
  const isDeleted = Boolean(sanitizeText(study && study.deleted_at));
  const retention = getStudyRetentionConfig(study);
  const localMediaBytes = getStudyLocalStorageBytes(study, recordings);
  const orthancStats = getStudyOrthancStorageStats(study, orthancStorageCache);
  summary.study_count += 1;
  summary.active_study_count += isDeleted ? 0 : 1;
  summary.deleted_study_count += isDeleted ? 1 : 0;
  summary.dicom_count += Number(study && study.dicom_count) || 0;
  summary.local_media_bytes += localMediaBytes;
  summary.orthanc_storage_bytes += orthancStats.disk_size_bytes;
  summary.orthanc_uncompressed_bytes += orthancStats.uncompressed_size_bytes;
  summary.total_storage_bytes += localMediaBytes + orthancStats.disk_size_bytes;
  summary.orthanc_storage_cached_count += orthancStats.status === 'ready' ? 1 : 0;
  summary.orthanc_storage_missing_count += orthancStats.status === 'missing' ? 1 : 0;
  summary.orthanc_storage_error_count += orthancStats.status === 'error' ? 1 : 0;
  summary.nextcloud_exported_count += sanitizeText(study && study.nextcloud_url) ? 1 : 0;
  summary.downloaded_count += sanitizeText(study && study.customer_downloaded_at) ? 1 : 0;

  const createdAt = sanitizeText(study && study.created_at);
  if (createdAt) {
    const currentNewest = new Date(summary.newest_study_at || 0).getTime();
    const nextNewest = new Date(createdAt).getTime();
    if (Number.isFinite(nextNewest) && nextNewest > currentNewest) {
      summary.newest_study_at = createdAt;
    }
  }

  if (retention.requiresCustomerDownload && retention.purgeAfter && !isDeleted) {
    const deadlineMs = new Date(retention.purgeAfter).getTime();
    if (Number.isFinite(deadlineMs)) {
      if (deadlineMs <= Date.now()) {
        summary.overdue_count += 1;
      } else if (deadlineMs - Date.now() <= 24 * 60 * 60 * 1000) {
        summary.due_within_24h_count += 1;
      }

      const currentOldest = new Date(summary.oldest_download_deadline || 8640000000000000).getTime();
      if (deadlineMs < currentOldest) {
        summary.oldest_download_deadline = retention.purgeAfter;
      }
    }
  }
}

function makeTenantGovernanceSummaries(context) {
  const store = readAuthStoreSnapshot();
  const recordings = loadCaseRecordings();
  const orthancStorageCache = loadOrthancStorageCache();
  const visibleStudies = filterStudiesForContext(loadStudies(), context);
  const summaryByTenant = new Map();

  if (isGlobalStudyOperator(context)) {
    summaryByTenant.set('', makeEmptyTenantGovernanceSummary(null));
    (store.whiteLabelAccounts || []).forEach(function (account) {
      const tenantId = normalizeTenantId(account && account.id);
      if (tenantId) summaryByTenant.set(tenantId, makeEmptyTenantGovernanceSummary(account));
    });
  } else {
    normalizeTenantIdList(context && context.white_label_account_ids).forEach(function (tenantId) {
      summaryByTenant.set(tenantId, makeEmptyTenantGovernanceSummary(getTenantAccount(tenantId)));
    });
  }

  visibleStudies.forEach(function (study) {
    const tenantId = getStudyTenantId(study);
    if (!summaryByTenant.has(tenantId)) {
      summaryByTenant.set(tenantId, makeEmptyTenantGovernanceSummary(getTenantAccount(tenantId)));
    }
    addStudyToTenantGovernanceSummary(summaryByTenant.get(tenantId), study, recordings, orthancStorageCache);
  });

  return Array.from(summaryByTenant.values()).sort(function (left, right) {
    if (right.local_media_bytes !== left.local_media_bytes) return right.local_media_bytes - left.local_media_bytes;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

async function refreshOrthancStorageForStudies(studies, context) {
  const visibleStudies = filterStudiesForContext(studies || [], context);
  const uniqueOrthancIds = Array.from(
    new Set(
      visibleStudies
        .map(function (study) {
          return sanitizeText(study && study.orthanc_study_id);
        })
        .filter(Boolean)
    )
  );
  const cache = loadOrthancStorageCache();
  let index = 0;
  let refreshed = 0;
  let failed = 0;
  const workerCount = Math.min(Math.max(Number(DICOM_UPLOAD_CONCURRENCY) || 2, 1), 6);

  async function worker() {
    while (index < uniqueOrthancIds.length) {
      const orthancStudyId = uniqueOrthancIds[index];
      index += 1;
      const stats = await fetchOrthancStudyStorageStats(orthancStudyId);
      if (stats) {
        cache[orthancStudyId] = stats;
        if (stats.status === 'error') failed += 1;
        else refreshed += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, function () {
      return worker();
    })
  );
  saveOrthancStorageCache(cache);
  return {
    requested: uniqueOrthancIds.length,
    refreshed: refreshed,
    failed: failed,
  };
}

function canAccessStudyRecord(context, study) {
  if (!context || !context.isAuthenticated || !study) return false;
  if (context.role === 'admin') return true;
  if (!canAccessTenant(context, getStudyTenantId(study))) return false;
  if (context.role === 'doctor' || context.role === 'clinic') return true;
  if (context.role === 'patient') {
    const patientId = sanitizeText(study.patient_id).toLowerCase();
    const patientIdentifier = normalizePatientIdentifier(context.patient_identifier).toLowerCase();
    return Boolean(patientId) && Boolean(patientIdentifier) && patientId === patientIdentifier;
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

function clearExpiredVideoAccessTokens() {
  const now = Date.now();
  for (const [token, entry] of videoAccessTokenCache.entries()) {
    const expiresAtMs = new Date(entry.expires_at || 0).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      videoAccessTokenCache.delete(token);
    }
  }
}

// Native <video> elements can't attach the app's x-user-email auth headers. This
// issues a resource-scoped token embedded in the video URL itself so playback keeps
// working for the life of a presentation regardless of cookie/header state.
function issueVideoAccessToken(resourceType, resourceId, context) {
  clearExpiredVideoAccessTokens();
  const token = crypto.randomUUID();
  videoAccessTokenCache.set(token, {
    resource_type: resourceType,
    resource_id: sanitizeText(resourceId),
    email: context.email,
    role: context.role,
    name: context.name,
    expires_at: new Date(Date.now() + VIDEO_ACCESS_TOKEN_TTL_MINUTES * 60 * 1000).toISOString(),
  });
  return token;
}

function getVideoTokenAuthContext(req, resourceType, resourceId) {
  clearExpiredVideoAccessTokens();
  const token = sanitizeText(req.query && req.query.vtoken);
  if (!token) return null;
  const entry = videoAccessTokenCache.get(token);
  if (!entry) return null;
  if (entry.resource_type !== resourceType || entry.resource_id !== sanitizeText(resourceId)) return null;
  return {
    email: entry.email,
    role: entry.role,
    name: entry.name,
    isAuthenticated: true,
    authSource: 'video_token',
  };
}

function requireStudyRoleForVideo(req, res, allowedRoles, resourceType, resourceId) {
  const headerContext = getStudyAccessContext(req);
  const context = headerContext.isAuthenticated
    ? headerContext
    : getVideoTokenAuthContext(req, resourceType, resourceId);
  if (!context || !context.isAuthenticated) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return null;
  }
  if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(context.role)) {
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
      tenant_ids: normalizeTenantIdList(job.tenant_ids || []),
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
      total_frames: Number(job.total_frames || job.frames_rendered) || 0,
      frames_rendered: Number(job.frames_rendered) || 0,
      progress_pct: Number(job.progress_pct) || 0,
      progress_message: sanitizeText(job.progress_message) || '',
      error: job.error || null,
      request_id: sanitizeText(job.request_id) || null,
      requested_ip: sanitizeText(job.requested_ip) || null,
      expires_at: job.expires_at || null,
      timeline: normalizeCaseStreamTimelineFrames(job.timeline, job.fps),
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
        tenant_ids: normalizeTenantIdList(item.tenant_ids || []),
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
        total_frames: Number(item.total_frames || item.frames_rendered) || 0,
        frames_rendered: Number(item.frames_rendered) || 0,
        progress_pct: Math.min(Math.max(Number(item.progress_pct) || 0, 0), 100),
        progress_message: sanitizeText(item.progress_message) || '',
        error: item.error || null,
        request_id: sanitizeText(item.request_id) || null,
        requested_ip: sanitizeText(item.requested_ip) || null,
        expires_at: sanitizeText(item.expires_at) || null,
        timeline: normalizeCaseStreamTimelineFrames(item.timeline, item.fps),
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
          tenant_ids: normalizeTenantIdList(item.tenant_ids || []),
          timeline: normalizeCaseStreamTimelineFrames(item.timeline, item.fps),
          skipped_studies_count: Number(item.skipped_studies_count) || 0,
          skipped_studies: Array.isArray(item.skipped_studies) ? item.skipped_studies : [],
          skipped_frames: Array.isArray(item.skipped_frames) ? item.skipped_frames : [],
          source_summary: Array.isArray(item.source_summary) ? item.source_summary : [],
          duration_sec: Number(item.duration_sec) || 0,
          total_frames: Number(item.total_frames || item.frames_rendered) || 0,
          frames_rendered: Number(item.frames_rendered) || 0,
          assigned_md_email: sanitizeText(item.assigned_md_email).toLowerCase() || null,
          assigned_md_name: sanitizeText(item.assigned_md_name) || null,
          assigned_at: sanitizeText(item.assigned_at) || null,
          assigned_by_email: sanitizeText(item.assigned_by_email).toLowerCase() || null,
          assigned_by_name: sanitizeText(item.assigned_by_name) || null,
          reading_status: sanitizeCaseStreamReadingStatus(item.reading_status),
          reading_status_updated_at: sanitizeText(item.reading_status_updated_at) || null,
          reading_status_updated_by_email: sanitizeText(item.reading_status_updated_by_email).toLowerCase() || null,
          reading_status_updated_by_name: sanitizeText(item.reading_status_updated_by_name) || null,
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

function sanitizeCaseStreamReadingStatus(value) {
  const normalized = sanitizeText(value).toLowerCase();
  if (['unassigned', 'assigned', 'in_review', 'read', 'completed'].includes(normalized)) return normalized;
  return 'unassigned';
}

function isCaseStreamAssignedToContext(stream, context) {
  if (!stream || !context || !context.isAuthenticated) return false;
  if (!canAccessTenantScopedResource(context, stream.tenant_ids)) return false;
  if (context.role === 'admin' || context.role === 'clinic') return true;
  if (context.role !== 'doctor') return false;
  const assignedEmail = sanitizeText(stream.assigned_md_email).toLowerCase();
  const contextEmail = sanitizeText(context.email).toLowerCase();
  if (assignedEmail && contextEmail && assignedEmail === contextEmail) return true;

  const assignedName = sanitizeText(stream.assigned_md_name).toLowerCase();
  const contextName = sanitizeText(context.name).toLowerCase();
  return Boolean(assignedName && contextName && assignedName === contextName);
}

function serializeCaseStreamLibraryItem(item) {
  const videoAvailable = Boolean(getCaseStreamLibraryDownloadPath(item));
  return {
    ...item,
    total_frames: getCaseStreamTotalFrames(item),
    video_available: videoAvailable,
    download_url: videoAvailable ? `/api/case-stream/library/${encodeURIComponent(item.id)}/download` : null,
    frame_review_url: videoAvailable ? `/api/case-stream/library/${encodeURIComponent(item.id)}/frames/{frameIndex}` : null,
    presentation_case_count: buildCasePresentationCases(item.timeline).length,
  };
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
    total_frames: Number(result.totalFrames || result.framesRendered || 0),
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
    deleteStudyVideoDerivativeFiles(study);
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
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS tenant_id TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS radiologist_notes TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS radiology_report TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_age TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_dob TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_sex TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS patient_zip TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS octrqaui TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS octraccui TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS client_email TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS client_name TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS subclient TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS md_name TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS revenue TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS recorded_by TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS transcribed_by TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS delete_permanent_after TIMESTAMPTZ');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS deleted_reason TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS nextcloud_export_status TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS nextcloud_deleted_at TIMESTAMPTZ');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS video_processing_status TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS video_processing_error TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS video_processing_job_id TEXT');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS video_metadata JSONB');
      await pgPool.query('ALTER TABLE studies ADD COLUMN IF NOT EXISTS reading_location JSONB');
      await pgPool.query("ALTER TABLE studies ADD COLUMN IF NOT EXISTS signoff_events JSONB NOT NULL DEFAULT '[]'::jsonb");
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_studies_patient_id ON studies (patient_id)');
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_studies_tenant_id ON studies (tenant_id)');
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
      (id, tenant_id, patient_name, patient_id, patient_age, patient_dob, patient_sex, patient_zip, study_date, octrqaui, octraccui, client_email, client_name, subclient, md_name, revenue, modality, notes, tech_notes, radiologist_notes, radiology_report, recorded_by, transcribed_by, mp4_url, pdf_url, orthanc_patient_id, orthanc_study_id, dicom_count, status, share_token, share_expires_at, nextcloud_folder, nextcloud_url, prior_study_ids, created_at, updated_at, deleted_at, delete_permanent_after, deleted_reason, nextcloud_export_status, nextcloud_deleted_at, video_processing_status, video_processing_error, video_processing_job_id, video_metadata, reading_location, signoff_events)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::jsonb,$35::timestamptz,$36::timestamptz,$37::timestamptz,$38::timestamptz,$39,$40,$41::timestamptz,$42,$43,$44,$45::jsonb,$46::jsonb,$47::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      tenant_id=EXCLUDED.tenant_id,
      patient_name=EXCLUDED.patient_name,
      patient_id=EXCLUDED.patient_id,
      patient_age=EXCLUDED.patient_age,
      patient_dob=EXCLUDED.patient_dob,
      patient_sex=EXCLUDED.patient_sex,
      patient_zip=EXCLUDED.patient_zip,
      study_date=EXCLUDED.study_date,
      octrqaui=EXCLUDED.octrqaui,
      octraccui=EXCLUDED.octraccui,
      client_email=EXCLUDED.client_email,
      client_name=EXCLUDED.client_name,
      subclient=EXCLUDED.subclient,
      md_name=EXCLUDED.md_name,
      revenue=EXCLUDED.revenue,
      modality=EXCLUDED.modality,
      notes=EXCLUDED.notes,
      tech_notes=EXCLUDED.tech_notes,
      radiologist_notes=EXCLUDED.radiologist_notes,
      radiology_report=EXCLUDED.radiology_report,
      recorded_by=EXCLUDED.recorded_by,
      transcribed_by=EXCLUDED.transcribed_by,
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
      nextcloud_deleted_at=EXCLUDED.nextcloud_deleted_at,
      video_processing_status=EXCLUDED.video_processing_status,
      video_processing_error=EXCLUDED.video_processing_error,
      video_processing_job_id=EXCLUDED.video_processing_job_id,
      video_metadata=EXCLUDED.video_metadata,
      reading_location=EXCLUDED.reading_location,
      signoff_events=EXCLUDED.signoff_events
  `;
  const values = [
    Number(study.id),
    getStudyTenantId(study) || null,
    sanitizeText(study.patient_name),
    normalizePatientIdentifier(study.patient_id) || null,
    sanitizeText(study.patient_age) || null,
    sanitizeText(study.patient_dob) || null,
    sanitizeText(study.patient_sex) || null,
    sanitizeText(study.patient_zip) || null,
    sanitizeText(study.study_date) || null,
    sanitizeText(study.octrqaui) || null,
    sanitizeText(study.octraccui) || null,
    sanitizeText(study.client_email) || null,
    sanitizeText(study.client_name) || null,
    sanitizeText(study.subclient) || null,
    sanitizeText(study.md_name) || null,
    sanitizeText(study.revenue) || null,
    sanitizeText(study.modality) || null,
    sanitizeText(study.notes) || null,
    sanitizeMultilineText(study.tech_notes) || null,
    sanitizeMultilineText(study.radiologist_notes) || null,
    sanitizeMultilineText(study.radiology_report) || null,
    sanitizeText(study.recorded_by) || null,
    sanitizeText(study.transcribed_by) || null,
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
    sanitizeText(study.video_processing_status) || null,
    sanitizeText(study.video_processing_error) || null,
    sanitizeText(study.video_processing_job_id) || null,
    study.video_metadata && typeof study.video_metadata === 'object'
      ? JSON.stringify(study.video_metadata)
      : null,
    study.reading_location && typeof study.reading_location === 'object'
      ? JSON.stringify(study.reading_location)
      : null,
    JSON.stringify(Array.isArray(study.signoff_events) ? study.signoff_events : []),
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
      id, tenant_id, patient_name, patient_id, patient_age, patient_dob, patient_sex, patient_zip, study_date, octrqaui, octraccui, client_email, client_name, subclient, md_name, revenue, modality, notes, tech_notes, radiologist_notes, radiology_report, recorded_by, transcribed_by, mp4_url, pdf_url,
      orthanc_patient_id, orthanc_study_id, dicom_count, status, created_at, updated_at,
      share_token, share_expires_at, nextcloud_folder, nextcloud_url, prior_study_ids,
      deleted_at, delete_permanent_after, deleted_reason, nextcloud_export_status, nextcloud_deleted_at,
      video_processing_status, video_processing_error, video_processing_job_id, video_metadata
    FROM studies
    ORDER BY created_at DESC
  `;
  try {
    const result = await pgPool.query(sql);
    return result.rows.map(function (row) {
      return {
        id: Number(row.id),
        tenant_id: normalizeTenantId(row.tenant_id) || null,
        tenantId: normalizeTenantId(row.tenant_id) || null,
        white_label_account_id: normalizeTenantId(row.tenant_id) || null,
        patient_name: sanitizeText(row.patient_name),
        patient_id: normalizePatientIdentifier(row.patient_id) || null,
        patient_identifier: normalizePatientIdentifier(row.patient_id) || null,
        patient_lookup_url: buildPatientLookupUrl(row.patient_id),
        patient_age: sanitizeText(row.patient_age) || null,
        patient_dob: sanitizeText(row.patient_dob) || null,
        patient_sex: sanitizeText(row.patient_sex) || null,
        patient_zip: sanitizeText(row.patient_zip) || null,
        study_date: sanitizeText(row.study_date) || null,
        octrqaui: sanitizeText(row.octrqaui) || null,
        octraccui: sanitizeText(row.octraccui) || null,
        client_email: sanitizeText(row.client_email) || null,
        client_name: sanitizeText(row.client_name) || null,
        subclient: sanitizeText(row.subclient) || null,
        md_name: sanitizeText(row.md_name) || null,
        revenue: sanitizeText(row.revenue) || null,
        modality: sanitizeText(row.modality) || null,
        notes: sanitizeText(row.notes) || null,
        tech_notes: sanitizeMultilineText(row.tech_notes) || null,
        radiologist_notes: sanitizeMultilineText(row.radiologist_notes) || null,
        radiology_report: sanitizeMultilineText(row.radiology_report) || null,
        recorded_by: sanitizeText(row.recorded_by) || null,
        transcribed_by: sanitizeText(row.transcribed_by) || null,
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
        video_processing_status: sanitizeText(row.video_processing_status) || null,
        video_processing_error: sanitizeText(row.video_processing_error) || null,
        video_processing_job_id: sanitizeText(row.video_processing_job_id) || null,
        video_metadata:
          row.video_metadata && typeof row.video_metadata === 'object' ? row.video_metadata : null,
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

function makeStudyRecord(studies, body, context) {
  const created = nowIso();
  const id = nextId(studies);
  const patientIdentifier = getPatientIdentifierFromPayload(body || {});
  const study = {
    id: id,
    patient_name: sanitizeText(body.patient_name) || `Case ${id}`,
    patient_id: patientIdentifier,
    patient_identifier: patientIdentifier,
    patient_lookup_url: buildPatientLookupUrl(patientIdentifier),
    patient_age: sanitizeText(body.patient_age || body.age),
    patient_dob: sanitizeText(body.patient_dob || body.dob),
    patient_sex: sanitizeText(body.patient_sex || body.sex),
    patient_zip: sanitizeText(body.patient_zip || body.zip_code || body.zip),
    study_date: sanitizeText(body.study_date),
    octrqaui: sanitizeText(body.octrqaui || body.OCTRQAUI),
    octraccui: sanitizeText(body.octraccui || body.OCTRACCUI),
    client_email: sanitizeText(body.client_email),
    client_name: sanitizeText(body.client_name || body.client),
    subclient: sanitizeText(body.subclient),
    md_name: sanitizeText(body.md_name || body.md || body.MD),
    revenue: sanitizeText(body.revenue),
    modality: sanitizeText(body.modality),
    notes: sanitizeText(body.notes),
    tech_notes: sanitizeMultilineText(body.tech_notes) || null,
    radiologist_notes: sanitizeMultilineText(body.radiologist_notes) || null,
    radiology_report: sanitizeMultilineText(body.radiology_report) || null,
    recorded_by: sanitizeText(body.recorded_by || body.recordedBy) || null,
    transcribed_by: sanitizeText(body.transcribed_by || body.transcribedBy) || null,
    case_reports: [],
    mp4_url: null,
    video_processing_status: null,
    video_processing_error: null,
    video_processing_job_id: null,
    video_metadata: null,
    pdf_url: null,
    dicom_count: 0,
    created_at: created,
    updated_at: created,
    status: 'ready',
    completed_at: null,
    completed_by_email: null,
    completed_by_name: null,
    completion_note: null,
    reading_location: null,
    signoff_events: [],
    orthanc_patient_id: null,
    orthanc_study_id: null,
    share_token: null,
    share_expires_at: null,
    nextcloud_folder: null,
    nextcloud_url: null,
    prior_study_ids: [],
    deleted_at: null,
  };
  assignStudyTenant(study, getDefaultTenantIdForContext(context, body || {}));
  applyStudyRetentionPolicy(study);
  return study;
}

function applyStudyMetadataUpdates(study, body) {
  const payload = body || {};
  const requestedPatientIdentifier = getPatientIdentifierFromPayload(payload);
  const fields = [
    ['patient_name', function (value) { return sanitizeText(value); }],
    ['patient_age', function (value) { return sanitizeText(value); }],
    ['patient_dob', function (value) { return sanitizeText(value); }],
    ['patient_sex', function (value) { return sanitizeText(value); }],
    ['patient_zip', function (value) { return sanitizeText(value); }],
    ['study_date', function (value) { return sanitizeText(value); }],
    ['octrqaui', function (value) { return sanitizeText(value); }],
    ['octraccui', function (value) { return sanitizeText(value); }],
    ['client_email', function (value) { return sanitizeText(value); }],
    ['client_name', function (value) { return sanitizeText(value); }],
    ['subclient', function (value) { return sanitizeText(value); }],
    ['md_name', function (value) { return sanitizeText(value); }],
    ['revenue', function (value) { return sanitizeText(value); }],
    ['modality', function (value) { return sanitizeText(value); }],
    ['notes', function (value) { return sanitizeText(value); }],
    ['tech_notes', function (value) { return sanitizeMultilineText(value) || null; }],
    ['radiologist_notes', function (value) { return sanitizeMultilineText(value) || null; }],
    ['radiology_report', function (value) { return sanitizeMultilineText(value) || null; }],
    ['recorded_by', function (value) { return sanitizeText(value) || null; }],
    ['transcribed_by', function (value) { return sanitizeText(value) || null; }],
  ];
  let changed = false;

  if (requestedPatientIdentifier) {
    const policyError = validatePatientIdentifierPolicy(requestedPatientIdentifier, {
      ...(study || {}),
      ...(payload || {}),
    });
    if (policyError) {
      throw makeAppError('VALIDATION_ERROR', 400, policyError);
    }
    const currentPatientIdentifier = normalizePatientIdentifier(study && study.patient_id);
    if (currentPatientIdentifier && currentPatientIdentifier !== requestedPatientIdentifier) {
      throw makeAppError(
        'PATIENT_IDENTIFIER_IMMUTABLE',
        409,
        'Patient identifier is immutable and cannot be changed after it is assigned.'
      );
    }
    if (!currentPatientIdentifier) {
      study.patient_id = requestedPatientIdentifier;
      study.patient_identifier = requestedPatientIdentifier;
      study.patient_lookup_url = buildPatientLookupUrl(requestedPatientIdentifier);
      changed = true;
    }
  }

  fields.forEach(function (entry) {
    const field = entry[0];
    const normalize = entry[1];
    if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
    const nextValue = normalize(payload[field]);
    if ((study[field] || null) === (nextValue || null)) return;
    study[field] = nextValue;
    changed = true;
  });

  enrichPatientIdentity(study);

  return changed;
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
  const patientId = normalizePatientIdentifier(study && study.patient_id).toLowerCase();
  return {
    patientId: patientId,
    key: patientId || '',
  };
}

function isSamePatientStudy(left, right) {
  const leftKey = normalizePatientKey(left);
  const rightKey = normalizePatientKey(right);
  if (!leftKey.key || !rightKey.key) return false;
  return leftKey.patientId === rightKey.patientId;
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

function resolveMediaAbsolutePathFromUrl(fileUrl) {
  const raw = sanitizeText(fileUrl);
  if (!raw) return null;

  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      candidate = new URL(raw).pathname;
    } catch (_) {
      return null;
    }
  }

  return resolveMediaAbsolutePath(candidate);
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

function getLocalMediaFileSize(fileUrl) {
  const fullPath = resolveMediaAbsolutePath(fileUrl);
  if (!fullPath) return 0;
  try {
    if (!fs.existsSync(fullPath)) return 0;
    const stats = fs.statSync(fullPath);
    return stats.isFile() ? Number(stats.size) || 0 : 0;
  } catch (_) {
    return 0;
  }
}

function parseStorageByteCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(Math.round(value), 0);
  const clean = sanitizeText(value);
  if (!clean) return 0;
  const numeric = Number(clean.replace(/,/g, ''));
  if (Number.isFinite(numeric)) return Math.max(Math.round(numeric), 0);
  const match = clean.match(/^([0-9]+(?:\.[0-9]+)?)\s*(b|bytes|kb|kib|mb|mib|gb|gib|tb|tib)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === 'tb' || unit === 'tib'
      ? 1024 ** 4
      : unit === 'gb' || unit === 'gib'
        ? 1024 ** 3
        : unit === 'mb' || unit === 'mib'
          ? 1024 ** 2
          : unit === 'kb' || unit === 'kib'
            ? 1024
            : 1;
  return Math.max(Math.round(amount * multiplier), 0);
}

function loadOrthancStorageCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ORTHANC_STORAGE_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveOrthancStorageCache(cache) {
  const tempFile = `${ORTHANC_STORAGE_CACHE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(cache && typeof cache === 'object' ? cache : {}, null, 2), 'utf8');
  fs.renameSync(tempFile, ORTHANC_STORAGE_CACHE_FILE);
}

function normalizeOrthancStorageStats(orthancStudyId, stats) {
  const diskSizeBytes = parseStorageByteCount(
    stats && (stats.DiskSizeBytes || stats.DiskSize || stats.disk_size_bytes || stats.disk_size)
  );
  const uncompressedSizeBytes = parseStorageByteCount(
    stats &&
      (stats.UncompressedSizeBytes ||
        stats.UncompressedSize ||
        stats.uncompressed_size_bytes ||
        stats.uncompressed_size)
  );
  return {
    orthanc_study_id: sanitizeText(orthancStudyId),
    status: 'ready',
    refreshed_at: nowIso(),
    disk_size_bytes: diskSizeBytes,
    uncompressed_size_bytes: uncompressedSizeBytes,
    instance_count: Number(stats && (stats.CountInstances || stats.Instances || stats.instance_count)) || 0,
  };
}

async function fetchOrthancStudyStorageStats(orthancStudyId) {
  const cleanId = sanitizeText(orthancStudyId);
  if (!cleanId) return null;
  try {
    const response = await orthancClient.get(`/studies/${cleanId}/statistics`);
    return normalizeOrthancStorageStats(cleanId, response.data || {});
  } catch (err) {
    const status = err && err.response && err.response.status;
    if (status === 404) {
      return {
        orthanc_study_id: cleanId,
        status: 'missing',
        refreshed_at: nowIso(),
        disk_size_bytes: 0,
        uncompressed_size_bytes: 0,
        instance_count: 0,
      };
    }
    return {
      orthanc_study_id: cleanId,
      status: 'error',
      refreshed_at: nowIso(),
      disk_size_bytes: 0,
      uncompressed_size_bytes: 0,
      instance_count: 0,
      error: sanitizeText(extractAxiosError(err)),
    };
  }
}

function getStudyOrthancStorageStats(study, cache) {
  const orthancStudyId = sanitizeText(study && study.orthanc_study_id);
  if (!orthancStudyId) {
    return {
      orthanc_study_id: null,
      status: 'none',
      refreshed_at: null,
      disk_size_bytes: 0,
      uncompressed_size_bytes: 0,
      instance_count: 0,
    };
  }
  const entry = cache && cache[orthancStudyId];
  if (!entry || typeof entry !== 'object') {
    return {
      orthanc_study_id: orthancStudyId,
      status: 'not_cached',
      refreshed_at: null,
      disk_size_bytes: 0,
      uncompressed_size_bytes: 0,
      instance_count: Number(study && study.dicom_count) || 0,
    };
  }
  return {
    orthanc_study_id: orthancStudyId,
    status: sanitizeText(entry.status) || 'ready',
    refreshed_at: sanitizeText(entry.refreshed_at) || null,
    disk_size_bytes: Number(entry.disk_size_bytes) || 0,
    uncompressed_size_bytes: Number(entry.uncompressed_size_bytes) || 0,
    instance_count: Number(entry.instance_count) || Number(study && study.dicom_count) || 0,
    error: sanitizeText(entry.error) || null,
  };
}

function getStudyLocalStorageBytes(study, recordings) {
  const reportBytes = normalizeCaseReports(study).reduce(function (sum, report) {
    return sum + getLocalMediaFileSize(report && report.report_url);
  }, 0);
  const recordingBytes = (recordings || [])
    .filter(function (record) {
      return Number(record && record.studyId) === Number(study && study.id);
    })
    .reduce(function (sum, record) {
      return sum + getLocalMediaFileSize(record && record.recording_url);
    }, 0);
  return (
    getLocalMediaFileSize(study && study.mp4_url) +
    getLocalMediaFileSize(study && study.pdf_url) +
    reportBytes +
    recordingBytes
  );
}

function deleteLocalMediaDirectoryForUrl(fileUrl) {
  const fullPath = resolveMediaAbsolutePath(fileUrl);
  if (!fullPath) return;
  const dir = path.dirname(fullPath);
  if (!dir.startsWith(VIDEO_THUMBNAILS_DIR + path.sep) && !dir.startsWith(VIDEO_HLS_DIR + path.sep)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'media.thumbnail_dir_delete_failed', { path: dir, message: err.message });
  }
}

function deleteStudyVideoDerivativeFiles(study) {
  deleteLocalMediaFile(study && study.mp4_url);
  const paths =
    study &&
    study.video_metadata &&
    Array.isArray(study.video_metadata.thumbnail_paths)
      ? study.video_metadata.thumbnail_paths
      : [];
  if (paths.length > 0) {
    deleteLocalMediaDirectoryForUrl(paths[0]);
  }
  const hlsMaster =
    study &&
    study.video_metadata &&
    study.video_metadata.hls &&
    sanitizeText(study.video_metadata.hls.master_playlist);
  if (hlsMaster) {
    deleteLocalMediaDirectoryForUrl(hlsMaster);
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
  const uploadedInstanceIds = [];
  const uploadedStudyIds = new Set();
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

  async function processOneFile(f, fileIndex) {
    try {
      const probeStartedAt = Date.now();
      const probeBuffer = readInputFileProbeBuffer(f, 128 * 1024);
      const fileSize = resolveInputFileSize(f);
      timings.probe_ms += Date.now() - probeStartedAt;
      totalBytes += fileSize > 0 ? fileSize : 0;
      const originalName = sanitizeText(f && f.originalname) || sanitizeText(f && f.filename) || 'unknown';
      let sourceDicomBuffer = null;
      let transferSyntaxUid = '';
      let sourceWasRawJpeg2000 = false;

      if (!isProbablyDicomBuffer(probeBuffer)) {
        if (!looksLikeRawJpeg2000(f, probeBuffer)) {
          throw makeAppError('INVALID_DICOM_FILE', 400, 'File does not appear to be a valid DICOM or JPEG2000 object.');
        }

        const wrapStartedAt = Date.now();
        sourceDicomBuffer = await wrapRawJpeg2000AsDicom(f, {
          namespace: dicomUidNamespace || 'mapdr-jpeg2000',
          instanceNumber: Number(fileIndex) + 1,
        });
        timings.transcode_ms += Date.now() - wrapStartedAt;
        transferSyntaxUid = DICOM_TRANSFER_SYNTAX_EXPLICIT_LE;
        sourceWasRawJpeg2000 = true;
        convertedCount += 1;
        convertedFiles.push({
          name: originalName,
          from_transfer_syntax: 'raw-jpeg2000',
          to_transfer_syntax: DICOM_TRANSFER_SYNTAX_EXPLICIT_LE,
        });
      } else {
        transferSyntaxUid = detectTransferSyntaxUid(probeBuffer);
      }

      const sourceSize = sourceDicomBuffer ? sourceDicomBuffer.length : fileSize;
      const canProcessInMemory = sourceSize > 0 ? sourceSize <= inMemoryByteCap : true;
      const shouldAutoTranscodeJpeg2000 = isJpeg2000TransferSyntax(transferSyntaxUid);
      const shouldAttemptJpeg2000Transcode = shouldAutoTranscodeJpeg2000 && !sourceWasRawJpeg2000;
      const shouldAttemptTransforms =
        sourceWasRawJpeg2000 || shouldAttemptJpeg2000Transcode || (canProcessInMemory && redactTextOnUpload);
      let uploadBuffer = null;

      if (sourceDicomBuffer) {
        uploadBuffer = sourceDicomBuffer;
      }

      if (shouldAttemptJpeg2000Transcode) {
        try {
          const sourceBuffer = sourceDicomBuffer || resolveInputFileBuffer(f);
          const transcodeStartedAt = Date.now();
          uploadBuffer = await transcodeDicomBufferViaOrthanc(
            sourceBuffer,
            DICOM_TRANSFER_SYNTAX_EXPLICIT_LE
          );
          timings.transcode_ms += Date.now() - transcodeStartedAt;
          convertedCount += 1;
          convertedFiles.push({
            name: originalName,
            from_transfer_syntax: transferSyntaxUid,
            to_transfer_syntax: DICOM_TRANSFER_SYNTAX_EXPLICIT_LE,
          });
        } catch (conversionErr) {
          log('warn', 'dicom.jpeg2000_transcode_failed', {
            filename: originalName,
            transfer_syntax: transferSyntaxUid || null,
            error: extractAxiosError(conversionErr),
          });
          throw makeAppError(
            'DICOM_JPEG2000_TRANSCODE_FAILED',
            502,
            'JPEG2000 DICOM could not be converted into a displayable transfer syntax.',
            {
              filename: originalName,
              transfer_syntax: transferSyntaxUid || null,
              error: extractAxiosError(conversionErr),
            }
          );
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
            name: originalName,
            reason: normalizeUploadErrorMessage(redactionErr),
          });
          log('warn', 'dicom.redaction_failed_fallback_original', {
            filename: originalName,
            error: extractAxiosError(redactionErr),
          });
          finalUploadBuffer = uploadBuffer;
        }
      }

      if (!canProcessInMemory && redactTextOnUpload) {
        log('warn', 'dicom.transforms_skipped_large_file', {
          filename: originalName,
          file_size_bytes: sourceSize,
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
        const instanceId = sanitizeText(response.data.ID);
        const parentStudyId = sanitizeText(response.data.ParentStudy);
        if (instanceId) uploadedInstanceIds.push(instanceId);
        if (parentStudyId) uploadedStudyIds.add(parentStudyId);
        orthancPatientId = response.data.ParentPatient || orthancPatientId;
        orthancStudyId = parentStudyId || orthancStudyId;
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
        await processOneFile(filesToProcess[currentIndex], currentIndex);
      }
    })();
  });

  await Promise.all(workers);

  if (failedFiles.length > 0) {
    await Promise.all(
      uploadedInstanceIds.map(function (instanceId) {
        return safeDeleteOrthancInstance(instanceId);
      })
    );
    throw makeAppError(
      'DICOM_UPLOAD_INCOMPLETE',
      502,
      'One or more DICOM files failed to upload. The batch was not attached to the case so streams cannot silently miss images.',
      {
        uploaded_count: uploadedCount,
        failed_files_count: failedFiles.length,
        failed_files: failedFiles.slice(0, 20),
      }
    );
  }

  if (uploadedStudyIds.size > 1) {
    await Promise.all(
      uploadedInstanceIds.map(function (instanceId) {
        return safeDeleteOrthancInstance(instanceId);
      })
    );
    throw makeAppError(
      'MIXED_DICOM_STUDIES',
      400,
      'Uploaded DICOM files belong to more than one Orthanc study. Upload one DICOM study per case so streams stay correctly ordered.',
      {
        orthanc_study_count: uploadedStudyIds.size,
        uploaded_count: uploadedCount,
        failed_files_count: failedFiles.length,
      }
    );
  }

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

async function wrapRawJpeg2000AsDicom(file, options) {
  const opts = options || {};
  const inputPath = sanitizeText(file && file.path);
  const outputPath = path.join(TMP_DIR, `jpeg2000-wrap-output-${crypto.randomUUID()}.dcm`);
  const originalName = sanitizeText(file && file.originalname) || sanitizeText(file && file.filename) || 'jpeg2000';
  const namespace = sanitizeText(opts.namespace) || crypto.randomUUID();
  const instanceNumber = Math.max(Number(opts.instanceNumber) || 1, 1);

  if (!inputPath) {
    throw new Error('JPEG2000 file payload is missing a temporary path.');
  }

  try {
    await runPythonScript(
      DICOM_JPEG2000_WRAP_SCRIPT,
      [
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--namespace',
        namespace,
        '--source-name',
        originalName,
        '--instance-number',
        String(instanceNumber),
      ],
      'jpeg2000_to_dicom.py'
    );
    const wrappedBuffer = fs.readFileSync(outputPath);
    if (!isProbablyDicomBuffer(wrappedBuffer)) {
      throw new Error('JPEG2000 wrapper output is not a valid DICOM payload.');
    }
    return wrappedBuffer;
  } finally {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (cleanupErr) {
      log('warn', 'dicom.jpeg2000_wrap_tmp_cleanup_failed', {
        path: outputPath,
        message: sanitizeText(cleanupErr && cleanupErr.message) || 'Cleanup failed.',
      });
    }
  }
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

const MAX_CONCURRENT_FFMPEG_PROCESSES = Math.max(
  1,
  Math.min(4, Number(process.env.MAX_CONCURRENT_FFMPEG_PROCESSES || 2))
);
let activeFfmpegProcesses = 0;
const pendingFfmpegRuns = [];

function acquireFfmpegSlot() {
  if (activeFfmpegProcesses < MAX_CONCURRENT_FFMPEG_PROCESSES) {
    activeFfmpegProcesses += 1;
    return Promise.resolve();
  }

  return new Promise(function (resolve) {
    pendingFfmpegRuns.push(resolve);
  }).then(function () {
    activeFfmpegProcesses += 1;
  });
}

function releaseFfmpegSlot() {
  activeFfmpegProcesses = Math.max(0, activeFfmpegProcesses - 1);
  const next = pendingFfmpegRuns.shift();
  if (next) next();
}

async function runFfmpeg(args, options) {
  const opts = options || {};
  await acquireFfmpegSlot();
  return new Promise(function (resolve, reject) {
    const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let canceled = false;
    let cancelTimer = null;
    let timeoutTimer = null;
    let settled = false;

    const finish = function (fn, value) {
      if (settled) return;
      settled = true;
      if (cancelTimer) clearInterval(cancelTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      releaseFfmpegSlot();
      fn(value);
    };

    if (typeof opts.shouldCancel === 'function') {
      cancelTimer = setInterval(function () {
        if (!opts.shouldCancel()) return;
        if (canceled) return;
        canceled = true;
        try {
          process.kill('SIGTERM');
        } catch (killErr) {
          finish(reject, killErr);
        }
      }, 400);
      cancelTimer.unref();
    }

    if (Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0) {
      timeoutTimer = setTimeout(function () {
        if (settled) return;
        canceled = true;
        try {
          process.kill('SIGTERM');
        } catch (_) {}
        setTimeout(function () {
          try {
            process.kill('SIGKILL');
          } catch (_) {}
        }, 2000).unref();
      }, Number(opts.timeoutMs));
      timeoutTimer.unref();
    }

    process.stderr.on('data', function (chunk) {
      stderr += String(chunk || '');
    });

    process.on('error', function (err) {
      finish(reject, err);
    });

    process.on('close', function (code) {
      if (canceled) {
        finish(reject, makeAppError('JOB_CANCELLED', 409, 'Case stream export was cancelled or timed out.'));
        return;
      }

      if (code === 0) {
        finish(resolve);
        return;
      }

      finish(reject, new Error(`ffmpeg failed with code ${code}. ${stderr.slice(-1200)}`));
    });
  });
}

function runFfprobeJson(args) {
  return new Promise(function (resolve, reject) {
    const child = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}. ${stderr.slice(-1200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function parseFfprobeRate(value) {
  const text = sanitizeText(value);
  if (!text) return 0;
  const parts = text.split('/');
  if (parts.length === 2) {
    const numerator = Number(parts[0]);
    const denominator = Number(parts[1]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
    return 0;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

async function probeVideoFile(filePath) {
  const data = await runFfprobeJson([
    '-show_entries',
    'format=duration:stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,duration',
    filePath,
  ]);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const videoStream = streams.find(function (stream) {
    return sanitizeText(stream && stream.codec_type) === 'video';
  });
  if (!videoStream) {
    throw makeAppError('INVALID_VIDEO_FILE', 400, 'Uploaded file does not contain a video stream.');
  }
  const duration =
    Number(videoStream.duration) ||
    Number(data && data.format && data.format.duration) ||
    0;
  const fps =
    parseFfprobeRate(videoStream.avg_frame_rate) ||
    parseFfprobeRate(videoStream.r_frame_rate) ||
    30;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(3)) : 0,
    width: Number(videoStream.width) || 0,
    height: Number(videoStream.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : 30,
  };
}

function getKeyframeIntervalFromFps(fps) {
  const rounded = Math.round(Number(fps) || 30);
  if (!Number.isFinite(rounded) || rounded <= 0) return 30;
  return Math.min(Math.max(rounded, 1), 240);
}

function mediaUrlForPath(filePath) {
  const relativeMediaPath = path.relative(MEDIA_DIR, filePath).split(path.sep).join('/');
  return `/media/${relativeMediaPath}`;
}

function listThumbnailUrls(thumbnailDir) {
  if (!thumbnailDir || !fs.existsSync(thumbnailDir)) return [];
  return fs
    .readdirSync(thumbnailDir)
    .filter(function (name) {
      return /^thumb-\d+\.jpg$/i.test(name);
    })
    .sort()
    .map(function (name) {
      return mediaUrlForPath(path.join(thumbnailDir, name));
    });
}

function getHlsVariantsForProbe(probe) {
  const sourceHeight = Number(probe && probe.height) || 0;
  const variants = [
    { name: '1080p', height: 1080, width: 1920, videoBitrate: '5000k', audioBitrate: '160k' },
    { name: '720p', height: 720, width: 1280, videoBitrate: '2800k', audioBitrate: '128k' },
    { name: '480p', height: 480, width: 854, videoBitrate: '1200k', audioBitrate: '96k' },
  ].filter(function (variant) {
    return sourceHeight >= variant.height;
  });

  if (variants.length === 0) {
    const safeHeight = Math.max(2, Math.floor(sourceHeight / 2) * 2 || 360);
    variants.push({
      name: `${safeHeight}p`,
      height: safeHeight,
      width: -2,
      videoBitrate: '900k',
      audioBitrate: '96k',
    });
  }

  return variants;
}

function hlsBandwidthForVariant(variant) {
  const videoKbps = Number(String(variant.videoBitrate).replace(/k$/i, '')) || 0;
  const audioKbps = Number(String(variant.audioBitrate).replace(/k$/i, '')) || 0;
  return Math.max((videoKbps + audioKbps) * 1000, 1);
}

function writeHlsMasterPlaylist(hlsDir, variants) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  variants.forEach(function (variant) {
    const width = variant.width > 0 ? variant.width : Math.max(2, Math.round((variant.height * 16) / 9 / 2) * 2);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${hlsBandwidthForVariant(variant)},RESOLUTION=${width}x${variant.height},NAME="${variant.name}"`
    );
    lines.push(`${variant.name}/index.m3u8`);
  });
  fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), `${lines.join('\n')}\n`, 'utf8');
}

async function generateHlsOutputs(inputPath, hlsDir, probe) {
  const variants = getHlsVariantsForProbe(probe);
  const gop = Math.max(1, getKeyframeIntervalFromFps(probe && probe.fps) * VIDEO_HLS_SEGMENT_SEC);
  ensureDir(hlsDir);

  for (const variant of variants) {
    const variantDir = path.join(hlsDir, variant.name);
    ensureDir(variantDir);
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      CASE_STREAM_X264_PRESET,
      '-crf',
      '23',
      '-b:v',
      variant.videoBitrate,
      '-maxrate',
      variant.videoBitrate,
      '-bufsize',
      `${Math.max((Number(String(variant.videoBitrate).replace(/k$/i, '')) || 1200) * 2, 1)}k`,
      '-vf',
      variant.width > 0
        ? `scale=w=${variant.width}:h=${variant.height}:force_original_aspect_ratio=decrease,pad=${variant.width}:${variant.height}:(ow-iw)/2:(oh-ih)/2`
        : `scale=-2:${variant.height}`,
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(gop),
      '-keyint_min',
      String(gop),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${VIDEO_HLS_SEGMENT_SEC})`,
      '-c:a',
      'aac',
      '-b:a',
      variant.audioBitrate,
      '-ac',
      '2',
      '-f',
      'hls',
      '-hls_time',
      String(VIDEO_HLS_SEGMENT_SEC),
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_filename',
      path.join(variantDir, 'seg-%05d.ts'),
      path.join(variantDir, 'index.m3u8'),
    ]);
  }

  writeHlsMasterPlaylist(hlsDir, variants);
  return {
    master_playlist: mediaUrlForPath(path.join(hlsDir, 'master.m3u8')),
    segment_duration: VIDEO_HLS_SEGMENT_SEC,
    variants: variants.map(function (variant) {
      return {
        name: variant.name,
        height: variant.height,
        width: variant.width > 0 ? variant.width : null,
        bandwidth: hlsBandwidthForVariant(variant),
        playlist: mediaUrlForPath(path.join(hlsDir, variant.name, 'index.m3u8')),
      };
    }),
  };
}

async function processUploadedVideoJob(job) {
  const sourcePath = sanitizeText(job && job.source_path);
  const studyId = Number(job && job.study_id);
  const jobId = sanitizeText(job && job.id);
  if (!sourcePath || !fs.existsSync(sourcePath) || !Number.isFinite(studyId) || studyId <= 0) {
    throw new Error('Video processing job is missing its source file or study id.');
  }

  const initialProbe = await probeVideoFile(sourcePath);
  const gop = getKeyframeIntervalFromFps(initialProbe.fps);
  const outputName = `study-${studyId}-video-${Date.now()}-${jobId.slice(0, 8)}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  const thumbnailDir = path.join(VIDEO_THUMBNAILS_DIR, `study-${studyId}-${jobId}`);
  const hlsDir = path.join(VIDEO_HLS_DIR, `study-${studyId}-${jobId}`);
  ensureDir(thumbnailDir);

  try {
    await runFfmpeg([
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      CASE_STREAM_X264_PRESET,
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(gop),
      '-keyint_min',
      String(gop),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*1)',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-avoid_negative_ts',
      'make_zero',
      outputPath,
    ]);

    let hlsMetadata = null;
    if (initialProbe.duration >= VIDEO_HLS_MIN_DURATION_SEC) {
      hlsMetadata = await generateHlsOutputs(outputPath, hlsDir, initialProbe);
    }

    await runFfmpeg([
      '-y',
      '-i',
      outputPath,
      '-vf',
      'fps=1,scale=320:-2',
      '-q:v',
      '4',
      path.join(thumbnailDir, 'thumb-%05d.jpg'),
    ]);

    const outputProbe = await probeVideoFile(outputPath);
    const thumbnailPaths = listThumbnailUrls(thumbnailDir);
    const studies = loadStudies();
    const study = findStudy(studies, studyId);
    if (!study) {
      throw new Error('Study not found while finalizing video processing.');
    }
    if (sanitizeText(study.video_processing_job_id) !== jobId) {
      try {
        fs.unlinkSync(outputPath);
      } catch (_) {}
      try {
        fs.rmSync(thumbnailDir, { recursive: true, force: true });
      } catch (_) {}
      try {
        fs.rmSync(hlsDir, { recursive: true, force: true });
      } catch (_) {}
      return;
    }

    deleteStudyVideoDerivativeFiles(study);
    study.mp4_url = mediaUrlForPath(outputPath);
    study.video_processing_status = 'ready';
    study.video_processing_error = null;
    study.video_metadata = {
      duration: outputProbe.duration,
      width: outputProbe.width,
      height: outputProbe.height,
      fps: outputProbe.fps,
      keyframe_interval: gop,
      thumbnail_interval_sec: 1,
      thumbnail_paths: thumbnailPaths,
      playback_strategy: hlsMetadata ? 'hls' : 'mp4',
      hls: hlsMetadata,
      processed_at: nowIso(),
      source_filename: sanitizeText(job.original_name) || null,
    };
    study.status = 'ready';
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    publishStudyRealtimeEvent(study, 'study.updated', {
      event: 'study.updated',
      source: 'video_processing_complete',
      mp4_url: study.mp4_url,
      video_metadata: study.video_metadata,
    });
    scheduleNextcloudExport(study.id, 'video_processing_complete');
  } catch (err) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (_) {}
    try {
      fs.rmSync(thumbnailDir, { recursive: true, force: true });
    } catch (_) {}
    try {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    } catch (_) {}
    throw err;
  } finally {
    try {
      if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
    } catch (err) {
      log('warn', 'video_processing.source_cleanup_failed', { path: sourcePath, message: err.message });
    }
  }
}

function pumpUploadedVideoJobs() {
  while (
    uploadedVideoJobsInFlight < VIDEO_PROCESSING_CONCURRENCY &&
    uploadedVideoJobQueue.length > 0
  ) {
    const job = uploadedVideoJobQueue.shift();
    uploadedVideoJobsInFlight += 1;
    updateUploadedVideoJob(job.id, function (draft) {
      draft.status = 'processing';
      draft.error = null;
    });
    processUploadedVideoJob(job)
      .then(function () {
        updateUploadedVideoJob(job.id, function (draft) {
          draft.status = 'done';
          draft.error = null;
        });
      })
      .catch(async function (err) {
        updateUploadedVideoJob(job.id, function (draft) {
          draft.status = 'failed';
          draft.error = sanitizeText(err && err.message) || 'Video processing failed.';
        });
        const studies = loadStudies();
        const study = findStudy(studies, job && job.study_id);
        if (study && sanitizeText(study.video_processing_job_id) === sanitizeText(job && job.id)) {
          study.mp4_url = null;
          study.video_processing_status = 'failed';
          study.video_processing_error = sanitizeText(err && err.message) || 'Video processing failed.';
          study.status = 'error';
          touchStudy(study);
          saveStudies(studies);
          if (ENABLE_PG_DUAL_WRITE) {
            await pgDualWriteStudy(study);
          }
          publishStudyRealtimeEvent(study, 'study.updated', {
            event: 'study.updated',
            source: 'video_processing_failed',
            status: study.status,
            video_processing_error: study.video_processing_error,
          });
        }
        try {
          if (job && job.source_path && fs.existsSync(job.source_path)) fs.unlinkSync(job.source_path);
        } catch (_) {}
        log('warn', 'video_processing.failed', {
          study_id: job && job.study_id,
          message: sanitizeText(err && err.message) || 'Video processing failed.',
        });
      })
      .finally(function () {
        uploadedVideoJobsInFlight -= 1;
        pumpUploadedVideoJobs();
      });
  }
}

function enqueueUploadedVideoProcessing(study, file, source) {
  const job = {
    id: crypto.randomUUID(),
    study_id: Number(study.id),
    source_path: file.path,
    original_name: sanitizeText(file.originalname) || null,
    source: sanitizeText(source) || 'video_upload',
    status: 'queued',
    error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  deleteStudyVideoDerivativeFiles(study);
  study.mp4_url = null;
  study.video_processing_status = 'processing';
  study.video_processing_error = null;
  study.video_processing_job_id = job.id;
  study.video_metadata = null;
  study.status = 'processing';
  touchStudy(study);
  const jobs = loadUploadedVideoJobs().filter(function (entry) {
    return sanitizeText(entry.id) !== job.id;
  });
  jobs.push(job);
  saveUploadedVideoJobs(jobs);
  uploadedVideoJobQueue.push(job);
  setImmediate(pumpUploadedVideoJobs);
  return job;
}

function restoreUploadedVideoJobQueue() {
  const jobs = loadUploadedVideoJobs();
  let restored = 0;
  let failed = 0;
  const nextJobs = jobs.map(function (job) {
    if (!['queued', 'processing'].includes(sanitizeText(job.status))) return job;
    if (!job.source_path || !fs.existsSync(job.source_path)) {
      failed += 1;
      const studies = loadStudies();
      const study = findStudy(studies, job.study_id);
      if (study && sanitizeText(study.video_processing_job_id) === sanitizeText(job.id)) {
        study.video_processing_status = 'failed';
        study.video_processing_error = 'Source video file is missing after API restart.';
        study.status = 'error';
        touchStudy(study);
        saveStudies(studies);
        if (ENABLE_PG_DUAL_WRITE) {
          pgDualWriteStudy(study);
        }
      }
      return {
        ...job,
        status: 'failed',
        error: 'Source video file is missing after API restart.',
        updated_at: nowIso(),
      };
    }
    restored += 1;
    uploadedVideoJobQueue.push({ ...job, status: 'queued', error: null });
    return {
      ...job,
      status: 'queued',
      error: null,
      updated_at: nowIso(),
    };
  });
  if (restored > 0 || failed > 0) {
    saveUploadedVideoJobs(nextJobs);
    log('info', 'video_processing.queue_restored', { restored: restored, failed: failed });
  }
  if (restored > 0) {
    setImmediate(pumpUploadedVideoJobs);
  }
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

async function convertAudioToMp3(inputPath, outputPath) {
  const sourcePath = sanitizeText(inputPath);
  const targetPath = sanitizeText(outputPath);
  if (!sourcePath || !targetPath) {
    throw new Error('Audio conversion source or target is missing.');
  }

  await runFfmpeg([
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '96k',
    targetPath,
  ]);
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

function resolveCaseStreamContext(body, authContext) {
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
  if (authContext) {
    const deniedStudy = selectedStudies.find(function (study) {
      return !canAccessStudyRecord(authContext, study);
    });
    if (deniedStudy) {
      throw makeAppError('FORBIDDEN', 403, `You do not have access to study ${deniedStudy.id}.`);
    }
  }
  const tenantIds = Array.from(
    new Set(
      selectedStudies
        .map(function (study) {
          return getStudyTenantId(study);
        })
        .filter(Boolean)
    )
  );

  return {
    parsedBody,
    selectedStudies,
    tenantIds,
  };
}

function canAccessTenantScopedResource(context, tenantIds) {
  const cleanTenantIds = normalizeTenantIdList(tenantIds || []);
  if (cleanTenantIds.length === 0) return isGlobalStudyOperator(context);
  return cleanTenantIds.every(function (tenantId) {
    return canAccessTenant(context, tenantId);
  });
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
    timeline: normalizeCaseStreamTimelineFrames(job.timeline, job.fps),
    skipped_studies_count: Number(job.skipped_studies_count || 0),
    skipped_studies: Array.isArray(job.skipped_studies) ? job.skipped_studies : [],
    skipped_frames: Array.isArray(job.skipped_frames) ? job.skipped_frames : [],
    source_summary: Array.isArray(job.source_summary) ? job.source_summary : [],
    duration_sec: Number(job.duration_sec || 0),
    total_frames: getCaseStreamTotalFrames(job),
    frame_review_url:
      job.status === 'ready'
        ? `/api/case-stream/jobs/${encodeURIComponent(job.id)}/frames/{frameIndex}`
        : null,
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
        const sourceFrameCount = Math.max(1, Math.floor(Number(sourceResult.frameCount) || 1));
        const timelineStartFrame = frameIndex;
        const timelineEndFrame = timelineStartFrame + sourceFrameCount;
        const timelineDurationSec =
          Number(sourceResult.renderedDurationSec) > 0
            ? Number(sourceResult.renderedDurationSec)
            : sourceFrameCount / parsedBody.fps;
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
          fps: parsedBody.fps,
          frame_count: sourceFrameCount,
          start_frame: timelineStartFrame,
          end_frame: timelineEndFrame,
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
          fps: parsedBody.fps,
          frame_count: sourceFrameCount,
          start_frame: timelineStartFrame,
          end_frame: timelineEndFrame,
          truncated: Boolean(sourceResult.truncated),
        });
        segmentPaths.push(sourceResult.segmentPath);
        frameIndex = timelineEndFrame;
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
        ...getCaseStreamFramePerfectX264Args(parsedBody.fps),
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
        ...getCaseStreamFramePerfectX264Args(parsedBody.fps),
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
      lastTimeline.end_frame = Number(lastTimeline.start_frame || 0) + lastTimeline.frame_count;

      const lastSummary = sourceSummary[sourceSummary.length - 1];
      if (lastSummary && Number(lastSummary.study_id) === Number(lastTimeline.study_id)) {
        lastSummary.rendered_duration_sec = lastTimeline.rendered_duration_sec;
        lastSummary.frame_count = lastTimeline.frame_count;
        lastSummary.end_frame = lastTimeline.end_frame;
      }

      totalDurationSec = normalizedFinalDurationSec;
      frameIndex = Math.max(1, Math.round(normalizedFinalDurationSec * parsedBody.fps));
    }

    const normalizedTimeline = normalizeCaseStreamTimelineFrames(timeline, parsedBody.fps);
    const totalFrames = getCaseStreamTotalFrames({
      timeline: normalizedTimeline,
      frames_rendered: frameIndex,
    });

    onProgress(100, 'Completed');

    return {
      fps: parsedBody.fps,
      totalFrames: totalFrames,
      timeline: normalizedTimeline,
      skippedStudies: skippedStudies,
      skippedFrames: skippedFrames,
      sourceSummary: sourceSummary,
      durationSec: Number(totalDurationSec.toFixed(3)),
      framesRendered: totalFrames,
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

function getCaseStreamFramePerfectX264Args(fps) {
  const normalizedFps = Math.max(1, Math.min(Number(fps) || 24, 60));
  const gopSize = Math.max(1, Math.round(normalizedFps));
  return [
    ...getCaseStreamX264Args(),
    '-g',
    String(gopSize),
    '-keyint_min',
    String(gopSize),
    '-sc_threshold',
    '0',
    '-bf',
    '0',
    '-x264-params',
    `keyint=${gopSize}:min-keyint=${gopSize}:scenecut=0:bframes=0:ref=1:fps=${normalizedFps}/1:force-cfr=1`,
  ];
}

function getCaseStreamTotalFrames(value) {
  const explicit = Number(value && value.total_frames);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);

  const rendered = Number(value && value.frames_rendered);
  if (Number.isFinite(rendered) && rendered > 0) return Math.floor(rendered);

  const timeline = Array.isArray(value && value.timeline) ? value.timeline : [];
  const timelineTotal = timeline.reduce(function (total, item) {
    return total + (Number(item && item.frame_count) || 0);
  }, 0);
  return Number.isFinite(timelineTotal) && timelineTotal > 0 ? Math.floor(timelineTotal) : 0;
}

function normalizeCaseStreamTimelineFrames(timeline, fps) {
  if (!Array.isArray(timeline)) return [];
  let nextStartFrame = 0;
  return timeline.map(function (item, index) {
    const frameCount = Math.max(1, Math.floor(Number(item && item.frame_count) || 1));
    const startFrame = Number.isFinite(Number(item && item.start_frame))
      ? Math.max(0, Math.floor(Number(item.start_frame)))
      : nextStartFrame;
    const endFrame = startFrame + frameCount;
    nextStartFrame = endFrame;
    return {
      ...item,
      index: Number.isFinite(Number(item && item.index)) ? Number(item.index) : index,
      fps: Number(fps) || Number(item && item.fps) || 0,
      frame_count: frameCount,
      start_frame: startFrame,
      end_frame: endFrame,
    };
  });
}

function getCaseStreamFrameCachePath(scope, id, frameIndex) {
  const cacheDir = getCaseStreamFrameCacheDir(scope, id);
  const frameName = `frame-${String(frameIndex).padStart(8, '0')}.png`;
  return path.join(cacheDir, frameName);
}

function getCaseStreamFrameCacheDir(scope, id) {
  const safeScope = sanitizeText(scope).replace(/[^a-z0-9_-]/gi, '') || 'stream';
  const safeId = sanitizeText(id).replace(/[^a-z0-9_-]/gi, '') || 'unknown';
  const cacheDir = path.join(CASE_STREAM_FRAME_CACHE_DIR, safeScope, safeId);
  ensureDir(cacheDir);
  return cacheDir;
}

async function extractCaseStreamFramePng(videoPath, scope, id, frameIndex) {
  const sourcePath = sanitizeText(videoPath);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw makeAppError('OUTPUT_MISSING', 410, 'Case stream video is missing.');
  }

  const frameNumber = Math.max(0, Math.floor(Number(frameIndex) || 0));
  const cachePath = getCaseStreamFrameCachePath(scope, id, frameNumber);
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  const tempPath = `${cachePath}.${crypto.randomUUID()}.tmp.png`;
  try {
    await runFfmpeg([
      '-y',
      '-i',
      sourcePath,
      '-vf',
      `select=eq(n\\,${frameNumber})`,
      '-vsync',
      '0',
      '-frames:v',
      '1',
      tempPath,
    ], { timeoutMs: 30000 });
    if (!fs.existsSync(tempPath)) {
      throw makeAppError('FRAME_NOT_FOUND', 404, 'Case stream frame was not found.');
    }
    fs.renameSync(tempPath, cachePath);
    return cachePath;
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    throw err;
  }
}

const caseStreamFramePrewarmLocks = new Set();

async function extractCaseStreamFrameWindowPngs(videoPath, scope, id, startFrame, endFrame) {
  const sourcePath = sanitizeText(videoPath);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw makeAppError('OUTPUT_MISSING', 410, 'Case stream video is missing.');
  }

  const firstFrame = Math.max(0, Math.floor(Number(startFrame) || 0));
  const lastFrame = Math.max(firstFrame, Math.floor(Number(endFrame) || firstFrame));
  const cacheDir = getCaseStreamFrameCacheDir(scope, id);
  const missingRanges = [];
  let rangeStart = null;

  for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
    const cachePath = getCaseStreamFrameCachePath(scope, id, frame);
    if (!fs.existsSync(cachePath)) {
      if (rangeStart === null) rangeStart = frame;
    } else if (rangeStart !== null) {
      missingRanges.push([rangeStart, frame - 1]);
      rangeStart = null;
    }
  }

  if (rangeStart !== null) {
    missingRanges.push([rangeStart, lastFrame]);
  }

  let generated = 0;
  for (const range of missingRanges) {
    const rangeFirst = range[0];
    const rangeLast = range[1];
    const tempDir = path.join(cacheDir, `.prewarm-${crypto.randomUUID()}`);
    ensureDir(tempDir);
    try {
      await runFfmpeg([
        '-y',
        '-i',
        sourcePath,
        '-vf',
        `select=between(n\\,${rangeFirst}\\,${rangeLast})`,
        '-vsync',
        '0',
        '-start_number',
        String(rangeFirst),
        path.join(tempDir, 'frame-%08d.png'),
      ], { timeoutMs: 60000 });

      for (let frame = rangeFirst; frame <= rangeLast; frame += 1) {
        const tempPath = path.join(tempDir, `frame-${String(frame).padStart(8, '0')}.png`);
        const cachePath = getCaseStreamFrameCachePath(scope, id, frame);
        if (fs.existsSync(tempPath) && !fs.existsSync(cachePath)) {
          fs.renameSync(tempPath, cachePath);
          generated += 1;
        }
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  return generated;
}

function scheduleCaseStreamFramePrewarm(videoPath, scope, id, centerFrame, totalFrames, radius) {
  const frameCount = Math.max(0, Math.floor(Number(totalFrames) || 0));
  if (frameCount <= 0) return false;
  const frame = Math.min(frameCount - 1, Math.max(0, Math.floor(Number(centerFrame) || 0)));
  const windowRadius = Math.min(Math.max(Math.floor(Number(radius) || 48), 4), 240);
  const startFrame = Math.max(0, frame - windowRadius);
  const endFrame = Math.min(frameCount - 1, frame + windowRadius);
  const lockKey = `${sanitizeText(scope)}:${sanitizeText(id)}`;
  if (caseStreamFramePrewarmLocks.has(lockKey)) return false;
  caseStreamFramePrewarmLocks.add(lockKey);

  extractCaseStreamFrameWindowPngs(videoPath, scope, id, startFrame, endFrame)
    .then(function (generated) {
      if (generated > 0) {
        log('info', 'case_stream.frame_prewarm.completed', {
          scope: sanitizeText(scope),
          id: sanitizeText(id),
          start_frame: startFrame,
          end_frame: endFrame,
          generated: generated,
        });
      }
    })
    .catch(function (err) {
      log('warn', 'case_stream.frame_prewarm.failed', {
        scope: sanitizeText(scope),
        id: sanitizeText(id),
        message: sanitizeText(err && err.message),
      });
    })
    .finally(function () {
      caseStreamFramePrewarmLocks.delete(lockKey);
    });

  return true;
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
    ...getCaseStreamFramePerfectX264Args(parsedBody.fps),
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
    ...getCaseStreamFramePerfectX264Args(parsedBody.fps),
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
    ...getCaseStreamFramePerfectX264Args(parsedBody.fps),
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
    ...getCaseStreamFramePerfectX264Args(parsedBody.fps),
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
    job.total_frames = Number(result.totalFrames || result.framesRendered || 0);
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
  const patientIdentifier = getPatientIdentifierFromPayload(body || {});
  if (!patientIdentifier) return null;
  return validatePatientIdentifierPolicy(patientIdentifier, body || {});
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
  const tenantId = getStudyTenantId(study);
  const root = tenantId ? `/Tenants/${sanitizeFolderName(tenantId)}/Cases` : '/Cases';
  const caseName = sanitizeFolderName(
    sanitizeText(study && study.patient_name) ||
      sanitizeText(study && study.patient_id) ||
      `Case_${study && study.id ? study.id : Date.now()}`
  );
  return `${root}/${caseName}`;
}

async function ncCreateStudyCaseRoot(study) {
  const tenantId = getStudyTenantId(study);
  if (!tenantId) {
    await ncCreateFolder('/Cases');
    return;
  }
  const tenantRoot = `/Tenants/${sanitizeFolderName(tenantId)}`;
  await ncCreateFolder('/Tenants');
  await ncCreateFolder(tenantRoot);
  await ncCreateFolder(`${tenantRoot}/Cases`);
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
  if (
    !folder ||
    folder === '/Cases' ||
    folder === '/Tenants' ||
    folder.endsWith('/Cases') ||
    (!folder.startsWith('/Cases/') && !folder.startsWith('/Tenants/'))
  ) {
    return false;
  }

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

  deleteStudyVideoDerivativeFiles(study);
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

let tenantRetentionSweepInFlight = false;
async function sweepTenantPlanRetention() {
  if (tenantRetentionSweepInFlight) return;
  tenantRetentionSweepInFlight = true;
  try {
    const studies = loadStudies();
    const due = studies.filter(function (study) {
      if (!study || sanitizeText(study.deleted_at)) return false;
      const retention = getStudyRetentionConfig(study);
      if (!retention.requiresCustomerDownload || !retention.purgeAfter) return false;
      const purgeMs = new Date(retention.purgeAfter).getTime();
      return Number.isFinite(purgeMs) && purgeMs <= Date.now();
    });

    for (const study of due) {
      const latest = loadStudies();
      const current = findStudy(latest, study.id);
      if (!current || sanitizeText(current.deleted_at)) continue;
      const retention = getStudyRetentionConfig(current);
      const purgeMs = new Date(retention.purgeAfter || 0).getTime();
      if (!retention.requiresCustomerDownload || !Number.isFinite(purgeMs) || purgeMs > Date.now()) continue;

      appendTenantAuditEvent('tenant.retention_purge.started', {
        tenant_id: getStudyTenantId(current),
        study_id: current.id,
        action: 'retention_purge',
        details: {
          plan_id: retention.plan_id,
          purge_after: retention.purgeAfter,
        },
      });

      await permanentlyDeleteStudyRecord(latest, current, 'tenant_self_download_retention_expired');

      appendTenantAuditEvent('tenant.retention_purge.completed', {
        tenant_id: retention.tenant_id,
        study_id: current.id,
        action: 'retention_purge',
        details: {
          plan_id: retention.plan_id,
          purge_after: retention.purgeAfter,
        },
      });
    }

    if (due.length > 0) {
      log('info', 'tenant.retention_sweep_completed', { checked: studies.length, purged: due.length });
    }
  } catch (err) {
    log('error', 'tenant.retention_sweep_failed', { error: extractAxiosError(err) });
  } finally {
    tenantRetentionSweepInFlight = false;
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
      tenant_id: getStudyTenantId(study) || null,
      patient_name: study.patient_name || null,
      patient_id: normalizePatientIdentifier(study.patient_id) || null,
      patient_identifier: normalizePatientIdentifier(study.patient_id) || null,
      patient_lookup_url: buildPatientLookupUrl(study.patient_id),
      patient_age: study.patient_age || null,
      patient_dob: study.patient_dob || null,
      patient_sex: study.patient_sex || null,
      patient_zip: study.patient_zip || null,
      study_date: study.study_date || null,
      octrqaui: study.octrqaui || null,
      octraccui: study.octraccui || null,
      client_email: study.client_email || null,
      client_name: study.client_name || null,
      subclient: study.subclient || null,
      md_name: study.md_name || null,
      revenue: study.revenue || null,
      modality: study.modality || null,
      notes: study.notes || null,
      tech_notes: study.tech_notes || null,
      radiologist_notes: study.radiologist_notes || null,
      radiology_report: study.radiology_report || null,
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

function normalizePatientPackageStudyStack(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map(function (entry, index) {
      const studyId = Number(entry && (entry.studyId || entry.study_id || entry.id));
      if (!Number.isFinite(studyId) || studyId <= 0) return null;
      if (seen.has(studyId)) return null;
      seen.add(studyId);
      const relation = sanitizeText(entry && entry.relation).toLowerCase() === 'prior' ? 'prior' : 'current';
      const order = Number.isFinite(Number(entry && entry.order)) ? Number(entry.order) : index;
      return {
        studyId: studyId,
        relation: relation,
        order: order,
      };
    })
    .filter(Boolean)
    .sort(function (left, right) {
      if (left.order !== right.order) return left.order - right.order;
      return left.studyId - right.studyId;
    })
    .slice(0, 25);
}

function normalizePatientPackageReportItems(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(function (entry, index) {
      const url = sanitizeText(entry && (entry.url || entry.report_url));
      if (!url) return null;
      return {
        url: url,
        filename: sanitizeFolderName(
          sanitizeText(entry && entry.filename) ||
            path.basename(url.split('?')[0]) ||
            `report-${index + 1}.pdf`
        ),
        sourceStudyId: Number.isFinite(Number(entry && entry.sourceStudyId))
          ? Number(entry.sourceStudyId)
          : null,
        createdAt: sanitizeText(entry && entry.createdAt) || nowIso(),
      };
    })
    .filter(Boolean)
    .slice(0, 50);
}

function findStudyOwningReportItem(studies, report) {
  if (!report) return null;
  if (report.sourceStudyId) {
    const explicitStudy = findStudy(studies, report.sourceStudyId);
    if (explicitStudy) return explicitStudy;
  }

  const reportUrl = sanitizeText(report.url);
  if (!reportUrl) return null;
  return (studies || []).find(function (study) {
    if (sanitizeText(study && study.pdf_url) === reportUrl) return true;
    return normalizeCaseReports(study).some(function (caseReport) {
      return sanitizeText(caseReport && caseReport.report_url) === reportUrl;
    });
  }) || null;
}

function resolvePatientPackageIdentifier(body, selectedStudies) {
  const requested = getPatientIdentifierFromPayload(body || {});
  const missingIdentifierStudy = (selectedStudies || []).find(function (entry) {
    return !normalizePatientIdentifier(entry && entry.study && entry.study.patient_id);
  });
  if (missingIdentifierStudy) {
    throw makeAppError(
      'PATIENT_IDENTIFIER_REQUIRED',
      400,
      `Study ${missingIdentifierStudy.study.id} does not have the immutable patient identifier.`
    );
  }
  const studyIdentifiers = Array.from(
    new Set(
      (selectedStudies || [])
        .map(function (entry) {
          return normalizePatientIdentifier(entry && entry.study && entry.study.patient_id);
        })
        .filter(Boolean)
    )
  );

  if (requested && studyIdentifiers.length > 0 && studyIdentifiers.some(function (id) { return id !== requested; })) {
    throw makeAppError(
      'PATIENT_IDENTIFIER_MISMATCH',
      400,
      'Selected studies do not match the requested patient identifier.'
    );
  }
  if (studyIdentifiers.length > 1) {
    throw makeAppError(
      'PATIENT_IDENTIFIER_MISMATCH',
      400,
      'Selected studies belong to more than one patient identifier.'
    );
  }

  return requested || studyIdentifiers[0] || '';
}

function assertPatientPackageReportOwnership(studies, reports, patientIdentifier, context) {
  const cleanPatientIdentifier = normalizePatientIdentifier(patientIdentifier);
  if (!cleanPatientIdentifier) {
    throw makeAppError(
      'PATIENT_IDENTIFIER_REQUIRED',
      400,
      'Patient identifier is required before sending patient files.'
    );
  }

  for (const report of reports || []) {
    const ownerStudy = findStudyOwningReportItem(studies, report);
    if (!ownerStudy) {
      throw makeAppError(
        'PATIENT_REPORT_NOT_TRACEABLE',
        400,
        `Report ${sanitizeText(report && report.filename) || sanitizeText(report && report.url) || ''} is not traceable to a study for this patient.`
      );
    }
    if (!canAccessStudyRecord(context, ownerStudy)) {
      throw makeAppError(
        'FORBIDDEN',
        403,
        `You do not have access to report ${sanitizeText(report && report.filename) || sanitizeText(report && report.url) || ''}.`
      );
    }
    if (normalizePatientIdentifier(ownerStudy.patient_id) !== cleanPatientIdentifier) {
      throw makeAppError(
        'PATIENT_REPORT_MISMATCH',
        400,
        `Report ${sanitizeText(report && report.filename) || sanitizeText(report && report.url) || ''} belongs to a different patient identifier.`
      );
    }
    report.sourceStudyId = Number(ownerStudy.id);
  }
}

function getPatientPackageTenantId(selectedStudies) {
  const tenantIds = Array.from(
    new Set(
      (selectedStudies || [])
        .map(function (entry) {
          return getStudyTenantId(entry && entry.study);
        })
        .filter(Boolean)
    )
  );
  if (tenantIds.length > 1) {
    throw makeAppError('TENANT_MISMATCH', 400, 'Selected studies belong to more than one white-label tenant.');
  }
  return tenantIds[0] || null;
}

function getPatientPackageFolder(body, tenantId) {
  const patientIdentifier = getPatientIdentifierFromPayload(body || {});
  const patientName = sanitizeText(body && body.patientName);
  const patientEmail = sanitizeText(body && body.patientEmail);
  const title = sanitizeText(body && body.title);
  const patientPart = sanitizeFolderName(patientIdentifier || patientName || patientEmail || 'Patient');
  const titlePart = sanitizeFolderName(title || 'Patient_Summary');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = tenantId
    ? `/Tenants/${sanitizeFolderName(tenantId)}/PatientSummaries`
    : '/PatientSummaries';
  return `${root}/${patientPart}/${stamp}_${titlePart}`;
}

async function ncCreatePatientPackageRoot(tenantId) {
  if (!tenantId) {
    await ncCreateFolder('/PatientSummaries');
    return;
  }
  const tenantRoot = `/Tenants/${sanitizeFolderName(tenantId)}`;
  await ncCreateFolder('/Tenants');
  await ncCreateFolder(tenantRoot);
  await ncCreateFolder(`${tenantRoot}/PatientSummaries`);
}

function buildPatientPackageMetadata(body, studies, reports, dicomExportedByStudy) {
  const soapNotes = normalizePatientPackageSoapNotes(body && body.soapNotes);
  const patientIdentifier = getPatientIdentifierFromPayload(body || {});
  return {
    exported_at: nowIso(),
    patient: {
      tenant_id: getPatientPackageTenantId(studies) || null,
      identifier: patientIdentifier || null,
      lookup_url: buildPatientLookupUrl(patientIdentifier),
      name: sanitizeText(body && body.patientName) || null,
      email: sanitizeText(body && body.patientEmail) || null,
    },
    case: {
      title: sanitizeText(body && body.title) || null,
      notes: sanitizeMultilineText(body && body.notes) || null,
      soap_notes: soapNotes,
    },
    studies: studies.map(function (entry) {
      return {
        id: entry.study.id,
        relation: entry.relation,
        order: entry.order,
        patient_name: entry.study.patient_name || null,
        patient_id: entry.study.patient_id || null,
        study_date: entry.study.study_date || null,
        modality: entry.study.modality || null,
        dicom_count: entry.study.dicom_count || 0,
        dicom_exported: dicomExportedByStudy[entry.study.id] || 0,
      };
    }),
    reports: reports.map(function (report) {
      return {
        filename: report.filename,
        source_study_id: report.sourceStudyId || null,
        created_at: report.createdAt || null,
      };
    }),
  };
}

function normalizePatientPackageSoapNotes(input) {
  if (!input || typeof input !== 'object') {
    return {
      subjective: '',
      objective: '',
      assessment: '',
      plan: '',
    };
  }
  const soapNotes = {
    subjective: sanitizeMultilineText(input.subjective) || '',
    objective: sanitizeMultilineText(input.objective) || '',
    assessment: sanitizeMultilineText(input.assessment) || '',
    plan: sanitizeMultilineText(input.plan) || '',
  };
  return soapNotes;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSoapTemplateLogoDataUri() {
  try {
    if (!SOAP_TEMPLATE_LOGO_PATH || !fs.existsSync(SOAP_TEMPLATE_LOGO_PATH)) return '';
    const ext = path.extname(SOAP_TEMPLATE_LOGO_PATH).toLowerCase();
    const mime = ext === '.svg'
      ? 'image/svg+xml'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(SOAP_TEMPLATE_LOGO_PATH).toString('base64')}`;
  } catch (err) {
    log('warn', 'soap.template_logo_load_failed', {
      path: SOAP_TEMPLATE_LOGO_PATH,
      message: sanitizeText(err && err.message) || 'Logo could not be loaded.',
    });
    return '';
  }
}

function makeSoapClinicalNoteText(body, context) {
  const soapNotes = normalizePatientPackageSoapNotes(body && body.soapNotes);
  const patientIdentifier = getPatientIdentifierFromPayload(body || {});
  const formatValue = function (value) {
    return sanitizeMultilineText(value) || 'Not entered';
  };
  return [
    'SOAP Clinical Note',
    '',
    `Patient identifier: ${patientIdentifier || ''}`,
    `Patient lookup: ${buildPatientLookupUrl(patientIdentifier) || ''}`,
    `Patient: ${sanitizeText(body && body.patientName) || ''}`,
    `Patient email: ${sanitizeText(body && body.patientEmail) || ''}`,
    `Case title: ${sanitizeText(body && body.title) || ''}`,
    `Prepared by: ${sanitizeText(context && (context.name || context.email)) || ''}`,
    `Prepared at: ${nowIso()}`,
    '',
    'Subjective',
    formatValue(soapNotes.subjective),
    '',
    'Objective',
    formatValue(soapNotes.objective),
    '',
    'Assessment',
    formatValue(soapNotes.assessment),
    '',
    'Plan',
    formatValue(soapNotes.plan),
    '',
  ].join('\n');
}

function makeSoapClinicalNoteHtml(body, context) {
  const soapNotes = normalizePatientPackageSoapNotes(body && body.soapNotes);
  const patientIdentifier = getPatientIdentifierFromPayload(body || {});
  const preparedAt = nowIso();
  const logoDataUri = getSoapTemplateLogoDataUri();
  const formatValue = function (value) {
    return escapeHtml(sanitizeMultilineText(value) || 'Not entered').replace(/\n/g, '<br>');
  };
  const metaRows = [
    ['Patient identifier', patientIdentifier || ''],
    ['Patient lookup', buildPatientLookupUrl(patientIdentifier) || ''],
    ['Patient', sanitizeText(body && body.patientName) || ''],
    ['Patient email', sanitizeText(body && body.patientEmail) || ''],
    ['Case title', sanitizeText(body && body.title) || ''],
    ['Prepared by', sanitizeText(context && (context.name || context.email)) || ''],
    ['Prepared at', preparedAt],
  ];
  const sections = [
    ['SUBJECTIVE', soapNotes.subjective],
    ['OBJECTIVE', soapNotes.objective],
    ['ASSESSMENT', soapNotes.assessment],
    ['PLAN', soapNotes.plan],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SUBJECTIVE OBJECTIVE ASSESSMENT PLAN - STUDY NOTES</title>
  <style>
    @page { margin: 0.5in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f3f4f6;
      color: #111827;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      line-height: 1.45;
    }
    .page {
      width: 8.5in;
      min-height: 10.95in;
      margin: 24px auto;
      background: #ffffff;
      border: 1px solid #d1d5db;
      padding: 0.48in;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 14px;
    }
    .brand-logo {
      max-width: 2.25in;
      max-height: 0.65in;
      object-fit: contain;
    }
    .brand-name {
      color: #111827;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .brand-meta {
      color: #6b7280;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-align: right;
    }
    .title {
      border: 2px solid #111827;
      padding: 12px 14px;
      text-align: center;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-left: 1px solid #111827;
      border-top: 1px solid #111827;
      margin-top: 16px;
    }
    .meta-row {
      min-height: 34px;
      border-right: 1px solid #111827;
      border-bottom: 1px solid #111827;
      padding: 6px 8px;
    }
    .meta-label,
    .section-title {
      display: block;
      color: #374151;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .meta-value {
      display: block;
      margin-top: 2px;
      white-space: pre-wrap;
    }
    .section {
      margin-top: 14px;
      border: 1px solid #111827;
    }
    .section-title {
      border-bottom: 1px solid #111827;
      background: #f9fafb;
      color: #111827;
      padding: 8px 10px;
    }
    .section-body {
      min-height: 1.35in;
      padding: 10px;
      white-space: normal;
    }
    .footer {
      margin-top: 18px;
      color: #6b7280;
      font-size: 10px;
      text-align: right;
    }
    @media print {
      body { background: #ffffff; }
      .page {
        width: auto;
        min-height: auto;
        margin: 0;
        border: 0;
        padding: 0;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="brand">
      ${
        logoDataUri
          ? `<img class="brand-logo" src="${logoDataUri}" alt="OCTELERAD">`
          : '<div class="brand-name">OCTELERAD</div>'
      }
      <div class="brand-meta">CLINICAL NOTE REPORT</div>
    </header>
    <header class="title">SUBJECTIVE OBJECTIVE ASSESSMENT PLAN - STUDY NOTES</header>
    <section class="meta">
      ${metaRows
        .map(function (row) {
          return `<div class="meta-row"><span class="meta-label">${escapeHtml(row[0])}</span><span class="meta-value">${escapeHtml(row[1])}</span></div>`;
        })
        .join('')}
    </section>
    ${sections
      .map(function (section) {
        return `<section class="section"><span class="section-title">${escapeHtml(section[0])}</span><div class="section-body">${formatValue(section[1])}</div></section>`;
      })
      .join('')}
    <div class="footer">Generated by MAPDR</div>
  </main>
</body>
</html>`;
}

async function renderSoapClinicalNotePdf(html) {
  let playwright;
  try {
    playwright = require(PLAYWRIGHT_MODULE_PATH);
  } catch (err) {
    throw new Error(`Playwright renderer is not available at ${PLAYWRIGHT_MODULE_PATH}: ${err.message}`);
  }

  let browser = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage({
      viewport: { width: 816, height: 1056 },
    });
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: {
        top: '0in',
        right: '0in',
        bottom: '0in',
        left: '0in',
      },
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

function makeSoapNotesSummaryText(input) {
  const soapNotes = normalizePatientPackageSoapNotes(input);
  return [
    'SOAP notes:',
    `Subjective: ${soapNotes.subjective || 'Not entered'}`,
    '',
    `Objective: ${soapNotes.objective || 'Not entered'}`,
    '',
    `Assessment: ${soapNotes.assessment || 'Not entered'}`,
    '',
    `Plan: ${soapNotes.plan || 'Not entered'}`,
    '',
  ];
}

async function exportPatientSummaryToNextcloud(body, context) {
  const configError = requireNextcloudConfig();
  if (configError) {
    throw makeAppError('NEXTCLOUD_NOT_CONFIGURED', 503, configError);
  }

  const stack = normalizePatientPackageStudyStack(body && body.studyStack);
  const reportItems = normalizePatientPackageReportItems(body && body.priorReports);

  if (stack.length === 0 && reportItems.length === 0) {
    throw makeAppError('VALIDATION_ERROR', 400, 'Select at least one study or report to send.');
  }

  const studies = loadStudies();
  const selectedStudies = [];
  for (const item of stack) {
    const study = findStudy(studies, item.studyId);
    if (!study || sanitizeText(study.deleted_at)) {
      throw makeAppError('NOT_FOUND', 404, `Study ${item.studyId} not found.`);
    }
    if (!canAccessStudyRecord(context, study)) {
      throw makeAppError('FORBIDDEN', 403, `You do not have access to study ${item.studyId}.`);
    }
    selectedStudies.push({
      study: study,
      relation: item.relation,
      order: item.order,
    });
  }

  const packagePatientIdentifier = resolvePatientPackageIdentifier(body || {}, selectedStudies);
  assertPatientPackageReportOwnership(studies, reportItems, packagePatientIdentifier, context);
  const packageTenantId = getPatientPackageTenantId(selectedStudies);
  const packageBody = {
    ...(body || {}),
    patient_identifier: packagePatientIdentifier,
    patientIdentifier: packagePatientIdentifier,
    patient_lookup_url: buildPatientLookupUrl(packagePatientIdentifier),
    patientLookupUrl: buildPatientLookupUrl(packagePatientIdentifier),
  };

  const packagePath = getPatientPackageFolder(packageBody, packageTenantId);
  const dicomExportedByStudy = {};

  await ncCreatePatientPackageRoot(packageTenantId);
  const patientRoot = path.dirname(packagePath);
  await ncCreateFolder(patientRoot);
  await ncCreateFolder(packagePath);
  await ncCreateFolder(`${packagePath}/studies`);
  await ncCreateFolder(`${packagePath}/reports`);

  const summaryText = [
    `Patient identifier: ${packagePatientIdentifier}`,
    `Patient lookup: ${buildPatientLookupUrl(packagePatientIdentifier) || ''}`,
    `Patient: ${sanitizeText(body && body.patientName) || ''}`,
    `Patient email: ${sanitizeText(body && body.patientEmail) || ''}`,
    `Case title: ${sanitizeText(body && body.title) || ''}`,
    `Shared by: ${sanitizeText(context && (context.name || context.email)) || ''}`,
    '',
    'Clinical summary:',
    sanitizeMultilineText(body && body.notes) || '',
    '',
    ...makeSoapNotesSummaryText(body && body.soapNotes),
  ].join('\n');
  await ncUploadBuffer(`${packagePath}/patient-summary.txt`, Buffer.from(summaryText, 'utf8'), 'text/plain; charset=utf-8');

  for (let index = 0; index < selectedStudies.length; index += 1) {
    const entry = selectedStudies[index];
    const study = entry.study;
    const studyFolder = `${packagePath}/studies/${String(index + 1).padStart(2, '0')}-${entry.relation}-study-${study.id}`;
    await ncCreateFolder(studyFolder);
    await ncCreateFolder(`${studyFolder}/dicom`);

    const studyText = [
      `Study ID: ${study.id}`,
      `Relation: ${entry.relation}`,
      `Patient: ${sanitizeText(study.patient_name) || ''}`,
      `Patient ID: ${sanitizeText(study.patient_id) || ''}`,
      `Study date: ${sanitizeText(study.study_date) || ''}`,
      `Modality: ${sanitizeText(study.modality) || ''}`,
      `DICOM count: ${Number(study.dicom_count) || 0}`,
      '',
      'Study notes:',
      sanitizeMultilineText(study.notes) || '',
      '',
    ].join('\n');
    await ncUploadBuffer(`${studyFolder}/study-summary.txt`, Buffer.from(studyText, 'utf8'), 'text/plain; charset=utf-8');
    dicomExportedByStudy[study.id] = await exportStudyDicomToNextcloud(study, studyFolder);
  }

  let reportExported = 0;
  const soapClinicalNoteHtml = makeSoapClinicalNoteHtml(packageBody, context);
  try {
    const soapClinicalNotePdf = await renderSoapClinicalNotePdf(soapClinicalNoteHtml);
    await ncUploadBuffer(
      `${packagePath}/reports/soap-clinical-note.pdf`,
      soapClinicalNotePdf,
      'application/pdf'
    );
    reportExported += 1;
  } catch (err) {
    log('warn', 'soap.clinical_note_pdf_render_failed', {
      folder: packagePath,
      message: sanitizeText(err && err.message) || 'PDF render failed.',
    });
  }
  const soapClinicalNoteFilename = 'soap-clinical-note.txt';
  await ncUploadBuffer(
    `${packagePath}/reports/${soapClinicalNoteFilename}`,
    Buffer.from(makeSoapClinicalNoteText(packageBody, context), 'utf8'),
    'text/plain; charset=utf-8'
  );
  reportExported += 1;
  await ncUploadBuffer(
    `${packagePath}/reports/soap-clinical-note.html`,
    Buffer.from(soapClinicalNoteHtml, 'utf8'),
    'text/html; charset=utf-8'
  );
  reportExported += 1;

  for (let index = 0; index < reportItems.length; index += 1) {
    const report = reportItems[index];
    const localPath = resolveMediaAbsolutePathFromUrl(report.url);
    if (!localPath || !fs.existsSync(localPath)) {
      log('warn', 'nextcloud.patient_summary_report_missing', {
        filename: report.filename,
        source_study_id: report.sourceStudyId || null,
      });
      continue;
    }
    const ext = path.extname(report.filename || localPath) || '.pdf';
    const filename = getMediaExportName(
      `report-${String(index + 1).padStart(2, '0')}`,
      report.filename || report.url,
      ext
    );
    await ncUploadFile(`${packagePath}/reports/${filename}`, localPath);
    reportExported += 1;
  }

  await ncUploadBuffer(
    `${packagePath}/metadata.json`,
    Buffer.from(JSON.stringify(buildPatientPackageMetadata(packageBody, selectedStudies, reportItems, dicomExportedByStudy), null, 2), 'utf8'),
    'application/json'
  );

  const shareUrl = await ncCreateShare(packagePath);
  const gristRows = makeGristCompletedCaseRows(selectedStudies, packageBody, shareUrl, packagePath, dicomExportedByStudy);
  await logCompletedCasesToGrist(gristRows);

  log('info', 'nextcloud.patient_summary_export_completed', {
    folder: packagePath,
    study_count: selectedStudies.length,
    report_count: reportExported,
    requested_report_count: reportItems.length,
    requested_by: sanitizeText(context && context.email),
  });

  return {
    ok: true,
    tenant_id: packageTenantId,
    folder: packagePath,
    url: shareUrl,
    study_count: selectedStudies.length,
    report_count: reportExported,
    requested_report_count: reportItems.length,
    dicom_exported: Object.values(dicomExportedByStudy).reduce(function (sum, count) {
      return sum + (Number(count) || 0);
    }, 0),
  };
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

  await ncCreateStudyCaseRoot(study);
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
    'Radiologist notes:',
    sanitizeMultilineText(study.radiologist_notes) || '',
    '',
    'Radiology report:',
    sanitizeMultilineText(study.radiology_report) || '',
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

function getClientIp(req) {
  const forwardedFor = sanitizeText(req && req.headers && req.headers['x-forwarded-for']).split(',')[0].trim();
  return forwardedFor || sanitizeText(req && req.socket && req.socket.remoteAddress) || 'unknown';
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
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count = Number(current.count || 0) + 1;
  return {
    allowed: current.count <= maxAttempts,
    retryAfterSeconds: Math.max(Math.ceil((current.resetAt - now) / 1000), 1),
  };
}

function enforceRateLimit(req, res, scope, subject, maxAttempts, windowMs) {
  const cleanSubject = sanitizeText(subject).toLowerCase() || 'anonymous';
  const result = consumeRateLimit(`${scope}:${getClientIp(req)}:${cleanSubject}`, maxAttempts, windowMs);
  if (result.allowed) return true;
  sendError(
    res,
    429,
    'RATE_LIMITED',
    `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.`,
    { retry_after_seconds: result.retryAfterSeconds }
  );
  return false;
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

function getStorageStatus() {
  if (typeof fs.statfsSync !== 'function') {
    return {
      ok: false,
      available: false,
      path: STORAGE_MONITOR_PATH,
      warning_threshold_used_percent: STORAGE_WARNING_USED_PERCENT,
      warning: false,
      message: 'Filesystem usage is not available in this Node runtime.',
    };
  }

  const stats = fs.statfsSync(STORAGE_MONITOR_PATH);
  const blockSize = Number(stats.bsize || stats.frsize || 0);
  const totalBlocks = Number(stats.blocks || 0);
  const freeBlocks = Number(stats.bfree || 0);
  const availableBlocks = Number(stats.bavail || stats.bfree || 0);
  const total_bytes = totalBlocks * blockSize;
  const free_bytes = freeBlocks * blockSize;
  const available_bytes = availableBlocks * blockSize;
  const used_bytes = Math.max(total_bytes - free_bytes, 0);
  const used_percent = total_bytes > 0 ? (used_bytes / total_bytes) * 100 : 0;
  const used_percent_rounded = Math.round(used_percent * 10) / 10;

  return {
    ok: true,
    available: true,
    path: STORAGE_MONITOR_PATH,
    total_bytes: total_bytes,
    used_bytes: used_bytes,
    free_bytes: free_bytes,
    available_bytes: available_bytes,
    used_percent: used_percent_rounded,
    warning_threshold_used_percent: STORAGE_WARNING_USED_PERCENT,
    warning: used_percent_rounded >= STORAGE_WARNING_USED_PERCENT,
    warning_message:
      used_percent_rounded >= STORAGE_WARNING_USED_PERCENT ? 'Export cases to keep the main case disk from filling.' : '',
  };
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

app.get('/api/storage', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  try {
    return res.json(getStorageStatus());
  } catch (err) {
    log('warn', 'storage.status_failed', {
      path: STORAGE_MONITOR_PATH,
      message: err && err.message ? err.message : String(err),
    });
    return sendError(res, 500, 'STORAGE_STATUS_FAILED', 'Failed to read disk usage.');
  }
});

app.get('/api/auth/2fa/status', function (req, res) {
  const context = requireStudyRole(req, res, []);
  if (!context) return;

  try {
    const authStore = getAuthStoreUserForContext(context);
    return res.json({
      ok: true,
      two_factor: getTwoFactorStatusForUser(authStore.user),
    });
  } catch (err) {
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_STATUS_FAILED', err.message, err.details);
  }
});

app.post('/api/auth/2fa/setup/start', asyncHandler(async function (req, res) {
  const context = requireStudyRole(req, res, []);
  if (!context) return;

  try {
    requireTwoFactorEmailProviderReady();
    const authStore = getAuthStoreUserForContext(context);
    if (!enforceRateLimit(req, res, 'api.2fa.setup.send', authStore.user.email, TWO_FACTOR_SEND_RATE_LIMIT_MAX, TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    const pending = createTwoFactorChallenge(authStore.user, 'setup');
    writeAuthStore(authStore.store);
    await sendTwoFactorEmail(pending.challenge.email, pending.code, 'setup');
    return res.status(202).json({
      ok: true,
      challenge_id: pending.challenge.id,
      expires_at: pending.challenge.expires_at,
      method: pending.challenge.method,
      email: pending.challenge.email,
    });
  } catch (err) {
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_SETUP_START_FAILED', err.message, err.details);
  }
}));

app.post('/api/auth/2fa/setup/verify', function (req, res) {
  const context = requireStudyRole(req, res, []);
  if (!context) return;
  let authStore = null;

  try {
    requireTwoFactorFrameworkReady();
    const challengeId = sanitizeText(req.body && req.body.challenge_id);
    const code = sanitizeText(req.body && req.body.code).replace(/\s+/g, '');
    if (!challengeId || !code) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'challenge_id and code are required.');
    }
    if (!enforceRateLimit(req, res, 'api.2fa.setup.verify', `${context.email}:${challengeId}`, TWO_FACTOR_VERIFY_RATE_LIMIT_MAX, TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    authStore = getAuthStoreUserForContext(context);
    const challenge = verifyTwoFactorChallenge(authStore.user, challengeId, code, 'setup');
    authStore.user.twoFactor = {
      ...normalizeTwoFactorSettings(authStore.user.twoFactor),
      enabled: true,
      verified_at: nowIso(),
      method: 'email',
      email: sanitizeText(challenge.email).toLowerCase(),
      disabled_at: null,
    };
    writeAuthStore(authStore.store);
    appendTenantAuditEvent('auth.2fa.enabled', {
      actor_email: context.email,
      actor_role: context.role,
      action: 'enable_2fa',
      details: { method: 'email' },
    });
    return res.json({
      ok: true,
      two_factor: getTwoFactorStatusForUser(authStore.user),
    });
  } catch (err) {
    try {
      if (authStore && (err && (err.code === 'TWO_FACTOR_CODE_INVALID' || err.code === 'TWO_FACTOR_TOO_MANY_ATTEMPTS'))) {
        writeAuthStore(authStore.store);
      }
    } catch (_) {}
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_SETUP_VERIFY_FAILED', err.message, err.details);
  }
});

app.post('/api/auth/2fa/disable/start', asyncHandler(async function (req, res) {
  const context = requireStudyRole(req, res, []);
  if (!context) return;

  try {
    requireTwoFactorEmailProviderReady();
    const authStore = getAuthStoreUserForContext(context);
    if (!enforceRateLimit(req, res, 'api.2fa.disable.send', authStore.user.email, TWO_FACTOR_SEND_RATE_LIMIT_MAX, TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    const settings = normalizeTwoFactorSettings(authStore.user.twoFactor || authStore.user.two_factor);
    if (!settings.enabled) {
      return sendError(res, 409, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled for this user.');
    }
    const pending = createTwoFactorChallenge(authStore.user, 'disable');
    writeAuthStore(authStore.store);
    await sendTwoFactorEmail(pending.challenge.email, pending.code, 'disable');
    return res.status(202).json({
      ok: true,
      challenge_id: pending.challenge.id,
      expires_at: pending.challenge.expires_at,
      method: pending.challenge.method,
      email: pending.challenge.email,
    });
  } catch (err) {
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_DISABLE_START_FAILED', err.message, err.details);
  }
}));

app.post('/api/auth/2fa/disable', function (req, res) {
  const context = requireStudyRole(req, res, []);
  if (!context) return;
  let authStore = null;

  try {
    requireTwoFactorFrameworkReady();
    const challengeId = sanitizeText(req.body && req.body.challenge_id);
    const code = sanitizeText(req.body && req.body.code).replace(/\s+/g, '');
    if (!challengeId || !code) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'challenge_id and code are required.');
    }
    if (!enforceRateLimit(req, res, 'api.2fa.disable.verify', `${context.email}:${challengeId}`, TWO_FACTOR_VERIFY_RATE_LIMIT_MAX, TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    authStore = getAuthStoreUserForContext(context);
    verifyTwoFactorChallenge(authStore.user, challengeId, code, 'disable');
    authStore.user.twoFactor = {
      ...normalizeTwoFactorSettings(authStore.user.twoFactor),
      enabled: false,
      disabled_at: nowIso(),
    };
    writeAuthStore(authStore.store);
    appendTenantAuditEvent('auth.2fa.disabled', {
      actor_email: context.email,
      actor_role: context.role,
      action: 'disable_2fa',
      details: { method: 'email' },
    });
    return res.json({
      ok: true,
      two_factor: getTwoFactorStatusForUser(authStore.user),
    });
  } catch (err) {
    try {
      if (authStore && (err && (err.code === 'TWO_FACTOR_CODE_INVALID' || err.code === 'TWO_FACTOR_TOO_MANY_ATTEMPTS'))) {
        writeAuthStore(authStore.store);
      }
    } catch (_) {}
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_DISABLE_FAILED', err.message, err.details);
  }
});

app.post('/api/auth/2fa/challenge/start', asyncHandler(async function (req, res) {
  try {
    requireTwoFactorEmailProviderReady();
    const email = sanitizeText(req.body && req.body.email).toLowerCase();
    if (!email) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'email is required.');
    }
    if (!enforceRateLimit(req, res, 'api.2fa.login.send', email, TWO_FACTOR_SEND_RATE_LIMIT_MAX, TWO_FACTOR_SEND_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    const store = readAuthStoreForUpdate();
    const user = findAuthStoreUser(store, email);
    const settings = normalizeTwoFactorSettings(user && (user.twoFactor || user.two_factor));
    if (!user || sanitizeText(user.status) !== 'active' || !settings.enabled) {
      return res.status(202).json({
        ok: true,
        challenge_required: false,
      });
    }
    const pending = createTwoFactorChallenge(user, 'login');
    writeAuthStore(store);
    await sendTwoFactorEmail(pending.challenge.email, pending.code, 'login');
    return res.status(202).json({
      ok: true,
      challenge_required: true,
      challenge_id: pending.challenge.id,
      expires_at: pending.challenge.expires_at,
      method: pending.challenge.method,
      email: pending.challenge.email,
    });
  } catch (err) {
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_CHALLENGE_START_FAILED', err.message, err.details);
  }
}));

app.post('/api/auth/2fa/challenge/verify', function (req, res) {
  let store = null;
  try {
    requireTwoFactorFrameworkReady();
    const email = sanitizeText(req.body && req.body.email).toLowerCase();
    const challengeId = sanitizeText(req.body && req.body.challenge_id);
    const code = sanitizeText(req.body && req.body.code).replace(/\s+/g, '');
    if (!email || !challengeId || !code) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'email, challenge_id, and code are required.');
    }
    if (!enforceRateLimit(req, res, 'api.2fa.login.verify', `${email}:${challengeId}`, TWO_FACTOR_VERIFY_RATE_LIMIT_MAX, TWO_FACTOR_VERIFY_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    store = readAuthStoreForUpdate();
    const user = findAuthStoreUser(store, email);
    if (!user || sanitizeText(user.status) !== 'active') {
      return sendError(res, 404, 'TWO_FACTOR_CHALLENGE_NOT_FOUND', 'Two-factor challenge was not found or has expired.');
    }
    verifyTwoFactorChallenge(user, challengeId, code, 'login');
    const verification = issueTwoFactorVerificationToken(user, 'login');
    writeAuthStore(store);
    return res.json({
      ok: true,
      verified: true,
      verification_id: verification.id,
      verification_token: verification.token,
      expires_at: verification.expires_at,
    });
  } catch (err) {
    try {
      if (store && (err && (err.code === 'TWO_FACTOR_CODE_INVALID' || err.code === 'TWO_FACTOR_TOO_MANY_ATTEMPTS'))) {
        writeAuthStore(store);
      }
    } catch (_) {}
    return sendError(res, err.status || 500, err.code || 'TWO_FACTOR_CHALLENGE_VERIFY_FAILED', err.message, err.details);
  }
});

app.get('/api/tenant-governance/studies', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const recordings = loadCaseRecordings();
  const orthancStorageCache = loadOrthancStorageCache();
  const studies = filterStudiesForContext(loadStudies(), context)
    .filter(function (study) {
      return !sanitizeText(study && study.deleted_at);
    })
    .map(function (study) {
      const retention = getStudyRetentionConfig(study);
      const localMediaBytes = getStudyLocalStorageBytes(study, recordings);
      const orthancStorage = getStudyOrthancStorageStats(study, orthancStorageCache);
      return {
        id: Number(study.id),
        tenant_id: getStudyTenantId(study) || null,
        patient_name: sanitizeText(study.patient_name) || null,
        patient_id: normalizePatientIdentifier(study.patient_id) || null,
        modality: sanitizeText(study.modality) || null,
        study_date: sanitizeText(study.study_date) || null,
        created_at: sanitizeText(study.created_at) || null,
        nextcloud_url: sanitizeText(study.nextcloud_url) || null,
        nextcloud_export_status: sanitizeText(study.nextcloud_export_status) || null,
        local_media_bytes: localMediaBytes,
        orthanc_storage_bytes: orthancStorage.disk_size_bytes,
        orthanc_uncompressed_bytes: orthancStorage.uncompressed_size_bytes,
        orthanc_storage_status: orthancStorage.status,
        orthanc_storage_refreshed_at: orthancStorage.refreshed_at,
        total_storage_bytes: localMediaBytes + orthancStorage.disk_size_bytes,
        plan_id: retention.plan_id,
        hosted_by_octelerad: retention.hostedByOctelerad,
        requires_customer_download: retention.requiresCustomerDownload,
        customer_download_required_by: retention.purgeAfter,
      };
    })
    .sort(function (left, right) {
      return new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime();
    });

  return res.json({
    ok: true,
    count: studies.length,
    studies: studies,
  });
});

app.get('/api/tenant-governance/tenants', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const tenants = makeTenantGovernanceSummaries(context);
  return res.json({
    ok: true,
    count: tenants.length,
    tenants: tenants,
  });
});

app.post('/api/tenant-governance/orthanc-storage/refresh', asyncHandler(async function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'governance', 'Your account cannot refresh tenant storage accounting.')) return;

  const tenantId = normalizeTenantId(req.body && req.body.tenant_id);
  let studies = filterStudiesForContext(loadStudies(), context).filter(function (study) {
    return !sanitizeText(study && study.deleted_at);
  });
  if (tenantId) {
    studies = studies.filter(function (study) {
      return getStudyTenantId(study) === tenantId;
    });
  }

  const result = await refreshOrthancStorageForStudies(studies, context);
  appendTenantAuditEvent('tenant.orthanc_storage_refreshed', {
    tenant_id: tenantId || null,
    actor_email: context.email,
    actor_role: context.role,
    action: 'refresh_orthanc_storage',
    details: result,
  });

  return res.json({
    ok: true,
    ...result,
  });
}));

app.get('/api/tenant-governance/audit', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const tenantFilter = normalizeTenantId(req.query && req.query.tenant_id);
  const allowedTenantIds = normalizeTenantIdList(context.white_label_account_ids);
  const events = readTenantAuditEvents(req.query && req.query.limit)
    .filter(function (event) {
      const eventTenantId = normalizeTenantId(event && event.tenant_id);
      if (tenantFilter && eventTenantId !== tenantFilter) return false;
      if (isGlobalStudyOperator(context)) return true;
      if (!eventTenantId) return false;
      return allowedTenantIds.includes(eventTenantId);
    });

  return res.json({
    ok: true,
    count: events.length,
    events: events,
  });
});

app.post('/api/tenant-governance/studies/:id/retention', asyncHandler(async function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'governance', 'Your account cannot change tenant retention controls.')) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);
  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
  }

  const action = sanitizeText(req.body && req.body.action).toLowerCase();
  if (action === 'mark_downloaded') {
    study.customer_downloaded_at = nowIso();
    study.customer_downloaded_by_email = sanitizeText(context.email).toLowerCase() || null;
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    appendTenantAuditEvent('study.customer_downloaded', {
      tenant_id: getStudyTenantId(study),
      study_id: study.id,
      actor_email: context.email,
      actor_role: context.role,
      action: 'mark_customer_downloaded',
    });
    return res.json({ ok: true, study: study, retention: getStudyRetentionConfig(study) });
  }

  if (action === 'extend_deadline') {
    const days = Math.min(Math.max(Number(req.body && req.body.days) || 1, 1), 90);
    const currentDeadline = sanitizeText(study.customer_download_required_by) || getStudyRetentionConfig(study).purgeAfter;
    const baseMs = Math.max(Date.now(), new Date(currentDeadline || 0).getTime() || 0);
    study.customer_download_required_by = new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
    study.retention_extension_reason = sanitizeMultilineText(req.body && req.body.reason) || null;
    study.retention_extended_by_email = sanitizeText(context.email).toLowerCase() || null;
    study.retention_extended_at = nowIso();
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    appendTenantAuditEvent('study.retention_extended', {
      tenant_id: getStudyTenantId(study),
      study_id: study.id,
      actor_email: context.email,
      actor_role: context.role,
      action: 'extend_retention_deadline',
      details: {
        days: days,
        customer_download_required_by: study.customer_download_required_by,
        reason: study.retention_extension_reason,
      },
    });
    return res.json({ ok: true, study: study, retention: getStudyRetentionConfig(study) });
  }

  return sendError(res, 400, 'VALIDATION_ERROR', 'action must be mark_downloaded or extend_deadline.');
}));

app.get('/api/revenue/adjustments', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const entries = loadRevenueAdjustments().sort(function (left, right) {
    return new Date(right.date || 0).getTime() - new Date(left.date || 0).getTime();
  });
  return res.json({ ok: true, adjustments: entries });
});

app.post('/api/revenue/adjustments', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const date = sanitizeText(req.body && req.body.date);
  const amount = Number(req.body && req.body.amount);
  const label = sanitizeText(req.body && req.body.label) || 'Manual revenue';
  const clientName = sanitizeText(req.body && req.body.client_name) || null;
  const subclient = sanitizeText(req.body && req.body.subclient) || null;
  const notes = sanitizeMultilineText(req.body && req.body.notes, 2000) || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Revenue date must be YYYY-MM-DD.');
  }
  if (!Number.isFinite(amount)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Revenue amount must be a number.');
  }

  const now = nowIso();
  const entries = loadRevenueAdjustments();
  const entry = {
    id: crypto.randomUUID(),
    date: date,
    amount: Number(amount.toFixed(2)),
    label: label,
    client_name: clientName,
    subclient: subclient,
    notes: notes,
    created_by_email: sanitizeText(context.email) || null,
    created_by_name: sanitizeText(context.name) || null,
    created_at: now,
    updated_at: now,
  };
  entries.push(entry);
  saveRevenueAdjustments(entries);
  return res.status(201).json({ ok: true, adjustment: entry });
});

app.delete('/api/revenue/adjustments/:id', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  const id = sanitizeText(req.params.id);
  const entries = loadRevenueAdjustments();
  const nextEntries = entries.filter(function (entry) {
    return sanitizeText(entry.id) !== id;
  });
  if (nextEntries.length === entries.length) {
    return sendError(res, 404, 'NOT_FOUND', 'Revenue adjustment not found.');
  }
  saveRevenueAdjustments(nextEntries);
  return res.json({ ok: true });
});

app.post('/api/form-submissions', function (req, res) {
  if (!validateFormSubmissionApiKey(req)) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Valid form submission API key required.');
  }

  try {
    const entries = loadFormSubmissions();
    const idempotencyKey = sanitizeText(req.headers['idempotency-key']).slice(0, 255);
    if (idempotencyKey) {
      const existing = entries.find(function (entry) {
        return sanitizeText(entry.idempotency_key) === idempotencyKey;
      });
      if (existing) {
        return res.status(200).json({
          ok: true,
          submission: existing,
          idempotent: true,
        });
      }
    }
    const record = makeFormSubmissionRecord(req);
    record.idempotency_key = idempotencyKey || null;
    entries.push(record);
    saveFormSubmissions(entries);
    log('info', 'form_submission.created', {
      id: record.id,
      type: record.type,
      source: record.source,
      form_name: record.form_name,
      requestId: req.requestId,
    });
    return res.status(201).json({ ok: true, submission: record });
  } catch (err) {
    return sendError(res, 500, 'FORM_SUBMISSION_CREATE_FAILED', 'Failed to save form submission.', err.message);
  }
});

app.get('/api/form-submissions', function (req, res) {
  const context = requireStudyRole(req, res, ['admin']);
  if (!context) return;

  const type = sanitizeText(req.query && req.query.type).toLowerCase();
  const query = sanitizeText(req.query && req.query.q).toLowerCase();
  const limit = Math.min(Math.max(Number(req.query && req.query.limit) || 250, 1), 1000);
  const entries = loadFormSubmissions();
  const studies = loadStudies();
  const filtered = entries.filter(function (entry) {
    if (type && type !== 'all' && sanitizeText(entry.type).toLowerCase() !== type) return false;
    if (query && !sanitizeText(entry.search_index).toLowerCase().includes(query)) return false;
    return true;
  });

  return res.json({
    ok: true,
    total: entries.length,
    count: filtered.length,
    submissions: filtered.slice(0, limit).map(function (entry) {
      return enrichFormSubmissionForResponse(entry, studies);
    }),
  });
});

app.post('/api/form-submissions/sync', asyncHandler(async function (req, res) {
  const context = requireStudyRole(req, res, ['admin']);
  if (!context) return;

  try {
    const result = await pullAllFormSubmissionsFromSource();
    log('info', 'form_submissions.synced', {
      ...result,
      requestId: req.requestId,
      actor: context.email,
    });
    return res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return sendError(
      res,
      502,
      'FORM_SUBMISSION_SYNC_FAILED',
      'Failed to sync form submissions from the source site.',
      err.message
    );
  }
}));

app.get('/api/upcoming-patients', asyncHandler(async function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  let syncResult = null;
  if (parseBooleanFlag(req.query && req.query.sync)) {
    if (context.role !== 'admin') {
      return sendError(res, 403, 'FORBIDDEN', 'Only admins can sync form submissions from the source server.');
    }
    syncResult = await pullAllFormSubmissionsFromSource();
  }

  const upcomingPatients = listUpcomingPatientRecords({
    limit: req.query && req.query.limit,
    query: req.query && req.query.q,
  });

  return res.json({
    ok: true,
    count: upcomingPatients.length,
    upcoming_patients: upcomingPatients,
    sync: syncResult,
  });
}));

app.get('/api/patients/:patientIdentifier/profile', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic', 'patient']);
  if (!context) return;

  const patientIdentifier = normalizePatientIdentifier(req.params.patientIdentifier);
  if (!patientIdentifier) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Patient identifier is required.');
  }
  if (
    context.role === 'patient' &&
    normalizePatientIdentifier(context.patient_identifier) !== patientIdentifier
  ) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this patient profile.');
  }

  const studies = loadStudies()
    .filter(function (study) {
      return (
        !sanitizeText(study && study.deleted_at) &&
        canAccessStudyRecord(context, study) &&
        normalizePatientIdentifier(study && study.patient_id) === patientIdentifier
      );
    })
    .sort(function (left, right) {
      return new Date(right.study_date || right.created_at || 0).getTime() -
        new Date(left.study_date || left.created_at || 0).getTime();
    });

  const reports = [];
  studies.forEach(function (study) {
    if (sanitizeText(study.pdf_url)) {
      reports.push({
        id: `study-${study.id}-pdf`,
        study_id: Number(study.id),
        title: 'Study report',
        report_type: 'pdf',
        report_url: study.pdf_url,
        created_at: study.updated_at || study.created_at || null,
      });
    }
    normalizeCaseReports(study).forEach(function (report) {
      reports.push({
        ...report,
        study_id: Number(study.id),
      });
    });
  });

  const profileStudy = studies.find(function (study) {
    return sanitizeText(study.patient_name) || sanitizeText(study.patient_dob);
  }) || null;

  return res.json({
    ok: true,
    patient: {
      identifier: patientIdentifier,
      lookup_url: buildPatientLookupUrl(patientIdentifier),
      name: sanitizeText(profileStudy && profileStudy.patient_name) || null,
      dob: sanitizeText(profileStudy && profileStudy.patient_dob) || null,
    },
    study_count: studies.length,
    report_count: reports.length,
    studies: studies,
    reports: reports,
  });
});

app.get('/api/acronyms', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const query = normalizeAcronymCode(req.query && req.query.q);
  const entries = loadAcronymDatabase();
  const matches = query
    ? entries.filter(function (entry) {
        return entry.code.includes(query) || (entry.aliases || []).some(function (alias) {
          return alias.includes(query);
        });
      })
    : entries;

  return res.json({
    ok: true,
    count: entries.length,
    results: matches.slice(0, 25),
  });
});

app.get('/api/acronyms/:code', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;

  const entry = findAcronymEntry(req.params.code);
  if (!entry) {
    return sendError(res, 404, 'ACRONYM_NOT_FOUND', 'Acronym not found.');
  }
  return res.json({
    ok: true,
    acronym: entry,
  });
});

app.post(
  '/api/acronyms/sync',
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin']);
    if (!context) return;

    const rawTableIds = req.body && Object.prototype.hasOwnProperty.call(req.body, 'table_ids')
      ? req.body.table_ids
      : '';
    const tableIds = parseCsv(rawTableIds).map(function (tableId) {
      return tableId.replace(/[^A-Za-z0-9_]/g, '_');
    });
    const result = await syncAcronymDatabaseFromGrist({
      baseUrl: sanitizeText(req.body && req.body.base_url),
      docId: sanitizeText(req.body && req.body.doc_id) || GRIST_ACRONYM_DOC_ID,
      tableIds: tableIds,
      username: sanitizeText(req.body && req.body.proxy_username),
      password: req.body && Object.prototype.hasOwnProperty.call(req.body, 'proxy_password')
        ? String(req.body.proxy_password || '')
        : '',
    });
    log('info', 'acronym.database_synced', {
      doc_id: result.doc_id,
      table_count: result.table_count,
      acronym_count: result.acronym_count,
      requested_by: sanitizeText(context.email),
    });
    return res.json(result);
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
  if (!requireWhiteLabelAction(context, res, 'upload', 'Your account cannot create studies.')) return;
  try {
    const validationError = validateStudyPayload(req.body || {});
    if (validationError) {
      return sendError(res, 400, 'VALIDATION_ERROR', validationError);
    }

    const studies = loadStudies();
    const study = makeStudyRecord(studies, req.body || {}, context);

    studies.push(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    publishStudyRealtimeEvent(study, 'study.created', {
      event: 'study.created',
      source: 'create',
    });
    appendTenantAuditEvent('study.created', {
      tenant_id: getStudyTenantId(study),
      study_id: study.id,
      actor_email: context.email,
      actor_role: context.role,
      action: 'create_study',
      details: getStudyRetentionConfig(study),
    });

    return res.json(study);
  } catch (err) {
    return sendError(res, 500, 'STUDY_CREATE_FAILED', 'Failed to create study.', err.message);
  }
});

app.post(
  '/api/dicom/preconvert-jpeg2000',
  uploadDicomPreconvert.array('dicom_files'),
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) {
      cleanupUploadedFiles(req.files);
      return;
    }
    if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot attach DICOM files to studies.')) {
      cleanupUploadedFiles(req.files);
      return;
    }

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
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) {
      cleanupUploadedFiles(req.files);
      return;
    }

    const receiveMs = Date.now() - (req.startedAt || Date.now());
    const convertJpeg2000ToDcm = parseBooleanFlag(req.body && req.body.convert_jpeg2000_to_dcm);
    const redactTextOnUpload = parseOptionalBooleanFlag(req.body && req.body.redact_text_on_upload);
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (!canAccessStudyRecord(context, study)) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
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
      publishStudyRealtimeEvent(study, 'study.updated', {
        event: 'study.updated',
        source: 'dicom_upload',
        orthanc_patient_id: study.orthanc_patient_id,
        orthanc_study_id: study.orthanc_study_id,
        dicom_count: study.dicom_count,
      });
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
      publishStudyRealtimeEvent(study, 'study.updated', {
        event: 'study.updated',
        source: 'dicom_upload_failed',
        status: study.status,
      });

      return sendError(res, 502, 'ORTHANC_UPLOAD_FAILED', 'Failed to upload DICOM files to Orthanc.', extractAxiosError(err));
    }
  })
);

app.post('/api/studies/:id/mp4', uploadMp4.single('mp4_file'), function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) {
    cleanUploadedFile(req.file);
    return;
  }
  if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot attach videos to studies.')) {
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

  if (!req.file) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No MP4 file uploaded.');
  }

  try {
    const job = enqueueUploadedVideoProcessing(study, req.file, 'mp4_upload');
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    publishStudyRealtimeEvent(study, 'study.updated', {
      event: 'study.updated',
      source: 'mp4_upload',
      status: study.status,
      video_processing_status: study.video_processing_status,
    });

    return res.status(202).json({
      ok: true,
      success: true,
      processing: true,
      job_id: job.id,
      study: study,
    });
  } catch (err) {
    cleanUploadedFile(req.file);
    return sendError(res, 500, 'MP4_UPLOAD_FAILED', 'Failed to process MP4 upload.', err.message);
  }
});

app.post('/api/studies/:id/pdf', uploadPdf.single('pdf_file'), function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) {
    cleanUploadedFile(req.file);
    return;
  }
  if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot attach report PDFs to studies.')) {
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

  if (!req.file) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No PDF file uploaded.');
  }

  try {
    deleteLocalMediaFile(study.pdf_url);
    const moved = moveSingleUploadedFile(req.file, `study-${study.id}-report`, '.pdf');
    study.pdf_url = moved.url;
    touchStudy(study);
    saveStudies(studies);
    publishStudyRealtimeEvent(study, 'study.updated', {
      event: 'study.updated',
      source: 'pdf_upload',
      pdf_url: study.pdf_url,
    });
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
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) {
      cleanupUploadedFiles(req.files);
      return;
    }
    if (!requireWhiteLabelAction(context, res, 'upload', 'Your account cannot upload studies.')) {
      cleanupUploadedFiles(req.files);
      return;
    }
    const receiveMs = Date.now() - (req.startedAt || Date.now());
    const convertJpeg2000ToDcm = parseBooleanFlag(req.body && req.body.convert_jpeg2000_to_dcm);
    const redactTextOnUpload = parseOptionalBooleanFlag(req.body && req.body.redact_text_on_upload);
    const validationError = validateStudyPayload(req.body || {});
    if (validationError) {
      cleanupUploadedFiles(req.files);
      return sendError(res, 400, 'VALIDATION_ERROR', validationError);
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

    const studies = loadStudies();
    const study = makeStudyRecord(studies, req.body || {}, context);
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
      publishStudyRealtimeEvent(study, 'study.created', {
        event: 'study.created',
        source: 'dicom_upload_legacy',
      });
      appendTenantAuditEvent('study.created', {
        tenant_id: getStudyTenantId(study),
        study_id: study.id,
        actor_email: context.email,
        actor_role: context.role,
        action: 'create_study_legacy_dicom_upload',
        details: {
          ...getStudyRetentionConfig(study),
          dicom_count: study.dicom_count,
        },
      });
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
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) {
    cleanUploadedFile(req.file);
    return;
  }
  if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot attach videos to studies.')) {
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

  if (!req.file) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No MP4 file uploaded.');
  }

  try {
    const job = enqueueUploadedVideoProcessing(study, req.file, 'mp4_upload_legacy');
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    publishStudyRealtimeEvent(study, 'study.updated', {
      event: 'study.updated',
      source: 'mp4_upload_legacy',
      status: study.status,
      video_processing_status: study.video_processing_status,
    });

    return res.status(202).json({
      ok: true,
      processing: true,
      job_id: job.id,
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
  const studies = loadStudies();
  sessions = sessions.filter(function (session) {
    const study = findStudy(studies, session && session.study_id);
    return study ? canAccessStudyRecord(context, study) : isGlobalStudyOperator(context);
  });
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
    if (!canAccessStudyRecord(context, study)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
    }
  } else {
    study = makeStudyRecord(studies, req.body || {}, context);
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
  publishStudyRealtimeEvent(study, 'study.live.updated', {
    event: 'study.live.updated',
    source: 'live_start',
    live_streaming: true,
    live_session: session,
  });

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
  publishStudyRealtimeEvent(findStudy(loadStudies(), session.study_id), 'study.live.updated', {
    event: 'study.live.updated',
    source: 'live_stop',
    live_streaming: false,
    live_session: session,
  });

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
    if (!context) {
      cleanUploadedFile(req.file);
      return;
    }
    if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot upload live recordings.')) {
      cleanUploadedFile(req.file);
      return;
    }
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
        await normalizeWebmRecordingTimestamps(stagedSourcePath);
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
      await normalizeWebmRecordingTimestamps(req.file.path);
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

      deleteStudyVideoDerivativeFiles(study);
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
      publishStudyRealtimeEvent(study, 'study.recording_finalized', {
        event: 'study.recording_finalized',
        source: 'live_recording_upload',
        mp4_url: study.mp4_url,
        live_session: session,
      });
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
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic', 'patient']);
  if (!context) return;

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

  studies = filterStudiesForContext(studies, context);

  if (search) {
    studies = studies.filter(function (s) {
      return [s.patient_name, s.patient_id, s.modality, s.notes, s.tech_notes, s.radiologist_notes, s.radiology_report]
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
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic', 'patient']);
  if (!context) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
  }

  const priorIds = Array.isArray(study.prior_study_ids) ? study.prior_study_ids : [];
  const priorStudies = priorIds
    .map(function (priorId) {
      return findStudy(studies, priorId);
    })
    .filter(function (priorStudy) {
      return priorStudy && canAccessStudyRecord(context, priorStudy);
    });

  return res.json({
    study_id: study.id,
    prior_study_ids: priorIds,
    priors: priorStudies,
  });
});

app.put('/api/studies/:id/priors', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot edit study priors.')) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
  }
  assertStudyVersion(study, req.body || {});

  const priorStudyIds = parsePriorStudyIds(req.body && req.body.prior_study_ids, study.id);
  const missingId = priorStudyIds.find(function (priorId) {
    return !findStudy(studies, priorId);
  });

  if (missingId) {
    return sendError(res, 400, 'VALIDATION_ERROR', `Prior study ${missingId} does not exist.`);
  }

  const mismatchedPrior = priorStudyIds.find(function (priorId) {
    const priorStudy = findStudy(studies, priorId);
    return priorStudy && (!canAccessStudyRecord(context, priorStudy) || getStudyTenantId(study) !== getStudyTenantId(priorStudy) || !isSamePatientStudy(study, priorStudy));
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
  publishStudyRealtimeEvent(study, 'study.updated', {
    event: 'study.updated',
    source: 'priors_update',
    prior_study_ids: study.prior_study_ids,
  });

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
  assertStudyVersion(study, req.body || {});

  study.tech_notes = sanitizeMultilineText(req.body && req.body.tech_notes) || null;
  touchStudy(study);
  saveStudies(studies);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
  }
  publishStudyRealtimeEvent(study, 'study.updated', {
    event: 'study.updated',
    source: 'tech_notes_update',
    tech_notes: study.tech_notes,
  });
  scheduleNextcloudExport(study.id, 'tech_notes_update');

  return res.json({
    ok: true,
    study: study,
  });
});

app.get(
  '/api/studies/:id',
  asyncHandler(async function (req, res, next) {
    if (sanitizeText(req.params.id).toLowerCase() === 'stream') {
      return next();
    }
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic', 'patient']);
    if (!context) return;

    const includeDeleted = parseBooleanFlag(req.query && req.query.include_deleted);
    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (sanitizeText(study.deleted_at) && !includeDeleted) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (!canAccessStudyRecord(context, study)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
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

app.get(
  '/api/studies/stream',
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) return;

    const studyIdFilterRaw = sanitizeText(req.query.study_id);
    const studyIdFilter = Number(studyIdFilterRaw);
    if (studyIdFilterRaw && (!Number.isFinite(studyIdFilter) || studyIdFilter <= 0)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'study_id must be a positive number.');
    }

    const studies = loadStudies();
    if (Number.isFinite(studyIdFilter) && studyIdFilter > 0) {
      const study = findStudy(studies, studyIdFilter);
      if (!study) {
        return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
      }
      if (!canAccessStudyRecord(context, study)) {
        return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
      }
    }

    const client = {
      res: res,
      studyId: Number.isFinite(studyIdFilter) && studyIdFilter > 0 ? studyIdFilter : null,
      clientId: sanitizeText(req.query.client_id) || crypto.randomUUID(),
      closed: false,
      userEmail: sanitizeText(context.email) || null,
      userName: sanitizeText(context.name) || null,
      userRole: sanitizeText(context.role) || null,
    };

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    registerStudyRealtimeClient(client);
    sendStudyRealtimeEvent(client, 'connected', {
      event: 'connected',
      study_id: client.studyId || null,
      client_id: client.clientId,
      server_time: nowIso(),
      scope: client.studyId ? 'study' : 'all',
      snapshot: client.studyId ? makeStudyRealtimeSnapshot(findStudy(studies, client.studyId), { scope: 'study' }) : {
        event: 'connected',
        scope: 'all',
        server_time: nowIso(),
      },
    });

    const keepAliveTimer = setInterval(function () {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch (err) {
        unregisterStudyRealtimeClient(client);
        clearInterval(keepAliveTimer);
      }
    }, STUDY_REALTIME_HEARTBEAT_MS);
    keepAliveTimer.unref?.();

    req.on('close', function () {
      clearInterval(keepAliveTimer);
      unregisterStudyRealtimeClient(client);
      if (client.studyId) {
        removeStudyPresence(client.studyId, client.clientId);
        publishStudyRealtimeEvent(findStudy(loadStudies(), client.studyId), 'presence.updated', {
          event: 'presence.updated',
          mode: 'viewing',
          reason: 'disconnect',
          presence: listStudyPresence(client.studyId),
        });
      }
    });
  })
);

app.post('/api/studies/:id/presence', function (req, res) {
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

  try {
    const result = upsertStudyPresence(study.id, {
      client_id: req.body && req.body.client_id,
      email: context.email,
      name: context.name,
      role: context.role,
      mode: req.body && req.body.mode,
    });
    if (result.changed) {
      publishStudyRealtimeEvent(study, 'presence.updated', {
        event: 'presence.updated',
        mode: normalizeStudyPresenceMode(req.body && req.body.mode),
        presence: result.presence,
      });
    }
    return res.json({
      ok: true,
      presence: result.presence,
      entry: result.entry,
    });
  } catch (err) {
    return sendError(res, err.status || 500, err.code || 'PRESENCE_UPDATE_FAILED', err.message, err.details || null);
  }
});

app.delete('/api/studies/:id/presence', function (req, res) {
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

  const clientId = sanitizeText(req.body && req.body.client_id) || sanitizeText(req.query.client_id);
  if (!clientId) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'client_id is required.');
  }

  const removed = removeStudyPresence(study.id, clientId);
  if (removed) {
    publishStudyRealtimeEvent(study, 'presence.updated', {
      event: 'presence.updated',
      mode: 'viewing',
      reason: 'disconnect',
      presence: listStudyPresence(study.id),
    });
  }

  return res.json({
    ok: true,
    removed: removed,
    presence: listStudyPresence(study.id),
  });
});

app.put('/api/studies/:id', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot edit studies.')) return;

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
  assertStudyVersion(study, req.body || {});

  const changed = applyStudyMetadataUpdates(study, req.body || {});
  if (changed) {
    touchStudy(study);
    saveStudies(studies);
    if (ENABLE_PG_DUAL_WRITE) {
      pgDualWriteStudy(study);
    }
    publishStudyRealtimeEvent(study, 'study.updated', {
      event: 'study.updated',
      source: 'metadata_update',
    });
    scheduleNextcloudExport(study.id, 'study_metadata_update');
  }

  return res.json({
    ok: true,
    study: study,
  });
});

app.post('/api/studies/:id/complete', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'report', 'Your account cannot complete reports.')) return;

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
  if (!normalizePatientIdentifier(study.patient_id)) {
    return sendError(
      res,
      409,
      'PATIENT_IDENTIFIER_REQUIRED',
      'Assign the immutable patient identifier before completing a report.'
    );
  }
  assertStudyVersion(study, req.body || {});

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'radiology_report')) {
    study.radiology_report = sanitizeMultilineText(req.body && req.body.radiology_report) || null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'recorded_by')) {
    study.recorded_by = sanitizeText(req.body && req.body.recorded_by) || null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'transcribed_by')) {
    study.transcribed_by = sanitizeText(req.body && req.body.transcribed_by) || null;
  }
  const signedAt = nowIso();
  const readingLocation = normalizeReadingLocation(req.body && req.body.reading_location);
  const browserContext = normalizeBrowserContext(req, req.body && req.body.browser_context);
  const signoffEvent = {
    id: crypto.randomUUID(),
    signed_at: signedAt,
    signed_by_email: sanitizeText(context.email).toLowerCase() || null,
    signed_by_name: sanitizeText(context.name) || sanitizeText(context.email) || null,
    reading_location: readingLocation,
    browser_context: browserContext,
  };
  study.status = 'complete';
  study.completed_at = signedAt;
  study.completed_by_email = sanitizeText(context.email) || null;
  study.completed_by_name = sanitizeText(context.name) || sanitizeText(context.email) || null;
  study.completion_note = sanitizeMultilineText(req.body && req.body.completion_note) || null;
  study.reading_location = hasReadingLocationDetails(readingLocation) ? readingLocation : null;
  study.signoff_events = Array.isArray(study.signoff_events) ? study.signoff_events : [];
  study.signoff_events.push(signoffEvent);
  touchStudy(study);
  saveStudies(studies);
  if (ENABLE_PG_DUAL_WRITE) {
    pgDualWriteStudy(study);
  }
  publishStudyRealtimeEvent(study, 'study.completed', {
    event: 'study.completed',
    source: 'complete',
    completion_note: study.completion_note,
  });
  logReportCodesToGrist(makeGristReportCodeRowsForStudy(study, 'study_signoff')).catch(function (err) {
    log('warn', 'grist.report_codes_signoff_hook_failed', {
      study_id: study.id,
      error: extractAxiosError(err),
    });
  });
  scheduleNextcloudExport(study.id, 'study_signed_complete');

  return res.json({
    ok: true,
    study: study,
  });
});

app.delete(
  '/api/studies/:id',
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) return;
    if (!requireWhiteLabelAction(context, res, 'delete', 'Your account cannot delete studies.')) return;

    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (!canAccessStudyRecord(context, study)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
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
    appendTenantAuditEvent('study.deleted', {
      tenant_id: getStudyTenantId(study),
      study_id: study.id,
      actor_email: context.email,
      actor_role: context.role,
      action: 'delete_study',
      details: {
        purge_after: getStudyDeletedPurgeAt(study),
      },
    });
    publishStudyRealtimeEvent(study, 'study.deleted', {
      event: 'study.deleted',
      source: 'api_delete',
    });

    return res.json({
      ok: true,
      success: true,
      purge_after: getStudyDeletedPurgeAt(study),
    });
  })
);

app.post('/api/studies/:id/restore', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'delete', 'Your account cannot restore studies.')) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);
  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
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
  publishStudyRealtimeEvent(study, 'study.restored', {
    event: 'study.restored',
    source: 'api_restore',
  });
  appendTenantAuditEvent('study.restored', {
    tenant_id: getStudyTenantId(study),
    study_id: study.id,
    actor_email: context.email,
    actor_role: context.role,
    action: 'restore_study',
  });
  return res.json({ ok: true, study: study });
});

app.delete(
  '/api/studies/:id/permanent',
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin']);
    if (!context) return;

    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }

    await permanentlyDeleteStudyRecord(studies, study, 'api_permanent_delete');
    appendTenantAuditEvent('study.permanently_deleted', {
      tenant_id: getStudyTenantId(study),
      study_id: study.id,
      actor_email: context.email,
      actor_role: context.role,
      action: 'permanent_delete_study',
    });
    publishStudyRealtimeEvent(study, 'study.deleted', {
      event: 'study.deleted',
      source: 'api_permanent_delete',
    });

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
    if (!requireWhiteLabelAction(context, res, 'edit', 'Your account cannot upload case recordings.')) {
      cleanUploadedFile(req.file);
      return;
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
    assertStudyVersion(study, req.body || {});

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
      publishStudyRealtimeEvent(study, 'study.recording_added', {
        event: 'study.recording_added',
        source: 'case_recording_upload',
        recording: record,
      });
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
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) {
    cleanupUploadedFiles(req.files);
    return;
  }
  if (!requireWhiteLabelAction(context, res, 'report', 'Your account cannot upload case reports.')) {
    cleanupUploadedFiles(req.files);
    return;
  }

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
    if (!requireWhiteLabelAction(context, res, 'report', 'Your account cannot add reports to studies.')) {
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
      publishStudyRealtimeEvent(study, 'study.updated', {
        event: 'study.updated',
        source: 'case_report_added',
        report: report,
      });
      appendTenantAuditEvent('study.report_added', {
        tenant_id: getStudyTenantId(study),
        study_id: study.id,
        actor_email: context.email,
        actor_role: context.role,
        action: 'add_report',
        details: {
          report_id: report.id,
          report_type: report.report_type,
          title: report.title,
        },
      });
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

app.post(
  '/api/studies/:id/dictations',
  uploadDictationAudio.single('audio_file'),
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) {
      cleanUploadedFile(req.file);
      return;
    }
    if (!requireWhiteLabelAction(context, res, 'report', 'Your account cannot upload dictations.')) {
      cleanUploadedFile(req.file);
      return;
    }

    if (!req.file) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No dictation audio uploaded.');
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
    assertStudyVersion(study, req.body || {});

    const reportId = crypto.randomUUID();
    const caseLabel = sanitizeText(req.body && req.body.case_label) || makeCaseLabel(study);
    const title = sanitizeText(req.body && req.body.title) || `${caseLabel} dictation`;
    const outputFilename = `dictation-${study.id}-${reportId}-${Date.now()}.mp3`;
    const outputPath = path.join(CASE_REPORTS_DIR, outputFilename);

    try {
      ensureDir(CASE_REPORTS_DIR);
      await convertAudioToMp3(req.file.path, outputPath);
      const stat = fs.statSync(outputPath);
      const report = {
        id: reportId,
        study_id: Number(study.id),
        case_label: caseLabel,
        title: title,
        report_type: 'audio',
        created_at: nowIso(),
        uploaded_by: context.email || null,
        filename: outputFilename,
        file_size: Number(stat.size) || 0,
        mime_type: 'audio/mpeg',
        report_url: mediaUrlFromPath(outputPath),
        text: sanitizeMultilineText(req.body && req.body.transcript) || null,
      };

      study.case_reports = normalizeCaseReports(study);
      study.case_reports.push(report);
      touchStudy(study);
      saveStudies(studies);
      if (ENABLE_PG_DUAL_WRITE) {
        pgDualWriteStudy(study);
      }
      publishStudyRealtimeEvent(study, 'study.updated', {
        event: 'study.updated',
        source: 'dictation_added',
        report: report,
      });
      scheduleNextcloudExport(study.id, 'dictation_audio_upload');

      cleanUploadedFile(req.file);
      return res.status(201).json({
        ok: true,
        report: report,
        reports: study.case_reports,
        study: study,
      });
    } catch (err) {
      cleanUploadedFile(req.file);
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (_) {}
      return sendError(
        res,
        500,
        'DICTATION_AUDIO_UPLOAD_FAILED',
        'Failed to convert and save dictation audio.',
        sanitizeText(err && err.message)
      );
    }
  })
);

app.post('/api/studies/:id/share', function (req, res) {
  const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!context) return;
  if (!requireWhiteLabelAction(context, res, 'export', 'Your account cannot create external study share links.')) return;

  const studies = loadStudies();
  const study = findStudy(studies, req.params.id);

  if (!study) {
    return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
  }
  if (!canAccessStudyRecord(context, study)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
  }

  const requestedDays = Number(req.body && req.body.expires_in_days);
  const expiresInDays = Number.isFinite(requestedDays)
    ? Math.min(Math.max(requestedDays, 1), 365)
    : SHARE_TTL_DAYS;

  study.share_token = makeShareToken();
  study.share_expires_at = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  touchStudy(study);

  saveStudies(studies);
  appendTenantAuditEvent('study.share_created', {
    tenant_id: getStudyTenantId(study),
    study_id: study.id,
    actor_email: context.email,
    actor_role: context.role,
    action: 'create_share_link',
    details: {
      expires_at: study.share_expires_at,
    },
  });

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
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) return;
    if (!requireWhiteLabelAction(context, res, 'export', 'Your account cannot export studies to Nextcloud.')) return;

    try {
      const studies = loadStudies();
      const study = findStudy(studies, req.params.id);
      if (!study) {
        return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
      }
      if (!canAccessStudyRecord(context, study)) {
        return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
      }
      const result = await exportStudyToNextcloud(req.params.id, { reason: 'manual_export' });
      appendTenantAuditEvent('study.nextcloud_exported', {
        tenant_id: getStudyTenantId(study),
        study_id: study.id,
        actor_email: context.email,
        actor_role: context.role,
        action: 'export_nextcloud',
        details: {
          folder: result.folder || null,
          url_created: Boolean(result.url),
          plan: getStudyRetentionConfig(study),
        },
      });
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

app.post(
  '/api/patient-summaries/export-nextcloud',
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!context) return;
    if (!requireWhiteLabelAction(context, res, 'export', 'Your account cannot export patient summaries to Nextcloud.')) return;

    try {
      const result = await exportPatientSummaryToNextcloud(req.body || {}, context);
      appendTenantAuditEvent('patient_summary.nextcloud_exported', {
        tenant_id: normalizeTenantId(result.tenant_id),
        actor_email: context.email,
        actor_role: context.role,
        action: 'export_patient_summary_nextcloud',
        details: {
          folder: result.folder || null,
          study_count: result.study_count || 0,
          report_count: result.report_count || 0,
          url_created: Boolean(result.url),
        },
      });
      return res.json(result);
    } catch (err) {
      const status = err && err.status ? err.status : 502;
      const code = err && err.code ? err.code : 'NEXTCLOUD_PATIENT_SUMMARY_EXPORT_FAILED';
      log(status >= 500 ? 'error' : 'warn', 'nextcloud.patient_summary_export_failed', {
        patient_email: sanitizeText(req.body && req.body.patientEmail),
        error: extractAxiosError(err),
      });
      return sendError(res, status, code, 'Failed to export patient summary to Nextcloud.', extractAxiosError(err));
    }
  })
);

app.get(
  '/api/viewer-link/:id',
  asyncHandler(async function (req, res) {
    const context = requireStudyRole(req, res, ['admin', 'doctor', 'clinic', 'patient']);
    if (!context) return;

    const studies = loadStudies();
    const study = findStudy(studies, req.params.id);

    if (!study) {
      return sendError(res, 404, 'NOT_FOUND', 'Study not found.');
    }
    if (!canAccessStudyRecord(context, study)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this study.');
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
            patientIdentifier: study.patient_id,
            patientLookupUrl: buildPatientLookupUrl(study.patient_id),
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
    if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot create case streams.')) return;
    let context = null;
    try {
      context = resolveCaseStreamContext(req.body, authContext);
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
      res.setHeader('x-case-stream-total-frames', String(result.totalFrames || result.framesRendered || 0));
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
      context = resolveCaseStreamContext(req.body, authContext);
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
      tenant_ids: context.tenantIds,
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
      total_frames: 0,
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
  if (!canAccessTenantScopedResource(authContext, job.tenant_ids)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this case stream job.');
  }

  return res.json({
    ok: true,
    job: getCaseStreamPublicJob(job),
  });
});

app.post('/api/case-stream/jobs/:jobId/cancel', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot cancel case stream jobs.')) return;
  const jobId = sanitizeText(req.params.jobId);
  const job = caseStreamJobs.get(jobId);

  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }
  if (!canAccessTenantScopedResource(authContext, job.tenant_ids)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this case stream job.');
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
  const jobId = sanitizeText(req.params.jobId);
  const authContext = requireStudyRoleForVideo(req, res, ['admin', 'doctor', 'clinic'], 'case_stream_job', jobId);
  if (!authContext) return;
  const job = caseStreamJobs.get(jobId);

  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }
  if (!canAccessTenantScopedResource(authContext, job.tenant_ids)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this case stream job.');
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

  const dispositionType = parseBooleanFlag(req.query && req.query.inline) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `${dispositionType}; filename="${sanitizeText(job.filename) || `case-stream-${job.id}.mp4`}"`
  );
  res.setHeader('x-case-stream-job-id', job.id);
  res.setHeader('x-case-stream-fps', String(job.fps));
  res.setHeader('x-case-stream-skipped-studies', String(job.skipped_studies_count || 0));
  res.setHeader('x-case-stream-duration-sec', String(job.duration_sec || 0));
  res.setHeader('x-case-stream-total-frames', String(getCaseStreamTotalFrames(job)));

  return res.sendFile(job.output_path);
});

app.get(
  '/api/case-stream/jobs/:jobId/frames/:frameIndex',
  asyncHandler(async function (req, res) {
    const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!authContext) return;
    if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot repair case streams.')) return;
    const jobId = sanitizeText(req.params.jobId);
    const frameIndex = Number(req.params.frameIndex);
    const job = caseStreamJobs.get(jobId);

    if (!job) {
      return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
    }
    if (!canAccessTenantScopedResource(authContext, job.tenant_ids)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this case stream job.');
    }

    if (job.status !== 'ready') {
      return sendError(res, 409, 'JOB_NOT_READY', 'Case stream is not ready for frame review yet.', {
        status: job.status,
      });
    }

    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid frame index.');
    }

    const totalFrames = getCaseStreamTotalFrames(job);
    if (totalFrames > 0 && frameIndex >= totalFrames) {
      return sendError(res, 416, 'FRAME_OUT_OF_RANGE', 'Frame index is outside this stream.', {
        total_frames: totalFrames,
      });
    }

    if (!job.output_path || !fs.existsSync(job.output_path)) {
      return sendError(res, 410, 'OUTPUT_MISSING', 'Generated export file is missing. Please create a new case stream export.');
    }

    const framePath = await extractCaseStreamFramePng(job.output_path, 'job', job.id, frameIndex);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('x-case-stream-job-id', job.id);
    res.setHeader('x-case-stream-frame-index', String(frameIndex));
    res.setHeader('x-case-stream-total-frames', String(totalFrames));
    return res.sendFile(framePath);
  })
);

app.post('/api/case-stream/jobs/:jobId/frames/prewarm', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const jobId = sanitizeText(req.params.jobId);
  const centerFrame = Number(req.body && req.body.frame_index);
  const radius = Number(req.body && req.body.radius);
  const job = caseStreamJobs.get(jobId);

  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }
  if (!canAccessTenantScopedResource(authContext, job.tenant_ids)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this case stream job.');
  }

  if (job.status !== 'ready') {
    return sendError(res, 409, 'JOB_NOT_READY', 'Case stream is not ready for frame review yet.', {
      status: job.status,
    });
  }

  if (!job.output_path || !fs.existsSync(job.output_path)) {
    return sendError(res, 410, 'OUTPUT_MISSING', 'Generated export file is missing. Please create a new case stream export.');
  }

  const totalFrames = getCaseStreamTotalFrames(job);
  const scheduled = scheduleCaseStreamFramePrewarm(job.output_path, 'job', job.id, centerFrame, totalFrames, radius);
  return res.status(202).json({
    ok: true,
    scheduled: scheduled,
    total_frames: totalFrames,
  });
});

app.get('/api/case-stream/library/:streamId/download', function (req, res) {
  const streamId = sanitizeText(req.params.streamId);
  const authContext = requireStudyRoleForVideo(req, res, ['admin', 'doctor', 'clinic'], 'case_stream_library', streamId);
  if (!authContext) return;
  const stream = loadCaseStreamLibrary().find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  if (!isCaseStreamAssignedToContext(stream, authContext)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this stream.');
  }

  const filePath = getCaseStreamLibraryDownloadPath(stream);
  if (!filePath) {
    return sendError(res, 410, 'OUTPUT_MISSING', 'Saved stream video is missing. Please recreate and save this stream.');
  }

  const dispositionType = parseBooleanFlag(req.query && req.query.inline) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `${dispositionType}; filename="${sanitizeText(stream.filename) || `case-stream-${stream.id}.mp4`}"`
  );
  res.setHeader('x-case-stream-id', stream.id);
  res.setHeader('x-case-stream-fps', String(stream.fps || 0));
  res.setHeader('x-case-stream-duration-sec', String(stream.duration_sec || 0));
  res.setHeader('x-case-stream-total-frames', String(getCaseStreamTotalFrames(stream)));
  return res.sendFile(filePath);
});

app.get(
  '/api/case-stream/library/:streamId/frames/:frameIndex',
  asyncHandler(async function (req, res) {
    const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
    if (!authContext) return;
    const streamId = sanitizeText(req.params.streamId);
    const frameIndex = Number(req.params.frameIndex);
    const stream = loadCaseStreamLibrary().find(function (item) {
      return item.id === streamId;
    });

    if (!stream) {
      return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
    }

    if (!isCaseStreamAssignedToContext(stream, authContext)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this stream.');
    }

    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid frame index.');
    }

    const totalFrames = getCaseStreamTotalFrames(stream);
    if (totalFrames > 0 && frameIndex >= totalFrames) {
      return sendError(res, 416, 'FRAME_OUT_OF_RANGE', 'Frame index is outside this stream.', {
        total_frames: totalFrames,
      });
    }

    const filePath = getCaseStreamLibraryDownloadPath(stream);
    if (!filePath) {
      return sendError(res, 410, 'OUTPUT_MISSING', 'Saved stream video is missing. Please recreate and save this stream.');
    }

    const framePath = await extractCaseStreamFramePng(filePath, 'library', stream.id, frameIndex);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('x-case-stream-id', stream.id);
    res.setHeader('x-case-stream-frame-index', String(frameIndex));
    res.setHeader('x-case-stream-total-frames', String(totalFrames));
    return res.sendFile(framePath);
  })
);

app.post('/api/case-stream/library/:streamId/frames/prewarm', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const streamId = sanitizeText(req.params.streamId);
  const centerFrame = Number(req.body && req.body.frame_index);
  const radius = Number(req.body && req.body.radius);
  const stream = loadCaseStreamLibrary().find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  if (!isCaseStreamAssignedToContext(stream, authContext)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this stream.');
  }

  const filePath = getCaseStreamLibraryDownloadPath(stream);
  if (!filePath) {
    return sendError(res, 410, 'OUTPUT_MISSING', 'Saved stream video is missing. Please recreate and save this stream.');
  }

  const totalFrames = getCaseStreamTotalFrames(stream);
  const scheduled = scheduleCaseStreamFramePrewarm(filePath, 'library', stream.id, centerFrame, totalFrames, radius);
  return res.status(202).json({
    ok: true,
    scheduled: scheduled,
    total_frames: totalFrames,
  });
});

app.get('/api/case-stream/library', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const includeAll = parseBooleanFlag(req.query && req.query.all);
  const items = loadCaseStreamLibrary()
    .filter(function (item) {
      if (!canAccessTenantScopedResource(authContext, item.tenant_ids)) return false;
      if (authContext.role === 'admin' || authContext.role === 'clinic') return includeAll || true;
      return isCaseStreamAssignedToContext(item, authContext);
    })
    .map(function (item) {
      return serializeCaseStreamLibraryItem(item);
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
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  const streamId = sanitizeText(req.params.streamId);
  const stream = loadCaseStreamLibrary().find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  if (!isCaseStreamAssignedToContext(stream, authContext)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this stream.');
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

  const videoAccessToken = issueVideoAccessToken('case_stream_library', stream.id, authContext);
  const presentation = buildCaseStreamPresentationManifest(stream, job, {
    videoUrl: `/api/case-stream/library/${encodeURIComponent(stream.id)}/download?inline=1&vtoken=${encodeURIComponent(videoAccessToken)}`,
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

    if (!isCaseStreamAssignedToContext(stream, authContext)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this stream.');
    }

    const forceRepair = parseBooleanFlag(req.query && req.query.force);
    const existingPath = getCaseStreamLibraryDownloadPath(stream);
    if (existingPath && !forceRepair) {
      return res.json({
        ok: true,
        repaired: false,
        stream: serializeCaseStreamLibraryItem(stream),
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
    stream.total_frames = Number(rebuilt.total_frames || rebuilt.frames_rendered || 0);
    stream.frames_rendered = Number(rebuilt.frames_rendered || 0);
    stream.updated_at = nowIso();
    saveCaseStreamLibrary(streams);

    return res.json({
      ok: true,
      repaired: true,
      stream: serializeCaseStreamLibraryItem(stream),
    });
  })
);

app.patch('/api/case-stream/library/:streamId/assignment', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'clinic']);
  if (!authContext) return;
  if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot assign case streams.')) return;
  const streamId = sanitizeText(req.params.streamId);
  const streams = loadCaseStreamLibrary();
  const stream = streams.find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  const assignedMdEmail = sanitizeText(req.body && req.body.assigned_md_email).toLowerCase();
  const assignedMdName = sanitizeText(req.body && req.body.assigned_md_name);
  const nextStatus = sanitizeCaseStreamReadingStatus(req.body && req.body.reading_status);
  const now = nowIso();

  if (!assignedMdEmail && !assignedMdName) {
    stream.assigned_md_email = null;
    stream.assigned_md_name = null;
    stream.assigned_at = null;
    stream.assigned_by_email = null;
    stream.assigned_by_name = null;
    stream.reading_status = 'unassigned';
  } else {
    stream.assigned_md_email = assignedMdEmail || null;
    stream.assigned_md_name = assignedMdName || assignedMdEmail || null;
    stream.assigned_at = stream.assigned_at || now;
    stream.assigned_by_email = sanitizeText(authContext.email).toLowerCase() || null;
    stream.assigned_by_name = sanitizeText(authContext.name) || null;
    stream.reading_status = nextStatus === 'unassigned' ? 'assigned' : nextStatus;
  }

  stream.reading_status_updated_at = now;
  stream.reading_status_updated_by_email = sanitizeText(authContext.email).toLowerCase() || null;
  stream.reading_status_updated_by_name = sanitizeText(authContext.name) || null;
  stream.updated_at = now;
  saveCaseStreamLibrary(streams);

  return res.json({
    ok: true,
    stream: serializeCaseStreamLibraryItem(stream),
  });
});

app.patch('/api/case-stream/library/:streamId/reading-status', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot update case stream status.')) return;
  const streamId = sanitizeText(req.params.streamId);
  const streams = loadCaseStreamLibrary();
  const stream = streams.find(function (item) {
    return item.id === streamId;
  });

  if (!stream) {
    return sendError(res, 404, 'NOT_FOUND', 'Saved stream not found.');
  }

  if (!isCaseStreamAssignedToContext(stream, authContext)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this stream.');
  }

  const nextStatus = sanitizeCaseStreamReadingStatus(req.body && req.body.reading_status);
  if (nextStatus === 'unassigned') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Choose a valid reading status.');
  }

  const now = nowIso();
  stream.reading_status = nextStatus;
  stream.reading_status_updated_at = now;
  stream.reading_status_updated_by_email = sanitizeText(authContext.email).toLowerCase() || null;
  stream.reading_status_updated_by_name = sanitizeText(authContext.name) || null;
  stream.updated_at = now;
  saveCaseStreamLibrary(streams);

  return res.json({
    ok: true,
    stream: serializeCaseStreamLibraryItem(stream),
  });
});

app.post('/api/case-stream/library', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'doctor', 'clinic']);
  if (!authContext) return;
  if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot save case streams.')) return;
  const jobId = sanitizeText(req.body && req.body.job_id);
  const name = sanitizeText(req.body && req.body.name);
  const requestedAssignedMdEmail = sanitizeText(req.body && req.body.assigned_md_email).toLowerCase();
  const requestedAssignedMdName = sanitizeText(req.body && req.body.assigned_md_name);
  const defaultAssignedMdEmail = requestedAssignedMdEmail || DEFAULT_STREAM_ASSIGNED_MD_EMAIL || null;
  const defaultAssignedMdName =
    requestedAssignedMdName ||
    DEFAULT_STREAM_ASSIGNED_MD_NAME ||
    defaultAssignedMdEmail ||
    null;

  if (!jobId || !name) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Both job_id and name are required.');
  }

  const job = caseStreamJobs.get(jobId);
  if (!job) {
    return sendError(res, 404, 'NOT_FOUND', 'Case stream job not found.');
  }
  if (!canAccessTenantScopedResource(authContext, job.tenant_ids)) {
    return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this case stream job.');
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
    existing.tenant_ids = normalizeTenantIdList(job.tenant_ids || []);
    existing.timeline = Array.isArray(job.timeline) ? job.timeline : [];
    existing.skipped_studies_count = Number(job.skipped_studies_count || 0);
    existing.skipped_studies = Array.isArray(job.skipped_studies) ? job.skipped_studies : [];
    existing.skipped_frames = Array.isArray(job.skipped_frames) ? job.skipped_frames : [];
    existing.source_summary = Array.isArray(job.source_summary) ? job.source_summary : [];
    existing.duration_sec = Number(job.duration_sec || 0);
    existing.total_frames = getCaseStreamTotalFrames(job);
    existing.frames_rendered = Number(job.frames_rendered || 0);
    if (!existing.assigned_md_email && !existing.assigned_md_name && defaultAssignedMdName) {
      existing.assigned_md_email = defaultAssignedMdEmail;
      existing.assigned_md_name = defaultAssignedMdName;
      existing.assigned_at = nowIso();
      existing.assigned_by_email = sanitizeText(authContext.email).toLowerCase() || null;
      existing.assigned_by_name = sanitizeText(authContext.name) || null;
      existing.reading_status = 'assigned';
      existing.reading_status_updated_at = nowIso();
      existing.reading_status_updated_by_email = sanitizeText(authContext.email).toLowerCase() || null;
      existing.reading_status_updated_by_name = sanitizeText(authContext.name) || null;
    }
    saveCaseStreamLibrary(streams);
    return res.json({
      ok: true,
      stream: serializeCaseStreamLibraryItem(existing),
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
    tenant_ids: normalizeTenantIdList(job.tenant_ids || []),
    timeline: Array.isArray(job.timeline) ? job.timeline : [],
    skipped_studies_count: Number(job.skipped_studies_count || 0),
    skipped_studies: Array.isArray(job.skipped_studies) ? job.skipped_studies : [],
    skipped_frames: Array.isArray(job.skipped_frames) ? job.skipped_frames : [],
    source_summary: Array.isArray(job.source_summary) ? job.source_summary : [],
    duration_sec: Number(job.duration_sec || 0),
    total_frames: getCaseStreamTotalFrames(job),
    frames_rendered: Number(job.frames_rendered || 0),
    assigned_md_email: defaultAssignedMdEmail,
    assigned_md_name: defaultAssignedMdName,
    assigned_at: defaultAssignedMdName ? createdAt : null,
    assigned_by_email: defaultAssignedMdName ? sanitizeText(authContext.email).toLowerCase() || null : null,
    assigned_by_name: defaultAssignedMdName ? sanitizeText(authContext.name) || null : null,
    reading_status: defaultAssignedMdName ? 'assigned' : 'unassigned',
    reading_status_updated_at: defaultAssignedMdName ? createdAt : null,
    reading_status_updated_by_email: defaultAssignedMdName ? sanitizeText(authContext.email).toLowerCase() || null : null,
    reading_status_updated_by_name: defaultAssignedMdName ? sanitizeText(authContext.name) || null : null,
  };

  streams.push(item);
  saveCaseStreamLibrary(streams);

  return res.status(201).json({
    ok: true,
    stream: serializeCaseStreamLibraryItem(item),
  });
});

app.delete('/api/case-stream/library/:streamId', function (req, res) {
  const authContext = requireStudyRole(req, res, ['admin', 'clinic']);
  if (!authContext) return;
  if (!requireWhiteLabelAction(authContext, res, 'stream_manage', 'Your account cannot delete case streams.')) return;
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
      err.message === 'Only video files are accepted.' ||
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

restoreUploadedVideoJobQueue();

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
  clearInterval(acronymDatabaseSyncTimer);
  clearTimeout(acronymDatabaseInitialSyncTimer);

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
