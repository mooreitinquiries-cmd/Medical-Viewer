import { AuthSessionError } from '@/lib/sessionApi';

const configuredApiBase = import.meta.env.VITE_API?.trim();
const DEFAULT_FRONTEND_ORIGIN = 'http://192.168.4.249:8080';
const DEFAULT_STUDY_API_BASE = 'http://192.168.4.249:3001/api';
const DEFAULT_STUDY_MEDIA_BASE = 'http://192.168.4.249:3001';

function getCurrentOrigin() {
  if (typeof window === 'undefined') {
    return DEFAULT_FRONTEND_ORIGIN;
  }

  return window.location.origin;
}

function toAbsoluteUrl(path: string, base: string) {
  const resolvedBase =
    typeof window !== 'undefined' && base.startsWith('/')
      ? new URL(base, getCurrentOrigin()).toString()
      : base;
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, resolvedBase.endsWith('/') ? resolvedBase : `${resolvedBase}/`).toString();
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

async function sha256Hex(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof blob.arrayBuffer !== 'function') {
    throw new Error('This browser cannot verify screen recording integrity before upload.');
  }

  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function appendRecordingIntegrityFields(formData: FormData, recordingFile: Blob) {
  formData.append('recording_size', String(recordingFile.size));
  formData.append('recording_sha256', await sha256Hex(recordingFile));
}

function getPortBaseCandidates(port: number, pathname = '') {
  if (typeof window === 'undefined') {
    return [`http://192.168.4.249:${port}${pathname}`];
  }

  const { hostname, protocol } = window.location;
  const candidates = [`${protocol}//${hostname}:${port}${pathname}`];

  if (protocol !== 'http:') {
    candidates.push(`http://${hostname}:${port}${pathname}`);
  }

  return unique(candidates);
}

export function getApiBaseCandidates(): string[] {
  const currentOrigin = getCurrentOrigin();
  const candidates = [
    '/api',
    configuredApiBase,
    `${currentOrigin}/api`,
    ...getPortBaseCandidates(3001, '/api'),
    DEFAULT_STUDY_API_BASE,
  ].filter((value): value is string => Boolean(value));

  return unique(candidates.map((value) => value.replace(/\/+$/, '')));
}

const BASE_URL = getApiBaseCandidates()[0];

export function getMediaBaseUrl(): string {
  if (configuredApiBase) {
    if (configuredApiBase.startsWith('/')) {
      return getCurrentOrigin();
    }

    try {
      return new URL(configuredApiBase).origin;
    } catch {
      return getCurrentOrigin();
    }
  }

  return getCurrentOrigin();
}

/* ===================== TYPES ===================== */

export interface Study {
  id: number;
  tenant_id?: string | null;
  tenantId?: string | null;
  white_label_account_id?: string | null;
  patient_name?: string;
  patient_id?: string;
  patient_age?: string;
  patient_dob?: string;
  patient_sex?: string;
  patient_zip?: string;
  study_date?: string;
  octrqaui?: string;
  octraccui?: string;
  client_email?: string;
  client_name?: string;
  subclient?: string;
  md_name?: string;
  revenue?: string;
  modality?: string;
  notes?: string;
  tech_notes?: string | null;
  radiologist_notes?: string | null;
  radiology_report?: string | null;
  mp4_url?: string | null;
  video_processing_status?: 'processing' | 'ready' | 'failed' | string | null;
  video_processing_error?: string | null;
  video_metadata?: {
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    keyframe_interval?: number;
    thumbnail_interval_sec?: number;
    thumbnail_paths?: string[];
    playback_strategy?: 'hls' | 'mp4' | string;
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
    processed_at?: string;
    source_filename?: string | null;
  } | null;
  pdf_url?: string | null;
  orthanc_patient_id?: string | null;
  orthanc_study_id?: string | null;
  dicom_count?: number;
  status?: string;
  completed_at?: string | null;
  completed_by_email?: string | null;
  completed_by_name?: string | null;
  recorded_by?: string | null;
  transcribed_by?: string | null;
  completion_note?: string | null;
  reading_location?: ReadingLocation | null;
  signoff_events?: SignoffEvent[];
  created_at?: string;
  share_token?: string | null;
  share_expires_at?: string | null;
  nextcloud_folder?: string | null;
  nextcloud_url?: string | null;
  data_plan?: string | null;
  hosted_by_octelerad?: boolean;
  customer_download_required_by?: string | null;
  retention_policy_applied_at?: string | null;
  prior_study_ids?: number[];
  live_streaming?: boolean;
  has_recording?: boolean;
  deleted_at?: string | null;
  case_reports?: CaseReport[];
}

export interface ReadingLocation {
  country?: string | null;
  state?: string | null;
  zip_code?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface SignoffEvent {
  id: string;
  signed_at: string;
  signed_by_email?: string | null;
  signed_by_name?: string | null;
  reading_location?: ReadingLocation | null;
  browser_context?: {
    ip?: string | null;
    user_agent?: string | null;
    timezone?: string | null;
    language?: string | null;
    platform?: string | null;
  } | null;
}

export interface CaseReport {
  id: string;
  study_id: number;
  case_label?: string | null;
  title: string;
  report_type: 'pdf' | 'image' | 'text' | 'notepad' | 'document' | 'file' | string;
  created_at?: string;
  uploaded_by?: string | null;
  filename?: string | null;
  file_size?: number;
  mime_type?: string | null;
  report_url?: string | null;
  text?: string | null;
}

export interface AcronymEntry {
  code: string;
  diagnosis: string;
  aliases?: string[];
  chapter?: string;
  client?: string;
  source_doc_id?: string;
  source_table_id?: string;
  source_record_id?: string;
  synced_at?: string;
}

export interface UploadStudyPayload {
  patient_name: string;
  patient_id?: string;
  patient_age?: string;
  patient_dob?: string;
  patient_sex?: string;
  patient_zip?: string;
  study_date: string;
  octrqaui?: string;
  octraccui?: string;
  client_email?: string;
  client_name?: string;
  subclient?: string;
  md_name?: string;
  revenue?: string;
  modality: string;
  notes: string;
  tech_notes?: string;
  radiologist_notes?: string;
  radiology_report?: string;
}

export interface UpdateStudyPayload {
  patient_name?: string;
  patient_id?: string;
  patient_age?: string;
  patient_dob?: string;
  patient_sex?: string;
  patient_zip?: string;
  study_date?: string;
  octrqaui?: string;
  octraccui?: string;
  client_email?: string;
  client_name?: string;
  subclient?: string;
  md_name?: string;
  revenue?: string;
  modality?: string;
  notes?: string;
  tech_notes?: string | null;
  radiologist_notes?: string | null;
  radiology_report?: string | null;
  recorded_by?: string | null;
  transcribed_by?: string | null;
  base_updated_at?: string;
}

export interface StudyPresenceEntry {
  client_id: string;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  mode: 'viewing' | 'editing' | 'signoff' | string;
  last_seen_at: string;
  connected_at: string;
}

export interface StudyRealtimeEvent {
  event: string;
  study_id?: number;
  study?: Study | null;
  presence?: StudyPresenceEntry[];
  updated_at?: string;
  source?: string;
  recordings_count?: number;
  latest_recording?: CaseRecording | null;
  live_session?: LiveCaseSession | null;
  [key: string]: unknown;
}

export interface UploadResult {
  ok: boolean;
  study_id: number;
  orthanc_patient_id?: string;
  orthanc_study_id?: string;
  dicom_count?: number;
  dicom_converted_count?: number;
  dicom_redacted_count?: number;
  dicom_redaction_failed_count?: number;
  dicom_converted_files?: Array<{
    name?: string;
    from_transfer_syntax?: string;
    to_transfer_syntax?: string;
  }>;
  dicom_redaction_failed_files?: Array<{
    name?: string;
    reason?: string;
  }>;
  dicom_failed_count?: number;
  dicom_failed_files?: Array<{
    name?: string;
    reason?: string;
  }>;
  study?: Study;
}

export interface UploadProgressState {
  stage: 'creating_study' | 'uploading_dicom' | 'uploading_mp4' | 'uploading_pdf' | 'finalizing';
  percent: number;
  message: string;
  totalFiles: number;
  processedFiles: number;
  filesRemaining: number;
  currentBatch?: number;
  totalBatches?: number;
}

interface DicomUploadOptions {
  onProgress?: (state: UploadProgressState) => void;
  convertJpeg2000ToDcm?: boolean;
  conversionToken?: string;
  redactTextOnUpload?: boolean;
  auth?: StudyApiAuthContext;
}

export interface DicomPreconvertResult {
  ok: boolean;
  conversion_token: string;
  conversion_expires_at?: string;
  dicom_total_count?: number;
  dicom_converted_count?: number;
  dicom_converted_files?: Array<{
    name?: string;
    from_transfer_syntax?: string | null;
    to_transfer_syntax?: string | null;
  }>;
}

export interface DicomInstance {
  instance_id: string;
  index: number;
}

export interface CaseStreamExportResult {
  blob: Blob;
  filename: string;
}

export interface CaseStreamJob {
  id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  requested_study_ids?: number[];
  fps?: number;
  max_frames?: number;
  total_frames?: number;
  frame_review_url?: string | null;
  timeline?: Array<{
    index: number;
    study_id: number;
    label: string;
    frame_count: number;
    start_frame?: number;
    end_frame?: number;
    start_sec: number;
    end_sec: number;
  }>;
  skipped_studies_count?: number;
  progress_pct?: number;
  progress_message?: string;
  cancel_requested?: boolean;
  can_cancel?: boolean;
  download_url?: string | null;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  } | null;
}

