import { describe, expect, it } from "vitest";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { NotPortedError } from "./user.ts";
import { setSqlClient } from "./sql.ts";
import { findBaseVariantId } from "./workflow-manage.ts";

process.env.OBFUSCATE_IDS_CIPHER_KEY = "workflow-manage-test-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";

function answering(rows: Record<string, unknown>[]) {
  const statements: { sql: string; values: unknown[] }[] = [];
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string; values: unknown[] }) => {
      statements.push({ sql: query.sql, values: query.values });
      return rows;
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
  return statements;
}

describe("Workflow::ManageService variant lookup", () => {
  it("returns the id of the variant its external id names", async () => {
    const statements = answering([{ id: 7, name: "Gold" }]);

    expect(await findBaseVariantId(encrypt(7))).toBe(7);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("`base_variants`.`id` = ?");
    expect(statements[0]!.values).toEqual([7]);
  });

  it("returns null when no variant has that id", async () => {
    answering([]);

    expect(await findBaseVariantId(encrypt(7))).toBeNull();
  });

  it("looks up id IS NULL for an external id that does not decrypt, and for a missing one", async () => {
    const statements = answering([]);

    expect(await findBaseVariantId("x")).toBeNull();
    expect(await findBaseVariantId(undefined)).toBeNull();
    expect(statements.map((statement) => statement.sql)).toEqual([
      "SELECT `base_variants`.* FROM `base_variants` WHERE `base_variants`.`id` IS NULL LIMIT 1",
      "SELECT `base_variants`.* FROM `base_variants` WHERE `base_variants`.`id` IS NULL LIMIT 1",
    ]);
  });

  it("hands back an external id that is not text", async () => {
    answering([]);

    await expect(findBaseVariantId(["a"])).rejects.toBeInstanceOf(NotPortedError);
  });
});
