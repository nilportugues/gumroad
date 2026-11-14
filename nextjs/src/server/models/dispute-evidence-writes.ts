// Saves of a DisputeEvidence (app/models/dispute_evidence.rb) for the seller's statement: the stripped text fields, the length and
// attached-file validations, and the paper_trail version. Attaching or merging files stays in Ruby.
import { Prisma, type DisputeEvidence } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { defineModel, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesLengthOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError, strippedField } from "./user.ts";

// DisputeEvidence::STRIPE_MAX_COMBINED_FILE_SIZE and ALLOWED_FILE_CONTENT_TYPES
const STRIPE_MAX_COMBINED_FILE_SIZE = 5_000_000;
const ALLOWED_FILE_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_TEXT_LENGTH = 3_000;

const STRIPPED_FIELDS = [
  "customer_purchase_ip",
  "customer_email",
  "customer_name",
  "billing_address",
  "product_description",
  "refund_policy_disclosure",
  "cancellation_policy_disclosure",
  "shipping_address",
  "shipping_carrier",
  "shipping_tracking_number",
  "uncategorized_text",
  "cancellation_rebuttal",
  "refund_refusal_explanation",
  "reason_for_winning",
] as const;

const paperTrail = hasPaperTrail<DisputeEvidence>("DisputeEvidence", { itemType: "DisputeEvidence" });

type Blob = { byte_size: number; content_type: string | null };

async function attachedBlobs(
  record: ModelRecord<DisputeEvidence>,
  { tx }: CallbackContext,
): Promise<Map<string, Blob>> {
  const rows = await tx.$queryRaw<{ name: string; byte_size: bigint; content_type: string | null }[]>(
    Prisma.sql`SELECT a.name AS name, b.byte_size AS byte_size, b.content_type AS content_type FROM active_storage_attachments a INNER JOIN active_storage_blobs b ON b.id = a.blob_id WHERE a.record_type = 'DisputeEvidence' AND a.record_id = ${record.get("id")}`,
  );
  return new Map(rows.map((row) => [row.name, { byte_size: Number(row.byte_size), content_type: row.content_type }]));
}

// for_subscription_purchase?: does the disputed charge's purchase, or the disputed purchase, have a subscription?
async function forSubscriptionPurchase(
  record: ModelRecord<DisputeEvidence>,
  { tx }: CallbackContext,
): Promise<boolean> {
  const [dispute] = await tx.$queryRaw<{ charge_id: bigint | null; purchase_id: number | null }[]>(
    Prisma.sql`SELECT charge_id, purchase_id FROM disputes WHERE id = ${record.get("dispute_id")} LIMIT 1`,
  );
  if (!dispute) return false;
  const rows = await tx.$queryRaw<unknown[]>(
    dispute.charge_id === null
      ? Prisma.sql`SELECT 1 AS one FROM purchases p INNER JOIN subscriptions s ON s.id = p.subscription_id WHERE p.id = ${dispute.purchase_id} LIMIT 1`
      : Prisma.sql`SELECT 1 AS one FROM charge_purchases cp INNER JOIN purchases p ON p.id = cp.purchase_id INNER JOIN subscriptions s ON s.id = p.subscription_id WHERE cp.charge_id = ${dispute.charge_id} LIMIT 1`,
  );
  return rows.length > 0;
}

// The `has_one_attached` associations a job has already loaded the way Rails does, by name and whether a file is attached. A save
// of such a record validates from them, and reads the ones still unloaded one by one in validation order, as ActiveStorage does.
const loadedAttachments = new WeakMap<object, Map<string, boolean>>();

export function trackAttachmentReads(record: ModelRecord<DisputeEvidence>): void {
  if (!loadedAttachments.has(record)) loadedAttachments.set(record, new Map());
}

// `record.<name>.attached?`: `SELECT active_storage_attachments.* ... name = '<name>' LIMIT 1`, once per record.
export async function attachmentAttached(record: ModelRecord<DisputeEvidence>, name: string): Promise<boolean> {
  const loaded = loadedAttachments.get(record);
  const known = loaded?.get(name);
  if (known !== undefined) return known;
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`active_storage_attachments`.*")} FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_id")} = ${record.get("id")} AND ${column("active_storage_attachments", "record_type")} = ${"DisputeEvidence"} AND ${column("active_storage_attachments", "name")} = ${name} LIMIT 1`,
  );
  loaded?.set(name, rows.length > 0);
  return rows.length > 0;
}

// A file to measure needs its blob, which this path does not read: the job that tracks hands the save back instead.
async function validateTrackedFiles(record: ModelRecord<DisputeEvidence>): Promise<void> {
  // for_subscription_purchase? is false for the purchases such a job accepts, so the policy image is the refund policy's.
  for (const name of ["customer_communication_file", "receipt_image", "refund_policy_image"]) {
    if (await attachmentAttached(record, name))
      throw new NotPortedError(`Validating the attached ${name} of a dispute evidence`, "dispute_evidence.rb: all_files_size_within_limit");
  }
}

// customer_communication_file_size, customer_communication_file_type and all_files_size_within_limit read the attachments a save
// leaves in place, so a row without any adds no further query.
async function validateFiles(record: ModelRecord<DisputeEvidence>, ctx: CallbackContext): Promise<void> {
  if (loadedAttachments.has(record)) return validateTrackedFiles(record);
  const blobs = await attachedBlobs(record, ctx);
  if (blobs.size === 0) return;
  const hasPolicyImage = blobs.has("cancellation_policy_image") || blobs.has("refund_policy_image");
  const policyName =
    hasPolicyImage && (await forSubscriptionPurchase(record, ctx))
      ? "cancellation_policy_image"
      : "refund_policy_image";
  const receipt = blobs.get("receipt_image")?.byte_size ?? 0;
  const policy = blobs.get(policyName)?.byte_size ?? 0;
  const communication = blobs.get("customer_communication_file");
  if (communication) {
    if (communication.byte_size > STRIPE_MAX_COMBINED_FILE_SIZE - receipt - policy)
      record.errors.add("base", "The file exceeds the maximum size allowed.");
    if (!ALLOWED_FILE_CONTENT_TYPES.includes(communication.content_type ?? ""))
      record.errors.add("base", "Invalid file type.");
  }
  if (receipt + policy + (communication?.byte_size ?? 0) > STRIPE_MAX_COMBINED_FILE_SIZE)
    record.errors.add("base", "Uploaded files exceed the maximum size allowed by Stripe.");
}

export const DisputeEvidences = defineModel<DisputeEvidence>({
  rubyClass: "DisputeEvidence",
  prismaModel: "DisputeEvidence",
  delegate: (tx) => tx.disputeEvidence as never,
  beforeValidation: [
    {
      name: "stripped_fields",
      run(record) {
        for (const field of STRIPPED_FIELDS) record.set(field, strippedField(record.get(field)));
      },
    },
  ],
  validations: [
    validatesLengthOf<DisputeEvidence>(["cancellation_rebuttal", "reason_for_winning", "refund_refusal_explanation"], {
      maximum: MAX_TEXT_LENGTH,
    }),
    { name: "customer_communication_file and all_files_size_within_limit", run: validateFiles },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});
