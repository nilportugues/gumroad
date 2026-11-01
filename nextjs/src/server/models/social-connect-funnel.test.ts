// Replays social-connect-funnel.golden.json (scripts/golden/social-connect-funnel.rb): SocialConnectFunnel.record_offers!
// run by the real service. Node must send the statements Rails sent, given the same answers.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { recordOffers, type SocialConnection } from "./social-connect-funnel.ts";

type Case = { name: string; error: { class: string; message: string } | null; statements: Statement[] };
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/social-connect-funnel.golden.json", import.meta.url), "utf8")) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

const X: SocialConnection = { name: "X", connected: false };
const YOUTUBE: SocialConnection = { name: "YouTube", connected: false };
const TIKTOK: SocialConnection = { name: "TikTok", connected: true };

const CONNECTIONS: Record<string, SocialConnection[] | undefined> = {
  "offers every unconnected provider": [X, YOUTUBE, TIKTOK],
  "skips a provider already offered": [X, YOUTUBE],
  "offers again on another surface": [X],
  "does nothing when skipped": [X],
  "does nothing without connections": undefined,
  "ignores a connection without a known provider": [{ name: "Mastodon", connected: false }],
};

describe("SocialConnectFunnel.record_offers!", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      // The first recorded statement is the generator's own `User.find`.
      const sql = sqlReplay(c.statements.slice(1));
      await recordOffers({ userId: 1n, connections: CONNECTIONS[c.name], surface: "getting_started", skip: c.name === "does nothing when skipped", now });
      expect(sql.log).toEqual(sql.expected);
    });
  }
});
