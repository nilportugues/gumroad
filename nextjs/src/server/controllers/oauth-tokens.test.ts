import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  findApplicationByUid: vi.fn(),
  findApplicationById: vi.fn(),
  findAliveApplicationByUid: vi.fn(),
  findAccessToken: vi.fn(),
  findAccessGrant: vi.fn(),
  revokeAccessToken: vi.fn(),
  revokeAccessGrant: vi.fn(),
  insertAccessToken: vi.fn(),
  lockAccessGrant: vi.fn(),
  lockAccessToken: vi.fn(),
  transaction: vi.fn(),
  brandTokenValid: vi.fn(),
  copyTeamMembership: vi.fn(),
}));
const locks = vi.hoisted(() => ({ withApplicationLock: vi.fn() }));

vi.mock("../models/oauth-tokens.ts", async (original) => ({
  ...(await original<typeof import("../models/oauth-tokens.ts")>()),
  ...models,
}));
vi.mock("../models/oauth-application-writes.ts", () => locks);
vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

import type { Rendered } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { clientCredentials, createToken, introspect, revoke, TOKEN_PATHS } from "./oauth-tokens.ts";

const input = (
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
  path = "/oauth/token",
  cookies: [string, string][] = [],
  session: Record<string, unknown> = { session_id: "abc" },
) =>
  ({
    params,
    chain: { session: { data: session } },
    request: { headers: new Headers(headers), path, cookies: new Map(cookies) },
  }) as unknown as MutationInput;
const basic = (value: string) => ({ authorization: `Basic ${Buffer.from(value).toString("base64")}` });
const publicApp = {
  id: 1,
  uid: "pub",
  secret: "s3cret",
  confidential: 0,
  mcp_dynamic_client: 0,
  scopes: "view_profile edit_products",
};
const confidentialApp = { ...publicApp, id: 2, uid: "conf", confidential: 1 };
const body = (result: unknown) => JSON.parse((result as Rendered).body as string) as Record<string, unknown>;
const status = (result: unknown) => (result as Rendered).status;

