import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, selectRows, withApplicationLock } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  withApplicationLock: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("../models/sql.ts", () => ({
  selectRows,
  column: (_table: string, name: string) => name,
  table: (name: string) => name,
  quoteName: (name: string) => name,
}));
vi.mock("../models/oauth-application-writes.ts", () => ({ withApplicationLock }));

const { errorRedirect, preAuthorization } = await import("./oauth-authorizations.ts");

const CLIENT = {
  id: 5,
  redirect_uri: "https://example.com/callback",
  scopes: "view_public edit_products",
  deleted_at: null,
  mcp_dynamic_client: 0,
};
const REQUEST = {
  client_id: "uid",
  redirect_uri: "https://example.com/callback",
  response_type: "code",
  scope: "view_public",
};
const failureOf = (fields: Record<string, string>, client = CLIENT) => {
  const verdict = preAuthorization(fields, client);
  return verdict.failure?.name ?? null;
};

describe("preAuthorization", () => {
  it("accepts a request the client registered for", () => {
    expect(failureOf(REQUEST)).toBeNull();
  });

  it("reports a missing client id as a JSON-only invalid_request", () => {
    expect(preAuthorization({ ...REQUEST, client_id: " " }, null).failure).toMatchObject({
      name: "invalid_request",
      redirectable: false,
      status: 400,
    });
  });

  it("reports an unknown client as 401", () => {
    expect(preAuthorization(REQUEST, null).failure).toMatchObject({
      name: "invalid_client",
      redirectable: false,
      status: 401,
    });
  });

  it("rejects a redirect URI the client did not register, ignoring the case of scheme and host and the default port", () => {
    expect(failureOf({ ...REQUEST, redirect_uri: "https://example.org/callback" })).toBe("invalid_redirect_uri");
    expect(failureOf({ ...REQUEST, redirect_uri: "https://Example.com:443/callback" })).toBeNull();
    expect(failureOf({ ...REQUEST, redirect_uri: undefined } as never)).toBe("invalid_redirect_uri");
  });

  it("hands back a redirect URI whose comparison Ruby's URI decides", () => {
    expect(() => preAuthorization({ ...REQUEST, redirect_uri: "http://127.0.0.1:5555/callback" }, CLIENT)).toThrow(
      HandBackToRails,
    );
    expect(() => preAuthorization({ ...REQUEST, redirect_uri: "myapp://callback" }, CLIENT)).toThrow(HandBackToRails);
    expect(() => preAuthorization(REQUEST, { ...CLIENT, redirect_uri: "https://example.com/callback?a=1" })).toThrow(
      HandBackToRails,
    );
  });

  it("hands back a dynamic client and a response mode", () => {
    expect(() => preAuthorization(REQUEST, { ...CLIENT, mcp_dynamic_client: 1 })).toThrow(HandBackToRails);
    expect(() => preAuthorization({ ...REQUEST, response_mode: "query" }, CLIENT)).toThrow(HandBackToRails);
  });

  it("rejects a response type other than code as redirectable", () => {
    expect(preAuthorization({ ...REQUEST, response_type: "token" }, CLIENT).failure).toMatchObject({
      name: "unsupported_response_type",
      redirectable: true,
    });
  });

  it("checks scopes against the client's, then the server's when the client has none", () => {
    expect(failureOf({ ...REQUEST, scope: "view_sales" })).toBe("invalid_scope");
    expect(failureOf({ ...REQUEST, scope: "view_public  edit_products" })).toBeNull();
    expect(failureOf({ ...REQUEST, scope: "view_sales" }, { ...CLIENT, scopes: "" })).toBeNull();
    expect(failureOf({ ...REQUEST, scope: "bogus" }, { ...CLIENT, scopes: "" })).toBe("invalid_scope");
  });

  it("falls back to the default scope for a blank one, but only when the client allows it", () => {
    const { scope: _scope, ...withoutScope } = REQUEST;
    expect(failureOf(withoutScope)).toBeNull();
    expect(failureOf(withoutScope, { ...CLIENT, scopes: "edit_products" })).toBe("invalid_scope");
  });

  it("accepts a code challenge method of plain or S256 only", () => {
    expect(failureOf({ ...REQUEST, code_challenge: "abc", code_challenge_method: "S256" })).toBeNull();
    expect(failureOf({ ...REQUEST, code_challenge: "abc", code_challenge_method: "S512" })).toBe(
      "invalid_code_challenge_method",
    );
    expect(failureOf({ ...REQUEST, code_challenge: "abc" })).toBe("invalid_code_challenge_method");
    expect(failureOf({ ...REQUEST, code_challenge_method: "S512" })).toBeNull();
  });
});

