# MapDR Software Status and Maintenance Notes

Last updated: July 4, 2026 UTC

## Current Position

- The active product is a MediView/MapDR medical-case platform.
- The frontend is React, TypeScript, and Vite under `frontend/mediview-portal`.
- The main backend is an Express/Node API under `mapdr-api`.
- Orthanc stores and renders DICOM studies.
- OHIF is the primary DICOM viewer. External PACS viewer links are also supported by configuration.
- Nginx and Cloudflare provide the public routing layer.
- Case features currently include DICOM upload/viewing, screenshots, case streams, screen recordings, reports, sharing, and cloud export.

## Production Services

- `mapdr-api.service`: main API, normally bound to `127.0.0.1:3001`.
- `mediview-vite.service`: frontend Vite server, normally bound to `127.0.0.1:8081`.
- `auth-api` and `video-gateway`: managed through PM2.
- Orthanc HTTP API: normally available at `127.0.0.1:8042`.
- API health endpoint: `GET /api/health`.

The API and Orthanc health endpoint were successfully verified after the June 4 image-quality deployment.

The API, Orthanc health path, and frontend Vite service were successfully verified after the June 11 DICOM ordering/completeness and studies-table scrollbar deployments.

The API and frontend Vite service were successfully verified after the June 13 study-edit deployment.

The frontend Vite service, Cloudflare tunnel service, and PM2 video gateway were successfully verified after the June 13 video-call routing update.

The API, auth API, and frontend Vite service were successfully verified after the June 13 patient-summary Nextcloud package update.

The API and Orthanc health path were successfully verified after the June 13 Grist completed-case logging update.

The API, auth API, and frontend Vite service were successfully verified after the June 15 SOAP notes update.

The Orthanc container was successfully restarted after adding the June 16 `OCTR_MIRROR` DICOM modality whitelist entry.

The frontend Vite service was successfully verified after the June 17 patient-study assignment update.

The API, Orthanc health path, and frontend production build were successfully verified after the June 22 studies, dictation, signoff, and report-code framework updates.

The New Case intake, screen-recording upload path, and API authentication path were successfully verified after the June 24 optional-case-intake update.

The frontend stream-creation auth guard and case-stream progress/download handling were verified after the June 26 stream creation stability update.

The stream creation save/playback path, stream encoding size fix, and Streams table readability update were verified after the June 30 stream workflow update.

The API, auth API, frontend Vite service, and `/api/studies` route were verified after the July 1 stream color bar, session keepalive, auth-store backup, and frame-preview throttling update.

The API, auth API, frontend Vite service, `/streams`, `/api/studies`, and auth health route were verified after the July 2 no-auto-logout/no-auto-refresh update.

The API and frontend Vite service were verified after the July 4 large-DICOM upload recovery, realtime reconnect, and study-open performance update.

## July 4, 2026 Work Log

- Investigated large DICOM folder upload failures that appeared stuck near 30%:
  - Recent failed uploads were aborting before the API finished receiving multipart bodies.
  - Cloudflared logged client-side cancellations for several `/api/studies/:id/dicom` requests.
  - The newest reported case, `632` / `06172.BRMRWO`, was confirmed to be an empty case shell with `dicom_count: 0`, `orthanc_study_id: null`, and no DICOM upload completion logs.
- Tuned DICOM upload stability for large folders:
  - Backend DICOM upload concurrency default is now `4`.
  - Browser DICOM batches default to `50` files and `25 MB`.
  - Multipart DICOM uploads retry transient network-style failures twice with backoff.
  - Upload progress now continues while the server is reading/processing a completed batch, so users do not see a frozen percent while backend work is still active.
- Added empty-case DICOM recovery:
  - Study Detail now shows `Attach DICOM Folder` and `Attach DICOM Files`.
  - The attach flow uploads DICOMs into an existing case through `POST /api/studies/:id/dicom` using the same batching/retry path as new-case upload.
  - Empty DICOM cases show a clear warning and the Viewer button now stops early with a clear no-DICOM message.
  - Use this path to repair case `632` instead of creating another duplicate empty case.
- Fixed realtime reconnect behavior:
  - Stabilized the realtime hook's auth/callback dependencies so normal renders do not churn `/api/studies/stream` connections.
  - Changed the disconnected badge copy from `Reconnecting` to `Offline` to avoid implying a blocked viewer load.
- Improved Study Detail open performance:
  - The initial realtime `connected`/`snapshot` event and presence-only updates no longer trigger a full study and recording reload.
  - Opening a study should now avoid the duplicate `GET /api/studies/:id` and duplicate `GET /api/case-recordings?studyId=...` calls seen in logs.
- Verified:
  - `npm run check` in `mapdr-api`.
  - `npm run test:upload-throughput` in `mapdr-api`.
  - `npm run test -- src/test/api.test.ts` in `frontend/mediview-portal`.
  - `npm run build` in `frontend/mediview-portal`.
  - `GET /api/ready` and the frontend Vite endpoint after service restarts.

## July 2, 2026 Work Log

- Stopped passive PACS auto-logout and automatic workflow-disrupting auth refresh:
  - Removed the frontend focus/visibility auth refresh handler so tab changes and focus events do not automatically re-check auth or clear the current user.
  - The frontend still checks the existing session on initial page load and explicit protected actions.
  - The auth API now accepts existing server-side session records without deleting them solely because an older `expiresAt` timestamp passed.
  - Explicit sign-out still clears the server-side session and browser cookie.
- Kept the long session default:
  - Auth session cookie defaults remain `8760` hours.
  - Deployment templates and auth API examples keep `AUTH_SESSION_TTL_HOURS=8760`.
- Verified:
  - `node --check /root/mapdr-project/mapdr-api/server.js`.
  - `node --check /root/mapdr-project/frontend/mediview-portal/server/auth-api/server.mjs`.
  - `npm run build` in `frontend/mediview-portal`.
  - Restarted `mapdr-api.service`, `mediview-vite.service`, and PM2 `auth-api`.
  - `GET /streams`, `GET /api/studies`, and `GET /auth-api/healthz` returned HTTP 200 after restart.

## July 1, 2026 Work Log

