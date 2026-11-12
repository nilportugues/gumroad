// Replays exports-affiliate-export-worker.golden.json and exports-audience-export-worker.golden.json (scripts/golden/): the workers run
// by the real app as Sidekiq jobs. Node sends the `User.find` statement Rails sent (a plain find for one distinct id, `id IN (...)`
// for two), raises Rails' RecordNotFound messages, and hands users that were found back before the export.
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { affiliateExportWorkerWith, audienceExportWorkerWith } from "./user-export-workers.ts";

const isId = (value: unknown) =>
  (typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

// An id Rails casts (float, word), or the same id as an Integer and as a string: Node hands those back before any statement.
function handsBackEarly(c: JobCase, arity: [number, number]): boolean {
  if (c.args.length < arity[0] || c.args.length > arity[1]) return false;
  const present = c.args.slice(0, 2).filter((value) => value !== null);
  if (!present.every(isId)) return true;
  const distinct = present.filter((value, index) => present.indexOf(value) === index);
  return new Set(distinct.map(String)).size !== distinct.length;
}

const load = (name: string) => loadGolden(new URL(`./__fixtures__/${name}.golden.json`, import.meta.url));

replayJobGolden(
  "Exports::AffiliateExportWorker",
  load("exports-affiliate-export-worker"),
  affiliateExportWorkerWith(),
  (c) => handsBackEarly(c, [2, 2]),
);
const audience = load("exports-audience-export-worker");
replayJobGolden(
  "Exports::AudienceExportWorker",
  {
    ...audience,
    cases: audience.cases.map((c) => ({
      ...c,
      hands_back: Boolean(c.hands_back || (c as JobCase & { node_hands_back?: boolean }).node_hands_back),
    })),
  },
  audienceExportWorkerWith(),
  (c) => handsBackEarly(c, [2, 3]),
);
