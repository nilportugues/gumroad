// Read side of app/models/dispute_evidence.rb: the seller's evidence window and the scopes the
// dispute jobs scan. Nothing here writes a dispute_evidences row (evidence is created, stamped and
// resolved by Ruby: file attachments, Stripe submission). Window arithmetic is pinned by
// __fixtures__/dispute-evidence-window.golden.json (scripts/golden/dispute-evidence-window.rb).
import { Prisma } from "@prisma/client";

import { column } from "./sql.ts";

export const DISPUTE_EVIDENCES = "dispute_evidences";

export const SUBMIT_EVIDENCE_WINDOW_DURATION_IN_HOURS = 72;
// Added when the base window touches a Saturday or Sunday (UTC).
export const WEEKEND_EXTENSION_IN_HOURS = 48;
// Only windows stamped at or after this get the extension (Time.utc(2026, 10, 5)).
export const WEEKEND_EXTENSION_STARTS_AT = new Date(Date.UTC(2026, 9, 5));
export const EVIDENCE_REMINDER_LEAD_TIME_MS = 24 * 3_600_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// scope :seller_contacted, :not_resolved (TimestampStateFields)
export const disputeEvidenceScopes = {
  sellerContacted: () => Prisma.sql`${column(DISPUTE_EVIDENCES, "seller_contacted_at")} IS NOT NULL`,
  notResolved: () => Prisma.sql`${column(DISPUTE_EVIDENCES, "resolved_at")} IS NULL`,
};

// DisputeEvidence.weekend_extended?: does [stamp, stamp + 72h) touch a Saturday or Sunday (UTC)?
// A window ending exactly at midnight does not reach the day that begins there.
function weekendExtended(sellerContactedAt: Date): boolean {
  if (sellerContactedAt < WEEKEND_EXTENSION_STARTS_AT) return false;
  const endsAt = sellerContactedAt.getTime() + SUBMIT_EVIDENCE_WINDOW_DURATION_IN_HOURS * HOUR_MS;
  const startDay = Math.floor(sellerContactedAt.getTime() / DAY_MS);
  let lastDay = Math.floor(endsAt / DAY_MS);
  if (endsAt === lastDay * DAY_MS) lastDay -= 1;
  for (let day = startDay; day <= lastDay; day++) {
    const weekday = new Date(day * DAY_MS).getUTCDay();
    if (weekday === 0 || weekday === 6) return true;
  }
  return false;
}

// DisputeEvidence.window_duration, in milliseconds
export function windowDurationMs(sellerContactedAt: Date): number {
  const hours = SUBMIT_EVIDENCE_WINDOW_DURATION_IN_HOURS + (weekendExtended(sellerContactedAt) ? WEEKEND_EXTENSION_IN_HOURS : 0);
  return hours * HOUR_MS;
}

// DisputeEvidence.seller_response_due_at
export function sellerResponseDueAt(sellerContactedAt: Date | null): Date | null {
  if (sellerContactedAt === null) return null;
  return new Date(sellerContactedAt.getTime() + windowDurationMs(sellerContactedAt));
}

// DisputeEvidence.window_open?: exact comparison against the deadline.
export function windowOpen(sellerContactedAt: Date | null, now: Date): boolean {
  const dueAt = sellerResponseDueAt(sellerContactedAt);
  return dueAt !== null && now.getTime() < dueAt.getTime();
}

// DisputeEvidence.hours_left_in_window: rounded, for display only.
export function hoursLeftInWindow(sellerContactedAt: Date | null, now: Date): number {
  const dueAt = sellerResponseDueAt(sellerContactedAt);
  if (dueAt === null) return 0;
  // Float#round rounds halves away from zero.
  const hours = (dueAt.getTime() - now.getTime()) / HOUR_MS;
  // Adding 0 turns a rounded -0 into Ruby's 0.
  return (hours < 0 ? -Math.round(-hours) : Math.round(hours)) + 0;
}

// DisputeEvidence.seller_response_reminder_at
export function sellerResponseReminderAt(sellerContactedAt: Date | null): Date | null {
  const dueAt = sellerResponseDueAt(sellerContactedAt);
  return dueAt === null ? null : new Date(dueAt.getTime() - EVIDENCE_REMINDER_LEAD_TIME_MS);
}
