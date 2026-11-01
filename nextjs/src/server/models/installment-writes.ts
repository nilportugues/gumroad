// Writes of an Installment (app/models/installment.rb): `publish!`, `unpublish!` and `mark_deleted!`, with the validations and
// callbacks a save runs. Golden: worker/jobs/__fixtures__/publish-scheduled-post.golden.json (scripts/golden/publish-scheduled-post.rb).
//
// What Node cannot prove throws NotPortedError, before the first write of the save:
// - a post whose audience filter Node cannot read (audience-member filters in installment-audience.ts), which the
//   sending-limit validation needs;
// - a message Rails::HTML::Sanitizer would have to judge, a call to action, a post without a slug, a post with files (video
//   transcoding), and a seller that content moderation would review (it asks an AI model).
import { Prisma, type Installment } from "@prisma/client";

import { INSTALLMENT_ATTRIBUTE_TO_SEARCH_FIELDS } from "../search/documents/simple.ts";
import { filterCount } from "../search/audience-member-search.ts";
import { salesCentsTotal } from "../search/purchase-sales.ts";
import { deletable } from "./concerns/deletable.ts";
import { jsonData, mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { audienceMembersFilterParams } from "./installment-audience.ts";
import { InstallmentFlags, InstallmentPost } from "./installment-post.ts";
import { defineModel, type Callback, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesLengthOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { defaultSubscriptionDeps } from "./subscription.ts";
import { MINIMUM_SALES_CENTS_VALUE, emailSendingOverrideActive } from "./user-email-eligibility.ts";
import { NotPortedError } from "./user.ts";

type InstallmentModel = ModelRecord<Installment>;

export const INSTALLMENT_NAME_MAX_LENGTH = 255;
// Installment::SENDING_LIMIT
export const SENDING_LIMIT = 100;
// User::VipCreator::VIP_GROSS_PAID_PAYOUTS_THRESHOLD_CENTS
const VIP_GROSS_PAID_PAYOUTS_THRESHOLD_CENTS = 5_000_000;
const ELASTICSEARCH_UPDATE_DELAY_SECONDS = 4;
const SECOND_MS = 1000;
const CONTENT_MODERATION_FEATURE = "content_moderation";
const PUBLISHING = "publishing";
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";
const SOURCE = "installment.rb";

export class InstallmentInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Installment::InstallmentInvalid";
  }
}

const refuse = (what: string): never => {
  throw new NotPortedError(what, SOURCE);
};

const ASSOCIATIONS = "installmentAssociations";

// The associations of one loaded Installment are read once, as ActiveRecord memoizes them on the object.
export function post(record: InstallmentModel): InstallmentPost {
  const loaded = new InstallmentPost(record.attributes as Installment);
  loaded.memo = (record.ivars[ASSOCIATIONS] ??= new Map()) as InstallmentPost["memo"];
  return loaded;
}
const flag = (record: InstallmentModel, name: Parameters<typeof InstallmentFlags.isSet>[1]) => InstallmentFlags.isSet(record.get("flags") as number, name);
const isPublishing = (record: InstallmentModel) => record.ivars[PUBLISHING] === true;
const published = (record: InstallmentModel) => record.get("published_at") !== null;
const present = (value: string | null | undefined) => value !== null && value !== undefined && !/^[\t\n\v\f\r ]*$/u.test(value);

// `scrubbed_message.blank?`: Loofah keeps `br` and `p` and the text around them. Node judges the messages whose text is plain.
function messageHasText(message: string | null): boolean {
  if (message === null) return false;
  if (/<\s*(script|style|noscript|template|iframe|object|embed|svg|math|!--)/iu.test(message)) return refuse("a message with markup the sanitizer drops (message_must_be_provided)");
  const text = message.replace(/<[^>]*>/gu, "");
  if (/[A-Za-z0-9]/u.test(text)) return true;
  if (text.trim() === "" && !/&/u.test(text)) return false;
  return refuse("a message without plain text (message_must_be_provided)");
}

// `user`: `seller.presence || link.user`
const userOf = (record: InstallmentModel) => post(record).user();

