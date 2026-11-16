import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({ findAliveApplicationByUid: vi.fn() }));
vi.mock("../models/oauth-tokens.ts", async (original) => ({
  ...(await original<typeof import("../models/oauth-tokens.ts")>()),
  ...models,
}));

import type { MutationInput } from "./mutation.ts";
import {
  authenticateOauthApplication,
  normalisedScopes,
  oauthJsonError,
  requestedOauthScope,
  validOauthScope,
} from "./oauth-client-authentication.ts";

const input = (params: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ({ params, request: { headers: new Headers(headers) } }) as unknown as MutationInput;
const basic = (value: string) => ({ authorization: `Basic ${Buffer.from(value).toString("base64")}` });
const application = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 1,
    uid: "app",
    secret: "s3cret",
    confidential: 0,
    scopes: "view_profile edit_products",
    ...overrides,
  }) as never;

beforeEach(() => {
  models.findAliveApplicationByUid.mockReset();
  models.findAliveApplicationByUid.mockResolvedValue(null);
});

describe("authenticateOauthApplication", () => {
  it("asks for a client_id when neither a parameter nor a Basic header names one", async () => {
    expect((await authenticateOauthApplication(input({}))).refusal).toEqual({
      error: "invalid_request",
      description: "client_id is required",
      status: 400,
    });
  });

  it("lets a client_id parameter win over the Basic header", async () => {
    await authenticateOauthApplication(input({ client_id: "from-param" }, basic("from-header:x")));
    expect(models.findAliveApplicationByUid).toHaveBeenCalledWith("from-param");
  });

  it("falls back to the Basic header for a blank parameter", async () => {
    await authenticateOauthApplication(input({ client_id: " " }, basic("from-header:x")));
    expect(models.findAliveApplicationByUid).toHaveBeenCalledWith("from-header");
  });

  it("refuses an unknown or deleted client with 401", async () => {
    expect((await authenticateOauthApplication(input({ client_id: "nope" }))).refusal).toMatchObject({
      error: "invalid_client",
      status: 401,
    });
  });

  it("lets a public client in without a secret and a confidential one in only with its secret", async () => {
    models.findAliveApplicationByUid.mockResolvedValue(application());
    expect((await authenticateOauthApplication(input({ client_id: "app" }))).refusal).toBeNull();

    models.findAliveApplicationByUid.mockResolvedValue(application({ confidential: 1 }));
    expect((await authenticateOauthApplication(input({ client_id: "app" }))).refusal).toMatchObject({ status: 401 });
    expect(
      (await authenticateOauthApplication(input({ client_id: "app", client_secret: "wrong" }))).refusal,
    ).not.toBeNull();
    expect(
      (await authenticateOauthApplication(input({ client_id: "app", client_secret: "s3cret" }))).refusal,
    ).toBeNull();
    expect((await authenticateOauthApplication(input({}, basic("app:s3cret")))).refusal).toBeNull();
  });

  it("hands back an Authorization header that is not Basic and a parameter that is not a string", async () => {
    await expect(authenticateOauthApplication(input({}, { authorization: "Bearer abc" }))).rejects.toThrow(
      /not Basic/u,
    );
    await expect(authenticateOauthApplication(input({ client_id: ["a"] }))).rejects.toThrow(/client_id/u);
  });
});

describe("oauthJsonError", () => {
  it("challenges a 401 only when Basic credentials were sent", () => {
    expect(oauthJsonError(input({}, basic("a:b")), "invalid_client", "x", { status: 401 }).headers).toMatchObject({
      "www-authenticate": 'Basic realm="Doorkeeper"',
      "cache-control": "no-store",
    });
    expect(oauthJsonError(input({}), "invalid_client", "x", { status: 401 }).headers).not.toHaveProperty(
      "www-authenticate",
    );
    expect(oauthJsonError(input({}, basic("a:b")), "invalid_request", "x").headers).not.toHaveProperty(
      "www-authenticate",
    );
  });

  it("merges the extra fields after the error", () => {
    const body = oauthJsonError(input({}), "slow_down", "Polling too quickly", { extra: { interval: 35 } }).body;
    expect(JSON.parse(body as string)).toEqual({
      error: "slow_down",
      error_description: "Polling too quickly",
      interval: 35,
    });
  });
});

describe("scopes", () => {
  const app = application();

  it("uses a present string as sent and the application's normalised scopes for a blank one", () => {
    expect(requestedOauthScope({ scope: "view_profile  edit_products" }, app)).toBe("view_profile  edit_products");
    expect(requestedOauthScope({}, application({ scopes: "a  b a" }))).toBe("a b");
    expect(requestedOauthScope({ scope: "" }, app)).toBe("view_profile edit_products");
    expect(requestedOauthScope({ scope: [] }, app)).toBe("view_profile edit_products");
  });

  it("gives a present value that is not a string no scope at all", () => {
    expect(requestedOauthScope({ scope: ["view_profile"] }, app)).toBeNull();
    expect(requestedOauthScope({ scope: 5 }, app)).toBeNull();
    expect(validOauthScope(app, null)).toBe(false);
  });

  it("validates the string as sent against the application's scopes, or the server's when it has none", () => {
    expect(validOauthScope(app, "view_profile  edit_products")).toBe(true);
    expect(validOauthScope(app, "view_profile\tedit_products")).toBe(false);
    expect(validOauthScope(app, "view_sales")).toBe(false);
    expect(validOauthScope(application({ scopes: "" }), "view_sales")).toBe(true);
    expect(normalisedScopes(" a  b\ta ")).toBe("a b");
  });
});
