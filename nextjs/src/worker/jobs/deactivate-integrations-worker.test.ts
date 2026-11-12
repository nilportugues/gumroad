// Replays deactivate-integrations-worker.golden.json (scripts/golden/deactivate-integrations-worker.rb): the job run by the real app as a
// Sidekiq job, Circle answered by WebMock. Node sends the statements Rails sent and, for each Circle integration to leave, the
// `remove_member` request and rate-limit write Rails made. A Discord member to remove (a Discord call and a PurchaseIntegration write)
// hands the whole job back after the same reads, with no Circle request sent, even where Rails sent one before reaching Discord.
import { vi } from "vitest";

import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { deactivateIntegrationsWorkerWith } from "./deactivate-integrations-worker.ts";

vi.mock("../../server/infra/redis.ts", async () => ({
  getRedis: (await import("./__fixtures__/ratelimit-redis.ts")).getRedis,
}));

const CIRCLE_ORIGIN = "https://app.circle.so";
// Rails sends these (a number in the details, a key with characters a header line may treat differently); Node hands them back after the
// reads, before the rate-limit write and the request.
const handsBack = (c: { name: string }) => /details are numbers|no api key|api key that needs/u.test(c.name);

const golden = loadGolden(new URL("./__fixtures__/deactivate-integrations-worker.golden.json", import.meta.url));

// Rails raises for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "DeactivateIntegrationsWorker",
  golden,
  deactivateIntegrationsWorkerWith(),
  (c) => castByRails(c.args[0]),
  {
    handsBack,
    vendor: CIRCLE_ORIGIN,
  },
);
