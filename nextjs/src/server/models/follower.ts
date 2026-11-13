// Port of app/models/follower.rb with the concerns it includes (Deletable, ConfirmedFollowerEvent::FollowerCallbacks,
// Follower::AudienceMember) and has_paper_trail, in the order Rails runs the callbacks.
//
// Refused with NotPortedError rather than approximated: a follow that leaves the old newsletter of a seller with a
// FeatureAnnouncementNewsletterCutover row (record_feature_announcements_opt_out), a follow that would become active under
// such a seller (newsletter_not_retired), and an audience member row that is locked by another writer
// (RefreshAudienceMemberJob fallback). Changing the email of a saved follower is not ported.
import { randomUUID } from "node:crypto";

import { Prisma, type Follower } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";

import {
  AudienceMembers,
  findAudienceMember,
  findOrInitializeAudienceMember,
  type Details,
} from "./audience-member-record.ts";
import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, execute, isLockWaitTimeout, isRecordNotUnique, selectRows, table } from "./sql.ts";
import { isValidEmailFormat, NotPortedError } from "./user.ts";
import { SEND_WORKFLOW_INSTALLMENT_WORKER, schedulableInstallments, type WorkflowPush } from "./workflow-scheduling.ts";
import { aliveWorkflowsOfSeller } from "./workflow.ts";

export type FollowerRecord = ModelRecord<Follower>;

export const FOLLOWERS = "followers";
export const RETIRED_NEWSLETTER_MESSAGE =
  "Gumroad's newsletter is now Feature announcements. Turn them on in Settings, under Notifications.";
export const OPT_OUT_LOCK_WAIT_SECONDS = 10;
export const OPT_OUT_RETRY_AFTER_SECONDS = 60;

// Onetime::MigrateNewsletterSubscribersToFeatureAnnouncements::NEWSLETTER_SELLER_EXTERNAL_ID
const NEWSLETTER_SELLER_EXTERNAL_ID = "6282492303727";
// ConfirmedFollowerEvent::Events
const EVENT_ADDED = "added";
const EVENT_REMOVED = "removed";

const user = { name: "user", foreignKey: "followed_id", targetTable: "users", targetModel: "User" } as const;

// Time#iso8601 of a UTC time.
const iso8601 = (time: Date): string => time.toISOString().replace(".000Z", "Z");

async function cutoverRows(sellerId: number): Promise<{ state: string }[]> {
  return selectRows<{ state: string }>(
    Prisma.sql`SELECT ${Prisma.raw("`feature_announcement_newsletter_cutovers`.`state`")} FROM ${table("feature_announcement_newsletter_cutovers")} WHERE ${column("feature_announcement_newsletter_cutovers", "seller_id")} = ${sellerId}`,
  );
}

// FeatureAnnouncementNewsletterCutover.tracks_opt_outs_for?
export async function tracksOptOutsFor(sellerId: number): Promise<boolean> {
  return (await cutoverRows(sellerId)).some((row) => row.state !== "rolled_back");
}

