/**
 * One-shot scheduled job: dispatch due reminders/festivals and downgrade lapsed
 * promo grants. Runs the same logic as the in-process hourly scheduler, but as a
 * process that exits — which is what a platform cron (Railway Cron, Cloud
 * Scheduler, GitHub Actions, k8s CronJob) needs.
 *
 * Why this exists: the in-process scheduler only works for a single always-on
 * instance. Two replicas would double-send; a sleeping/scale-to-zero instance
 * would never fire. Point a cron at this instead and set RUN_SCHEDULER=false on
 * the web service.
 *
 *   npm run scheduler:run          # local
 *   railway run npm run scheduler:run
 *
 * Safe to re-run: both checks are idempotent — reminders are guarded by
 * `last_notified` and promo downgrades by the plan/expiry columns — so a
 * duplicate or retried run sends nothing twice.
 */
import { runReminderCheck, runPlanExpiryCheck } from "../server/reminderScheduler";
import { pool } from "../server/db";

async function main(): Promise<void> {
  const startedAt = Date.now();
  let failed = false;

  try {
    const { sent } = await runReminderCheck();
    console.log(`[scheduler] reminders dispatched: ${sent}`);
  } catch (e) {
    failed = true;
    console.error("[scheduler] reminder check FAILED:", e);
  }

  // Run the expiry sweep even if reminders failed — they're independent, and a
  // user shouldn't keep a lapsed promo plan because an email provider is down.
  try {
    const { downgraded } = await runPlanExpiryCheck();
    console.log(`[scheduler] promo grants expired: ${downgraded}`);
  } catch (e) {
    failed = true;
    console.error("[scheduler] plan expiry check FAILED:", e);
  }

  console.log(`[scheduler] finished in ${Date.now() - startedAt}ms`);
  await pool.end(); // release the connection so the process can exit
  process.exit(failed ? 1 : 0); // non-zero marks the cron run as failed
}

main().catch(async (e) => {
  console.error("[scheduler] fatal:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
