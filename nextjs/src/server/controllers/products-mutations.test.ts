import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  execute,
}));
vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

const { schedulePublicFilesForDeletion } = await import("./products-mutations.ts");

beforeEach(() => execute.mockReset());

describe("schedulePublicFilesForDeletion", () => {
  it("schedules the live public files of the product ten minutes ahead (the column keeps fractions) without touching updated_at", async () => {
    await schedulePublicFilesForDeletion(42n, new Date("2025-03-01T10:00:00.789Z"));
    const sql = execute.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sql.sql).toBe(
      "UPDATE `public_files` SET `public_files`.`scheduled_for_deletion_at` = ? WHERE `public_files`.`resource_id` = ? AND `public_files`.`resource_type` = 'Link' AND `public_files`.`deleted_at` IS NULL",
    );
    expect(sql.values).toEqual([new Date("2025-03-01T10:10:00.789Z"), 42n]);
  });
});
