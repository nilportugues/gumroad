// The reads behind the response of a free purchase, replayed from purchase-create.golden.json (the statements after
// ActivateIntegrationsWorker is pushed), with single answers changed to reach each fact.
import type { Link, Purchase, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { golden, isSql } from "../models/__fixtures__/purchase-golden.ts";
import { NotPortedError } from "../models/user.ts";

import { loadPurchaseResponseFacts } from "./purchase-response-facts.ts";

const c = golden.cases[0]!;
const start = c.statements.findIndex((entry) => "sql" in entry && entry.sql.includes("FROM `product_files`"));
const end = c.statements.findIndex(
  (entry) => "marker" in entry && entry.marker === "Order::ChargeService" && entry.phase === "end",
);
const reads = c.statements.slice(start, end).filter(isSql);

const input = {
  purchase: { id: 1n, email: "buyer@example.com" } as Purchase,
  link: { id: 1n } as Link,
  seller: { id: 1n } as User,
  purchaser: null,
  urlRedirect: null,
};

const withAnswer = (match: string, fields: string[], rows: unknown[][]): Statement[] =>
  reads.map((statement) =>
    statement.sql.includes(match) ? { ...statement, result: { fields, rows } } : statement,
  ) as Statement[];

const load = (statements: Statement[]) => {
  const sql = sqlReplay(statements);
  return { sql, facts: loadPurchaseResponseFacts(input) };
};

describe("loadPurchaseResponseFacts", () => {
  it("sends the recorded reads and finds nothing for a plain free purchase", async () => {
    const { sql, facts } = load(reads);
    expect(await facts).toMatchObject({
      hasFiles: false,
      hasStampablePdfs: false,
      isFollowing: false,
      hasThirdPartyAnalytics: false,
      enabledIntegrations: { circle: false, discord: false, zoom: false, google_calendar: false },
    });
    expect(sql.log).toEqual(reads.map((statement) => statement.sql));
  });

  it("reports a product file, a follower and a pdf waiting to be stamped", async () => {
    const statements = reads.map((statement) => {
      if (statement.sql.includes("SELECT `product_files`.*"))
        return { ...statement, result: { fields: ["id", "filetype", "flags"], rows: [[1, "pdf", 16]] } };
      if (
        statement.sql.startsWith("SELECT 1 AS one FROM `product_files`") ||
        statement.sql.includes("FROM `followers`")
      )
        return { ...statement, result: { fields: ["one"], rows: [[1]] } };
      return statement;
    }) as Statement[];
    const { facts } = load(statements);
    expect(await facts).toMatchObject({ hasFiles: true, hasStampablePdfs: true, isFollowing: true });
  });

  it("skips the seller's analytics once the product has one for the receipt", async () => {
    const statements = withAnswer("`third_party_analytics`.`link_id` = 1", ["id"], [[1]]).filter(
      (statement) => !statement.sql.includes("`third_party_analytics`.`user_id`"),
    );
    const { sql, facts } = load(statements);
    expect(await facts).toMatchObject({ hasThirdPartyAnalytics: true });
    expect(sql.log.filter((text) => text.includes("third_party_analytics"))).toHaveLength(1);
  });

  it.each([
    ["a presentment", "FROM `purchase_presentments`"],
    ["a shipment", "FROM `shipments`"],
    ["an enabled integration", "'DiscordIntegration'"],
    ["an affiliate credit", "FROM `affiliate_credits`"],
    ["a custom field", "FROM `purchase_custom_fields`"],
  ])("hands back %s", async (_name, match) => {
    const { facts } = load(withAnswer(match, ["id"], [[1]]));
    await expect(facts).rejects.toBeInstanceOf(NotPortedError);
  });
});
