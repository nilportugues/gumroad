import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, ParameterMissing } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, enqueueAudienceExport } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  enqueueAudienceExport: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", () => ({
  sellerJsonAction: (_action: unknown, _policy: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("../exports/enqueue.ts", () => ({ enqueueAudienceExport }));

await import("./audience-mutations.ts");

const run = specs.find((spec) => spec.pattern === "/audience/export")!.run;
const seller = { id: 7 };
const input = (options: unknown, impersonatedUser: { id: number } | null = null) =>
  ({ params: { options }, context: { currentSeller: seller, impersonatedUser } }) as unknown as MutationInput;

describe("POST /audience/export", () => {
  beforeEach(() => enqueueAudienceExport.mockReset().mockResolvedValue("jid"));

  it("enqueues the permitted options in the order Rails permits them and answers an empty 200", async () => {
    const result = await run(
      input({ affiliates: true, followers: "false", customers: null, admin: true, nested: { followers: true } }),
    );

    expect(result).toMatchObject({ status: 200, body: "" });
    expect(enqueueAudienceExport).toHaveBeenCalledWith(7n, 7n, {
      followers: "false",
      customers: null,
      affiliates: true,
    });
    expect(Object.keys(enqueueAudienceExport.mock.calls[0]![2] as object)).toEqual([
      "followers",
      "customers",
      "affiliates",
    ]);
  });

  it("drops a permitted key that holds a list or a hash", async () => {
    await run(input({ followers: [true], customers: { a: 1 }, affiliates: false }));

    expect(enqueueAudienceExport).toHaveBeenCalledWith(7n, 7n, { affiliates: false });
  });

  it("sends the report to the impersonating user", async () => {
    await run(input({ followers: true }, { id: 3 }));

    expect(enqueueAudienceExport).toHaveBeenCalledWith(7n, 3n, { followers: true });
  });

  it("raises ParameterMissing for options that are absent", async () => {
    await expect(run(input(undefined))).rejects.toBeInstanceOf(ParameterMissing);
    expect(enqueueAudienceExport).not.toHaveBeenCalled();
  });

  it.each([[null], [""], [{}], ["followers"], [[{ followers: true }]], [{ followers: 1 }]])(
    "hands options %j to Rails, which raises or renders them itself",
    async (options) => {
      await expect(run(input(options))).rejects.toBeInstanceOf(HandBackToRails);
      expect(enqueueAudienceExport).not.toHaveBeenCalled();
    },
  );
});