// FeatureAnnouncementNewsletterCutover.covers?: Gumroad's own newsletter seller, or a seller with a cutover row.
export async function coveredByCutover(sellerId: number): Promise<boolean> {
  if ((await cutoverRows(sellerId)).length > 0) return true;
  const [row] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw("`users`.`id`")} FROM ${table("users")} WHERE ${column("users", "external_id")} = ${NEWSLETTER_SELLER_EXTERNAL_ID} LIMIT 1`,
  );
  return row !== undefined && Number(row.id) === sellerId;
}

const savedBefore = (record: FollowerRecord, name: "confirmed_at" | "deleted_at"): Date | null => {
  const change = record.savedChanges[name];
  return (change ? change[0] : record.get(name)) as Date | null;
};

// `deleted_at_before_last_save.nil? && confirmed_at_before_last_save.present? && (deleted_at.present? || confirmed_at.nil?)`
const leftNewsletter = (record: FollowerRecord): boolean =>
  savedBefore(record, "deleted_at") === null &&
  savedBefore(record, "confirmed_at") !== null &&
  (record.get("deleted_at") !== null || record.get("confirmed_at") === null);

const becomingActive = (record: FollowerRecord): boolean =>
  (record.attributeChanged("confirmed_at") && record.get("confirmed_at") !== null) ||
  (record.attributeChanged("deleted_at") && record.get("deleted_at") === null);

const shouldBeAudienceMember = (record: FollowerRecord): boolean =>
  record.get("confirmed_at") !== null && isValidEmailFormat(record.get("email"));

// Follower::AudienceMember#remove_from_audience_member_details
async function removeFromAudienceMemberDetails(record: FollowerRecord, email: string): Promise<void> {
  const member = await findAudienceMember(email, BigInt(record.get("followed_id")));
  if (member === null) return;
  const details = { ...((member.get("details") ?? {}) as Details) };
  delete details.follower;
  member.set("details", details as never);
  // `member.valid? ? save! : destroy!`: a member who is still a customer or an affiliate keeps its row, with its columns recomputed.
  if (await AudienceMembers.valid(member)) return void (await AudienceMembers.saveBang(member));
  await AudienceMembers.destroyBang(member);
}

// Follower::AudienceMember#update_audience_member_details
const updateAudienceMemberDetails: Callback<Follower> = {
  name: "update_audience_member_details",
  async run(record) {
    if (!record.savedChanges.confirmed_at && !record.savedChanges.email) return;
    // `previously_new_record?`: a created follower has nothing under an earlier email to remove.
    const created = record.savedChanges.created_at !== undefined;
    if (record.savedChanges.email && !created)
      throw new NotPortedError("Changing the email of a follower", "app/models/concerns/follower/audience_member.rb");
    try {
      if (!shouldBeAudienceMember(record)) return await removeFromAudienceMemberDetails(record, record.get("email")!);
      const member = await findOrInitializeAudienceMember(record.get("email")!, BigInt(record.get("followed_id")));
      if (member.persisted)
        throw new NotPortedError(
          "Adding a follower to an existing audience member",
          "app/models/concerns/follower/audience_member.rb",
        );
      const details = { ...((member.get("details") ?? {}) as Details) };
      details.follower = { id: record.get("id"), created_at: iso8601(record.get("created_at")!) };
      member.set("details", details as never);
      await AudienceMembers.saveBang(member);
    } catch (error) {
      // The Ruby retries a unique-index race under a lock and falls back to RefreshAudienceMemberJob on a lock wait.
      if (isRecordNotUnique(error) || isLockWaitTimeout(error))
        throw new NotPortedError("A contended audience member row", "app/models/concerns/follower/audience_member.rb");
      throw error;
    }
  },
};

const paperTrail = hasPaperTrail<Follower>("Follower", { itemType: "Follower" });

export const Followers = defineModel<Follower>({
  rubyClass: "Follower",
  prismaModel: "Follower",
  delegate: (tx) => tx.follower as never,
  validations: [
    validatesAssociationPresence<Follower>(user),
    {
      name: "validates_presence_of :email",
      run(record) {
        if (isBlank(record.get("email"))) record.errors.add("email", "blank");
      },
    },
    {
      name: "validates :email, email_format, if: :email_changed?",
      if: (record) => record.attributeChanged("email"),
      run(record) {
        if (!isValidEmailFormat(record.get("email"))) record.errors.add("email", "invalid", { message: "invalid." });
      },
    },
    {
      name: "not_confirmed_and_deleted",
      run(record) {
        if (record.get("confirmed_at") !== null && record.get("deleted_at") !== null)
          record.errors.add("base", "Can't be both confirmed and deleted");
      },
    },
    {
      name: "double_follow_validation",
      if: (record) => record.newRecord,
      async run(record) {
        const rows = await selectRows<unknown>(
          Prisma.sql`SELECT 1 AS one FROM ${table(FOLLOWERS)} WHERE ${column(FOLLOWERS, "followed_id")} = ${record.get("followed_id")} AND ${column(FOLLOWERS, "email")} = ${record.get("email")} LIMIT 1`,
        );
        if (rows.length > 0) record.errors.add("base", "You are already following this creator.");
      },
    },
    {
      name: "follower_user_id_exists",
      unless: (record) => record.attributeChanged("deleted_at", { from: null }),
      async run(record, ctx) {
        const id = record.get("follower_user_id");
        if (id === null) return;
        const rows = await ctx.tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM ${table("users")} WHERE ${column("users", "id")} = ${id} LIMIT 1`,
        );
        if (rows.length === 0)
          record.errors.add("follower_user_id", "invalid", {
            message: "Follower's User ID does not map to an existing user",
          });
      },
    },
    {
      name: "newsletter_not_retired",
      if: (record) => record.newRecord || becomingActive(record),
      async run(record) {
        // retired_for_follow? answers for a seller the cutover covers; the barrier read is not ported.
        if (await coveredByCutover(record.get("followed_id")))
          throw new NotPortedError(
            "A follow under a newsletter cutover",
            "app/models/follower.rb newsletter_not_retired",
          );
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  afterSave: [
    updateAudienceMemberDetails,
    {
      name: "record_feature_announcements_opt_out",
      if: leftNewsletter,
      async run(record) {
        if (await tracksOptOutsFor(record.get("followed_id")))
          throw new NotPortedError(
            "Opting a newsletter subscriber out of Feature announcements",
            "app/models/follower.rb record_feature_announcements_opt_out",
          );
      },
    },
  ],
  afterCommit: [
    {
      // ConfirmedFollowerEvent::FollowerCallbacks#create_confirmed_follower_event
      name: "create_confirmed_follower_event",
      async run(record) {
        const change = record.savedChanges.confirmed_at;
        if (!change || !(change[0] == null || change[1] == null)) return;
        const body: Record<string, unknown> = {
          follower_id: record.get("id"),
          followed_user_id: record.get("followed_id"),
          follower_user_id: record.get("follower_user_id"),
          email: record.get("email"),
        };
        if (change[0] == null)
          Object.assign(body, { name: EVENT_ADDED, timestamp: iso8601(record.get("confirmed_at")!) });
        else Object.assign(body, { name: EVENT_REMOVED, timestamp: iso8601(record.get("deleted_at")!) });
        await performAsync("ElasticsearchIndexerWorker", [
          "index",
          { class_name: "ConfirmedFollowerEvent", id: randomUUID(), body } as never,
        ]);
      },
    },
  ],
});

