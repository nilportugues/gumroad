// Replays send-signed-piracy-notices-job.golden.json (scripts/golden/send-signed-piracy-notices-job.rb): the job run by the real app as
// a Sidekiq job. The Flipper feature a case starts from comes from its `redis_before`; Node sends the one scan Rails sent when the
// feature is on, none when it is off, and hands back, after the scan, a signed report.
import type { Redis } from "ioredis";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sendSignedPiracyNoticesJobWith } from "./send-signed-piracy-notices-job.ts";

const golden = loadGolden(new URL("./__fixtures__/send-signed-piracy-notices-job.golden.json", import.meta.url));
type Stored = Record<string, { type: string; value?: unknown }>;
const gateOf = (c: JobCase) => (c as JobCase & { gate: string }).gate;

// The hash Flipper's Redis adapter reads for a feature, from the Redis the case started from.
const flagRedis = (before: Stored): Redis =>
  ({
    hgetall: (key: string) => Promise.resolve((before[key]?.value ?? {}) as Record<string, string>),
  }) as unknown as Redis;

// One handler per case: the replay helper runs each case through the handler it is given.
for (const c of golden.cases) {
  const before = ((c as JobCase & { redis_before?: Stored }).redis_before ?? {}) as Stored;
  replayJobGolden(
    `SendSignedPiracyNoticesJob (${gateOf(c)})`,
    { now: golden.now, cases: [{ ...c, redis: {} }] },
    sendSignedPiracyNoticesJobWith(() => flagRedis(before)),
  );
}
