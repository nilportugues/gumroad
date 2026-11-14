import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors, RecordInvalid } from "../models/runtime/errors.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, aliveUserComplianceInfoRow, legalEntityName, createAgreement, createComment, notifyError } = vi.hoisted(
  () => ({
    specs: [] as MutationSpec[],
    aliveUserComplianceInfoRow: vi.fn(),
    legalEntityName: vi.fn(),
    createAgreement: vi.fn(),
    createComment: vi.fn(),
    notifyError: vi.fn(),
  }),
);

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", async (original) => ({
  ...(await original<typeof import("./json-seller.ts")>()),
  sellerJsonAction: (_input: unknown, _policy: unknown, run: (context: unknown) => unknown) => run({}),
}));
vi.mock("../models/user-compliance-info.ts", () => ({ aliveUserComplianceInfoRow, legalEntityName }));
vi.mock("../models/backtax-agreement.ts", () => ({
  BACKTAX_JURISDICTIONS: { AUSTRALIA: "AUSTRALIA" },
  BacktaxAgreements: { createBang: createAgreement },
}));
vi.mock("../models/comment.ts", () => ({ COMMENT_TYPES: { NOTE: "note" }, Comments: { createBang: createComment } }));
vi.mock("../infra/error-reporting.ts", () => ({ notifyError }));
vi.mock("../policies/settings/payments-user.ts", () => ({
  settingsPaymentsUserPolicy: { optInToAuBacktaxCollection: () => true },
}));

await import("./settings-payments-mutations.ts");

const optIn = specs.find((spec) => spec.pattern === "/settings/payments/opt_in_to_au_backtax_collection")!;
const SELLER = { id: 7n, email: "seller@example.com" };
const ADMIN = { id: 9n, email: "admin@example.com" };

const input = (params: Record<string, unknown>, loggedInUser: typeof SELLER = SELLER): MutationInput =>
  ({ params, context: { currentSeller: SELLER, loggedInUser, impersonatedUser: null } }) as unknown as MutationInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as unknown;

function invalid(): RecordInvalid {
  const errors = new Errors();
  errors.add("signature", "can't be blank");
  return new RecordInvalid(errors);
}

beforeEach(() => {
  aliveUserComplianceInfoRow.mockReset().mockResolvedValue({});
  legalEntityName.mockReset().mockReturnValue("Chuck Bartowski");
  createAgreement.mockReset().mockResolvedValue(undefined);
  createComment.mockReset().mockResolvedValue(undefined);
  notifyError.mockReset();
});

describe("POST /settings/payments/opt_in_to_au_backtax_collection", () => {
  it("records the agreement for a signature as long as the legal name, whatever its letters", async () => {
    const result = await optIn.run(input({ signature: "Charl Bartowski" }));

    expect(body(result)).toEqual({ success: true });
    expect(createAgreement).toHaveBeenCalledWith({
      user_id: 7n,
      jurisdiction: "AUSTRALIA",
      signature: "Charl Bartowski",
    });
  });

  it("asks for the exact name, with a 200, when the lengths differ", async () => {
    const result = await optIn.run(input({ signature: "Chuck" }));

    expect((result as { status: number }).status).toBe(200);
    expect(body(result)).toEqual({ success: false, error: "Please enter your exact name." });
    expect(createAgreement).not.toHaveBeenCalled();
  });

  it("skips the length check when there is no compliance information", async () => {
    aliveUserComplianceInfoRow.mockResolvedValue(null);

    expect(body(await optIn.run(input({ signature: "Anyone" })))).toEqual({ success: true });
    expect(legalEntityName).not.toHaveBeenCalled();
  });

  it("skips the length check when a business has no business name", async () => {
    legalEntityName.mockReturnValue(null);

    expect(body(await optIn.run(input({ signature: "Anyone" })))).toEqual({ success: true });
  });

  it("holds the signature to an empty legal name, which Ruby treats as present", async () => {
    legalEntityName.mockReturnValue("");

    expect(body(await optIn.run(input({ signature: "Anyone" })))).toEqual({
      success: false,
      error: "Please enter your exact name.",
    });
  });

  it("counts a character outside the basic plane once, as Ruby's String#length does", async () => {
    legalEntityName.mockReturnValue("Ann \u{1F600}");

    expect(body(await optIn.run(input({ signature: "abcde" })))).toEqual({ success: true });
    expect(body(await optIn.run(input({ signature: "abcdef" })))).toEqual({
      success: false,
      error: "Please enter your exact name.",
    });
  });

  it.each([
    ["missing", undefined],
    ["a number", 12],
    ["null", null],
    ["a list", ["Chuck Bartowski"]],
    ["a hash", { name: "Chuck" }],
    ["a lone surrogate", "Chuck\ud800"],
  ])("hands %s to Rails before any write", async (_label, signature) => {
    await expect(optIn.run(input(signature === undefined ? {} : { signature }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    expect(createAgreement).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it("lets the presence validation failure of a blank signature through as RecordInvalid and leaves no audit note", async () => {
    aliveUserComplianceInfoRow.mockResolvedValue(null);
    createAgreement.mockRejectedValue(invalid());

    await expect(optIn.run(input({ signature: "  " }, ADMIN))).rejects.toBeInstanceOf(RecordInvalid);
    expect(createComment).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    "creates with a null signature for a seller with no compliance information (%s)",
    async (signature) => {
      aliveUserComplianceInfoRow.mockResolvedValue(null);
      createAgreement.mockRejectedValue(invalid());

      await expect(optIn.run(input(signature === undefined ? {} : { signature }, ADMIN))).rejects.toBeInstanceOf(
        RecordInvalid,
      );
      expect(createAgreement).toHaveBeenCalledWith(expect.objectContaining({ signature: null }));
      expect(createComment).not.toHaveBeenCalled();
    },
  );

  it("writes no audit note when the seller opts in", async () => {
    await optIn.run(input({ signature: "Chuck Bartowski" }));

    expect(createComment).not.toHaveBeenCalled();
  });

  it("leaves a note on the seller when someone else acts on the account", async () => {
    await optIn.run(input({ signature: "Chuck Bartowski" }, ADMIN));

    expect(createComment).toHaveBeenCalledWith({
      commentable_id: 7n,
      commentable_type: "User",
      author_id: 9n,
      comment_type: "note",
      content: "Australia backtax collection agreement signed by team admin admin@example.com",
    });
  });

  it("answers success and reports the error when the audit note cannot be written", async () => {
    const failure = new Error("boom");
    createComment.mockRejectedValue(failure);

    expect(body(await optIn.run(input({ signature: "Chuck Bartowski" }, ADMIN)))).toEqual({ success: true });
    expect(notifyError).toHaveBeenCalledWith(failure, { seller_id: 7n, actor_id: 9n });
  });
});