const softDeletion = deletable(Followers);

// Follower#mark_deleted!: the follow is no longer confirmed either.
export function markDeletedBang(record: FollowerRecord) {
  record.set("confirmed_at", null);
  return softDeletion.markDeletedBang(record);
}

const FOLLOWER_WORKFLOW_TYPES = ["follower", "audience"] as const;

// Follower#schedule_workflow_jobs: the pushes, computed before the save so a rule Node cannot time still hands the request back
// ahead of every write (Rails raises on it after the save).
async function workflowPushes(record: FollowerRecord): Promise<WorkflowPush[]> {
  const referenceTime = record.get("confirmed_at") as Date;
  const pushes: WorkflowPush[] = [];
  const workflows = (await aliveWorkflowsOfSeller(record.get("followed_id"), FOLLOWER_WORKFLOW_TYPES)).sort(
    (a, b) => Number(a.id) - Number(b.id),
  );
  for (const workflow of workflows) {
    if (!workflow.newCustomerTrigger) continue;
    for (const { installment, rule } of await schedulableInstallments(workflow, { published: false })) {
      if (rule.delayed_delivery_time === null)
        throw new NotPortedError("an installment rule without a delay", "app/models/installment_rule.rb");
      pushes.push({
        at: new Date(referenceTime.getTime() + rule.delayed_delivery_time * 1000),
        args: [installment.id, rule.version, null, Number(record.get("id")), null, null, iso8601(referenceTime)],
      });
    }
  }
  return pushes;
}

// Follower#confirm!
export async function confirmBang(record: FollowerRecord): Promise<void> {
  if (record.get("confirmed_at") !== null) return;
  // Time.current.change(usec: 0)
  record.set("confirmed_at", new Date(Math.floor(Date.now() / 1000) * 1000));
  record.set("deleted_at", null);
  const pushes = await workflowPushes(record);
  await Followers.saveBang(record);
  for (const { at, args } of pushes) await performAsync(SEND_WORKFLOW_INSTALLMENT_WORKER, args, { at });
}

// `Follower.find_by_external_id(id)`
export async function findByExternalId(externalId: string): Promise<FollowerRecord | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`followers`.*")} FROM ${table(FOLLOWERS)} WHERE ${column(FOLLOWERS, "id")} = ${id} LIMIT 1`,
  );
  return row ? Followers.load(castRow<Follower>("Follower", row)) : null;
}

// Follower.with_opt_out_lock_wait: a bounded lock wait around the opt-out. The setting is session-wide, so the whole opt-out
// (setting, writes, restore) runs on the one connection of a transaction.
export function withOptOutLockWait<T>(fn: () => Promise<T>): Promise<T> {
  return transaction(async () => {
    const [setting] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT @@SESSION.innodb_lock_wait_timeout`);
    const previous = setting ? Object.values(setting)[0] : null;
    await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${OPT_OUT_LOCK_WAIT_SECONDS}`));
    try {
      return await fn();
    } finally {
      if (previous != null && String(previous) !== "")
        await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${Math.trunc(Number(previous))}`));
    }
  });
}
