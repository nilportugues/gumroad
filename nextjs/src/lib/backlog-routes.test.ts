import { describe, expect, it } from "vitest";

import { RAILS_KEEPS } from "../../scripts/backlog.ts";
import { parseRoutes, rows } from "../../scripts/remaining-work.ts";

const all = rows(parseRoutes());
const key = (row: { method: string; path: string }) => `${row.method} ${row.path}`;

describe("backlog routes not served natively", () => {
  it("counts the routes the old note called scanner false positives as native", () => {
    const falsePositives = all.filter((row) =>
      /^(GET \/products\/:product_id\/(other_refund_policies|available_offer_codes|builds)|(GET|POST) \/users\/auth\/(google_oauth2|youtube|instagram|tiktok)\/callback)$/u.test(
        key(row),
      ),
    );
    expect(falsePositives.length).toBeGreaterThan(0);
    expect(falsePositives.filter((row) => row.status !== "native").map(key)).toEqual([]);
  });

  it("gives every remaining route a reason and lists no reason for a route that is served or gone", () => {
    const remaining = all.filter((row) => row.status !== "native").map(key);
    expect(remaining.filter((route) => RAILS_KEEPS[route] === undefined)).toEqual([]);
    expect(Object.keys(RAILS_KEEPS).filter((route) => !remaining.includes(route))).toEqual([]);
  });
});