- Fixed the stream color-coding bar disappearing during playback:
  - The stream segment color timeline now stays visible for segmented streams instead of hiding with the idle transport controls.
  - Frontend frame-preview prewarm radius was reduced so scrubbing does not request large frame windows repeatedly.
- Prevented passive PACS sessions from logging out while users are watching streams or studies:
  - Auth session defaults were raised from 1 hour to 8760 hours so PACS does not auto-logout during normal use.
  - The frontend no longer polls auth every 5 minutes.
  - Follow-up on July 2 removed focus/visibility auth refresh entirely to avoid workflow disruptions.
  - The main API no longer rejects an otherwise valid auth-store session solely because an older expiry timestamp has passed.
- Hardened auth data persistence so user/session/care data does not disappear from a partial write:
  - The auth API now writes `store.json` through a temporary file and atomic rename.
  - The auth API keeps `store.json.bak` and restores from it if the primary store cannot be parsed.
- Kept the July 1 API-stall prevention in place:
  - Backend `ffmpeg` work is capped by `MAX_CONCURRENT_FFMPEG_PROCESSES` with a default of 2.
  - Case-stream single-frame extraction times out after 30 seconds and prewarm extraction times out after 60 seconds.
  - If studies appear missing, first verify `/api/studies` latency and check for stuck frame-preview workers before assuming study data is gone.
- Verified:
  - `node --check /root/mapdr-project/mapdr-api/server.js`.
  - `node --check /root/mapdr-project/frontend/mediview-portal/server/auth-api/server.mjs`.
  - `npm run build` in `frontend/mediview-portal`.
  - `GET /api/studies` through nginx returned HTTP 200 in milliseconds after restart.

## June 30, 2026 Work Log

- Fixed case stream creation appearing stuck at `95%`:
  - Root cause was the frontend downloading the completed MP4 into a browser `Blob` before saving the stream to the library.
  - Recent stream jobs were completing server-side, but the generated files were large enough that browser/proxy download stalled before the save request ran.
  - The creation flow now saves the ready job directly to the stream library first and uses the saved server URL for playback.
  - The explicit `Download MP4` action still downloads the file only when the user clicks it.
  - Frontend cleanup now revokes only `blob:` URLs, so server playback URLs are not accidentally revoked.
- Reduced new case-stream MP4 size:
  - Normal stream encoding no longer forces every frame to be a keyframe with `-g 1`.
  - The stream encoder now uses about a 1-second GOP, `-keyint_min` aligned to FPS, `-sc_threshold 0`, no B-frames, and CFR x264 parameters.
  - This preserves predictable playback/frame extraction while avoiding very large all-intra MP4s for normal streams.
- Added a Streams table readability update:
  - Widened the saved-streams table.
  - Added a synced top horizontal scrollbar above the table while retaining the bottom scrollbar.
  - Increased spacing and action-control sizes for assignment, presentation, reading status, and study actions.
- Guideline: do not reintroduce mandatory full-MP4 browser downloads into stream creation. Stream jobs should be saved server-side first, and the UI should use server media URLs for playback. Keep full downloads as an explicit user action only.
- Verified:
  - `node --check /root/mapdr-project/mapdr-api/server.js`.
  - `node /root/mapdr-project/mapdr-api/scripts/test-case-stream-presentation.js`.
  - `npm run build` in `frontend/mediview-portal`.
  - Restarted `mapdr-api.service` and confirmed it was active after restart.

## June 26, 2026 Work Log

- Fixed stream creation auth handling:
  - Case stream export controls stay disabled while the auth session is still initializing.
  - After auth initialization finishes, missing auth now reports a session/sign-in problem instead of the misleading "session is still loading" message.
  - Stream download, cancel, discard, and keep actions use the same auth-ready guard.
- Fixed case stream progress behavior:
  - Progress no longer jumps to `100%` before the MP4 download and library save steps complete.
  - Download now reports `95%`, save reports `98%`, and `100%` is only shown after completion.
  - Case stream MP4 downloads now have a client timeout so a stalled fetch fails cleanly instead of leaving the UI stuck.
- Guideline: case-stream workflows should treat `100%` as a terminal success state only. Download/save/network work must have explicit intermediate progress labels and error recovery.
- Verified:
  - `npm run build` in `frontend/mediview-portal`.

## June 24, 2026 Work Log

- Changed the PACS New Case intake so metadata fields are plain typed fields instead of required dropdown/date controls.
- Removed frontend required-field gates for case creation:
  - A case can be created with blank metadata.
  - A case can be created before DICOM, JPEG2000, MP4, PDF, or screen-recording media is attached.
  - DOB and Study Date still compute decimal age when both are parseable; otherwise age is stored blank and displayed as `00.0000` on intake.
- Kept client entry as a typed field with suggestions from the Clients section, so users can type any client while exact client-name matches still preserve the indexed client email.
- Kept MD as a typed field with `Sarai` prefilled, so users can replace it with any MD name without a mode switch.
- Relaxed backend study validation so empty case shells are accepted. Empty titles now fall back to `Case <id>`.
- Adjusted API header-auth trust so browser requests from configured portal origins can authenticate direct API calls with the existing user headers. Prefer same-origin `/api` routing, but when upload/auth failures occur, check `CORS_ALLOWED_ORIGINS` and proxy origin trust before changing the upload UI.
- Preserved the screen-recording upload integrity path:
  - Recording uploads still send auth headers plus cookies.
  - WebM recordings still use normalized timestamps and integrity metadata.
  - Recording media can be attached to a case without DICOM media.
- Verified:
  - `npm run test -- src/test/uploadStudy.test.tsx`.
  - `npm run build` in `frontend/mediview-portal`.
  - `node --check /root/mapdr-project/mapdr-api/server.js`.

## June 22, 2026 Work Log

- Added main-disk usage visibility to the Studies section:
  - Backend exposes live storage status through `GET /api/storage`.
  - Studies header shows the disk percentage next to the case count.
  - The storage warning threshold defaults to 10% used and prompts users to export cases before the main case disk fills.
  - The storage request is non-blocking so the Studies list still loads if storage status fails.
- Added additional study text fields across upload, edit, detail, search, export, and persistence paths:
  - Tech notes.
  - Radiologist notes.
  - Radiology report.
