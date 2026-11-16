// Replays generate-avatar-variant-job.golden.json (scripts/golden/generate-avatar-variant-job.rb): GenerateAvatarVariantJob run by the
// real app as a Sidekiq job. Node sends the statements Rails sent for a user that is gone or has no avatar, and hands back, after the
// same statements, a user with one.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { generateAvatarVariantJobWith } from "./generate-avatar-variant-job.ts";

const golden = loadGolden(new URL("./__fixtures__/generate-avatar-variant-job.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; a Float is cast too. Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("GenerateAvatarVariantJob", golden, generateAvatarVariantJobWith(), (c) => castByRails(c.args[0]));
