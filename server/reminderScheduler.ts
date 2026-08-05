import {
  listEnabledRemindersWithUser, markReminderNotified,
  listSubscriptionsForScheduler, markSubscriptionNotified,
  createNotification, listExpiredPromoUsers, downgradeToFree,
} from "./db";
import { sendEmail } from "./mailer";

// Reminder automation. A per-occurrence guard (last_notified) makes runs
// idempotent, so we can check frequently without double-sending.

/**
 * If today falls within [occurrence - leadDays, occurrence] for the given base
 * date & recurrence, return that occurrence's ISO date; otherwise null.
 */
function occurrenceInWindow(
  baseDate: string, recurrence: string, leadDays: number, today: Date,
): string | null {
  const [by, bm, bd] = baseDate.split("-").map(Number);
  if (!bm || !bd) return null;
  const todayMid = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const candidates: number[] = [];
  if (recurrence === "once") {
    candidates.push(Date.UTC(by, bm - 1, bd));
  } else {
    // Annual — check this year and next year so a Dec→Jan lead window works.
    const y = today.getUTCFullYear();
    candidates.push(Date.UTC(y, bm - 1, bd), Date.UTC(y + 1, bm - 1, bd));
  }
  const DAY = 86_400_000;
  for (const occ of candidates) {
    const windowStart = occ - Math.max(0, leadDays) * DAY;
    if (todayMid >= windowStart && todayMid <= occ) {
      return new Date(occ).toISOString().slice(0, 10);
    }
  }
  return null;
}

function prettyDate(iso: string): string {
  // The stored date is a plain calendar date pinned to UTC midnight, so it MUST
  // be formatted in UTC. Without timeZone the server's own zone applies and any
  // host west of UTC renders the previous day — telling users their ritual or
  // festival is a day earlier than it is.
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** Scan reminders + festival subscriptions and dispatch anything due. */
export async function runReminderCheck(now = new Date()): Promise<{ sent: number }> {
  let sent = 0;

  for (const r of await listEnabledRemindersWithUser()) {
    const occ = occurrenceInWindow(r.event_date, r.recurrence, r.lead_days, now);
    if (!occ || r.last_notified === occ) continue;
    const title = `Reminder: ${r.title}`;
    const body = `${r.title} is on ${prettyDate(occ)}.` + (r.notes ? ` ${r.notes}` : "");
    await createNotification(r.user_id, { title, body, level: "info" });
    if (r.email) {
      await sendEmail({ to: r.email, subject: title, text: `${body}\n\n— Aistrology Reminders` });
    }
    await markReminderNotified(r.id, occ);
    sent++;
  }

  for (const s of await listSubscriptionsForScheduler()) {
    const occ = occurrenceInWindow(s.event_date, s.recurring ? "annual" : "once", s.lead_days, now);
    if (!occ || s.last_notified === occ) continue;
    const title = `Festival: ${s.name}`;
    const body = `${s.name} is on ${prettyDate(occ)}.` + (s.description ? ` ${s.description}` : "");
    await createNotification(s.user_id, { title, body, level: "info" });
    if (s.email) {
      await sendEmail({ to: s.email, subject: title, text: `${body}\n\n— Aistrology Reminders` });
    }
    await markSubscriptionNotified(s.id, occ);
    sent++;
  }

  return { sent };
}

/** Revert any lapsed promo grants to the free (Basic) plan. */
export async function runPlanExpiryCheck(): Promise<{ downgraded: number }> {
  let downgraded = 0;
  for (const u of await listExpiredPromoUsers()) {
    await downgradeToFree(u.id);
    await createNotification(u.id, {
      title: "Promo plan ended",
      body: `Your ${u.plan.charAt(0).toUpperCase() + u.plan.slice(1)} promo access has ended — you're back on the Basic (Free) plan.`,
      level: "warning",
    });
    downgraded++;
  }
  return { downgraded };
}

let started = false;
export function startReminderScheduler(): void {
  if (started) return;
  started = true;
  const run = async () => {
    try { await runReminderCheck(); } catch (e) { console.warn("[reminders] check failed:", e); }
    try { await runPlanExpiryCheck(); } catch (e) { console.warn("[plans] expiry check failed:", e); }
  };
  setTimeout(run, 10_000);           // shortly after boot
  setInterval(run, 3_600_000);       // hourly (promo expiry is time-sensitive)
}
