import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../../scripts/generate-job-registry.ts";

import recurringLockTtls from "./__fixtures__/recurring-lock-ttl.golden.json" with { type: "json" };
import { attemptsFor, sidekiqBackoffMs } from "./bullmq/options.ts";
import { resolveJobClass } from "./enqueue.ts";
import type { JobDefinition } from "./registry-types.ts";
import { CRON_SCHEDULE, JOB_REGISTRY } from "./registry.generated.ts";

const registry = JOB_REGISTRY as Record<string, JobDefinition>;

describe("job registry", () => {
  it("is up to date with app/sidekiq and config/sidekiq_schedule.yml", () => {
    const { jobs, schedule } = buildRegistry();
    expect(JSON.parse(JSON.stringify(registry))).toEqual(jobs);
    expect(CRON_SCHEDULE).toEqual(schedule);
  });

  // Vectors from app/models/concerns/recurring_lock_ttl.rb itself, run over the same schedule.
  it.each(Object.entries(recurringLockTtls))("computes %s's recurring lock TTL as Ruby does", (className, ttl) => {
    expect(registry[className]!.options.lock_ttl).toBe(ttl);
  });

  it("reads multi-line options, constants and nested hashes", () => {
    expect(registry.RefreshMerchantAccountProductsRecommendationEligibilityJob!.options).toEqual({
      retry: 3,
      queue: "low",
      lock: "until_executing",
      lock_ttl: 6 * 3600,
      on_conflict: { client: "log" },
    });
    expect(registry.DeliverFilesReadyNotificationJob!.options.lock_ttl).toBe(120);
    expect(Object.keys(registry["Reports::GenerateYtdSalesReportJob"]!.options)).toEqual(["queue", "retry"]);
  });

  it("resolves aliases to the class Ruby would push", () => {
    expect(resolveJobClass("PdfUnstampableNotifierWorker").className).toBe("PdfUnstampableNotifierJob");
  });

  it("parses cron args the way sidekiq-cron does", () => {
    expect(CRON_SCHEDULE.find((entry) => entry.name === "payouts_paypal")?.args).toEqual(["PAYPAL"]);
  });

  it("marks an alias of a ported job as Node-run without listing it as node-owned", () => {
    expect(registry.PdfUnstampableNotifierWorker!.runtime).toBe("node");
    expect(registry.ProcessPurchaseEarlyFraudWarningJob!.runtime).toBe("node");
    const nodeOwned = JSON.parse(
      readFileSync(new URL("./node-owned-jobs.generated.json", import.meta.url), "utf8"),
    ) as string[];
    expect(nodeOwned).not.toContain("PdfUnstampableNotifierWorker");
  });

  it("marks only ported jobs as Node-run", () => {
    const nodeOwned = JSON.parse(
      readFileSync(new URL("./node-owned-jobs.generated.json", import.meta.url), "utf8"),
    ) as string[];
    expect(
      Object.entries(registry)
        .filter(([, entry]) => entry.runtime === "node" && !entry.aliasOf)
        .map(([name]) => name),
    ).toEqual(nodeOwned);
  });
});

describe("BullMQ options from sidekiq_options", () => {
  it("maps Sidekiq retries to BullMQ attempts", () => {
    expect(attemptsFor(false)).toBe(1);
    expect(attemptsFor(0)).toBe(1);
    expect(attemptsFor(5)).toBe(6);
    expect(attemptsFor(undefined)).toBe(26);
  });

  it("backs off like Sidekiq's default retry delay", () => {
    expect(sidekiqBackoffMs(1, () => 0)).toBe(15_000);
    expect(sidekiqBackoffMs(3, () => 0.95)).toBe((2 ** 4 + 15 + 9 * 3) * 1000);
  });
});
