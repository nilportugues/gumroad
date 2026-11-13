import { describe, expect, it } from "vitest";

import { MAX_MESSAGE_LENGTH, refundRequestMessage } from "./purchase-refund-request.ts";

describe("refundRequestMessage", () => {
  it("strips ASCII whitespace from both ends", () => {
    expect(refundRequestMessage("  \n padded text \t ")).toBe("padded text");
  });

  it("keeps Unicode whitespace at the ends, as String#strip does", () => {
    expect(refundRequestMessage(" kept　")).toBe(" kept　");
  });

  it("stores a message of Unicode whitespace only as nil, as blank? does", () => {
    expect(refundRequestMessage(" 　")).toBeNull();
    expect(refundRequestMessage("   ")).toBeNull();
    expect(refundRequestMessage("")).toBeNull();
  });

  it("cuts to the maximum length in code points", () => {
    const cut = refundRequestMessage("😀".repeat(MAX_MESSAGE_LENGTH + 5))!;
    expect([...cut]).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("cuts after stripping", () => {
    expect(refundRequestMessage(` ${"a".repeat(MAX_MESSAGE_LENGTH)}`)).toBe("a".repeat(MAX_MESSAGE_LENGTH));
  });
});