export interface CaseStreamLibraryItem {
  id: string;
  job_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  assigned_md_email?: string | null;
  assigned_md_name?: string | null;
  assigned_at?: string | null;
  assigned_by_email?: string | null;
  assigned_by_name?: string | null;
  reading_status?: 'unassigned' | 'assigned' | 'in_review' | 'read' | 'completed';
  reading_status_updated_at?: string | null;
  reading_status_updated_by_email?: string | null;
  reading_status_updated_by_name?: string | null;
  filename?: string | null;
  file_size?: number;
  fps?: number;
  requested_study_ids?: number[];
  total_frames?: number;
  frame_review_url?: string | null;
  presentation_case_count?: number;
  video_available?: boolean;
  download_url?: string | null;
  timeline?: Array<{
    index: number;
    study_id: number;
    label: string;
    frame_count: number;
    start_frame?: number;
    end_frame?: number;
    start_sec: number;
    end_sec: number;
  }>;
}

export interface CaseStreamPresentationCase {
  index: number;
  study_id: number;
  label: string;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  frame_count?: number;
  start_frame?: number | null;
  end_frame?: number | null;
}

export interface CaseStreamPresentationManifest {
  stream_id: string;
  job_id: string;
  name: string;
  video_url?: string | null;
  fps?: number;
  total_frames?: number;
  requested_study_ids?: number[];
  case_count: number;
  cases: CaseStreamPresentationCase[];
}

export interface StudyApiAuthContext {
  email?: string;
  role?: string;
  name?: string;
  isSuperAdmin?: boolean;
  whiteLabelAccountIds?: string[];
  primaryWhiteLabelAccountId?: string | null;
  whiteLabelAccessLevel?: string | null;
}

interface CaseStreamRequestOptions {
  fps?: number;
  maxFrames?: number;
  studyLayouts?: Record<
    string,
    {
      mode: 'fit' | 'fill' | 'manual';
      crop?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    }
  >;
  auth?: StudyApiAuthContext;
}

export interface CaseRecording {
  id: string;
  caseId?: string | null;
  studyId: number;
  studyInstanceUID?: string | null;
  patientId?: string | null;
  uploadedBy?: string | null;
  uploaderRole?: string | null;
  created_at?: string;
  recording_url: string;
  filename?: string;
  file_size?: number;
  sha256?: string | null;
}

export interface CaseReportUploadItem {
  report_url: string;
  filename?: string;
  file_size?: number;
  created_at?: string;
}

export interface PatientSummaryExportPayload {
  patientEmail: string;
  patientName?: string;
  title: string;
  notes: string;
  soapNotes?: SoapNotesPayload;
  studyStack?: Array<{
    studyId: number;
    relation: 'prior' | 'current';
    order: number;
  }>;
  priorReports?: Array<{
    url: string;
    filename?: string;
    sourceStudyId?: number | null;
    createdAt?: string;
  }>;
}

export interface SoapNotesPayload {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
}

export interface PatientSummaryExportResult {
  ok: boolean;
  folder: string;
  url: string;
  study_count: number;
  report_count: number;
  requested_report_count: number;
  dicom_exported: number;
}

export interface LiveCaseSession {
  id: string;
  study_id: number;
  started_at: string;
  last_seen_at: string;
  ended_at?: string | null;
  started_by_email?: string | null;
  started_by_name?: string | null;
}

export interface StorageStatus {
  ok: boolean;
  available: boolean;
  path?: string;
  total_bytes?: number;
  used_bytes?: number;
  free_bytes?: number;
  available_bytes?: number;
  used_percent?: number;
  warning_threshold_used_percent?: number;
  warning?: boolean;
  warning_message?: string;
  message?: string;
}

export interface RevenueAdjustment {
  id: string;
  date: string;
  amount: number;
  label: string;
  client_name?: string | null;
  subclient?: string | null;
  notes?: string | null;
  created_by_email?: string | null;
  created_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface FormSubmissionField {
  key: string;
  value: string;
}

export interface FormSubmission {
  id: string;
  type: 'patient' | 'clinic' | 'other' | string;
  patient_identifier?: string | null;
  patient_lookup_url?: string | null;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  form_name?: string | null;
  submitted_name?: string;
  submission_subject_type?: string;
  submitted_at?: string | null;
  nextcloud_study_url?: string | null;
  matched_study_id?: string | null;
  matched_study_name?: string | null;
  payload: Record<string, unknown>;
  fields: FormSubmissionField[];
  created_at: string;
  updated_at?: string;
  received_from_ip?: string | null;
}

export interface UpcomingPatient {
  id: string;
  patient_identifier?: string | null;
  patient_lookup_url?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  form_name?: string | null;
  submitted_at?: string | null;
  updated_at?: string | null;
  fields?: FormSubmissionField[];
  payload?: Record<string, unknown>;
}

export interface FormSubmissionSyncResult {
  fetched: number;
  created: number;
  updated: number;
  total: number;
}

/* ===================== HELPERS ===================== */

function isProxyLikeApiBase(baseUrl: string) {
  if (baseUrl.startsWith('/')) {
    return true;
  }

  try {
    return new URL(baseUrl, getCurrentOrigin()).origin === getCurrentOrigin();
  } catch {
    return false;
  }
}

function isJsonResponse(res: Response) {
  const contentType = res.headers.get('content-type') || '';
  return contentType.toLowerCase().includes('application/json');
}

function toErrorMessage(data: unknown, status: number) {
  if (data && typeof data === 'object' && 'error' in data) {
    const error = (data as { error?: unknown }).error;

    if (typeof error === 'string' && error.trim()) {
      return error;
    }

    if (
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      const message = (error as { message: string }).message.trim();
      const failedFiles = (error as { details?: { failed_files?: Array<{ name?: unknown; reason?: unknown }> } })
        .details?.failed_files;
      const failedFile = Array.isArray(failedFiles) ? failedFiles[0] : null;
      const failedName = typeof failedFile?.name === 'string' ? failedFile.name.trim() : '';
      const failedReason = typeof failedFile?.reason === 'string' ? failedFile.reason.trim() : '';

      if (message && failedName) {
        return `${message} File: ${failedName}${failedReason ? ` (${failedReason})` : ''}`;
      }
      if (message) return message;
    }
  }

  return `Request failed (${status})`;
}

function formatApiNetworkError() {
  const candidates = getApiBaseCandidates();
  const attemptedHosts = unique(
    candidates.map((baseUrl) => {
      try {
        return new URL(baseUrl).origin;
      } catch {
        return baseUrl;
      }
    })
  );

  const hostList = attemptedHosts.join(', ');
  return new Error(
    `Unable to reach the study API. Checked ${hostList}. Verify the backend is running or set VITE_API.`
  );
}

export function isStudyApiUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Unable to reach the study API.');
}

let preferredApiBase: string | null = null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: Error | null = null;

  const baseCandidates = unique(
    [preferredApiBase, ...getApiBaseCandidates()].filter((value): value is string => Boolean(value))
  );

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const baseUrl = baseCandidates[index];
    const hasNextCandidate = index < baseCandidates.length - 1;

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        credentials: 'include',
        ...init,
      });
      const data = await res.json().catch(() => null);

      if (res.ok) {
        if (data !== null) {
          preferredApiBase = baseUrl;
          return data as T;
        }

        if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && !isJsonResponse(res)) {
          lastError = new Error(`Study API at ${baseUrl} returned a non-JSON response`);
          continue;
        }

        throw new Error('Study API returned an invalid JSON response.');
      }

      const errorMessage = toErrorMessage(data, res.status);

      if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && res.status === 404) {
        lastError = new Error(errorMessage);
        continue;
      }

      if (res.status === 401) {
        throw new AuthSessionError(errorMessage);
      }

      throw new Error(errorMessage);
    } catch (error) {
      if (!(error instanceof Error)) {
        lastError = new Error('Study API request failed');
        continue;
      }

      if (error instanceof TypeError) {
        lastError = formatApiNetworkError();
        continue;
      }

      throw error;
    }
  }

  throw lastError || formatApiNetworkError();
}

function headersToPlainObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((result, [key, value]) => {
      result[key] = value;
      return result;
    }, {});
  }
  return { ...headers };
}

const DEFAULT_DICOM_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const CASE_STREAM_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_DICOM_UPLOAD_BATCH_MAX_BYTES = 512 * 1024 * 1024;
const DICOM_UPLOAD_NETWORK_RETRIES = 2;

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDicomUploadTimeoutMs() {
  return parsePositiveNumber(
    import.meta.env.VITE_DICOM_UPLOAD_TIMEOUT_MS,
    DEFAULT_DICOM_UPLOAD_TIMEOUT_MS
  );
}