// `user&.vip_creator?`: gross paid payouts above the threshold
async function vipCreator(record: InstallmentModel): Promise<boolean> {
  const user = await userOf(record);
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT SUM(${column("payments", "amount_cents")}) FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${user.id} AND ${column("payments", "state")} = ${"completed"}`,
  );
  const sum = row === undefined ? 0 : Number(Object.values(row)[0] ?? 0);
  return sum > VIP_GROSS_PAID_PAYOUTS_THRESHOLD_CENTS;
}

const validations: Callback<Installment>[] = [
  validatesLengthOf<Installment>(["name"], { maximum: INSTALLMENT_NAME_MAX_LENGTH }),
  {
    name: "message_must_be_provided",
    run(record) {
      if (!messageHasText(record.get("message"))) record.errors.add("base", "Please include a message as part of the update.");
    },
  },
  {
    name: "validate_call_to_action_url_and_text",
    run(record) {
      if (present(record.get("call_to_action_url")) || present(record.get("call_to_action_text"))) refuse("a call to action (validate_call_to_action_url_and_text)");
    },
  },
  {
    name: "validate_channel",
    run(record) {
      if (flag(record, "shown_on_profile") || flag(record, "send_emails")) return;
      record.errors.add("base", "Please set at least one channel for your update.");
    },
  },
  {
    name: "published_at_cannot_be_in_the_future",
    run(record, ctx) {
      const publishedAt = record.get("published_at");
      if (publishedAt === null) return;
      if (publishedAt.getTime() <= (ctx.now ?? (() => new Date()))().getTime()) return;
      record.errors.add("base", "Please enter a publish date in the past.");
    },
  },
  {
    name: "validate_sending_limit_for_sellers",
    async run(record) {
      if (!flag(record, "send_emails")) return;
      if (record.get("deleted_at") !== null) return;
      if (record.get("installment_type") === "abandoned_cart") return;
      if (flag(record, "single_recipient_email")) return;
      const user = await userOf(record);
      if (await emailSendingOverrideActive(user)) return;
      // Reading the filters initializes json_data to `{}`, which a save then writes.
      record.untracked(() => jsonData(record));
      const params = await audienceMembersFilterParams(post(record));
      const audience = await filterCount(record.get("seller_id"), params, SENDING_LIMIT + 1);
      if (audience === null) throw new TypeError("undefined method '>' for nil");
      if (audience > SENDING_LIMIT && (await salesCentsTotal(user.id)) < MINIMUM_SALES_CENTS_VALUE) {
        record.errors.add(
          "base",
          `<a href='/help/article/269-balance-page' target='_blank' rel='noreferrer'>Sorry, you cannot send out more than ${SENDING_LIMIT} emails until you have $${MINIMUM_SALES_CENTS_VALUE / 100} in total earnings.</a>`,
        );
      }
    },
  },
  {
    name: "shown_on_profile_only_for_confirmed_users",
    // `shown_on_profile_changed?`: the flag's bit differs from the one in the database
    if: (record) => {
      const change = record.changes().flags;
      return change !== undefined && InstallmentFlags.isSet(change[0] as number, "shown_on_profile") !== InstallmentFlags.isSet(change[1] as number, "shown_on_profile");
    },
    async run(record) {
      if (!flag(record, "shown_on_profile")) return;
      const seller = await post(record).seller();
      if (seller === null) throw new TypeError("undefined method 'confirmed?' for nil");
      if (seller.confirmed_at === null) record.errors.add("base", "Please confirm your email before creating a public post.");
    },
  },
  {
    name: "content_moderation_check",
    if: (record) => isPublishing(record) || (record.persisted && published(record) && (record.attributeChanged("name") || record.attributeChanged("message"))),
    async run(record) {
      if (await vipCreator(record)) return;
      // ContentModeration::ModerateRecordService.check: with the kill switch off nothing is reviewed.
      if (await defaultSubscriptionDeps.featureActive(CONTENT_MODERATION_FEATURE, null)) refuse("content moderation of a post (ModerateRecordService asks an AI model)");
    },
  },
];

const paperTrail = hasPaperTrail<Installment>("Installment", { itemType: "Installment" });

export const Installments = defineModel<Installment>({
  rubyClass: "Installment",
  prismaModel: "Installment",
  delegate: (tx) => tx.installment as never,
  beforeValidation: [
    {
      // friendly_id: a slug is generated only for a record that has none
      name: "FriendlyId set_slug",
      run(record) {
        if (record.get("slug") === null && record.get("name") !== null) refuse("a post without a slug (friendly_id)");
      },
    },
    {
      name: "(guard) create",
      on: "create",
      run: () => refuse("Installment#create"),
    },
  ],
  validations,
  beforeSave: [mergeJsonDataWithCurrentRow<Installment>("installments")],
  afterUpdate: [...paperTrail.afterUpdate],
  afterSave: [
    {
      name: "TransactionalAttributeChangeTracker after_save",
      run: (record) => {
        record.ivars[COMMITTED] = null;
        const changed = (record.ivars[CHANGED_IN_TRANSACTION] ??= new Set<string>()) as Set<string>;
        for (const name of Object.keys(record.savedChanges)) changed.add(name);
      },
    },
  ],
  afterCommit: [
    {
      // ElasticsearchModelAsyncCallbacks#send_to_elasticsearch("update")
      name: "send_to_elasticsearch",
      on: "update",
      async run(record) {
        const committed = (record.ivars[COMMITTED] as string[] | undefined) ?? [];
        const fields = [...new Set(committed.flatMap((name) => INSTALLMENT_ATTRIBUTE_TO_SEARCH_FIELDS[name] ?? []))];
        if (fields.length === 0) return;
        await performAsync("ElasticsearchIndexerWorker", ["update", { record_id: record.get("id"), class_name: "Installment", fields }], { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS });
      },
    },
    {
      name: "TransactionalAttributeChangeTracker before_commit",
      run: (record) => {
        const changed = record.ivars[CHANGED_IN_TRANSACTION] as Set<string> | undefined;
        if (changed === undefined) return;
        record.ivars[COMMITTED] = [...changed];
        changed.clear();
      },
    },
  ],
});

const softDeletion = deletable(Installments);

// `transcode_videos!`: the alive product files that are videos to transcode. Node leaves any file to Rails.
async function transcodeVideos(record: InstallmentModel): Promise<void> {
  if ((await post(record).aliveProductFiles()).length > 0) refuse("a post with files (transcode_videos!)");
}

// `publish!(published_at:)`
export async function publishBang(record: InstallmentModel, { publishedAt = null, now }: { publishedAt?: Date | null; now?: () => Date } = {}): Promise<void> {
  const user = await userOf(record);
  if (user.confirmed_at === null) throw new InstallmentInvalid("You have to confirm your email address before you can do that.");
  await transcodeVideos(record);
  // datetime(0): ActiveRecord drops the fraction of a second
  const publishedAtWhole = publishedAt ?? (now ?? (() => new Date()))();
  record.set("published_at", new Date(Math.floor(publishedAtWhole.getTime() / SECOND_MS) * SECOND_MS));
  // `workflow.present?`: loading the association leaves its foreign key materialized
  if ((record.get("workflow_id") ?? null) !== null) record.touch("workflow_id");
  if ((record.get("workflow_id") ?? null) !== null) record.set("flags", Number(InstallmentFlags.set(record.get("flags") as number, "workflow_installment_published_once_already", true)));
  record.ivars[PUBLISHING] = true;
  try {
    await Installments.saveBang(record, { now } as SaveOptions);
  } finally {
    record.ivars[PUBLISHING] = false;
  }
}

// `unpublish!(is_unpublished_by_admin:)`
export async function unpublishBang(record: InstallmentModel, { isUnpublishedByAdmin = false, now }: { isUnpublishedByAdmin?: boolean; now?: () => Date } = {}): Promise<void> {
  record.set("published_at", null);
  record.set("flags", Number(InstallmentFlags.set(record.get("flags") as number, "is_unpublished_by_admin", isUnpublishedByAdmin)));
  await Installments.saveBang(record, { now } as SaveOptions);
}

// `mark_deleted!` (Deletable)
export const markDeletedBang = (record: InstallmentModel, options: SaveOptions = {}) => softDeletion.markDeletedBang(record, options);
