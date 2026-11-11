import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  findApplicationByUid: vi.fn(),
  findApplicationById: vi.fn(),
  findAccessToken: vi.fn(),
  findAccessGrant: vi.fn(),
  revokeAccessToken: vi.fn(),
}));

vi.mock("../models/oauth-tokens.ts", async (original) => ({
  ...(await original<typeof import("../models/oauth-tokens.ts")>()),
  ...models,
}));
vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

import type { Rendered } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { clientCredentials, createToken, introspect, revoke } from "./oauth-tokens.ts";

const input = (
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
  path = "/oauth/token",
  cookies: [string, string][] = [],
) =>
  ({ params, request: { headers: new Headers(headers), path, cookies: new Map(cookies) } }) as unknown as MutationInput;
const basic = (value: string) => ({ authorization: `Basic ${Buffer.from(value).toString("base64")}` });
const publicApp = { id: 1, uid: "pub", secret: "s3cret", confidential: 0, mcp_dynamic_client: 0 };
const confidentialApp = { ...publicApp, id: 2, uid: "conf", confidential: 1 };
const body = (result: unknown) => JSON.parse((result as Rendered).body as string) as Record<string, unknown>;
const status = (result: unknown) => (result as Rendered).status;

beforeEach(() => {
  for (const mock of Object.values(models)) mock.mockReset();
  models.findApplicationByUid.mockResolvedValue(null);
  models.findApplicationById.mockResolvedValue(null);
  models.findAccessToken.mockResolvedValue(null);
  models.findAccessGrant.mockResolvedValue(null);
});

describe("client credentials", () => {
  it("reads the uid and secret of a Basic header", () => {
    expect(clientCredentials(input({}, basic("abc:def")))).toEqual({ uid: "abc", secret: "def" });
  });

  it("splits a Basic value at the first colon only", () => {
    expect(clientCredentials(input({}, basic("abc:d:ef")))).toEqual({ uid: "abc", secret: "d:ef" });
  });

  it("has no secret when the Basic value has no colon", () => {
    expect(clientCredentials(input({}, basic("abc")))).toEqual({ uid: "abc", secret: null });
  });

  it("falls back to client_id and client_secret when the Basic uid is blank", () => {
    expect(clientCredentials(input({ client_id: "x", client_secret: "y" }, basic(":secret")))).toEqual({
      uid: "x",
      secret: "y",
    });
  });

  it("is absent without a present uid", () => {
    expect(clientCredentials(input({ client_id: "  " }))).toBeNull();
  });

  it("hands a Basic header that is not plain Base64 back", () => {
    expect(() => clientCredentials(input({}, { authorization: "Basic !!!!" }))).toThrow(/not ported/u);
  });

  it("hands a client_id that is not a string back", () => {
    expect(() => clientCredentials(input({ client_id: ["a"] }))).toThrow(/not ported/u);
  });
});

describe("session cookie", () => {
  it("hands a request that carries one back", async () => {
    process.env.RAILS_ENV = "test";
    await expect(createToken(input({}, {}, "/oauth/token", [["_gumroad_app_session_test", "x"]]))).rejects.toThrow(
      /session cookie/u,
    );
  });
});

