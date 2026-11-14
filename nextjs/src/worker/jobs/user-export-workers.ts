// Ports of app/sidekiq/exports/affiliate_export_worker.rb and exports/audience_export_worker.rb up to the export. Both open with
// `seller, recipient = User.find(seller_id, recipient_id)`, which runs in Node; building the file and mailing it hand back before
// either. Golden: __fixtures__/exports-affiliate-export-worker.golden.json and exports-audience-export-worker.golden.json
// (scripts/golden/exports-affiliate-export-worker.rb, exports-audience-export-worker.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { columnIn, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const USERS = "users";

// `User.find(*ids)` drops nil and repeated ids first: no id is an error, one id is a plain find, and several read `id IN (...)`
// and must all come back.
async function findSellerAndRecipient(sellerId: unknown, recipientId: unknown): Promise<void> {
  const present = [sellerId, recipientId].filter((value) => value !== null);
  const given = present.filter((value, index) => present.indexOf(value) === index);
  const ids = await beforeSideEffects(() => given.map((value) => recordIdFrom(value, "User.find")));
  // `uniq` compares the raw values, so 1 and "1" are two ids that read the same row: a count mismatch Rails reports.
  if (new Set(ids).size !== ids.length)
    throw new HandBackToRuby("one user id is given twice, as an Integer and as a string");

  if (ids.length === 0) throw new RecordNotFound("Couldn't find User without an ID");
  if (ids.length === 1) {
    await findByIdBang("User", ids[0]!);
  } else {
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw(`\`${USERS}\`.*`)} FROM ${table(USERS)} WHERE ${columnIn(USERS, "id", ids)}`,
    );
    if (rows.length !== ids.length) {
      const list = given.map((value) => JSON.stringify(value)).join(", ");
      throw new RecordNotFound(
        `Couldn't find all Users with 'id': (${list}) (found ${rows.length} results, but was looking for ${ids.length}).`,
      );
    }
  }
}

export const affiliateExportWorkerWith = modelJob({ min: 2 }, async ([sellerId, recipientId]) => {
  await findSellerAndRecipient(sellerId, recipientId);

  throw new HandBackToRuby("the affiliate export is built and mailed");
});
export const affiliateExportWorker = affiliateExportWorkerWith();

class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

const AUDIENCE_TYPES = ["followers", "customers", "affiliates"];

// `Exports::AudienceExportService.new` rejects options that select no audience type (Ruby truthiness: only nil and false are falsy).
// Options that are not a Hash fail on `with_indifferent_access`, an error Node leaves to Ruby.
function validateAudienceOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new HandBackToRuby("audience_options is not a Hash");
  }
  const values = options as Record<string, unknown>;
  if (!AUDIENCE_TYPES.some((type) => values[type] !== undefined && values[type] !== null && values[type] !== false)) {
    throw new ArgumentError("At least one audience type (followers, customers, or affiliates) must be selected");
  }
}

export const audienceExportWorkerWith = modelJob(
  { min: 2, max: 3 },
  async ([sellerId, recipientId, audienceOptions = {}]) => {
    await findSellerAndRecipient(sellerId, recipientId);
    validateAudienceOptions(audienceOptions);

    throw new HandBackToRuby("the audience export is built and mailed");
  },
);
export const audienceExportWorker = audienceExportWorkerWith();