- Added a movable dictation widget available anywhere a user is signed in:
  - Dictation inserts transcribed text into the last focused text input or textarea.
  - Dictate-and-record mode saves the recording as MP3 alongside the case through `POST /api/studies/:id/dictations`.
  - Study Detail plays saved audio dictation reports inline.
  - Drag behavior was revised to track pointer movement smoothly through animation-frame position updates.
- Added a signed-complete popup workflow:
  - Upload and edit flows can open a dedicated signoff popup after saving.
  - Study Detail includes a `Read & Sign` entry point.
  - The popup is served at `/studies/:id/sign`, is protected by study access rules, and supports fullscreen-style reading.
  - The popup shows study metadata, completion note, editable radiology report text, attached reports, and PDF viewing when a study PDF or report PDF exists.
  - `POST /api/studies/:id/complete` marks the study `complete`, stores signer identity, completion time, and completion note, and can update the radiology report.
- Added complete-state visibility:
  - Completed studies show a green checkmark/status treatment in Studies, Study Detail, Shared Study, and signoff views.
  - Patient and SOAP study summary lines include complete-state text for completed studies.
- Added the initial report-code plotting framework for signed-complete studies:
  - Dedicated Grist/sheet config keys were added: `GRIST_REPORT_CODES_TABLE_ID` and `GRIST_REPORT_CODES_TABLE_NAME`.
  - The default report-code sheet target is `Report_Codes` / `Report Codes`.
  - When a study is signed complete, the backend builds a `ReportCode` row and attempts to append it to the report-code sheet.
  - Rows include report code, study ID/name, patient name/ID, modality, study date, status, signed-complete time, signer, Nextcloud link when available, source, created time, and whether report text exists.
  - If Grist is unavailable or unconfigured, rows are queued at `mapdr-api/grist-report-codes-queue.json` and flushed after configuration recovers.
  - Existing completed-case Grist logging for patient-summary Nextcloud packages remains unchanged.
- Extended the report-code framework for OCTR monthly sheet sync:
  - Report-code writes can now target a dedicated monthly Grist document through `GRIST_REPORT_CODES_DOC_ID`, instead of always using the default `GRIST_DOC_ID`.
  - Added `GRIST_REPORT_CODES_MONTH_KEY` so June, July, and later sheet targets can be tracked without changing code.
  - Added acronym-sheet configuration placeholders: `GRIST_ACRONYM_DOC_ID` and `GRIST_ACRONYM_TABLE_ID`.
  - Signed-complete rows now include OCTR-specific mapping fields: `OctrCode`, `RawCaseLog`, `ClientCode`, `ClientName`, `Tier`, `Chapter`, `BodyRegion`, `PatientLog`, `AcronymCodes`, and `DiagnosisCodes`.
  - Signed-complete rows now include sync-state fields: `MonthlySheetDocId`, `MonthlySheetMonth`, `MonthlySheetRowId`, `AcronymDocId`, `SyncDirection`, `SyncStatus`, `SyncMessage`, and `SheetSyncedAt`.
  - The backend extracts the primary OCTR case code and uppercase acronym/diagnosis-style tokens from study patient name, patient ID, notes, tech notes, radiologist notes, and radiology report text.
  - Current default sync direction is `software_to_sheet`; the row schema is ready for sheet-to-software reconciliation once Grist document access and exact table/column IDs are confirmed.
  - The June sheet and acronym document are protected by proxy authentication plus Grist document authorization. Proxy access worked from the server, but the Grist API returned `No view access`, so exact line 31 column IDs could not be inspected from the API yet.
- Added local acronym-diagnosis expansion:
  - Backend now stores imported acronym rows in `mapdr-api/acronym-database.json`.
  - Added admin sync endpoint `POST /api/acronyms/sync` to import acronym rows from the Grist acronym document into the local database.
  - Added lookup endpoints `GET /api/acronyms/:code` and `GET /api/acronyms?q=...` for report-writing tools.
  - Added an hourly refresh job that re-imports the acronym sheet on a timer and performs an initial refresh shortly after service startup.
  - Imported 2,206 acronym entries from the public-editor acronym document on June 22, 2026.
  - Frontend now mounts an acronym expansion watcher for signed-in users. When a user completes an acronym token in report/note text fields and the token has an exact local match, the token is replaced with the full diagnosis/template text.
  - Verified `BODBEFAST` and `NECTHYNOD` lookups from the local database. Exact source lookup for `NECTHYUS` returned no row in the imported public acronym tables, so that specific code likely needs confirmation or addition in the source sheet.
- Restarted `mapdr-api.service` after backend changes.
- Verified:
  - Backend syntax check with `npm run check`.
  - Frontend production build after the complete-checkmark/signoff UI changes.
  - Playwright popup/PDF selection smoke coverage during signoff work.
  - Dictation widget drag tracking with Playwright pointer movement checks.
  - API health and Orthanc connectivity after API restart.
  - `mapdr-api.service` is online after restart.

## June 23, 2026 Work Log

- Added study-level realtime collaboration plumbing:
  - Backend now exposes a study realtime stream at `GET /api/studies/stream`.
  - Study presence can be claimed and cleared per tab through `POST /api/studies/:id/presence` and `DELETE /api/studies/:id/presence`.
  - Study save, completion, priors, report, dictation, recording, create, delete, restore, and live-session events now broadcast realtime change notifications.
  - Version checks now reject stale study writes with a 409 conflict instead of silently overwriting newer edits when a client sends `base_updated_at`.
- Added frontend realtime subscriptions:
  - Study Detail listens for study changes and refreshes study metadata and screen recordings live.
  - Study Signoff popup listens for changes and keeps the read/sign workflow fresh without overwriting a dirty draft.
  - Studies List listens for global study events and refreshes the case list in near real time.
  - The client now sends study presence heartbeats so other devices can see who is viewing or editing a case.
- Restarted `mapdr-api.service` and `mediview-vite.service`.
- Verified:
  - `npm run check` in `mapdr-api`.
  - `npm run build` in `frontend/mediview-portal`.
  - Both systemd services are active after restart.

## June 17, 2026 Work Log

