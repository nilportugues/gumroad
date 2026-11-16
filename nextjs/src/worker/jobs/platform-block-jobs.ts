// Ports of the PlatformBlock jobs:
//   app/sidekiq/block_object_worker.rb
//   app/sidekiq/block_email_domains_worker.rb
//   app/sidekiq/unblock_object_worker.rb
import type { PlatformBlock } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { addPlatformBlock, PLATFORM_BLOCK_TYPES, PlatformBlocks, unblockPlatformBlock } from "../../server/models/platform-block.ts";
import { castRow, column, findInBatches } from "../../server/models/sql.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { modelJob } from "./support/job-deps.ts";

// `PlatformBlock::TYPES[object_type.to_sym]`: nil for an unknown key, which then fails validation.
function typeFor(objectType: JsonValue): string | null {
  if (typeof objectType !== "string") throw new TypeError(`undefined method 'to_sym' for ${objectType === null ? "nil" : String(objectType)}`);
  return Object.hasOwn(PLATFORM_BLOCK_TYPES, objectType) ? PLATFORM_BLOCK_TYPES[objectType as keyof typeof PLATFORM_BLOCK_TYPES] : null;
}

export const blockObjectWorkerWith = modelJob({ min: 3, max: 4 }, async (args, deps) => {
  const [objectType, identifier, authorId, expiresIn = null] = args;
  await addPlatformBlock(
    { objectType: typeFor(objectType!), objectValue: identifier as string, by: authorId, expiresInSeconds: expiresIn as number | null },
    deps.now,
  );
});

export const blockEmailDomainsWorkerWith = modelJob({ min: 2 }, async (args, deps) => {
  const [authorId, emailDomains] = args;
  if (!Array.isArray(emailDomains)) throw new TypeError("undefined method 'each'");
  for (const emailDomain of emailDomains) {
    await addPlatformBlock({ objectType: PLATFORM_BLOCK_TYPES.email_domain, objectValue: emailDomain as string, by: authorId }, deps.now);
  }
});

export const unblockObjectWorkerWith = modelJob({ min: 1 }, async (args, deps) => {
  const [objectValue] = args;
  await findInBatches<PlatformBlock>("platform_blocks", Prisma.sql`${column("platform_blocks", "object_value")} = ${objectValue}`, 1_000, async (rows) => {
    for (const row of rows) await unblockPlatformBlock(PlatformBlocks.load(castRow<PlatformBlock>("PlatformBlock", row)), deps.now);
  });
});

export const blockObjectWorker = blockObjectWorkerWith();
export const blockEmailDomainsWorker = blockEmailDomainsWorkerWith();
export const unblockObjectWorker = unblockObjectWorkerWith();