describe("token endpoint", () => {
  const grant = { application_id: 1, code_challenge: null, created_at: new Date(), expires_in: 600, revoked_at: null };

  it("answers unsupported_grant_type with the state", async () => {
    const result = await createToken(input({ grant_type: "password", state: "xyz" }));
    expect(status(result)).toBe(400);
    expect(body(result)).toEqual({
      error: "unsupported_grant_type",
      error_description: "The authorization grant type is not supported by the authorization server.",
      state: "xyz",
    });
  });

  it("treats a blank grant_type as an authorization code exchange", async () => {
    expect(body(await createToken(input({ grant_type: "" })))).toMatchObject({
      error: "invalid_request",
      error_description: "Missing required parameter: code.",
    });
  });

  it("asks for the redirect URI before judging the client", async () => {
    expect(body(await createToken(input({ code: "c", client_id: "unknown" })))).toMatchObject({
      error_description: "Missing required parameter: redirect_uri.",
    });
  });

  it("asks for the code verifier of a code granted with a challenge", async () => {
    models.findAccessGrant.mockResolvedValue({ ...grant, code_challenge: "x" });
    expect(body(await createToken(input({ code: "c", redirect_uri: "https://x" })))).toMatchObject({
      error_description: "Missing required parameter: code_verifier.",
    });
  });

  it("answers invalid_client with the Bearer challenge for an unknown client", async () => {
    const result = (await createToken(
      input({ code: "c", redirect_uri: "https://x", client_id: "unknown" }),
    )) as Rendered;
    expect(result.status).toBe(401);
    expect(result.headers).toMatchObject({ "www-authenticate": expect.stringContaining('error="invalid_client"') });
  });

  it("answers invalid_client for a confidential client without its secret", async () => {
    models.findApplicationByUid.mockResolvedValue(confidentialApp);
    expect(status(await createToken(input({ code: "c", redirect_uri: "https://x", client_id: "conf" })))).toBe(401);
  });

  it("answers invalid_grant for a code of another application", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findAccessGrant.mockResolvedValue({ ...grant, application_id: 99 });
    expect(body(await createToken(input({ code: "c", redirect_uri: "https://x", client_id: "pub" })))).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("answers invalid_grant for an expired code", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findAccessGrant.mockResolvedValue({ ...grant, created_at: new Date(Date.now() - 3_600_000) });
    expect(body(await createToken(input({ code: "c", redirect_uri: "https://x", client_id: "pub" })))).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("hands a code that passes the client and grant checks back", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findAccessGrant.mockResolvedValue(grant);
    await expect(createToken(input({ code: "c", redirect_uri: "https://x", client_id: "pub" }))).rejects.toThrow(
      /not ported/u,
    );
  });

  it("hands a code of a dynamically registered client back", async () => {
    models.findAccessGrant.mockResolvedValue({ ...grant, application_id: 3 });
    models.findApplicationById.mockResolvedValue({ ...publicApp, id: 3, mcp_dynamic_client: 1 });
    await expect(createToken(input({ code: "c" }))).rejects.toThrow(/dynamically registered/u);
  });

  it("answers unauthorized_client for a dynamically registered client_credentials grant", async () => {
    models.findApplicationByUid.mockResolvedValue({ ...publicApp, mcp_dynamic_client: 1 });
    expect(body(await createToken(input({ grant_type: "client_credentials", client_id: "pub" })))).toMatchObject({
      error: "unauthorized_client",
    });
  });

  it("hands the refresh_token grant and the device code grant back", async () => {
    await expect(createToken(input({ grant_type: "refresh_token" }))).rejects.toThrow(/not ported/u);
    await expect(createToken(input({ grant_type: "urn:ietf:params:oauth:grant-type:device_code" }))).rejects.toThrow(
      /device code/u,
    );
  });

  it("leaves a device code grant on an alias path to the unsupported grant answer", async () => {
    const result = await createToken(
      input({ grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, {}, "/claude/v1/oauth2/token"),
    );
    expect(body(result)).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("revoke", () => {
  const token = {
    id: 5,
    application_id: 1,
    token: "t",
    created_at: new Date(),
    expires_in: null,
    revoked_at: null,
    scopes: "view_profile",
  };

  beforeEach(() => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findApplicationById.mockResolvedValue(publicApp);
  });

  it("refuses a request with no client", async () => {
    models.findApplicationByUid.mockResolvedValue(null);
    expect(status(await revoke(input({ token: "t" })))).toBe(403);
  });

  it("answers 200 and writes nothing for an unknown token", async () => {
    const result = await revoke(input({ token: "t", client_id: "pub" }));
    expect([status(result), body(result)]).toEqual([200, {}]);
    expect(models.revokeAccessToken).not.toHaveBeenCalled();
  });

  it("revokes an accessible token", async () => {
    models.findAccessToken.mockResolvedValue(token);
    await revoke(input({ token: "t", client_id: "pub" }));
    expect(models.revokeAccessToken).toHaveBeenCalledWith(5, expect.any(Date));
  });

  it("does not revoke a token that is already revoked", async () => {
    models.findAccessToken.mockResolvedValue({ ...token, revoked_at: new Date(Date.now() - 1000) });
    expect(status(await revoke(input({ token: "t", client_id: "pub" })))).toBe(200);
    expect(models.revokeAccessToken).not.toHaveBeenCalled();
  });

  it("refuses to revoke the token of another confidential application", async () => {
    models.findApplicationByUid.mockResolvedValue({ ...confidentialApp, secret: "s" });
    models.findApplicationById.mockResolvedValue({ ...confidentialApp, id: 9 });
    models.findAccessToken.mockResolvedValue(token);
    expect(status(await revoke(input({ token: "t" }, basic("conf:s"))))).toBe(403);
    expect(models.revokeAccessToken).not.toHaveBeenCalled();
  });

  it("looks only for a refresh token when the hint says so", async () => {
    await revoke(input({ token: "t", client_id: "pub", token_type_hint: "refresh_token" }));
    expect(models.findAccessToken.mock.calls).toEqual([["refresh_token", "t"]]);
  });
});

describe("introspect", () => {
  const created = new Date("2026-01-02T03:04:05Z");
  const token = {
    id: 5,
    application_id: 2,
    token: "t",
    created_at: created,
    expires_in: null,
    revoked_at: null,
    scopes: "view_profile",
  };

  beforeEach(() => {
    models.findApplicationByUid.mockResolvedValue({ ...confidentialApp, secret: "s" });
    models.findApplicationById.mockResolvedValue(confidentialApp);
    models.findAccessToken.mockResolvedValue(token);
  });

  it("reports iat and exp 0 for a token that never expires", async () => {
    expect(body(await introspect(input({ token: "t" }, basic("conf:s"))))).toEqual({
      active: true,
      scope: "view_profile",
      client_id: "conf",
      token_type: "Bearer",
      exp: 0,
      iat: Date.parse("2026-01-02T03:04:05Z") / 1000,
    });
  });

  it("adds expires_in to the creation time for exp", async () => {
    models.findAccessToken.mockResolvedValue({ ...token, expires_in: 60, created_at: new Date(Date.now() - 1000) });
    const { exp, iat } = body(await introspect(input({ token: "t" }, basic("conf:s")))) as { exp: number; iat: number };
    expect(exp - iat).toBe(60);
  });

  it("reports a token of another application as inactive", async () => {
    models.findApplicationById.mockResolvedValue({ ...confidentialApp, id: 7 });
    expect(body(await introspect(input({ token: "t" }, basic("conf:s"))))).toEqual({ active: false });
  });

  it("answers invalid_request when the caller proves nothing", async () => {
    const result = await introspect(input({ token: "t" }));
    expect([status(result), body(result).error]).toEqual([400, "invalid_request"]);
  });

  it("answers invalid_token with state unauthorized for a bearer of another application", async () => {
    models.findAccessToken.mockImplementation(async (_by: string, value: string) => ({
      ...token,
      token: value,
      application_id: value === "bearer" ? 7 : 2,
    }));
    models.findApplicationById.mockImplementation(async (id: number) => ({ ...confidentialApp, id }));
    const result = await introspect(input({ token: "t" }, { authorization: "Bearer bearer" }));
    expect([status(result), body(result)]).toEqual([
      401,
      { error: "invalid_token", error_description: "The access token is invalid", state: "unauthorized" },
    ]);
  });
});
