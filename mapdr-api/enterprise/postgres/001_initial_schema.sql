-- Initial enterprise schema scaffold for MapDR API
-- Phase 1: create tables in parallel with existing JSON/file storage.

CREATE TABLE IF NOT EXISTS studies (
  id BIGSERIAL PRIMARY KEY,
  patient_name TEXT NOT NULL,
  patient_id TEXT,
  study_date TEXT,
  modality TEXT,
  notes TEXT,
  tech_notes TEXT,
  mp4_url TEXT,
  pdf_url TEXT,
  orthanc_patient_id TEXT,
  orthanc_study_id TEXT,
  dicom_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  share_token TEXT,
  share_expires_at TIMESTAMPTZ,
  nextcloud_folder TEXT,
  nextcloud_url TEXT,
  prior_study_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE studies ADD COLUMN IF NOT EXISTS tech_notes TEXT;

CREATE TABLE IF NOT EXISTS live_case_sessions (
  id UUID PRIMARY KEY,
  study_id BIGINT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  started_by_email TEXT,
  started_by_name TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  finalized_mp4_url TEXT,
  upload_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_case_sessions_active
  ON live_case_sessions (study_id, last_seen_at)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS case_stream_jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL,
  requested_study_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  fps INTEGER NOT NULL DEFAULT 15,
  max_frames INTEGER NOT NULL DEFAULT 500,
  output_path TEXT,
  filename TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  skipped_studies_count INTEGER NOT NULL DEFAULT 0,
  progress_pct INTEGER NOT NULL DEFAULT 0,
  progress_message TEXT,
  error JSONB,
  timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_id TEXT,
  requested_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS case_stream_library (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES case_stream_jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filename TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  fps INTEGER,
  requested_study_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS live_finalize_jobs (
  id UUID PRIMARY KEY,
  live_session_id UUID NOT NULL REFERENCES live_case_sessions(id) ON DELETE CASCADE,
  study_id BIGINT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_finalize_jobs_status ON live_finalize_jobs(status, updated_at);