beforeEach(() => {
  for (const mock of Object.values(models)) mock.mockReset();
  models.findApplicationByUid.mockResolvedValue(null);
  models.findApplicationById.mockResolvedValue(null);
  models.findAliveApplicationByUid.mockResolvedValue(null);
  models.findAccessToken.mockResolvedValue(null);
  models.findAccessGrant.mockResolvedValue(null);
  models.brandTokenValid.mockResolvedValue(true);
  models.transaction.mockImplementation((run: () => unknown) => run());
  locks.withApplicationLock.mockImplementation((_id: number, _shared: boolean, run: () => unknown) => run());
  models.lockAccessGrant.mockImplementation((id: number) => Promise.resolve({ id, revoked_at: null }));
  models.lockAccessToken.mockImplementation((id: number) => Promise.resolve({ id, revoked_at: null }));
  models.insertAccessToken.mockImplementation((attributes: Record<string, unknown>) =>
    Promise.resolve({
      ...attributes,
      token: "new-token",
      refreshToken: attributes.useRefreshToken ? "new-refresh" : null,
    }),
  );
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

describe("registered token paths", () => {
  it("serves /oauth/token and every alias, which rack-attack.ts counts once before the action chain", () => {
    expect(TOKEN_PATHS).toEqual([
      "/oauth/token",
      "/muse/v1/oauth2/token",
      "/claude/v1/oauth2/token",
      "/chatgpt/v1/oauth2/token",
      "/ifttt/v1/oauth2/token",
      "/notion/oauth2/token",
    ]);
  });

  it("lists each of them in routes.json", () => {
    const routes = JSON.parse(readFileSync(new URL("../../../routes.json", import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
    for (const path of TOKEN_PATHS) expect(routes).toHaveProperty([`POST ${path}`]);
  });
});

describe("session cookie", () => {
  it("hands back a session that holds more than its session id", async () => {
    await expect(
      createToken(input({}, {}, "/oauth/token", [["_gumroad_app_session_test", "x"]], { session_id: "a", warden: 1 })),
    ).rejects.toThrow(/more than a session id/u);
  });

  it("answers a request whose session holds only its session id", async () => {
    expect(status(await createToken(input({ grant_type: "password" })))).toBe(400);
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

  it("issues a token and revokes the code for one that passes the checks", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findAccessGrant.mockResolvedValue({
      ...grant,
      id: 7,
      scopes: "view_profile  edit_products view_profile",
      redirect_uri: "https://x.example.com/cb",
      resource_owner_id: 3,
      resource: "r",
    });
    const result = await createToken(input({ code: "c", redirect_uri: "https://x.example.com/cb", client_id: "pub" }));
    expect(models.revokeAccessGrant).toHaveBeenCalledWith(7, expect.any(Date));
    expect(models.insertAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 1,
        resourceOwnerId: 3,
        scopes: "view_profile edit_products",
        expiresIn: null,
        useRefreshToken: true,
        resource: "r",
      }),
    );
    expect(body(result)).toMatchObject({
      access_token: "new-token",
      token_type: "Bearer",
      refresh_token: "new-refresh",
      scope: "view_profile edit_products",
    });
    expect(body(result)).not.toHaveProperty("expires_in");
  });

  it("answers invalid_grant with the state when the code was revoked while the request waited for its lock", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findAccessGrant.mockResolvedValue({
      ...grant,
      id: 7,
      redirect_uri: "https://x.example.com/cb",
      scopes: "a",
    });
    models.lockAccessGrant.mockResolvedValue({ id: 7, revoked_at: new Date(Date.now() - 1000) });
    const result = await createToken(
      input({ code: "c", redirect_uri: "https://x.example.com/cb", client_id: "pub", state: "s" }),
    );
    expect(body(result)).toMatchObject({ error: "invalid_grant", state: "s" });
    expect(models.insertAccessToken).not.toHaveBeenCalled();
  });

  it("answers invalid_grant for a redirect URI that is not the one of the code", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findAccessGrant.mockResolvedValue({ ...grant, redirect_uri: "https://x.example.com/cb" });
    const result = await createToken(input({ code: "c", redirect_uri: "https://y.example.com/cb", client_id: "pub" }));
    expect(body(result)).toMatchObject({ error: "invalid_grant" });
    expect(models.insertAccessToken).not.toHaveBeenCalled();
  });

  it("verifies an S256 challenge against the SHA-256 of the verifier", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    // RFC 7636 appendix B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    models.findAccessGrant.mockResolvedValue({
      ...grant,
      redirect_uri: "https://x.example.com/cb",
      scopes: "a",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const params = { code: "c", redirect_uri: "https://x.example.com/cb", client_id: "pub" };
    expect(body(await createToken(input({ ...params, code_verifier: verifier })))).toMatchObject({
      access_token: "new-token",
    });
    expect(body(await createToken(input({ ...params, code_verifier: `${verifier}x` })))).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("holds a dynamically registered client to S256 PKCE and the resource of its code", async () => {
    models.findApplicationById.mockResolvedValue({ ...publicApp, id: 3, mcp_dynamic_client: 1 });
    const dynamic = { ...grant, application_id: 3, resource: "r", code_challenge: "c", code_challenge_method: "S256" };
    models.findAccessGrant.mockResolvedValue({ ...dynamic, code_challenge_method: "plain" });
    expect(body(await createToken(input({ code: "c", code_verifier: "v" })))).toEqual({
      error: "invalid_grant",
      error_description: "authorization code was not issued with an S256 code challenge",
    });
    models.findAccessGrant.mockResolvedValue(dynamic);
    expect(body(await createToken(input({ code: "c" })))).toMatchObject({ error: "invalid_request" });
    models.findAccessGrant.mockResolvedValue({ ...dynamic, resource: null });
    expect(body(await createToken(input({ code: "c", code_verifier: "v" })))).toMatchObject({
      error_description: "authorization code has no bound resource",
    });
    models.findAccessGrant.mockResolvedValue(dynamic);
    expect(body(await createToken(input({ code: "c", code_verifier: "v", resource: "other" })))).toMatchObject({
      error: "invalid_target",
    });
  });

  it("answers unauthorized_client for a dynamically registered client_credentials grant", async () => {
    models.findApplicationByUid.mockResolvedValue({ ...publicApp, mcp_dynamic_client: 1 });
    expect(body(await createToken(input({ grant_type: "client_credentials", client_id: "pub" })))).toMatchObject({
      error: "unauthorized_client",
    });
  });

  const oldToken = {
    id: 5,
    application_id: 1,
    token: "old",
    refresh_token: "old-refresh",
    expires_in: null,
    revoked_at: null,
    created_at: new Date(),
    scopes: "view_profile edit_products",
    resource_owner_id: 3,
    resource: null,
    team_membership_id: null,
  };

  it("refreshes under the shared application lock, revoking the old token and keeping its scopes and lifetime", async () => {
    models.findApplicationByUid.mockResolvedValue({ ...publicApp, scopes: "edit_products view_profile" });
    models.findApplicationById.mockResolvedValue(publicApp);
    models.findAccessToken.mockResolvedValue({ ...oldToken, expires_in: 7200 });
    const result = await createToken(
      input({ grant_type: "refresh_token", refresh_token: "old-refresh", client_id: "pub" }),
    );
    expect(locks.withApplicationLock).toHaveBeenCalledWith(1, true, expect.any(Function));
    expect(models.revokeAccessToken).toHaveBeenCalledWith(5, expect.any(Date));
    expect(models.insertAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: "view_profile edit_products",
        expiresIn: 7200,
        resourceOwnerId: 3,
        useRefreshToken: true,
      }),
    );
    expect(body(result)).toMatchObject({ refresh_token: "new-refresh" });
  });

  it("answers invalid_scope for a scope the old token lacks, writing nothing", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findApplicationById.mockResolvedValue(publicApp);
    models.findAccessToken.mockResolvedValue({ ...oldToken, scopes: "view_profile" });
    const result = await createToken(
      input({ grant_type: "refresh_token", refresh_token: "r", client_id: "pub", scope: "edit_products" }),
    );
    expect(body(result)).toMatchObject({ error: "invalid_scope" });
    expect(models.revokeAccessToken).not.toHaveBeenCalled();
  });

  it("asks for the refresh token when none is sent", async () => {
    expect(body(await createToken(input({ grant_type: "refresh_token", client_id: "pub" })))).toMatchObject({
      error_description: "Missing required parameter: refresh_token.",
    });
  });

  it("refuses a brand token whose team membership is no longer active, writing nothing", async () => {
    models.findAccessToken.mockResolvedValue({ ...oldToken, team_membership_id: 9 });
    models.brandTokenValid.mockResolvedValue(false);
    const result = await createToken(input({ grant_type: "refresh_token", refresh_token: "r" }));
    expect(body(result)).toEqual({
      error: "invalid_grant",
      error_description: "The team membership behind this token is no longer active",
    });
    expect(models.revokeAccessToken).not.toHaveBeenCalled();
    expect(models.insertAccessToken).not.toHaveBeenCalled();
  });

  it("gives the refreshed token of a brand account the membership of the one it replaces, after the insert", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findApplicationById.mockResolvedValue(publicApp);
    models.findAccessToken.mockResolvedValue({ ...oldToken, team_membership_id: 9 });
    await createToken(input({ grant_type: "refresh_token", refresh_token: "r", client_id: "pub" }));
    expect(models.copyTeamMembership).toHaveBeenCalledWith("new-token", 9);
    expect(models.insertAccessToken.mock.invocationCallOrder[0]).toBeLessThan(
      models.copyTeamMembership.mock.invocationCallOrder[0]!,
    );
  });

  it("does not touch the membership of a refreshed token that has none", async () => {
    models.findApplicationByUid.mockResolvedValue(publicApp);
    models.findApplicationById.mockResolvedValue(publicApp);
    models.findAccessToken.mockResolvedValue(oldToken);
    await createToken(input({ grant_type: "refresh_token", refresh_token: "r", client_id: "pub" }));
    expect(models.copyTeamMembership).not.toHaveBeenCalled();
  });

  it("answers invalid_scope for a client_credentials grant that asks for what the application lacks", async () => {
    models.findApplicationByUid.mockResolvedValue({ ...confidentialApp, secret: "s", scopes: "view_profile" });
    const result = await createToken(
      input({ grant_type: "client_credentials", client_id: "conf", client_secret: "s", scope: "view_sales" }),
    );
    expect(body(result)).toMatchObject({ error: "invalid_scope" });
    expect(models.insertAccessToken).not.toHaveBeenCalled();
  });

  it("issues a client_credentials token with no owner and no refresh token", async () => {
    models.findApplicationByUid.mockResolvedValue({
      ...confidentialApp,
      secret: "s",
      scopes: "view_profile edit_products",
    });
    const result = await createToken(
      input({ grant_type: "client_credentials", client_id: "conf", client_secret: "s", scope: "view_profile" }),
    );
    expect(models.insertAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ resourceOwnerId: null, useRefreshToken: false, scopes: "view_profile" }),
    );
    expect(body(result)).not.toHaveProperty("refresh_token");
  });

  it("answers a device code grant for an unknown client with the device flow's own invalid_client", async () => {
    const result = await createToken(
      input({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "nope" }),
    );
    expect(status(result)).toBe(401);
    expect(body(result)).toEqual({
      error: "invalid_client",
      error_description: "Client authentication failed due to unknown client",
    });
  });

  it("asks a device code grant without a client for a client_id", async () => {
    const result = await createToken(input({ grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
    expect(status(result)).toBe(400);
    expect(body(result)).toMatchObject({ error: "invalid_request", error_description: "client_id is required" });
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
