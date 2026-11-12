// Replays activate-integrations-worker.golden.json (scripts/golden/activate-integrations-worker.rb): the job run by the real app as a
// Sidekiq job, Circle answered by WebMock. Node sends the statements Rails sent, then the `add_member` request line and Authorization
// header and the rate-limit write Rails made, whatever Circle answers (Rails never reads it). A key or detail Ruby may render
// differently is handed back after the reads and before the request.
import { vi } from "vitest";

import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { activateIntegrationsWorkerWith } from "./activate-integrations-worker.ts";

vi.mock("../../server/infra/redis.ts", async () => ({
  getRedis: (await import("./__fixtures__/ratelimit-redis.ts")).getRedis,
}));

const CIRCLE_ORIGIN = "https://app.circle.so";
// Rails sends these (a number in the details, a key with characters a header line may treat differently); Node hands them back after the
// reads, before the rate-limit write and the request.
const handsBack = (c: { name: string }) => /details are numbers|no api key|api key that needs/u.test(c.name);

const golden = loadGolden(new URL("./__fixtures__/activate-integrations-worker.golden.json", import.meta.url));

// Rails raises for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("ActivateIntegrationsWorker", golden, activateIntegrationsWorkerWith(), (c) => castByRails(c.args[0]), {
  handsBack,
  vendor: CIRCLE_ORIGIN,
});