function getDicomUploadBatchMaxBytes() {
  const configuredMb = parsePositiveNumber(
    import.meta.env.VITE_DICOM_UPLOAD_BATCH_MAX_MB,
    DEFAULT_DICOM_UPLOAD_BATCH_MAX_BYTES / (1024 * 1024)
  );
  return configuredMb * 1024 * 1024;
}

function createDicomUploadBatches(files: File[], maxFiles: number, maxBytes: number): File[][] {
  const batches: File[][] = [];
  let currentBatch: File[] = [];
  let currentBatchBytes = 0;

  files.forEach((file) => {
    const fileSize = file.size || 0;
    const shouldIsolateLargeFile = fileSize > maxBytes;

    if (shouldIsolateLargeFile) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchBytes = 0;
      }
      batches.push([file]);
      return;
    }

    const wouldExceedFileLimit = currentBatch.length >= maxFiles;
    const wouldExceedByteLimit =
      currentBatch.length > 0 && currentBatchBytes + fileSize > maxBytes;

    if (wouldExceedFileLimit || wouldExceedByteLimit) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
    }

    currentBatch.push(file);
    currentBatchBytes += fileSize;
  });

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function advanceUploadProcessingPercent(current: number, target: number, startedAt: number): number {
  const elapsedMs = Date.now() - startedAt;
  const timeBasedProgress = Math.floor(elapsedMs / 2500);
  return Math.min(target, Math.max(current + 1, current + timeBasedProgress));
}

function isRetryableMultipartUploadError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('timed out') || message.includes('network') || message.includes('failed to fetch');
}

