// Port of app/services/exports/audience_export_service.rb (the CSV and filename; the audience query and the
// mailer stay with the job, WS-30). Enqueue: app/controllers/audience_controller.rb via enqueue.ts.
import { csvSafeGenerate } from "../../lib/csv-safe.ts";

export const AUDIENCE_FIELDS = ["Subscriber Email", "Subscribed Time"] as const;

export type AudienceOptions = { followers?: boolean; customers?: boolean; affiliates?: boolean };

export class AudienceExportArgumentError extends Error {
  constructor() {
    super("At least one audience type (followers, customers, or affiliates) must be selected");
  }
}

export type AudienceMember = { email: string | null; minCreatedAt: Date | null };

// Rails' Time.current.to_fs(:db) with its spaces and colons turned into dashes; Time.zone is unset, so UTC.
export function exportTimestamp(now: Date): string {
  const iso = now.toISOString();
  return iso.slice(0, 19).replace("T", "-").replaceAll(":", "-");
}

export function audienceExportFilename(username: string, now: Date): string {
  return `Subscribers-${username}_${exportTimestamp(now)}.csv`;
}

export function validateAudienceOptions(options: AudienceOptions): void {
  if (!options.followers && !options.customers && !options.affiliates) throw new AudienceExportArgumentError();
}

// The OR-joined SQL conditions the service adds to the audience_members query, in its order.
export function audienceMemberConditions(options: AudienceOptions): string[] {
  const conditions: string[] = [];
  if (options.followers) conditions.push("follower = true");
  if (options.customers) conditions.push("customer = true");
  if (options.affiliates) conditions.push("affiliate = true");
  return conditions;
}

// Ruby's Time#to_s for a UTC time: "2025-01-02 03:04:05 UTC".
export function rubyTimeToS(time: Date): string {
  return `${time.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// find_each batches by primary key and drops the query's order(:min_created_at), so the caller passes the
// members in id order and the rows keep that order.
export function audienceExportCsv(members: readonly AudienceMember[]): string {
  const rows = members.map((member) => [member.email, member.minCreatedAt === null ? null : rubyTimeToS(member.minCreatedAt)]);
  return csvSafeGenerate([[...AUDIENCE_FIELDS], ...rows]);
}
