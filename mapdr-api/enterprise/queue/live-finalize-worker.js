/**
 * Live finalize worker scaffold.
 *
 * Intended target architecture:
 * - Producer (API): enqueue row into live_finalize_jobs when upload recording arrives.
 * - Worker: poll queued jobs, run ffmpeg transcode webm->mp4, update studies and sessions atomically.
 *
 * This is intentionally not wired into runtime yet; it is a migration scaffold.
 */

async function runOnce() {
  // TODO: connect to Postgres and claim one queued job using FOR UPDATE SKIP LOCKED.
  // TODO: run ffmpeg transcode and update db rows in transaction.
  // TODO: mark success/failure with attempts and error payload.
}

async function main() {
  // Placeholder loop; replace with queue backend (BullMQ/SQS) during rollout phase.
  // Keep process contract stable for PM2/systemd.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      // Swallow to keep worker alive; production version should add structured logging.
      console.error('[live-finalize-worker] loop error', err && err.message ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[live-finalize-worker] fatal', err);
    process.exit(1);
  });
}
