import { readdirSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { replayExchange } from "../src/replay";

// Replays spec/requests/api_token_auth_spec.rb against nextjs/src/server/auth/api-token.ts: the same
// token lookup, binding, validity and scope checks, so each request is refused or accepted as Rails
// did, with the same status and the headers Doorkeeper adds. The module is a server building block
// rather than a route, so it is exercised in process behind a stand-in endpoint for /v2/user.
const url = process.env.PARITY_DATABASE_URL;
const FIXTURE_DIR = "parity/fixtures/requests/api_token_auth_spec";

// Doorkeeper.configuration.public_api_read_scopes + :view_public
const PUBLIC_READ_SCOPES = ["edit_products", "view_sales", "mark_sales_as_shipped", "edit_sales", "revenue_share", "ifttt", "view_profile", "view_payouts", "view_tax_data", "account", "view_public"];

const files = url ? readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json")) : [];

describe.skipIf(!url)("API token authentication", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let handle: (request: Request) => Promise<Response>;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.RAILS_ENV = "test";
    process.env.DATABASE_URL = url;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const api = await import("@/server/auth/api-token");

    handle = async (request) => {
      const { pathname, searchParams } = new URL(request.url);
      const apiRequest = { authorization: request.headers.get("authorization"), parameters: Object.fromEntries(searchParams), path: pathname };
      const token = await api.doorkeeperToken(apiRequest);
      const scopes = pathname === "/v2/user/profile_layout" ? ["view_profile"] : PUBLIC_READ_SCOPES;
      const result = await api.doorkeeperAuthorize(token, scopes, { apiV2: true });
      if (!result.ok) return new Response(null, { status: result.status, headers: result.headers });
      if (pathname === "/v2/user/profile_layout") {
        const refusal = api.requireOauthScope(token, ["view_profile"]);
        if (refusal) return Response.json(refusal.body, { status: refusal.status });
      }
      const user = await api.currentApiUser(token);
      return Response.json({ id: String(user!.id) });
    };
  });

  afterAll(async () => {
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  it.each(files.map((file) => [file.replace(/\.json$/u, ""), file] as const))("%s", async (_name, file) => {
    const fixture = loadFixture(path.join(FIXTURE_DIR, file));
    const exchange = fixture.exchanges.at(-1)!;
    const actual = await replayExchange(exchange, { sql, transport: handle, interceptHttp: false }, fixture);

    expect(actual.response.status).toBe(exchange.response.status);
    for (const header of ["www-authenticate", "cache-control"]) {
      if (exchange.response.status !== 200 && !exchange.response.json) expect([header, actual.response.headers[header]]).toEqual([header, exchange.response.headers[header]]);
    }
    if (exchange.response.status === 200) {
      const seeded = exchange.seed.tables.oauth_access_tokens!.rows[0] as Record<string, unknown>;
      expect(actual.response.json).toEqual({ id: expect.any(String) });
      expect(seeded.resource_owner_id).toBeTruthy();
    }
    if (exchange.response.json && exchange.response.status === 403) expect(actual.response.json).toEqual(exchange.response.json);
  });
});
