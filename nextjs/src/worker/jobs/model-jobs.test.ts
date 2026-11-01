// Replays model-jobs.golden.json: for each case, the Node port must send the statements Rails
// sent (given the same answers), fail with the same error, and leave Sidekiq's Redis as Rails
// left it. Cases whose enqueues take a unique-jobs lock need a real Redis:
//   JOBS_REDIS_URL=redis://127.0.0.1:6379/12 npm test
import { Prisma } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The generator stubs `perform_async` to return nil for some cases, as a dropping client
// middleware would; `dropped` lists the job classes whose pushes the current case drops.
const dropped = vi.hoisted(() => new Set<string>());
vi.mock("../../server/models/concerns/job-runtime.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/models/concerns/job-runtime.ts")>();
  const performAsync: typeof original.performAsync = (jobClass, args, options) =>
    dropped.has(jobClass) ? Promise.resolve(null) : original.performAsync(jobClass, args, options);
  return { ...original, performAsync };
});
const DROPPED_PUSHES: Record<string, string[]> = { "an enqueue that is dropped releases the claim": ["ScheduleWorkflowInstallmentJob"] };

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { JOB_REGISTRY } from "../../server/jobs/registry.generated.ts";
import type { JobDefinition } from "../../server/jobs/registry-types.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { goldenNow, modelJobsGolden, sqlReplay, type ModelJobCase } from "./__fixtures__/sql-replay.ts";
import { deleteOldPingDeliveriesJobWith, deleteOldProcessedStripeEventsJobWith, deleteOldSentEmailInfoRecordsJobWith } from "./delete-old-records-jobs.ts";
import { deleteExpiredProductCachedValuesWorkerWith, deleteOldUnusedEventsWorkerWith, deleteProcessedWorkflowInstallmentScheduleIntentsJobWith } from "./batched-cleanup-jobs.ts";
import { alertOnStalledAbandonedCartEmailsJobWith, bigDecimalToS, buildTaxRateCacheWorkerWith, recoverAusBacktaxesFromStripeAccountsJobWith } from "./scheduled-check-jobs.ts";
import { blockEmailDomainsWorkerWith, blockObjectWorkerWith, unblockObjectWorkerWith } from "./platform-block-jobs.ts";
import { forceFinishLongRunningCommunityChatRecapRunsJobWith, triggerCommunityChatRecapRunJobWith } from "./community-chat-recap-jobs.ts";
import { expireStampedPdfsJobWith, updateLargeSellersSalesCountJobWith } from "./large-seller-and-stamped-pdf-jobs.ts";
import { recalculateRecentWishlistFollowerCountJobWith } from "./wishlist-jobs.ts";
import { dispatchPendingWorkflowInstallmentScheduleIntentsJobWith } from "./dispatch-workflow-intents-job.ts";
import { isAdult } from "../../server/models/concerns/adult-keyword-detector.ts";
import type { JobDeps } from "./support/job-deps.ts";
import type { JobHandler } from "./types.ts";

type Extra = { redisSet: (key: string, value: string) => Promise<void>; logError: (message: string) => void };
type Factory = (deps: JobDeps & Extra) => JobHandler;