- Added a patient-side study assignment workflow on the Patients page.
- Each patient row now has an `Assign Studies` action that opens a compact assignment panel.
- The assignment panel can search studies by study ID, current patient name/email, study date, modality, or notes.
- Users can select multiple studies at once and assign them to the chosen patient in one action.
- Assignment updates the existing study metadata linkage by setting `patient_name` to the patient account name and `patient_id` to the patient email, so the study is immediately discoverable under Patients, SOAP Notes, patient package workflows, and other software paths that use the same study patient identifiers.
- The panel shows currently linked studies for the patient and marks already linked studies in search results.
- Added patient row expansion from the Patients page so clicking a patient shows assigned cases and linked studies in one place.
- Patient details now show case status, sharing doctor, created date, counts for case studies/reports, Case Package links, linked study metadata, and Nextcloud study links when available.
- Linked studies in patient details now click through to the actual study route at `/studies/:id`, with an explicit `Open Study` action on each linked study row.
- Restarted `mediview-vite.service`.
- Verified:
  - Frontend production build.
  - All 48 frontend tests.
  - Local `/patients` and `/studies/:id` routes served by Vite.
  - `mediview-vite.service` is online after restart.

## June 16, 2026 Work Log

- Added Orthanc DICOM modality whitelist entry `OCTR_MIRROR` for host `192.168.4.7` on DICOM port `4242`.
- Kept called AE validation enabled, so outside systems must call this database as AE `MAPDR`.
- Kept broad unknown-modality C-FIND/C-GET/C-MOVE disabled; query/retrieve access is available through registered modalities such as `OCTR_MIRROR`.
- Restarted the `orthanc` Docker container so the mounted Orthanc config was reloaded.
- Verified:
  - Orthanc container is online.
  - DICOM listener is bound on `0.0.0.0:4242`.
  - API health reports Orthanc OK with AE `MAPDR` and port `4242`.
  - Running container config contains `OCTR_MIRROR`.

## June 4, 2026 Work Log

- Fixed low-quality case images by requesting Orthanc's native `image-uint8` rendering before its lower-detail `preview` rendering.
- Improved generated case-stream video quality by adding an explicit x264 CRF setting with a high-quality default of `16`.
- Documented `CASE_STREAM_X264_CRF` and `CASE_STREAM_X264_PRESET` environment controls.
- Added `test:case-stream-image-quality` regression coverage.
- Restarted `mapdr-api.service` to activate the quality fix.
- Installed the backend's missing PostgreSQL dependency and resolved backend package-audit findings.
- Removed runtime data, generated files, dependencies, and secrets from source control.
- Replaced exposed Git history with a single sanitized production baseline.
- Published the sanitized baseline as the only branch and reachable commit on remote `main`.
- Rotated locally controlled Orthanc, LiveKit, and bootstrap administrator credentials.
- Rotated the external Nextcloud administrator password and switched MapDR to a dedicated Nextcloud app password.
- Revoked an unused legacy Nextcloud app password and redacted retired Nextcloud credentials from local history files.
- Restored the requested PACS frontend administrator login and verified it through the public authentication route.
- Standardized the production portal on `pacs.octelerad.com` and repaired stale Cloudflare-facing PACS CORS and DICOM authentication settings.
- Safely increased DICOM browser batches from 25 MB to 75 MB and upload timeout from 5 to 10 minutes while keeping backend concurrency at 8.
- Restarted only `mediview-vite.service` for the upload tuning; API, Orthanc, Nginx, and Cloudflare services remained running.
- Isolated large DICOM files into their own requests and added filename-specific timeout/rejection messages so one unreadable file cannot silently hold the rest of a batch.
- Restarted only `mapdr-api.service` and `mediview-vite.service` for the stall mitigation.
- Changed LiveKit's default configuration so TURN remains disabled until valid TLS certificates are mounted.
- Recreated and verified the LiveKit container after applying the corrected runtime configuration.
- Verified:
  - API syntax check.
  - Case-stream image-quality regression.
  - Existing case-stream layout regression.
  - Existing case-stream presentation regression.
  - API health and Orthanc connectivity.
  - A real case screenshot returned successfully as a PNG.
  - Large-file batch regression, all 44 frontend tests, frontend production build, backend upload-throughput regression, and API smoke checks.
  - Live Cloudflare-served frontend contains the 75 MB batch and 10-minute timeout defaults.
  - Unreadable-DICOM integration test returned the exact test filename and rejection reason; the temporary test study was deleted.
  - All 46 frontend tests, frontend production build, backend regressions, API smoke checks, and public PACS routes passed after deployment.

Important: existing saved case-stream videos retain their old encoding. Rebuild or regenerate them to receive the improved quality.

## June 11, 2026 Work Log

- Fixed DICOM ordering for case streams, ordered DICOM instance inspection, and Nextcloud DICOM export by improving the shared Orthanc instance-ordering path.
- Changed instance ordering to prefer DICOM spatial position with orientation-aware projection, then fall back through temporal, stack, slice, date/time, instance number, SOP UID, Orthanc ID, and original index metadata.
- Added regression coverage for:
  - Spatial position overriding misleading `InstanceNumber` values.
  - Non-axial orientation-aware ordering.
  - Temporal-position ordering.
- Prevented mixed Orthanc-study uploads from being attached to one MapDR case. If a DICOM upload batch resolves to more than one Orthanc parent study, the backend rejects the batch and deletes the uploaded instances from that failed batch.
- Prevented incomplete DICOM batches from being marked ready. If any file in a batch fails upload or Orthanc ingest, the backend rejects the whole batch and deletes already-uploaded instances from that failed batch so future streams cannot silently miss images.
- Added an upload-throughput regression guard requiring incomplete DICOM batches to fail the whole batch and clean up uploaded Orthanc instances.
- Backtested DICOM ordering against live Orthanc metadata:
  - 38 linked studies scanned.
  - 224 image series scanned.
  - 13,291 DICOM instances scanned.
  - 21 of 38 linked studies had corrected ordering changes.
  - 120 series changed order; sampled changes used spatial image-position ordering.
  - 10 of 10 deployed `/api/studies/:id/dicom-instances` samples matched the corrected backend order.
- Backtested DICOM completeness against live Orthanc metadata:
  - 38 linked studies checked.
  - 13,291 Orthanc image instances matched 13,291 API ordered instances.
  - No mismatched studies.
  - No duplicate API instance lists.
  - No errors.
