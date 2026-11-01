import type { OauthAccessToken } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { requireOauthScope, tokenForRequest } from "./api-token.ts";

const token = (attributes: Partial<OauthAccessToken> = {}) => ({ scopes: "view_public edit_products", resource: null, ...attributes }) as OauthAccessToken;

describe("requireOauthScope", () => {
  it("lets a token holding any of the scopes through", () => {
    expect(requireOauthScope(token(), ["edit_products", "view_sales"])).toBeNull();
  });

  // Array#to_sentence(last_word_connector: " or "), as Ruby 3.4 answered for 1, 2 and 3 scopes.
  it.each([
    [["a"], "a"],
    [["a", "b"], "a and b"],
    [["a", "b", "c"], "a, b or c"],
  ])("names %j in the refusal as %s", (scopes, sentence) => {
    expect(requireOauthScope(token(), scopes)).toEqual({ status: 403, body: { success: false, message: `This endpoint requires the ${sentence} scope.` } });
  });

  it("refuses a missing token", () => {
    expect(requireOauthScope(null, ["a"])?.status).toBe(403);
  });
});

describe("tokenForRequest", () => {
  it("keeps an unbound token anywhere and drops a bound one elsewhere", () => {
    expect(tokenForRequest(token(), "/v2/user")).not.toBeNull();
    expect(tokenForRequest(token({ resource: "https://example.com/claude/v1/mcp" }), "/v2/user")).toBeNull();
    expect(tokenForRequest(null, "/v2/user")).toBeNull();
  });
});
