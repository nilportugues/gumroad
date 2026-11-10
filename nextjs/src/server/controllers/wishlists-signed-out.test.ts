import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { railsRequest } from "./rails-request.ts";
import { signedOutRefusal } from "./wishlists-mutations.ts";

const signedOut = { loggedInUser: null, currentSeller: null, impersonatedUser: null };

function refusal(path: string, headers: Record<string, string>, context: object = signedOut, method = "POST") {
  const request = railsRequest(new Request(`http://app.example.com${path}`, { method, headers }));
  return signedOutRefusal({ request, context } as unknown as MutationInput);
}

describe("signedOutRefusal", () => {
  it("answers e404_json to a JSON request", () => {
    const result = refusal("/wishlists/abc/followers", { accept: "application/json" });

    expect(result).toMatchObject({ status: 404, rescued: true });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ success: false, error: "Not found" });
  });

  it("redirects an HTML request to the login page with the full path as next", () => {
    expect(refusal("/wishlists?a=1", { accept: "text/html" })).toEqual({ status: 302, location: "/login?next=%2Fwishlists%3Fa%3D1", rescued: true });
  });

  it("redirects a request without an Accept header like a browser", () => {
    expect(refusal("/wishlists/x", {}, signedOut, "DELETE")).toMatchObject({ status: 302, location: "/login?next=%2Fwishlists%2Fx" });
  });

  it("lets a signed-in user through", () => {
    expect(refusal("/wishlists", { accept: "application/json" }, { ...signedOut, loggedInUser: { id: 1n } })).toBeNull();
  });

  it("hands an XHR in a format it does not model back to Rails", () => {
    expect(() => refusal("/wishlists", { "x-requested-with": "XMLHttpRequest", accept: "text/csv" })).toThrow(HandBackToRails);
  });
});