- Verified live case-stream export after the ordering/completeness changes by rendering a short MP4 from an affected study. The export returned HTTP 200, `video/mp4`, 2 seconds, and 472,360 bytes.
- Restarted only `mapdr-api.service` for backend DICOM ordering and completeness changes.
- Added a synced top horizontal scrollbar to the main Studies table so mouse users can horizontally scroll wide study rows without needing a trackpad or scrolling to the bottom/table body.
- Restarted only `mediview-vite.service` for the frontend scrollbar change.
- Verified:
  - Backend syntax check.
  - DICOM ordering regression.
  - Upload-throughput and incomplete-batch regression.
  - Case-stream image-quality regression.
  - Case-stream layout regression.
  - Case-stream presentation regression.
  - API health and Orthanc connectivity.
  - Frontend production build.
  - All 46 frontend tests.
  - Local `/studies` route and transformed `StudiesList.tsx` module from Vite.

Important: existing saved case-stream videos retain their old rendered order and encoding. Rebuild or regenerate saved streams to receive corrected DICOM ordering and improved encoding.

## June 13, 2026 Work Log

- Added a study-edit workflow from the main Studies table.
- Added an `Edit` action beside each study so already-uploaded studies can be updated without re-uploading.
- Added editable fields for patient name, patient ID, age, sex, zip, study date, modality, notes, and tech notes.
- Added optional report attachment from the edit dialog using the existing case-report storage path.
- Added `PUT /api/studies/:id` for authorized metadata updates by admin, doctor, and clinic roles.
- Kept metadata updates scoped to existing study fields and rejected deleted or inaccessible studies.
- Scheduled cloud export refreshes after metadata changes so external exports stay current.
- Added frontend API-client coverage for `updateStudy`.
- Verified:
  - Backend syntax check.
  - DICOM ordering regression.
  - Upload-throughput and incomplete-batch regression.
  - Case-stream image-quality regression.
  - Case-stream layout regression.
  - Case-stream presentation regression.
  - Frontend production build.
  - All 47 frontend tests.
- Hooked the MAPDR Video Calls route to the existing public OCTELERAD call app at `https://call.octelerad.com`.
- Replaced the old in-portal self-hosted LiveKit room screen with a redirect/fallback button so existing `/video` links from the sidebar, messages, care desk, cases, and admin quick access open the public call app.
- Updated video-call entry points so the call app opens in a separate browser tab and the PACS app remains open.
- Confirmed `call.octelerad.com` already serves the standalone call app through Cloudflare, so the local tunnel was not repointed or hijacked.
- Restored the local PM2 video gateway `LIVEKIT_URL` setting to `auto` so it does not mint tokens for a hostname owned by the standalone call app.
- Added `/video-api/` proxying to the PACS Nginx server blocks for local gateway compatibility.
- Verified:
  - Nginx configuration syntax.
  - Cloudflare tunnel ingress validation.
  - Frontend production build.
  - All 47 frontend tests.
  - Local `/video` route served by Vite.
  - Built `VideoCalls` asset contains the `https://call.octelerad.com` redirect.
  - Sidebar video calls, Care Desk call, Messages call, Cases follow-up call, and `/video` fallback open `https://call.octelerad.com` in a separate tab.
  - Public `https://call.octelerad.com` returns the standalone call app.
  - PM2 video gateway is online.
  - `mediview-vite.service` and `cloudflared.service` are active.
- Added patient-summary cloud package export for Care Desk case sends.
- When sending a patient summary, the portal now exports selected studies and selected/uploaded reports to a public Nextcloud share before creating the patient-visible case.
- Added `POST /api/patient-summaries/export-nextcloud` to create `/PatientSummaries/...` packages containing:
  - `patient-summary.txt`.
  - `metadata.json`.
  - Per-study `study-summary.txt` files.
  - Ordered DICOM exports for selected studies.
  - Selected report PDFs and uploaded prior-report PDFs.
- Stored the returned public Nextcloud share on the patient case as `nextcloudShare`.
- Added a Case Package link in the patient case inbox showing the share URL plus study, report, and DICOM export counts.
- Added frontend API-client coverage for the patient-summary export call.
- Verified:
  - Main API syntax check.
  - Auth API syntax check.
  - DICOM ordering regression.
  - Upload-throughput and incomplete-batch regression.
  - Case-stream image-quality regression.
  - Case-stream layout regression.
  - Case-stream presentation regression.
  - Frontend production build.
  - All 48 frontend tests.
  - API health and Orthanc connectivity.
  - Auth API health.
  - Local Playwright Chromium smoke test generated a valid one-page SOAP PDF with the configured logo.
  - Local Care Desk route served by Vite.
  - Non-writing patient-summary export smoke test returns a validation error for empty selections before any Nextcloud write.
  - `mapdr-api.service`, `mediview-vite.service`, and PM2 `auth-api` are online.
- Added completed-case logging for patient-summary Nextcloud package sends.
- The backend now prepares one Grist row per selected study after the public Nextcloud package share link is created.
- The target Grist table ID is `TEST_Sheet`, corresponding to the requested sheet name `TEST Sheet`.
- Each completed-case row includes a physical-database style `Code` value in the requested format:
  - `OCTR - .[StudyName] - ..[Modality] - ...[NextcloudLink]`
- Each row also stores study name, modality, Nextcloud link, study ID, patient name, patient email, case title, package folder, export time, and whether DICOM files were exported.
- If Grist is not configured, completed-case rows are saved to the local queue at `mapdr-api/grist-completed-cases-queue.json` and will be flushed after Grist credentials are configured.
- Added Grist configuration placeholders to `mapdr-api/.env.example`:
  - `GRIST_BASE_URL`
  - `GRIST_API_KEY`
  - `GRIST_DOC_ID`
  - `GRIST_COMPLETED_CASES_TABLE_ID=TEST_Sheet`
  - `GRIST_COMPLETED_CASES_TABLE_NAME=TEST Sheet`
