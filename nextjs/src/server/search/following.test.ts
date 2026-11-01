import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { followerEventSources, followingByDate, netTotal } from "./following.ts";
import { setEsSender } from "./transport.ts";

// Replays following.golden.json, recorded by generate-following-golden.rb from the real
// CreatorAnalytics::Following against Elasticsearch 7.17: every request must be the one Rails sent
// and the recorded answers must give the chart Rails built.
type Exchange = { method: string; path: string; body: string; status: number; response: Record<string, unknown> };
type Case = { kind: string; timezone?: string; from?: string; to?: string; before?: string | null; user_id: number; outcome: unknown; exchanges: Exchange[] };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/following.golden.json", import.meta.url), "utf8")) as { now: string; cases: Case[] };

let restore: (() => void) | undefined;
afterEach(() => restore?.());

function replay(exchanges: Exchange[]): string[] {
  const sent: string[] = [];
  const queue = [...exchanges];
  restore = setEsSender(async (request) => {
    sent.push(request.body ?? "");
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return { status: next.status, body: next.response };
  });
  return sent;
}

describe("CreatorAnalytics::Following", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(14);
  });

  it.each(golden.cases.map((c, index) => [`${c.kind} ${c.timezone ?? ""} ${c.from ?? c.before ?? ""} ${c.to ?? ""} #${index}`, c] as const))("%s", async (_name, recorded) => {
    const sent = replay(recorded.exchanges);
    const user = { id: recorded.user_id, timezone: recorded.timezone ?? null };
    let outcome: unknown;
    if (recorded.kind === "by_date") outcome = await followingByDate(user, recorded.from!, recorded.to!, { now: () => new Date(golden.now) });
    else if (recorded.kind === "net_total") outcome = await netTotal(user, recorded.before ?? null);
    else {
      const sources = await followerEventSources(recorded.user_id);
      outcome = sources.map((source) => ({ type: `follower_${String(source.name)}`, timestamp: source.timestamp, details: { email: source.email, name: null } }));
    }
    expect(sent).toEqual(recorded.exchanges.map((exchange) => exchange.body));
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(recorded.outcome);
  });
});