async function requestMultipartWithUploadProgress<T>(
  path: string,
  formData: FormData,
  options?: {
    headers?: HeadersInit;
    onUploadProgress?: (loaded: number, total: number) => void;
    uploadLabel?: string;
  }
): Promise<T> {
  if (typeof XMLHttpRequest === 'undefined' || import.meta.env.MODE === 'test') {
    return request<T>(path, {
      method: 'POST',
      headers: options?.headers,
      body: formData,
    });
  }

  let lastError: Error | null = null;
  const baseCandidates = unique(
    [preferredApiBase, ...getApiBaseCandidates()].filter((value): value is string => Boolean(value))
  );
  const headers = headersToPlainObject(options?.headers);

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const baseUrl = baseCandidates[index];
    const hasNextCandidate = index < baseCandidates.length - 1;

    for (let attempt = 0; attempt <= DICOM_UPLOAD_NETWORK_RETRIES; attempt += 1) {
      try {
        const result = await new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${baseUrl}${path}`, true);
        xhr.withCredentials = true;
        xhr.timeout = getDicomUploadTimeoutMs();
        Object.entries(headers).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            options?.onUploadProgress?.(event.loaded, event.total);
          }
        };
        xhr.onload = () => {
          const contentType = xhr.getResponseHeader('content-type') || '';
          const rawText = xhr.responseText || '';
          let data: unknown = null;
          if (rawText) {
            try {
              data = JSON.parse(rawText);
            } catch {
              data = null;
            }
          }

          if (xhr.status >= 200 && xhr.status < 300) {
            if (data !== null) {
              preferredApiBase = baseUrl;
              resolve(data as T);
              return;
            }

            if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && !contentType.toLowerCase().includes('application/json')) {
              reject(new TypeError(`Study API at ${baseUrl} returned a non-JSON response`));
              return;
            }

            reject(new Error('Study API returned an invalid JSON response.'));
            return;
          }

          const errorMessage = toErrorMessage(data, xhr.status);
          if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && xhr.status === 404) {
            reject(new TypeError(errorMessage));
            return;
          }
          reject(new Error(errorMessage));
        };
        xhr.onerror = () =>
          reject(new TypeError(`Failed to upload${options?.uploadLabel ? ` ${options.uploadLabel}` : ''}.`));
        xhr.ontimeout = () =>
          reject(
            new Error(
              `${options?.uploadLabel || 'DICOM upload'} timed out before the server finished reading or processing it. ` +
                'The file may be unreadable or use an unsupported encoding.'
            )
          );
        xhr.onabort = () => reject(new Error('Upload cancelled'));
        xhr.send(formData);
      });

        return result;
      } catch (error) {
        const hasRetry = attempt < DICOM_UPLOAD_NETWORK_RETRIES;
        if (hasRetry && isRetryableMultipartUploadError(error)) {
          lastError = error instanceof Error ? error : new Error('DICOM upload failed.');
          await sleep(1000 * (attempt + 1));
          continue;
        }

        if (error instanceof TypeError && hasNextCandidate) {
          lastError = error.message.includes('non-JSON')
            ? new Error(error.message)
            : formatApiNetworkError();
          break;
        }
        if (error instanceof Error) throw error;
        throw new Error('Study API request failed');
      }
    }
  }

  throw lastError || formatApiNetworkError();
}

function isStudyRecord(value: unknown): value is Study {
  return typeof value === 'object' && value !== null;
}

function normalizeStudiesPayload(payload: unknown): Study[] {
  if (Array.isArray(payload)) {
    return payload.filter(isStudyRecord);
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;

    if (Array.isArray(record.studies)) {
      return record.studies.filter(isStudyRecord);
    }

    if (Array.isArray(record.data)) {
      return record.data.filter(isStudyRecord);
    }

    if (Array.isArray(record.items)) {
      return record.items.filter(isStudyRecord);
    }
  }

  return [];
}

async function uploadDicomFilesToStudy(
  studyId: number,
  dicomFiles: File[],
  options?: DicomUploadOptions
): Promise<UploadResult> {
  const onProgress = options?.onProgress;
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const totalFiles = dicomFiles.length;
  const hasConversionToken = Boolean(options?.conversionToken);
  const batchSize = Math.max(
    10,
    Math.min(Number(import.meta.env.VITE_DICOM_UPLOAD_BATCH_SIZE || 100), 1000)
  );
  const batchMaxBytes = getDicomUploadBatchMaxBytes();

  const uploadToStudy = async (
    formData: FormData,
    onUploadProgress?: (loaded: number, total: number) => void,
    uploadLabel?: string
  ) =>
    requestMultipartWithUploadProgress<UploadResult>(`/studies/${studyId}/dicom`, formData, {
      headers: authHeaders,
      onUploadProgress,
      uploadLabel,
    });

  let dicomData: UploadResult | null = null;
  let processedFiles = 0;
  let totalConvertedCount = 0;
  let totalRedactedCount = 0;
  let totalRedactionFailedCount = 0;
  let totalFailedCount = 0;
  let convertedFiles: NonNullable<UploadResult['dicom_converted_files']> = [];
  let redactionFailedFiles: NonNullable<UploadResult['dicom_redaction_failed_files']> = [];
  let failedFiles: NonNullable<UploadResult['dicom_failed_files']> = [];

  if (hasConversionToken) {
    const tokenForm = new FormData();
    tokenForm.append('convert_jpeg2000_to_dcm', options?.convertJpeg2000ToDcm ? '1' : '0');
    tokenForm.append('redact_text_on_upload', options?.redactTextOnUpload === true ? '1' : '0');
    tokenForm.append('conversion_token', options?.conversionToken || '');

    onProgress?.({
      stage: 'uploading_dicom',
      percent: 10,
      message: 'Uploading converted DICOM batch (1/1)...',
      totalFiles,
      processedFiles: 0,
      filesRemaining: totalFiles,
      currentBatch: 1,
      totalBatches: 1,
    });

    let tokenPercent = 10;
    const tokenProcessingStartedAt = Date.now();
    const tokenProcessingTimer = window.setInterval(() => {
      tokenPercent = advanceUploadProcessingPercent(tokenPercent, 89, tokenProcessingStartedAt);
      onProgress?.({
        stage: 'uploading_dicom',
        percent: tokenPercent,
        message: 'Processing converted DICOM batch on server...',
        totalFiles,
        processedFiles: 0,
        filesRemaining: totalFiles,
        currentBatch: 1,
        totalBatches: 1,
      });
    }, 1500);

    try {
      dicomData = await uploadToStudy(tokenForm, (loaded, total) => {
        const ratio = total > 0 ? loaded / total : 0;
        tokenPercent = Math.max(tokenPercent, Math.round(10 + ratio * 80));
        onProgress?.({
          stage: 'uploading_dicom',
          percent: tokenPercent,
          message: `Uploading converted DICOM batch (${Math.round(ratio * 100)}%)...`,
          totalFiles,
          processedFiles: 0,
          filesRemaining: totalFiles,
          currentBatch: 1,
          totalBatches: 1,
        });
      });
    } finally {
      window.clearInterval(tokenProcessingTimer);
    }
    processedFiles = totalFiles;
  } else if (dicomFiles.length > 0) {
    const dicomBatches = createDicomUploadBatches(dicomFiles, batchSize, batchMaxBytes);
    const totalBatches = dicomBatches.length;

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
      const batchFiles = dicomBatches[batchIndex];
      const largestBatchFile = batchFiles.reduce<File | null>(
        (largest, file) => (!largest || file.size > largest.size ? file : largest),
        null
      );
      const largestBatchFileLabel = largestBatchFile
        ? `"${largestBatchFile.name}" (${(largestBatchFile.size / (1024 * 1024)).toFixed(1)} MB)`
        : 'selected DICOM files';
      const batchUploadLabel =
        batchFiles.length === 1
          ? `DICOM file ${largestBatchFileLabel}`
          : `DICOM batch ${batchIndex + 1}/${totalBatches}`;
      const filesRemaining = Math.max(0, totalFiles - processedFiles);
      const batchProgressBase = totalFiles > 0 ? processedFiles / totalFiles : 0;
      const percent = Math.round(5 + batchProgressBase * 85);

      onProgress?.({
        stage: 'uploading_dicom',
        percent,
        message: `Uploading DICOM batch ${batchIndex + 1}/${totalBatches} (${batchFiles.length} files). ${filesRemaining} file(s) left to process.`,
        totalFiles,
        processedFiles,
        filesRemaining,
        currentBatch: batchIndex + 1,
        totalBatches,
      });

      const formData = new FormData();
      formData.append('convert_jpeg2000_to_dcm', options?.convertJpeg2000ToDcm ? '1' : '0');
      formData.append('redact_text_on_upload', options?.redactTextOnUpload === true ? '1' : '0');
      batchFiles.forEach((file) => formData.append('dicom_files', file));

      const batchCompletePercent = Math.round(
        5 + ((processedFiles + batchFiles.length) / Math.max(totalFiles, 1)) * 85
      );
      const maxProcessingPercent = Math.max(percent, batchCompletePercent);
      let currentBatchPercent = percent;
      let currentBatchUploadComplete = false;
      const batchProcessingStartedAt = Date.now();
      const batchProcessingTimer = window.setInterval(() => {
        currentBatchPercent = advanceUploadProcessingPercent(
          currentBatchPercent,
          maxProcessingPercent,
          batchProcessingStartedAt
        );
        onProgress?.({
          stage: 'uploading_dicom',
          percent: currentBatchPercent,
          message: currentBatchUploadComplete
            ? `Upload complete. Server is reading ${batchUploadLabel}. Unreadable files will be reported and skipped.`
            : `Uploading DICOM batch ${batchIndex + 1}/${totalBatches} (${batchFiles.length} files).`,
          totalFiles,
          processedFiles,
          filesRemaining,
          currentBatch: batchIndex + 1,
          totalBatches,
        });
      }, 1500);

      let batchResult: UploadResult;
      try {
        batchResult = await uploadToStudy(formData, (loaded, total) => {
          const uploadRatio = total > 0 ? loaded / total : 0;
          currentBatchUploadComplete = uploadRatio >= 1;
          const processedRatio = totalFiles > 0 ? processedFiles / totalFiles : 0;
          const batchRatio = totalFiles > 0 ? batchFiles.length / totalFiles : 0;
          const percent = Math.round(5 + (processedRatio + batchRatio * uploadRatio) * 85);
          const loadedMb = loaded / (1024 * 1024);
          const totalMb = total / (1024 * 1024);
          currentBatchPercent = Math.max(currentBatchPercent, percent);

          onProgress?.({
            stage: 'uploading_dicom',
            percent: currentBatchPercent,
            message: `Uploading DICOM batch ${batchIndex + 1}/${totalBatches} (${Math.round(uploadRatio * 100)}%, ${loadedMb.toFixed(1)}/${totalMb.toFixed(1)} MB).`,
            totalFiles,
            processedFiles,
            filesRemaining,
            currentBatch: batchIndex + 1,
            totalBatches,
          });
        }, batchUploadLabel);
      } finally {
        window.clearInterval(batchProcessingTimer);
      }
      dicomData = batchResult;
      processedFiles += batchFiles.length;
      totalConvertedCount += batchResult.dicom_converted_count || 0;
      totalRedactedCount += batchResult.dicom_redacted_count || 0;
      totalRedactionFailedCount += batchResult.dicom_redaction_failed_count || 0;
      totalFailedCount += batchResult.dicom_failed_count || 0;
      convertedFiles = convertedFiles.concat(batchResult.dicom_converted_files || []);
      redactionFailedFiles = redactionFailedFiles.concat(batchResult.dicom_redaction_failed_files || []);
      failedFiles = failedFiles.concat(batchResult.dicom_failed_files || []);

      onProgress?.({
        stage: 'uploading_dicom',
        percent: Math.round(5 + (processedFiles / Math.max(totalFiles, 1)) * 85),
        message: `Processed ${processedFiles}/${totalFiles} DICOM file(s). ${Math.max(0, totalFiles - processedFiles)} file(s) left.`,
        totalFiles,
        processedFiles,
        filesRemaining: Math.max(0, totalFiles - processedFiles),
        currentBatch: batchIndex + 1,
        totalBatches,
      });
    }
  }

  if (!dicomData) {
    dicomData = {
      ok: true,
      study_id: studyId,
      dicom_count: 0,
      dicom_converted_count: 0,
      dicom_redacted_count: 0,
      dicom_redaction_failed_count: 0,
      dicom_failed_count: 0,
      dicom_converted_files: [],
      dicom_redaction_failed_files: [],
      dicom_failed_files: [],
    };
  }

  return {
    ...dicomData,
    study_id: studyId,
    dicom_converted_count: hasConversionToken
      ? dicomData.dicom_converted_count
      : totalConvertedCount,
    dicom_redacted_count: hasConversionToken
      ? dicomData.dicom_redacted_count
      : totalRedactedCount,
    dicom_redaction_failed_count: hasConversionToken
      ? dicomData.dicom_redaction_failed_count
      : totalRedactionFailedCount,
    dicom_failed_count: hasConversionToken
      ? dicomData.dicom_failed_count
      : totalFailedCount,
    dicom_converted_files: hasConversionToken
      ? dicomData.dicom_converted_files
      : convertedFiles.slice(0, 20),
    dicom_redaction_failed_files: hasConversionToken
      ? dicomData.dicom_redaction_failed_files
      : redactionFailedFiles.slice(0, 20),
    dicom_failed_files: hasConversionToken
      ? dicomData.dicom_failed_files
      : failedFiles.slice(0, 20),
  };
}

/* ===================== UPLOAD ===================== */

export async function uploadDicomToStudy(
  studyId: number | string,
  dicomFiles: File[],
  options?: DicomUploadOptions
): Promise<UploadResult> {
  const numericStudyId = Number(studyId);
  if (!Number.isFinite(numericStudyId) || numericStudyId <= 0) {
    throw new Error('A valid study ID is required before uploading DICOM files.');
  }
  if (!dicomFiles.length && !options?.conversionToken) {
    throw new Error('Select DICOM files before uploading.');
  }

  return uploadDicomFilesToStudy(numericStudyId, dicomFiles, options);
}

export async function uploadStudy(
  payload: UploadStudyPayload,
  dicomFiles: File[],
  mp4File?: File | null,
  pdfFile?: File | null,
  options?: DicomUploadOptions
): Promise<UploadResult> {
  const onProgress = options?.onProgress;
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const totalFiles = dicomFiles.length;
  const hasConversionToken = Boolean(options?.conversionToken);

  onProgress?.({
    stage: 'creating_study',
    percent: 2,
    message: 'Creating study record...',
    totalFiles,
    processedFiles: 0,
    filesRemaining: totalFiles,
  });

  const study = await request<Study>('/studies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      patient_name: payload.patient_name || '',
      patient_id: payload.patient_id || '',
      patient_age: payload.patient_age || '',
      patient_dob: payload.patient_dob || '',
      patient_sex: payload.patient_sex || '',
      patient_zip: payload.patient_zip || '',
      study_date: payload.study_date || '',
      octrqaui: payload.octrqaui || '',
      octraccui: payload.octraccui || '',
      client_email: payload.client_email || '',
      client_name: payload.client_name || '',
      subclient: payload.subclient || '',
      md_name: payload.md_name || '',
      revenue: payload.revenue || '',
      modality: payload.modality || '',
      notes: payload.notes || '',
      tech_notes: payload.tech_notes || '',
      radiologist_notes: payload.radiologist_notes || '',
      radiology_report: payload.radiology_report || '',
    }),
  });

  const dicomData = await uploadDicomFilesToStudy(study.id, dicomFiles, options);
  const processedFiles = dicomFiles.length;

  // Upload MP4 (optional)
  if (mp4File && study.id) {
    onProgress?.({
      stage: 'uploading_mp4',
      percent: 92,
      message: 'Uploading video for backend optimization...',
      totalFiles,
      processedFiles: processedFiles || totalFiles,
      filesRemaining: Math.max(0, totalFiles - (processedFiles || totalFiles)),
    });

    const mp4Data = new FormData();
    mp4Data.append('mp4_file', mp4File);

    await request(`/upload-mp4/${study.id}`, {
      method: 'POST',
      headers: authHeaders,
      body: mp4Data,
    });
  }

  if (pdfFile && study.id) {
    onProgress?.({
      stage: 'uploading_pdf',
      percent: 97,
      message: 'Uploading PDF report...',
      totalFiles,
      processedFiles: processedFiles || totalFiles,
      filesRemaining: Math.max(0, totalFiles - (processedFiles || totalFiles)),
    });

    const pdfData = new FormData();
    pdfData.append('pdf_file', pdfFile);

    await request(`/studies/${study.id}/pdf`, {
      method: 'POST',
      headers: authHeaders,
      body: pdfData,
    });
  }

  onProgress?.({
    stage: 'finalizing',
    percent: 100,
    message: mp4File ? 'Upload complete. Video optimization is processing in the background.' : 'Upload complete.',
    totalFiles,
    processedFiles: processedFiles || totalFiles,
    filesRemaining: 0,
  });

  return {
    ...dicomData,
    study_id: study.id,
  };
}

export async function preconvertDicomFiles(
  dicomFiles: File[],
  options?: { convertJpeg2000ToDcm?: boolean; auth?: StudyApiAuthContext }
): Promise<DicomPreconvertResult> {
  const formData = new FormData();
  formData.append(
    'convert_jpeg2000_to_dcm',
    options?.convertJpeg2000ToDcm === false ? '0' : '1'
  );

  dicomFiles.forEach((file) => {
    formData.append('dicom_files', file);
  });

  return request<DicomPreconvertResult>('/dicom/preconvert-jpeg2000', {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
    body: formData,
  });
}

/* ===================== STUDIES ===================== */

export async function fetchStorageStatus(options?: { auth?: StudyApiAuthContext }): Promise<StorageStatus> {
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller
    ? globalThis.setTimeout(() => controller.abort(), 2500)
    : 0;

  try {
    return request<StorageStatus>(
      '/storage',
      {
        ...(Object.keys(authHeaders).length > 0 ? { headers: authHeaders } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      }
    );
  } finally {
    if (timeoutId) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

export async function listRevenueAdjustments(options?: {
  auth?: StudyApiAuthContext;
}): Promise<RevenueAdjustment[]> {
  const payload = await request<{ ok?: boolean; adjustments?: RevenueAdjustment[] }>('/revenue/adjustments', {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(payload.adjustments) ? payload.adjustments : [];
}

export async function addRevenueAdjustment(
  payload: {
    date: string;
    amount: number;
    label: string;
    client_name?: string;
    subclient?: string;
    notes?: string;
  },
  options?: { auth?: StudyApiAuthContext }
): Promise<RevenueAdjustment> {
  const response = await request<{ ok?: boolean; adjustment?: RevenueAdjustment }>('/revenue/adjustments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(payload),
  });
  if (!response.adjustment) throw new Error('Revenue adjustment was not saved.');
  return response.adjustment;
}

export async function deleteRevenueAdjustment(
  id: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<void> {
  await request(`/revenue/adjustments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function listFormSubmissions(options?: {
  auth?: StudyApiAuthContext;
  type?: string;
  q?: string;
  limit?: number;
}): Promise<FormSubmission[]> {
  const query = new URLSearchParams();
  if (options?.type && options.type !== 'all') query.set('type', options.type);
  if (options?.q?.trim()) query.set('q', options.q.trim());
  if (options?.limit) query.set('limit', String(options.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const payload = await request<{ ok?: boolean; submissions?: FormSubmission[] }>(`/form-submissions${suffix}`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(payload.submissions) ? payload.submissions : [];
}

export async function syncFormSubmissions(options?: {
  auth?: StudyApiAuthContext;
}): Promise<FormSubmissionSyncResult> {
  const payload = await request<{ ok?: boolean } & Partial<FormSubmissionSyncResult>>('/form-submissions/sync', {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return {
    fetched: Number(payload.fetched) || 0,
    created: Number(payload.created) || 0,
    updated: Number(payload.updated) || 0,
    total: Number(payload.total) || 0,
  };
}

export async function listUpcomingPatients(options?: {
  auth?: StudyApiAuthContext;
  q?: string;
  limit?: number;
  sync?: boolean;
}): Promise<{ upcomingPatients: UpcomingPatient[]; sync?: Partial<FormSubmissionSyncResult> | null }> {
  const query = new URLSearchParams();
  if (options?.q?.trim()) query.set('q', options.q.trim());
  if (options?.limit) query.set('limit', String(options.limit));
  if (options?.sync) query.set('sync', '1');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const payload = await request<{
    ok?: boolean;
    upcoming_patients?: UpcomingPatient[];
    sync?: Partial<FormSubmissionSyncResult> | null;
  }>(`/upcoming-patients${suffix}`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return {
    upcomingPatients: Array.isArray(payload.upcoming_patients) ? payload.upcoming_patients : [],
    sync: payload.sync || null,
  };
}

export async function fetchStudies(options?: {
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  auth?: StudyApiAuthContext;
}): Promise<Study[]> {
  const query = new URLSearchParams();
  if (options?.includeDeleted) query.set('include_deleted', '1');
  if (options?.deletedOnly) query.set('deleted_only', '1');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const data = await request<unknown>(
    `/studies${suffix}`,
    Object.keys(authHeaders).length > 0 ? { headers: authHeaders } : undefined
  );
  return normalizeStudiesPayload(data);
}

export interface TenantGovernanceStudy {
  id: number;
  tenant_id?: string | null;
  patient_name?: string | null;
  patient_id?: string | null;
  modality?: string | null;
  study_date?: string | null;
  created_at?: string | null;
  nextcloud_url?: string | null;
  nextcloud_export_status?: string | null;
  local_media_bytes?: number;
  orthanc_storage_bytes?: number;
  orthanc_uncompressed_bytes?: number;
  orthanc_storage_status?: string | null;
  orthanc_storage_refreshed_at?: string | null;
  total_storage_bytes?: number;
  plan_id: string;
  hosted_by_octelerad: boolean;
  requires_customer_download: boolean;
  customer_download_required_by?: string | null;
}

export interface TenantAuditEvent {
  ts: string;
  event: string;
  tenant_id?: string | null;
  study_id?: number | null;
  actor_email?: string | null;
  actor_role?: string | null;
  action?: string | null;
  result?: string;
  details?: Record<string, unknown>;
}

export interface TenantGovernanceSummary {
  tenant_id?: string | null;
  name: string;
  slug?: string | null;
  status: string;
  plan_id: string;
  plan_label: string;
  hosted_by_octelerad: boolean;
  requires_customer_download: boolean;
  retention_days?: number | null;
  study_count: number;
  active_study_count: number;
  deleted_study_count: number;
  dicom_count: number;
  local_media_bytes: number;
  orthanc_storage_bytes: number;
  orthanc_uncompressed_bytes: number;
  total_storage_bytes: number;
  orthanc_storage_cached_count: number;
  orthanc_storage_missing_count: number;
  orthanc_storage_error_count: number;
  nextcloud_exported_count: number;
  due_within_24h_count: number;
  overdue_count: number;
  downloaded_count: number;
  oldest_download_deadline?: string | null;
  newest_study_at?: string | null;
}

export async function fetchTenantGovernanceStudies(options?: {
  auth?: StudyApiAuthContext;
}): Promise<TenantGovernanceStudy[]> {
  const payload = await request<{ ok?: boolean; studies?: TenantGovernanceStudy[] }>('/tenant-governance/studies', {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(payload.studies) ? payload.studies : [];
}

export async function fetchTenantGovernanceSummaries(options?: {
  auth?: StudyApiAuthContext;
}): Promise<TenantGovernanceSummary[]> {
  const payload = await request<{ ok?: boolean; tenants?: TenantGovernanceSummary[] }>('/tenant-governance/tenants', {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(payload.tenants) ? payload.tenants : [];
}

export async function fetchTenantAuditEvents(options?: {
  auth?: StudyApiAuthContext;
  tenantId?: string;
  limit?: number;
}): Promise<TenantAuditEvent[]> {
  const query = new URLSearchParams();
  if (options?.tenantId) query.set('tenant_id', options.tenantId);
  if (options?.limit) query.set('limit', String(options.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const payload = await request<{ ok?: boolean; events?: TenantAuditEvent[] }>(`/tenant-governance/audit${suffix}`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(payload.events) ? payload.events : [];
}

export async function refreshOrthancStorageAccounting(options?: {
  auth?: StudyApiAuthContext;
  tenantId?: string | null;
}): Promise<{ ok: boolean; requested: number; refreshed: number; failed: number }> {
  return request('/tenant-governance/orthanc-storage/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(options?.tenantId ? { tenant_id: options.tenantId } : {}),
  });
}

export async function updateStudyRetention(
  studyId: string | number,
  payload: { action: 'mark_downloaded' } | { action: 'extend_deadline'; days: number; reason?: string },
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; study: Study; retention?: Record<string, unknown> }> {
  return request(`/tenant-governance/studies/${encodeURIComponent(String(studyId))}/retention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(payload),
  });
}

export async function createStudyRecord(payload: UploadStudyPayload): Promise<Study> {
  const response = await request<{ ok?: boolean; study?: Study }>('/studies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patient_name: payload.patient_name || '',
      patient_id: payload.patient_id || '',
      patient_age: payload.patient_age || '',
      patient_dob: payload.patient_dob || '',
      patient_sex: payload.patient_sex || '',
      patient_zip: payload.patient_zip || '',
      study_date: payload.study_date || '',
      octrqaui: payload.octrqaui || '',
      octraccui: payload.octraccui || '',
      client_email: payload.client_email || '',
      client_name: payload.client_name || '',
      subclient: payload.subclient || '',
      md_name: payload.md_name || '',
      revenue: payload.revenue || '',
      modality: payload.modality || '',
      notes: payload.notes || '',
      tech_notes: payload.tech_notes || '',
      radiologist_notes: payload.radiologist_notes || '',
      radiology_report: payload.radiology_report || '',
    }),
  });

  if (!response?.study) {
    throw new Error('Failed to create study record.');
  }

  return response.study;
}

export async function startLiveCase(payload: {
  study_id?: number;
  patient_name?: string;
  patient_age?: string;
  patient_dob?: string;
  patient_sex?: string;
  patient_zip?: string;
  study_date?: string;
  octrqaui?: string;
  octraccui?: string;
  client_email?: string;
  client_name?: string;
  subclient?: string;
  md_name?: string;
  revenue?: string;
  modality?: string;
  notes?: string;
  tech_notes?: string;
  radiologist_notes?: string;
  radiology_report?: string;
  started_by_email?: string;
  started_by_name?: string;
}, options?: { auth?: StudyApiAuthContext }): Promise<{ session: LiveCaseSession; study: Study }> {
  const response = await request<{ ok?: boolean; session?: LiveCaseSession; study?: Study }>('/live-cases/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(payload || {}),
  });
  if (!response?.session || !response?.study) {
    throw new Error('Failed to start live case.');
  }
  return { session: response.session, study: response.study };
}

export async function listActiveLiveCases(
  startedByEmail?: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<LiveCaseSession[]> {
  const query = new URLSearchParams();
  if (startedByEmail) query.set('started_by_email', startedByEmail);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await request<{ ok?: boolean; sessions?: LiveCaseSession[] }>(`/live-cases/active${suffix}`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(response?.sessions) ? response.sessions : [];
}

export async function heartbeatLiveCase(
  sessionId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<void> {
  await request(`/live-cases/${encodeURIComponent(sessionId)}/heartbeat`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function stopLiveCase(
  sessionId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<void> {
  await request(`/live-cases/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function uploadLiveCaseRecording(
  sessionId: string,
  recordingFile: Blob,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ study?: Study; queued?: boolean; finalize_job_id?: string }> {
  const formData = new FormData();
  formData.append('recording_file', recordingFile, `live-case-${Date.now()}.webm`);
  await appendRecordingIntegrityFields(formData, recordingFile);
  const response = await request<{ ok?: boolean; study?: Study; queued?: boolean; job?: { id: string; status: string } }>(
    `/live-cases/${encodeURIComponent(sessionId)}/upload-recording`,
    { method: 'POST', headers: buildStudyApiAuthHeaders(options?.auth), body: formData }
  );
  if (response?.queued && response?.job?.id) {
    return { queued: true, finalize_job_id: response.job.id };
  }
  if (!response?.study) {
    throw new Error('Failed to finalize live case recording.');
  }
  return { study: response.study };
}

export async function getLiveFinalizeJob(
  jobId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ id: string; status: string; error?: string; mp4_url?: string | null }> {
  const response = await request<{ ok?: boolean; job?: { id: string; status: string; error?: string; mp4_url?: string | null } }>(
    `/live-cases/finalize-jobs/${encodeURIComponent(jobId)}`,
    {
      headers: buildStudyApiAuthHeaders(options?.auth),
    }
  );
  if (!response?.job) {
    throw new Error('Finalize job not found.');
  }
  return response.job;
}

export async function fetchStudyById(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
) {
  return request(`/studies/${id}`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function updateStudy(
  id: string | number,
  payload: UpdateStudyPayload,
  options?: { auth?: StudyApiAuthContext; baseUpdatedAt?: string }
): Promise<{ ok: boolean; study: Study }> {
  return request(`/studies/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify({
      ...payload,
      base_updated_at: options?.baseUpdatedAt || payload.base_updated_at,
    }),
  });
}

export async function completeStudy(
  id: string | number,
  payload?: {
    radiology_report?: string;
    completion_note?: string;
    recorded_by?: string;
    transcribed_by?: string;
    reading_location?: ReadingLocation;
    browser_context?: {
      user_agent?: string;
      timezone?: string;
      language?: string;
      platform?: string;
    };
  },
  options?: { auth?: StudyApiAuthContext; baseUpdatedAt?: string }
): Promise<{ ok: boolean; study: Study }> {
  return request(`/studies/${id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify({
      ...(payload || {}),
      base_updated_at: options?.baseUpdatedAt || (payload as { base_updated_at?: string } | undefined)?.base_updated_at,
    }),
  });
}

export async function fetchAcronym(code: string): Promise<{ ok: boolean; acronym: AcronymEntry }> {
  return request(`/acronyms/${encodeURIComponent(code)}`);
}

export async function searchAcronyms(query: string): Promise<{ ok: boolean; count: number; results: AcronymEntry[] }> {
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  return request(`/acronyms${suffix}`);
}

export async function fetchStudyPriors(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ study_id: number; prior_study_ids: number[]; priors: Study[] }> {
  return request(`/studies/${id}/priors`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function updateStudyPriors(
  id: string | number,
  priorStudyIds: Array<string | number>,
  options?: { auth?: StudyApiAuthContext; baseUpdatedAt?: string }
): Promise<{ ok: boolean; study_id: number; prior_study_ids: number[]; priors: Study[]; study: Study }> {
  return request(`/studies/${id}/priors`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify({
      prior_study_ids: priorStudyIds,
      base_updated_at: options?.baseUpdatedAt,
    }),
  });
}

export async function updateStudyTechNotes(
  id: string | number,
  techNotes: string,
  options?: { auth?: StudyApiAuthContext; baseUpdatedAt?: string }
): Promise<{ ok: boolean; study: Study }> {
  return request(`/studies/${id}/tech-notes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify({
      tech_notes: techNotes,
      base_updated_at: options?.baseUpdatedAt,
    }),
  });
}

export async function fetchStudyReports(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; study_id: number; reports: CaseReport[] }> {
  return request(`/studies/${id}/reports`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function addStudyReport(
  id: string | number,
  payload: {
    title?: string;
    caseLabel?: string;
    reportType?: string;
    textReport?: string;
    file?: File | null;
    baseUpdatedAt?: string;
  },
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; report: CaseReport; reports: CaseReport[]; study: Study }> {
  const formData = new FormData();
  if (payload.title) formData.append('title', payload.title);
  if (payload.caseLabel) formData.append('case_label', payload.caseLabel);
  if (payload.reportType) formData.append('report_type', payload.reportType);
  if (payload.textReport) formData.append('text_report', payload.textReport);
  if (payload.file) formData.append('report_file', payload.file);
  if (payload.baseUpdatedAt) formData.append('base_updated_at', payload.baseUpdatedAt);

  return request(`/studies/${id}/reports`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
    body: formData,
  });
}

export async function uploadStudyDictation(
  id: string | number,
  payload: {
    audioFile: Blob;
    transcript?: string;
    title?: string;
    caseLabel?: string;
    baseUpdatedAt?: string;
  },
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; report: CaseReport; reports: CaseReport[]; study: Study }> {
  const formData = new FormData();
  const filename = payload.audioFile instanceof File ? payload.audioFile.name : `dictation-${Date.now()}.webm`;
  formData.append('audio_file', payload.audioFile, filename);
  if (payload.transcript) formData.append('transcript', payload.transcript);
  if (payload.title) formData.append('title', payload.title);
  if (payload.caseLabel) formData.append('case_label', payload.caseLabel);
  if (payload.baseUpdatedAt) formData.append('base_updated_at', payload.baseUpdatedAt);

  return request(`/studies/${id}/dictations`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
    body: formData,
  });
}

/* ===================== VIEWER ===================== */

export async function getViewerLink(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ viewer_url: string }> {
  return request(`/viewer-link/${id}`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function listDicomInstances(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ study_id: number; total: number; instances: DicomInstance[] }> {
  return request(`/studies/${id}/dicom-instances`, {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function downloadDicomScreenshot(
  instanceId: string,
  frame = 0
): Promise<Blob> {
  const urls = getDicomScreenshotUrls(instanceId, frame, true);
  let lastError: Error | null = null;

  for (const url of urls) {
    const res = await fetch(url);

    if (res.ok) {
      return res.blob();
    }

    const data = await res.json().catch(() => ({}));
    lastError = new Error(data.error || `Request failed (${res.status})`);
  }

  throw lastError || new Error('Failed to capture screenshot');
}

export function getDicomScreenshotUrl(instanceId: string, frame = 0): string {
  return getDicomScreenshotUrls(instanceId, frame)[0];
}

export function getDicomScreenshotUrls(
  instanceId: string,
  frame = 0,
  download = false
): string[] {
  const query = new URLSearchParams({
    frame: String(frame),
  });

  if (download) {
    query.set('download', '1');
  }

  const path = `/dicom-instances/${encodeURIComponent(instanceId)}/screenshot?${query.toString()}`;

  return unique(getApiBaseCandidates().map((baseUrl) => toAbsoluteUrl(path, baseUrl)));
}

/* ===================== DELETE ===================== */

export async function deleteStudy(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ success: boolean }> {
  return request(`/studies/${id}`, {
    method: 'DELETE',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function restoreStudy(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; study: Study }> {
  return request(`/studies/${id}/restore`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function permanentlyDeleteStudy(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ success: boolean }> {
  return request(`/studies/${id}/permanent`, {
    method: 'DELETE',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

/* ===================== SHARE ===================== */

export async function createShareLink(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ token: string; share_url: string; expires_at?: string }> {
  return request(`/studies/${id}/share`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function fetchSharedStudy(token: string): Promise<Study> {
  return request(`/shared/${token}`);
}

/* ===================== EXPORT CLOUD ============== */

export async function exportToCloud(
  id: string | number,
  options?: { auth?: StudyApiAuthContext }
): Promise<{ success: boolean; folder: string; url: string; study?: Study }> {
  return request(`/studies/${id}/export-nextcloud`, {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

export async function exportPatientSummaryToCloud(
  payload: PatientSummaryExportPayload,
  options?: { auth?: StudyApiAuthContext }
): Promise<PatientSummaryExportResult> {
  return request('/patient-summaries/export-nextcloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(payload),
  });
}

function parseAttachmentFilename(contentDisposition: string | null) {
  if (!contentDisposition) return '';
  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  return match && match[1] ? match[1].trim() : '';
}

export async function exportCaseStream(
  studyIds: Array<string | number>,
  options?: CaseStreamRequestOptions
): Promise<CaseStreamExportResult> {
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const body = JSON.stringify({
    study_ids: studyIds,
    fps: options?.fps,
    max_frames: options?.maxFrames,
    study_layouts: options?.studyLayouts,
  });

  let lastError: Error | null = null;

  const baseCandidates = getApiBaseCandidates();

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const baseUrl = baseCandidates[index];
    const hasNextCandidate = index < baseCandidates.length - 1;

    try {
      const res = await fetch(`${baseUrl}/case-stream/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body,
      });

      if (res.ok) {
        const filename = parseAttachmentFilename(res.headers.get('content-disposition')) || `case-stream-${Date.now()}.mp4`;
        return {
          blob: await res.blob(),
          filename,
        };
      }

      const data = await res.json().catch(() => ({}));
      const message = toErrorMessage(data, res.status);

      if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && res.status === 404) {
        lastError = new Error(message);
        continue;
      }

      if (res.status === 401) {
        throw new AuthSessionError(message);
      }

      throw new Error(message);
    } catch (error) {
      if (!(error instanceof Error)) {
        lastError = new Error('Case stream export failed');
        continue;
      }

      if (error instanceof TypeError) {
        lastError = formatApiNetworkError();
        continue;
      }

      throw error;
    }
  }

  throw lastError || formatApiNetworkError();
}

export async function createCaseStreamJob(
  studyIds: Array<string | number>,
  options?: CaseStreamRequestOptions
): Promise<CaseStreamJob> {
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const payload = await request<{ ok?: boolean; job?: CaseStreamJob }>('/case-stream/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      study_ids: studyIds,
      fps: options?.fps,
      max_frames: options?.maxFrames,
      study_layouts: options?.studyLayouts,
    }),
  });

  if (!payload || !payload.job) {
    throw new Error('Case stream job creation returned an invalid response.');
  }

  return payload.job;
}

export async function getCaseStreamJob(
  jobId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamJob> {
  const payload = await request<{ ok?: boolean; job?: CaseStreamJob }>(
    `/case-stream/jobs/${encodeURIComponent(jobId)}`,
    {
      headers: buildStudyApiAuthHeaders(options?.auth),
    }
  );

  if (!payload || !payload.job) {
    throw new Error('Case stream job status returned an invalid response.');
  }

  return payload.job;
}

export async function downloadCaseStreamJob(
  jobId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamExportResult> {
  let lastError: Error | null = null;
  const baseCandidates = getApiBaseCandidates();
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const baseUrl = baseCandidates[index];
    const hasNextCandidate = index < baseCandidates.length - 1;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), CASE_STREAM_DOWNLOAD_TIMEOUT_MS);
      const res = await fetch(`${baseUrl}/case-stream/jobs/${encodeURIComponent(jobId)}/download`, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      });
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (res.ok) {
        const filename = parseAttachmentFilename(res.headers.get('content-disposition')) || `case-stream-${jobId}.mp4`;
        return {
          blob: await res.blob(),
          filename,
        };
      }

      const data = await res.json().catch(() => ({}));
      const message = toErrorMessage(data, res.status);
      if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && res.status === 404) {
        lastError = new Error(message);
        continue;
      }
      if (res.status === 401) {
        throw new AuthSessionError(message);
      }
      throw new Error(message);
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (!(error instanceof Error)) {
        lastError = new Error('Case stream download failed');
        continue;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new Error('Case stream download timed out. Please try downloading again.');
        continue;
      }

      if (error instanceof TypeError) {
        lastError = formatApiNetworkError();
        continue;
      }

      throw error;
    }
  }

  throw lastError || formatApiNetworkError();
}

export function getCaseStreamJobDownloadUrl(jobId: string): string {
  const path = `/case-stream/jobs/${encodeURIComponent(jobId)}/download`;
  return `${getApiBaseCandidates()[0]}${path}`;
}

export async function cancelCaseStreamJob(
  jobId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamJob> {
  const payload = await request<{ ok?: boolean; job?: CaseStreamJob }>(
    `/case-stream/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: 'POST',
      headers: buildStudyApiAuthHeaders(options?.auth),
    }
  );

  if (!payload || !payload.job) {
    throw new Error('Case stream cancel returned an invalid response.');
  }

  return payload.job;
}

export async function listSavedCaseStreams(options?: {
  auth?: StudyApiAuthContext;
}): Promise<CaseStreamLibraryItem[]> {
  const payload = await request<{ ok?: boolean; streams?: CaseStreamLibraryItem[] }>('/case-stream/library', {
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
  return Array.isArray(payload?.streams) ? payload.streams : [];
}

export function getCaseStreamJobFrameUrl(jobId: string, frameIndex: number): string {
  return `/api/case-stream/jobs/${encodeURIComponent(jobId)}/frames/${Math.max(0, Math.floor(frameIndex))}`;
}

export function getSavedCaseStreamFrameUrl(streamId: string, frameIndex: number): string {
  return `/api/case-stream/library/${encodeURIComponent(streamId)}/frames/${Math.max(0, Math.floor(frameIndex))}`;
}

export async function prewarmCaseStreamJobFrames(
  jobId: string,
  frameIndex: number,
  options?: { auth?: StudyApiAuthContext; radius?: number }
): Promise<void> {
  await request(`/case-stream/jobs/${encodeURIComponent(jobId)}/frames/prewarm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify({
      frame_index: Math.max(0, Math.floor(frameIndex)),
      radius: Math.max(4, Math.floor(options?.radius || 72)),
    }),
  });
}

export async function prewarmSavedCaseStreamFrames(
  streamId: string,
  frameIndex: number,
  options?: { auth?: StudyApiAuthContext; radius?: number }
): Promise<void> {
  await request(`/case-stream/library/${encodeURIComponent(streamId)}/frames/prewarm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify({
      frame_index: Math.max(0, Math.floor(frameIndex)),
      radius: Math.max(4, Math.floor(options?.radius || 72)),
    }),
  });
}

export async function getSavedCaseStreamPresentation(
  streamId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamPresentationManifest> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8000);

  let payload: { ok?: boolean; presentation?: CaseStreamPresentationManifest } | null = null;
  try {
    payload = await request<{ ok?: boolean; presentation?: CaseStreamPresentationManifest }>(
      `/case-stream/library/${encodeURIComponent(streamId)}/presentation`,
      {
        headers: buildStudyApiAuthHeaders(options?.auth),
        signal: controller.signal,
      }
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Case presentation request timed out.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!payload?.presentation || !Array.isArray(payload.presentation.cases)) {
    throw new Error('Case presentation returned an invalid response.');
  }

  return payload.presentation;
}

export async function downloadSavedCaseStream(
  streamId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamExportResult> {
  let lastError: Error | null = null;
  const baseCandidates = getApiBaseCandidates();
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const baseUrl = baseCandidates[index];
    const hasNextCandidate = index < baseCandidates.length - 1;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), CASE_STREAM_DOWNLOAD_TIMEOUT_MS);
      const res = await fetch(`${baseUrl}/case-stream/library/${encodeURIComponent(streamId)}/download`, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      });
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (res.ok) {
        const filename = parseAttachmentFilename(res.headers.get('content-disposition')) || `case-stream-${streamId}.mp4`;
        return {
          blob: await res.blob(),
          filename,
        };
      }

      const data = await res.json().catch(() => ({}));
      const message = toErrorMessage(data, res.status);
      if (hasNextCandidate && isProxyLikeApiBase(baseUrl) && res.status === 404) {
        lastError = new Error(message);
        continue;
      }
      if (res.status === 401) {
        throw new AuthSessionError(message);
      }
      throw new Error(message);
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (!(error instanceof Error)) {
        lastError = new Error('Saved stream download failed');
        continue;
      }

      if (error.name === 'AbortError') {
        lastError = new Error('Saved stream download timed out. Please try again.');
        continue;
      }

      if (error instanceof TypeError) {
        lastError = formatApiNetworkError();
        continue;
      }

      throw error;
    }
  }

  throw lastError || formatApiNetworkError();
}

export async function saveCaseStreamToLibrary(
  jobId: string,
  name: string,
  options?: { auth?: StudyApiAuthContext; assignedMdEmail?: string; assignedMdName?: string }
): Promise<CaseStreamLibraryItem> {
  const authHeaders = buildStudyApiAuthHeaders(options?.auth);
  const payload = await request<{ ok?: boolean; stream?: CaseStreamLibraryItem }>('/case-stream/library', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      job_id: jobId,
      name: name,
      assigned_md_email: options?.assignedMdEmail || '',
      assigned_md_name: options?.assignedMdName || '',
    }),
  });

  if (!payload?.stream) {
    throw new Error('Failed to save stream.');
  }

  return payload.stream;
}

export async function repairSavedCaseStream(
  streamId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamLibraryItem> {
  const payload = await request<{ ok?: boolean; stream?: CaseStreamLibraryItem }>(
    `/case-stream/library/${encodeURIComponent(streamId)}/repair`,
    {
      method: 'POST',
      headers: buildStudyApiAuthHeaders(options?.auth),
    }
  );

  if (!payload?.stream) {
    throw new Error('Failed to repair saved stream.');
  }

  return payload.stream;
}

export async function assignSavedCaseStream(
  streamId: string,
  assignment: {
    assignedMdEmail?: string;
    assignedMdName?: string;
    readingStatus?: CaseStreamLibraryItem['reading_status'];
  },
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamLibraryItem> {
  const payload = await request<{ ok?: boolean; stream?: CaseStreamLibraryItem }>(
    `/case-stream/library/${encodeURIComponent(streamId)}/assignment`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
      body: JSON.stringify({
        assigned_md_email: assignment.assignedMdEmail || '',
        assigned_md_name: assignment.assignedMdName || '',
        reading_status: assignment.readingStatus || 'assigned',
      }),
    }
  );

  if (!payload?.stream) {
    throw new Error('Failed to assign saved stream.');
  }

  return payload.stream;
}

export async function updateSavedCaseStreamReadingStatus(
  streamId: string,
  readingStatus: Exclude<CaseStreamLibraryItem['reading_status'], 'unassigned' | undefined>,
  options?: { auth?: StudyApiAuthContext }
): Promise<CaseStreamLibraryItem> {
  const payload = await request<{ ok?: boolean; stream?: CaseStreamLibraryItem }>(
    `/case-stream/library/${encodeURIComponent(streamId)}/reading-status`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
      body: JSON.stringify({
        reading_status: readingStatus,
      }),
    }
  );

  if (!payload?.stream) {
    throw new Error('Failed to update stream reading status.');
  }

  return payload.stream;
}

export async function deleteSavedCaseStream(
  streamId: string,
  options?: { auth?: StudyApiAuthContext }
): Promise<void> {
  await request(`/case-stream/library/${encodeURIComponent(streamId)}`, {
    method: 'DELETE',
    headers: buildStudyApiAuthHeaders(options?.auth),
  });
}

function buildStudyApiAuthHeaders(auth?: StudyApiAuthContext): Record<string, string> {
  if (!auth?.email) return {};
  const headers: Record<string, string> = {
    'x-user-email': auth.email,
    'x-user-role': auth.role || '',
    'x-user-name': auth.name || '',
  };
  if (auth.isSuperAdmin) {
    headers['x-user-super-admin'] = '1';
  }
  if (Array.isArray(auth.whiteLabelAccountIds) && auth.whiteLabelAccountIds.length > 0) {
    headers['x-white-label-account-ids'] = auth.whiteLabelAccountIds.join(',');
  }
  if (auth.primaryWhiteLabelAccountId) {
    headers['x-primary-white-label-account-id'] = auth.primaryWhiteLabelAccountId;
  }
  if (auth.whiteLabelAccessLevel) {
    headers['x-white-label-access-level'] = auth.whiteLabelAccessLevel;
  }
  return headers;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSseMessage(raw: string): { event?: string; data?: string } | null {
  const lines = raw.split(/\r?\n/);
  let event = '';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!event && dataLines.length === 0) return null;
  return {
    event: event || 'message',
    data: dataLines.join('\n'),
  };
}

export async function setStudyPresence(
  id: string | number,
  payload: { client_id: string; mode?: 'viewing' | 'editing' | 'signoff' | string },
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; presence: StudyPresenceEntry[]; entry: StudyPresenceEntry }> {
  return request(`/studies/${id}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(payload || {}),
  });
}

export async function clearStudyPresence(
  id: string | number,
  payload: { client_id: string },
  options?: { auth?: StudyApiAuthContext }
): Promise<{ ok: boolean; removed: boolean; presence: StudyPresenceEntry[] }> {
  return request(`/studies/${id}/presence`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...buildStudyApiAuthHeaders(options?.auth) },
    body: JSON.stringify(payload || {}),
  });
}

export function subscribeStudyRealtime(options: {
  auth?: StudyApiAuthContext;
  clientId: string;
  studyId?: string | number;
  onEvent: (event: StudyRealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}): { close: () => void } {
  const controller = new AbortController();
  let closed = false;
  let retryDelay = 1000;
  const studyId = options.studyId !== undefined && options.studyId !== null ? String(options.studyId) : '';

  const connect = async () => {
    while (!closed && !controller.signal.aborted) {
      try {
        const url = new URL(toAbsoluteUrl('/studies/stream', BASE_URL));
        url.searchParams.set('client_id', options.clientId);
        if (studyId) url.searchParams.set('study_id', studyId);

        const response = await fetch(url.toString(), {
          headers: buildStudyApiAuthHeaders(options.auth),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`Realtime stream failed (${response.status})`);
        }

        options.onConnectionChange?.(true);
        retryDelay = 1000;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!closed && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseMessage(raw);
            if (!parsed?.event || !parsed.data) continue;
            try {
              const payload = JSON.parse(parsed.data) as StudyRealtimeEvent;
              options.onEvent({
                ...payload,
                event: payload.event || parsed.event,
              });
            } catch (error) {
              options.onError?.(error instanceof Error ? error : new Error('Failed to parse realtime payload'));
            }
          }
        }
      } catch (error) {
        if (closed || controller.signal.aborted) break;
        options.onConnectionChange?.(false);
        options.onError?.(error instanceof Error ? error : new Error('Realtime connection failed'));
        await sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
        continue;
      }
    }
    options.onConnectionChange?.(false);
  };

  void connect();

  return {
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}

export async function uploadCaseRecording(
  payload: {
    recordingFile: Blob;
    caseId?: string;
    studyId: string | number;
    studyInstanceUID?: string;
    patientId?: string;
    uploadedBy?: string;
  },
  auth?: StudyApiAuthContext
): Promise<{ ok: boolean; recording: CaseRecording }> {
  const formData = new FormData();
  formData.append('recording_file', payload.recordingFile, `case-recording-${Date.now()}.webm`);
  await appendRecordingIntegrityFields(formData, payload.recordingFile);
  formData.append('studyId', String(payload.studyId));
  if (payload.caseId) formData.append('caseId', payload.caseId);
  if (payload.studyInstanceUID) formData.append('studyInstanceUID', payload.studyInstanceUID);
  if (payload.patientId) formData.append('patientId', payload.patientId);
  if (payload.uploadedBy) formData.append('uploadedBy', payload.uploadedBy);

  return request('/case-recordings/upload', {
    method: 'POST',
    headers: buildStudyApiAuthHeaders(auth),
    body: formData,
  });
}

export async function listCaseRecordings(
  payload: {
    studyId?: string | number;
    caseId?: string;
  },
  auth?: StudyApiAuthContext
): Promise<{ ok: boolean; recordings: CaseRecording[] }> {
  const query = new URLSearchParams();
  if (payload.studyId !== undefined && payload.studyId !== null) {
    query.set('studyId', String(payload.studyId));
  }
  if (payload.caseId) {
    query.set('caseId', payload.caseId);
  }
  query.set('_ts', String(Date.now()));
  return request(`/case-recordings?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      ...buildStudyApiAuthHeaders(auth),
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  });
}

export async function uploadCaseReportPdfs(
  files: File[]
): Promise<{ ok: boolean; reports: CaseReportUploadItem[] }> {
  const formData = new FormData();
  files.forEach((file) => {
    formData.append('pdf_files', file);
  });

  return request('/case-reports/upload', {
    method: 'POST',
    body: formData,
  });
}