- Added the initial report-code plotting framework for signed-complete studies:
  - When a study is signed complete, the API builds a `ReportCode` row and sends it to a dedicated Grist sheet table.
  - The default table ID/name are `Report_Codes` and `Report Codes`, configurable with `GRIST_REPORT_CODES_TABLE_ID` and `GRIST_REPORT_CODES_TABLE_NAME`.
  - Rows include report code, study ID/name, patient name/ID, modality, study date, status, signed-complete time, signer, Nextcloud link when available, source, created time, and whether report text exists.
  - If Grist is unavailable or not configured, report-code rows are queued locally at `mapdr-api/grist-report-codes-queue.json` and flushed after configuration recovers.
- Verified:
  - Main API syntax check.
  - DICOM ordering regression.
  - Upload-throughput and incomplete-batch regression.
  - Case-stream presentation regression.
  - API health and Orthanc connectivity.
  - `mapdr-api.service` is online after restart.

## June 15, 2026 Work Log

- Added structured SOAP notes to the Care Desk case-send workflow.
- Added Subjective, Objective, Assessment, and Plan text sections beside the existing clinical summary.
- Added a fixed-format SOAP Clinical Note preview in Care Desk so the note document is visible before sending.
- Added a dedicated SOAP Notes workspace at `/soap-notes` and linked it from the side menu for admin, doctor, and clinic users.
- The SOAP Notes workspace lets users select one or more studies, mark studies as current or prior, reorder the study stack by drag and drop, upload prior PDF documents, and compare multiple movable study/report/prior document panels.
- Replaced the tall SOAP study checklist with a compact searchable study picker dropdown. Study picker results, selected-study rows, study stack rows, and document panels now use the same study title/patient-name label shown in the Studies table, with ID/date/modality/DICOM count as secondary detail.
- SOAP Notes now supports no patient filter while building, selecting an existing patient, or typing a new patient name/email. Typed patients are created as patient accounts before the SOAP note is sent.
- Added a dedicated Patients page at `/patients` and linked it from the side menu for admin, doctor, and clinic users.
- The Patients page lets care-team users create patient accounts, see linked case/study counts, and suspend or reactivate patient accounts while preserving linked files/cases.
- Added care-team patient management API routes under `/care/patients`.
- Included SOAP notes in the patient-summary Nextcloud package `patient-summary.txt`.
- Added `reports/soap-clinical-note.txt` to each patient-summary Nextcloud package with the same Subjective, Objective, Assessment, and Plan sections every time.
- Added `reports/soap-clinical-note.html` to each patient-summary Nextcloud package as a print-ready template-style SOAP note report titled `SUBJECTIVE OBJECTIVE ASSESSMENT PLAN - STUDY NOTES`.
- Added `reports/soap-clinical-note.pdf` rendering through local Playwright Chromium so patient-summary packages include a PDF SOAP report with the configured OCTELERAD logo.
- Included SOAP notes in patient-summary package `metadata.json` under `case.soap_notes`.
- Stored SOAP notes on patient-visible care cases through the auth API.
- Displayed SOAP notes in the SOAP workspace preview and patient Cases view as the same fixed-format template-style note document.
- Kept the existing clinical summary required in Care Desk; the dedicated SOAP workspace requires a case title and at least one SOAP field.
- Restarted `mapdr-api.service`, `mediview-vite.service`, and PM2 `auth-api`.
- Restarted `mediview-vite.service` after adding the dedicated SOAP Notes workspace.
- Restarted PM2 `auth-api` and `mediview-vite.service` after adding patient management.
- Restarted `mapdr-api.service` and `mediview-vite.service` after adding the SOAP template-style HTML report.
- Verified:
  - Main API syntax check.
  - Auth API syntax check.
  - Frontend production build.
  - All 48 frontend tests.
  - API health and Orthanc connectivity.
  - Auth API health.
  - Local Care Desk route served by Vite.
  - Local `/soap-notes` route served by Vite.
  - Local `/patients` route served by Vite.
  - SOAP Notes searchable study picker served by Vite after frontend restart.
  - Local `/cases` route served by Vite after the SOAP template-style patient view update.
  - `mapdr-api.service`, `mediview-vite.service`, and PM2 `auth-api` are online.

## Current Risks

- Runtime data, secrets, generated media, Orthanc storage, and dependency directories must not be treated as normal source-code changes.
- Do not run destructive Git commands such as `git reset --hard` or broad cleanup commands against this repository.
- Orthanc runtime configuration and bootstrap administrator credentials must be generated from local environment secrets, never committed.
- The root-readable pre-sanitization Git bundle contains old sensitive history and must never be published.
- New or repaired case streams must be generated from the corrected DICOM ordering path; existing MP4 files are not automatically rewritten.
- Do not accept partial DICOM ingestion as a successful case upload. A partial batch can create missing images in downstream streams.
- Real Grist writes require `GRIST_BASE_URL`, `GRIST_API_KEY`, and `GRIST_DOC_ID` to be configured on the API service. Until then, completed-case rows remain queued locally.
- Report-code sheet writes use the same Grist credentials but a separate table and queue. Until configured, signed-complete report-code rows remain queued locally.

## Maintenance Guidelines

1. Check service and data health before and after every deployment.

   ```bash
   systemctl status mapdr-api.service --no-pager
   systemctl status mediview-vite.service --no-pager
   curl -fsS http://127.0.0.1:3001/api/health
   ```

2. Validate backend changes before restarting production.

   ```bash
   cd /root/mapdr-project/mapdr-api
   npm run check
   npm run test:case-stream-image-quality
   npm run test:case-stream-layouts
   npm run test:case-stream-presentation
   node scripts/test-dicom-ordering.js
   npm run test:upload-throughput
   ```

3. Restart only the service affected by the change, then inspect its logs.

   ```bash
   systemctl restart mapdr-api.service
   journalctl -u mapdr-api.service --since "5 minutes ago" --no-pager
   ```

4. Keep medical-image quality controlled:

   - Request native-resolution DICOM renders before preview fallbacks.
   - Keep `CASE_STREAM_X264_CRF=16` unless file-size testing justifies another value.
   - Lower CRF means higher quality and larger files.
   - Test screenshots and regenerated case streams using real cases after pipeline changes.

5. Protect medical data:

   - Never expose `.env` files, patient data, Orthanc storage, reports, or recordings in source control.
   - Back up Orthanc and application data before migrations or cleanup.
   - Verify case isolation so one case cannot display another case's DICOM images.

