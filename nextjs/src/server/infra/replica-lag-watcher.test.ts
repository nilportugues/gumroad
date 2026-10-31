import { describe, expect, it } from "vitest";

import { type ReplicaConnection, ReplicaLagWatcher, replicasHosts } from "./replica-lag-watcher.ts";

describe("replicasHosts", () => {
  it("keeps present replica hosts once each and drops the primary", () => {
    expect(
      replicasHosts({
        DATABASE_HOST: "primary",
        DATABASE_REPLICA1_HOST: "r1",
        DATABASE_WORKER_REPLICA1_HOST: "r1",
        DATABASE_REPLICA2_HOST: " ",
        DATABASE_WORKER_REPLICA2_HOST: "primary",
        DATABASE_REPLICA3_HOST: "r3",
      }),
    ).toEqual(["r1", "r3"]);
  });
});

function harness(lags: Record<string, (number | null | "missing")[]>) {
  let clock = 100;
  const log: string[] = [];
  const queries: string[] = [];
  const connect = (host: string): ReplicaConnection => ({
    host,
    query: async (sql) => {
      queries.push(`${host}: ${sql}`);
      const lag = lags[host]!.shift();
      return lag === "missing" ? [] : [{ Seconds_Behind_Source: lag === null ? null : BigInt(lag!) }];
    },
  });
  const watcher = new ReplicaLagWatcher({
    hosts: () => Object.keys(lags),
    connect,
    now: () => clock,
    sleep: async (seconds) => {
      clock += seconds;
    },
    log: (line) => log.push(line),
  });
  return { watcher, log, queries, advance: (seconds: number) => (clock += seconds) };
}

describe("ReplicaLagWatcher", () => {
  it("does nothing without replicas", async () => {
    const { watcher, queries } = harness({});
    await watcher.watch();
    expect(queries).toEqual([]);
  });

  it("sleeps while a replica lags past one second", async () => {
    const { watcher, log, queries } = harness({ r1: [0, 0, 0], r2: [3, 1] });
    await watcher.watch();
    expect(queries).toEqual(["r1: SHOW REPLICA STATUS", "r2: SHOW REPLICA STATUS", "r1: SHOW REPLICA STATUS", "r2: SHOW REPLICA STATUS"]);
    expect(log).toEqual(["r2 lag = 3 seconds", "sleeping 1 second"]);
  });

  it("checks at most once per second", async () => {
    const { watcher, queries, advance } = harness({ r1: [0, 0] });
    await watcher.watch();
    await watcher.watch();
    expect(queries).toHaveLength(1);
    advance(1);
    await watcher.watch();
    expect(queries).toHaveLength(2);
  });

  it("refuses a host that is not replicating, or reports no lag", async () => {
    await expect(harness({ p: ["missing"] }).watcher.watch()).rejects.toThrow(/p is in REPLICAS_HOSTS but is not replicating/);
    await expect(harness({ r: [null] }).watcher.watch()).rejects.toThrow("r lag = null. Is this replica available and replicating?");
  });

  it("stops at the deadline", async () => {
    const { watcher, log } = harness({ r1: [5, 5, 5, 5] });
    await watcher.watch({ deadline: 101.5, silence: true });
    expect(log).toEqual([]);
  });
});
