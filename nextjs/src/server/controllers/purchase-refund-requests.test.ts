import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { textParam } from "./purchase-refund-requests.ts";

const input = (params: Record<string, unknown>) => ({ params }) as unknown as MutationInput;

describe("textParam", () => {
  it("reads an absent or null parameter as the empty string, as nil.to_s does", () => {
    expect(textParam(input({}), "reason")).toBe("");
    expect(textParam(input({ reason: null }), "reason")).toBe("");
  });

  it("returns text as it came", () => {
    expect(textParam(input({ message: " é\n" }), "message")).toBe(" é\n");
  });

  it("hands back what Rails would stringify itself", () => {
    for (const value of [["other"], { a: 1 }, 7, true])
      expect(() => textParam(input({ reason: value }), "reason")).toThrow(HandBackToRails);
  });

  it("hands back a NUL and a lone surrogate, which String#strip and the JSON parser read differently", () => {
    expect(() => textParam(input({ message: "a\u0000b" }), "message")).toThrow(HandBackToRails);
    expect(() => textParam(input({ message: "a\ud800b" }), "message")).toThrow(HandBackToRails);
    expect(textParam(input({ message: "😀" }), "message")).toBe("😀");
  });
});