6. Keep a daily operational log containing:

   - Exact date and UTC time.
   - Files and behavior changed.
   - Commands/tests run and their result.
   - Services restarted.
   - Health checks performed.
   - Known risks and unfinished work.

7. Keep large DICOM uploads within the Cloudflare boundary:

   - Use `VITE_DICOM_UPLOAD_BATCH_MAX_MB=75` to reduce request overhead while leaving multipart headroom.
   - Use `VITE_DICOM_UPLOAD_TIMEOUT_MS=600000` for slower large-study connections.
   - Keep `DICOM_UPLOAD_CONCURRENCY=8` unless a measured benchmark proves a higher value is stable.
   - A single DICOM larger than the batch target is uploaded alone; do not lower the backend per-file limit below expected source-file sizes.
   - Files using at least half the batch target are isolated automatically. Orthanc read timeouts are reported once with the filename instead of retrying the same stalled file.

8. Keep DICOM stream ordering and completeness guarded:

   - Use `fetchStudyInstanceIds` as the single backend path for ordered Orthanc instance lists used by streams, screenshots, DICOM inspection, and cloud export.
   - Preserve orientation-aware spatial ordering before falling back to `InstanceNumber`; many real studies do not stream correctly when `InstanceNumber` is treated as the first ordering key.
   - Reject and clean up mixed Orthanc-study upload batches instead of binding one app case to whichever Orthanc study finishes last.
   - Reject and clean up incomplete DICOM upload batches instead of marking a study ready with missing instances.
   - After DICOM ordering or upload changes, run a read-only Orthanc backtest comparing Orthanc image-instance counts to `/api/studies/:id/dicom-instances` counts, and render at least one short case-stream export from an affected study.

9. Validate frontend-only Studies table changes before restarting Vite:

   ```bash
   cd /root/mapdr-project/frontend/mediview-portal
   npm run build
   npm run test
   ```

   Restart only `mediview-vite.service` for frontend-only changes, then verify the route and recent Vite logs.

10. Validate study metadata edit changes before restarting services:

   ```bash
   cd /root/mapdr-project/mapdr-api
   npm run check
   cd /root/mapdr-project/frontend/mediview-portal
   npm run build
   npm run test
   ```

   Restart `mapdr-api.service` when the edit API changes and `mediview-vite.service` when the Studies UI changes.

11. Keep patient-summary Nextcloud exports complete and auditable:

   - Send patient-facing case packages through `POST /api/patient-summaries/export-nextcloud` before creating or updating the visible patient case.
   - Include selected study summaries, ordered DICOM exports, selected reports, uploaded prior reports, `patient-summary.txt`, and `metadata.json` in each package.
   - Include SOAP notes in both `patient-summary.txt` and `metadata.json` whenever any SOAP field is filled.
   - Include `reports/soap-clinical-note.pdf`, `reports/soap-clinical-note.html`, and `reports/soap-clinical-note.txt` in each package so the patient receives a PDF report plus HTML/plain-text fallbacks.
   - Store the returned public Nextcloud share as `nextcloudShare` on the patient case so the patient inbox can show the Case Package link.
   - Do not log or expose Nextcloud credentials; only store public share URLs and package metadata needed for the case workflow.
   - Re-run DICOM ordering and upload-throughput regressions after changing package exports because those exports depend on the same ordered Orthanc instance path as streams.

12. Keep SOAP notes structured and optional:

   - Preserve the four SOAP fields as `subjective`, `objective`, `assessment`, and `plan`.
   - Do not merge SOAP notes into the free-text clinical summary; keep both available because the clinical summary is patient-facing and SOAP is structured clinical context.
   - Store SOAP notes on care cases through `soapNotes` and display the fixed-format SOAP Clinical Note document with all four fields.
   - Use `Not entered` for blank SOAP sections in generated note reports so the document shape is consistent.
   - Keep generated and previewed SOAP note reports aligned to the `SUBJECTIVE OBJECTIVE ASSESSMENT PLAN - STUDY NOTES` template structure: document title, patient/case metadata, and fixed Subjective, Objective, Assessment, and Plan sections.
   - Keep `SOAP_TEMPLATE_LOGO_PATH` pointed at the approved report logo and keep `PLAYWRIGHT_MODULE_PATH` valid so the PDF renderer can create `soap-clinical-note.pdf`.
   - Keep the dedicated `/soap-notes` workspace available from the side menu for admin, doctor, and clinic users.
   - Preserve drag-and-drop ordering for selected study stacks and document comparison panels so current studies, priors, and uploaded prior documents can be arranged before note completion.
   - Keep study selection compact in SOAP Notes by using a searchable picker/dropdown instead of a full page-height checklist.
   - Use the same study title/patient-name label shown in the Studies table as the primary study name throughout SOAP Notes; keep study ID/date/modality/file counts as secondary metadata.
   - Keep case title required. In Care Desk, keep the existing clinical summary requirement; in the dedicated SOAP workspace, allow the SOAP clinical note itself to provide the required clinical content.

13. Keep patient records account-backed:

   - Use patient accounts as the durable patient record so cases, messages, study matches, SOAP packages, and future patient access stay tied to one email.
   - Keep `/patients` available from the side menu for admin, doctor, and clinic users.
   - Keep Patients page study assignment tied to existing study metadata: assign by writing the patient account name to `patient_name` and the patient account email to `patient_id`.
   - Allow multi-select assignment from Patients so existing studies can be linked to the durable patient record without re-uploading.
   - Keep patient row details available from `/patients` so assigned cases and linked studies can be reviewed without leaving the patient record.
   - Keep linked studies in patient details clickable to `/studies/:id` so users can open the actual study record from the patient record.
   - Allow SOAP Notes users to build without a patient filter, select an existing patient, or type a new patient name/email.
   - When a typed SOAP patient does not already exist, create the patient account before sending the case package and show the generated temporary password once.
   - Match retained patient files by patient email first, then patient name when study records do not have an email-style patient ID.