describe("errorRedirect", () => {
  it("builds the query the way Rack does, leaving out a blank state", () => {
    expect(errorRedirect("https://example.com/callback", "access_denied", "No way.", undefined, false)).toBe(
      "https://example.com/callback?error=access_denied&error_description=No+way.",
    );
    expect(errorRedirect("https://example.com", "invalid_scope", "a, b", "a b*~&", false)).toBe(
      "https://example.com?error=invalid_scope&error_description=a%2C+b&state=a+b*%7E%26",
    );
  });

  it("puts the parameters in the fragment for an implicit request", () => {
    expect(errorRedirect("https://example.com/cb", "access_denied", "No.", "s", true)).toBe(
      "https://example.com/cb#error=access_denied&error_description=No.&state=s",
    );
  });
});

describe("the routes", () => {
  const find = (method: string, pattern: string) =>
    specs.find((spec) => spec.method === method && spec.pattern === pattern)!;
  const signedOut = (path: string) =>
    ({
      context: { loggedInUser: null },
      request: { path: path.split("?")[0], queryString: path.split("?")[1] ?? "" },
      params: {},
    }) as unknown as MutationInput;
  const signedIn = (params: Record<string, unknown>) =>
    ({
      context: { loggedInUser: { id: 1n } },
      request: { path: "/oauth/authorize", queryString: "" },
      params,
    }) as unknown as MutationInput;

  beforeEach(() => {
    selectRows.mockReset();
    withApplicationLock.mockReset();
  });

  it("registers the connector aliases of GET", () => {
    for (const client of ["muse", "claude", "chatgpt", "cursor", "antigravity", "ifttt"])
      expect(find("GET", `/${client}/v1/oauth2/authorize`)).toBeDefined();
  });

  it("redirects a signed-out visitor to the login page with the escaped path", async () => {
    const result = await find("GET", "/oauth/authorize").run(signedOut("/oauth/authorize?scope=a b&state=1"));
    expect(result).toMatchObject({
      status: 302,
      location: "/oauth/login?next=%2Foauth%2Fauthorize%3Fscope%3Da+b%26state%3D1",
      rescued: true,
    });
  });

  it("hands back every signed-in GET, which renders a layout", async () => {
    await expect(find("GET", "/oauth/authorize").run(signedIn({ client_id: "uid" }))).rejects.toThrow(HandBackToRails);
  });

  it("denies a request with a redirect carrying X-Robots-Tag, without reading the application when the client id is blank", async () => {
    const result = await find("DELETE", "/oauth/authorize").run(
      signedIn({ redirect_uri: "https://example.com/cb", state: "s" }),
    );
    expect(result).toMatchObject({ status: 302, headers: { "x-robots-tag": "noindex" } });
    expect((result as { location: string }).location).toMatch(
      /^https:\/\/example\.com\/cb\?error=access_denied&error_description=.+&state=s$/u,
    );
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("hands back a denial for a response type with no strategy and for a custom scheme", async () => {
    await expect(
      find("DELETE", "/oauth/authorize").run(
        signedIn({ redirect_uri: "https://example.com/cb", response_type: "bogus" }),
      ),
    ).rejects.toThrow(HandBackToRails);
    await expect(find("DELETE", "/oauth/authorize").run(signedIn({ redirect_uri: "myapp://cb" }))).rejects.toThrow(
      HandBackToRails,
    );
  });

  it("answers an unknown client of POST as 401 JSON without taking a lock", async () => {
    selectRows.mockResolvedValue([]);
    const result = (await find("POST", "/oauth/authorize").run(
      signedIn({ client_id: "nope", redirect_uri: "https://example.com/cb", state: "s" }),
    )) as { status: number; body: string };
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body)).toMatchObject({ error: "invalid_client", state: "s" });
    expect(withApplicationLock).not.toHaveBeenCalled();
  });

  it("reads a live application under the shared lock, and hands back when the lock cannot be taken", async () => {
    selectRows.mockResolvedValue([CLIENT]);
    withApplicationLock.mockRejectedValue(new Error("Lock wait timeout exceeded"));
    await expect(find("POST", "/oauth/authorize").run(signedIn({ ...REQUEST, scope: "bogus" }))).rejects.toThrow(
      HandBackToRails,
    );
    expect(withApplicationLock).toHaveBeenCalledWith(5, true, expect.any(Function));
  });

  it("hands back a request that passes every check, which would issue a grant", async () => {
    selectRows.mockResolvedValue([CLIENT]);
    withApplicationLock.mockImplementation((_id: number, _shared: boolean, run: () => unknown) => run());
    await expect(find("POST", "/oauth/authorize").run(signedIn(REQUEST))).rejects.toThrow(HandBackToRails);
  });

  it("hands back a parameter that is not plain text", async () => {
    await expect(
      find("POST", "/oauth/authorize").run(signedIn({ ...REQUEST, scope: ["view_public"] })),
    ).rejects.toThrow(HandBackToRails);
    await expect(
      find("DELETE", "/oauth/authorize").run(signedIn({ redirect_uri: "https://example.com/cb", state: "é" })),
    ).rejects.toThrow(HandBackToRails);
  });
});