const PORTS: Record<string, Factory> = {
  DeleteOldSentEmailInfoRecordsJob: (deps) => deleteOldSentEmailInfoRecordsJobWith(deps),
  DeleteOldPingDeliveriesJob: (deps) => deleteOldPingDeliveriesJobWith(deps),
  DeleteOldProcessedStripeEventsJob: (deps) => deleteOldProcessedStripeEventsJobWith(deps),
  DeleteProcessedWorkflowInstallmentScheduleIntentsJob: (deps) => deleteProcessedWorkflowInstallmentScheduleIntentsJobWith(deps),
  DeleteExpiredProductCachedValuesWorker: (deps) => deleteExpiredProductCachedValuesWorkerWith(deps),
  DeleteOldUnusedEventsWorker: (deps) => deleteOldUnusedEventsWorkerWith(deps),
  RecoverAusBacktaxesFromStripeAccountsJob: (deps) => recoverAusBacktaxesFromStripeAccountsJobWith(deps),
  AlertOnStalledAbandonedCartEmailsJob: (deps) => alertOnStalledAbandonedCartEmailsJobWith(deps),
  BuildTaxRateCacheWorker: (deps) => buildTaxRateCacheWorkerWith(deps),
  BlockObjectWorker: (deps) => blockObjectWorkerWith(deps),
  BlockEmailDomainsWorker: (deps) => blockEmailDomainsWorkerWith(deps),
  UnblockObjectWorker: (deps) => unblockObjectWorkerWith(deps),
  ForceFinishLongRunningCommunityChatRecapRunsJob: (deps) => forceFinishLongRunningCommunityChatRecapRunsJobWith(deps),
  TriggerCommunityChatRecapRunJob: (deps) => triggerCommunityChatRecapRunJobWith(deps),
  UpdateLargeSellersSalesCountJob: (deps) => updateLargeSellersSalesCountJobWith(deps),
  ExpireStampedPdfsJob: (deps) => expireStampedPdfsJobWith(deps),
  RecalculateRecentWishlistFollowerCountJob: (deps) => recalculateRecentWishlistFollowerCountJobWith(deps),
  DispatchPendingWorkflowInstallmentScheduleIntentsJob: (deps) => dispatchPendingWorkflowInstallmentScheduleIntentsJobWith(deps),
};

// The golden ran with every job in Ruby, so enqueues here go to Sidekiq whatever the registry says.
const rubyRegistry: Record<string, JobDefinition> = Object.fromEntries(
  Object.entries(JOB_REGISTRY).map(([name, definition]) => [name, { ...definition, runtime: "ruby" } as JobDefinition]),
);

const takesLocks = (c: ModelJobCase) => Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

async function replay(name: string, c: ModelJobCase) {
  const sql = sqlReplay(c.statements);
  let snapshot: () => Promise<RedisSnapshot>;
  let sidekiqRedis: Redis;
  if (takesLocks(c)) {
    await realRedis!.flushdb();
    sidekiqRedis = realRedis!;
    snapshot = () => snapshotRedis(realRedis!);
  } else {
    const recording = recordingSidekiqRedis();
    sidekiqRedis = recording.redis;
    snapshot = async () => recording.snapshot();
  }
  const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRegistry, now: () => modelJobsGolden.now, newJid: sequentialJids() });
  const namespaceWrites: [string, string][] = [];
  let uuid = 0;
  const handler = PORTS[name]!({
    now: goldenNow,
    watchReplicaLag: sql.watch,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    redisSet: async (key, value) => void namespaceWrites.push([key, value]),
    logError: () => {},
  });

  let error: unknown = null;
  for (const jobClass of DROPPED_PUSHES[c.name] ?? []) dropped.add(jobClass);
  try {
    await asSidekiqJob(() => handler(c.args, contextFor(runtime)), modelJobsGolden.now);
  } catch (e) {
    error = e;
  } finally {
    dropped.clear();
  }
  expect(sql.log).toEqual(sql.expected);
  expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
  expect(await snapshot()).toEqual(c.redis);
  expect(namespaceWrites).toEqual(c.namespace_writes);
}

for (const [name, cases] of Object.entries(modelJobsGolden.jobs)) {
  describe.skipIf(!PORTS[name])(name, () => {
    for (const c of cases) {
      it.skipIf(takesLocks(c) && !url)(c.name, () => replay(name, c));
    }
  });
}

describe("BigDecimal#to_s under ActiveSupport", () => {
  it.each(modelJobsGolden.big_decimal_to_s)("%s", (input, expected) => {
    expect(bigDecimalToS(new Prisma.Decimal(input))).toBe(expected);
  });
});

describe("AdultKeywordDetector.adult?", () => {
  it.each(modelJobsGolden.adult_keyword_detector)("%s", (text, expected) => {
    expect(isAdult(text)).toBe(expected);
  });
});