14. Keep Grist completed-case logging recoverable:

   - Use `TEST_Sheet` as the Grist-safe table ID for the requested `TEST Sheet` completed-case sheet unless the user explicitly asks to rename it.
   - Keep the completed-case `Code` value in this format: `OCTR - .[StudyName] - ..[Modality] - ...[NextcloudLink]`.
   - Log one row per selected study only after the Nextcloud public share link exists.
   - If `GRIST_BASE_URL`, `GRIST_API_KEY`, or `GRIST_DOC_ID` is missing, queue rows in `mapdr-api/grist-completed-cases-queue.json` instead of dropping them.
   - After Grist configuration changes, restart `mapdr-api.service`, perform one test patient-summary export, confirm queued rows flush, and confirm rows appear in the target Grist document.

15. Keep signed-report-code plotting recoverable:

   - Keep signed-complete study plotting separate from patient-summary completed-case logging. Signoff writes belong to `Report_Codes` by default, not `TEST_Sheet`.
   - Preserve `GRIST_REPORT_CODES_DOC_ID`, `GRIST_REPORT_CODES_TABLE_ID`, `GRIST_REPORT_CODES_TABLE_NAME`, and `GRIST_REPORT_CODES_MONTH_KEY` as the deployment-level controls for the monthly report-code sheet target.
   - Preserve `GRIST_ACRONYM_DOC_ID` and `GRIST_ACRONYM_TABLE_ID` as the controls for the acronym lookup sheet used to expand short names such as `NECTHYUS`.
   - Keep `POST /api/studies/:id/complete` as the signoff trigger that calls `logReportCodesToGrist(makeGristReportCodeRowsForStudy(...))`.
   - Keep report-code rows small and auditable: report code, OCTR code, raw case-log text, client/tier/chapter/body/patient-log fields, acronym and diagnosis tokens, study identifiers, patient identifiers, modality/date/status, signed-complete timestamp, signer, optional Nextcloud link, source, created timestamp, and report-text presence.
   - Match software studies to monthly sheet rows by primary OCTR code first, then study ID or patient-log text if a sheet row lacks a parseable OCTR code.
   - Treat sheet-to-software sync as a reconciliation step: never overwrite radiology report text or completion state from a sheet row unless the update path records source, timestamp, and sync status.
   - If Grist credentials or the report-code table are unavailable, queue rows in `mapdr-api/grist-report-codes-queue.json` instead of blocking signoff or dropping data.
   - After sheet configuration changes, restart `mapdr-api.service`, sign one test study complete, confirm queued rows flush, and confirm the row appears in the `Report Codes` sheet.
   - When NAS export is added, enrich the report-code row with the final export link or add a follow-up row update path rather than changing the signoff flow into a blocking export operation.
   - Do not store proxy passwords or Grist API keys in this document. Keep sheet credentials only in local service environment files or the deployment secret store.

16. Keep acronym expansion locally cached:

   - Treat Grist as the source of truth for acronym definitions and `mapdr-api/acronym-database.json` as the local runtime cache.
   - Use `POST /api/acronyms/sync` as an admin-only import path after acronym sheet edits, and keep the hourly scheduler enabled so the cache refreshes automatically.
   - The acronym importer reads Grist fields `E` and `H` as acronym/code aliases and field `F` as the diagnosis/template text.
   - Keep exact acronym replacement conservative: expand only when the completed token has an exact local match.
   - If a user expects an acronym such as `NECTHYUS` but lookup fails, confirm the exact code exists in the public acronym sheet before adding software aliases.
   - Do not commit the generated acronym database as source code unless the deployment intentionally moves to a versioned acronym snapshot.

17. Keep live screen-recording timing stable:

   - Normalize uploaded WebM timestamps before live recording finalization so browser capture gaps do not survive into the MP4 stored for the study.
   - Keep the existing timestamp normalization path in `mapdr-api/server.js` for case-recording uploads and reuse the same helper for live finalize uploads.
   - If a new recording path is added, run it through the same normalize-then-transcode flow before the file is exposed to the study viewer.

18. Keep video-call routing separated from MAPDR PACS:

   - The MAPDR video-call feature should open `https://call.octelerad.com` in a separate browser tab so the PACS app stays open.
   - Keep `/video` as a fallback page that opens the call app in a new tab and shows a manual external-link button.
   - Do not repoint the PACS Cloudflare tunnel or local Vite service to host the call app unless the routing plan is intentionally changed.
   - Keep the local `video-gateway` service healthy for compatibility, but do not mint tokens for `call.octelerad.com` from the MAPDR gateway unless that standalone app is deliberately brought under this stack.
   - Verify public `https://call.octelerad.com` separately from `pacs.octelerad.com` after any video or Cloudflare change.

19. Keep study collaboration realtime but conflict-safe:

   - Use the study realtime stream for case-level change notifications instead of relying on manual refresh for shared cases.
   - Treat presence as a best-effort indicator of who is viewing or editing a case, not as a hard lock.
   - Reject stale study writes with the `base_updated_at` check so concurrent edits produce a conflict instead of overwriting newer work.
   - When a case editor is dirty, do not silently overwrite their draft from a realtime refresh; surface the newer state and let the user re-open or resync explicitly.
   - Keep attachments and uploads append-only where possible so multiple users can add recordings or reports without colliding on a single file slot.

## Recommended Near-Term Work

- Rebuild representative existing case streams and compare order, quality, and file size.
- Add an automated integration test that verifies screenshot dimensions and case-stream encoding settings.
- Add an automated integration test or admin-only diagnostic that checks DICOM stream completeness against Orthanc instance counts without exposing patient details.
- Establish backups and a tested restore procedure before any database or Orthanc storage cleanup.
- Configure and test TURN only after a public TURN domain and valid TLS certificate files are available.

## Repository Cleanup Plan

Completed on June 4, 2026:

- Stopped tracking runtime data, secrets, Orthanc storage, temporary files, auth data, and `node_modules`.
- Committed and tested backend dependency/security, export, and image-quality work.
- Committed and tested frontend case workflow and stream presentation work.
- Rotated locally controlled Orthanc, LiveKit, and administrator credentials.
- Replaced exposed repository history with a single sanitized production baseline.
- Live runtime files remained on disk and production health checks continued to pass.

The pre-sanitization history is retained only in a root-readable local bundle for emergency recovery. Do not publish that bundle.
