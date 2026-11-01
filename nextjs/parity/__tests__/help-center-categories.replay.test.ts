import { readdirSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";
import { setSubdomainRedirectorDepsForTesting } from "@/server/services/subdomain-redirector";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { assertParity, replayFixture, type Transport } from "../src/replay";

// Replays spec/controllers/help_center/categories_controller_spec.rb through the routing proxy for
// the responses the proxy answers itself (the 302 for an unknown category). The 200 page fixtures
// are not replayed: rendered pages do not yet send the Rails envelope (_gumroad_guid cookie, x-gr,
// x-revision) and their RSC HTML carries no data-page for the inertia comparison.
// The legacy ".html" URL never reaches Next.js (route patterns exclude the format dot).
const url = process.env.PARITY_DATABASE_URL;
const FIXTURES = "parity/fixtures/controllers/help_center/categories_controller_spec";

describe.skipIf(!url)("HelpCenter::CategoriesController parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let proxy: (request: NextRequest) => Promise<Response>;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.RAILS_ENV = "test";
    process.env.NEXTJS_ROUTE_FLAGS = "nextjs_help_center_category";
    process.env.NEXTJS_ASSUME_SIGNED_OUT = "1";
    process.env.RAILS_ORIGIN = "http://rails.invalid";
    process.env.SECRET_KEY_BASE ??= "parity-replay-secret-key-base";
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    proxy = (await import("@/proxy")).proxy as typeof proxy;
  });

  afterAll(async () => {
    setSubdomainRedirectorDepsForTesting(null);
    await closeAllRedis();
    await client?.$disconnect();
    process.env = saved;
  });

  const throughProxy: Transport = async (request) => {
    const response = await proxy(new NextRequest(request.clone()));
    if (response.headers.get("x-middleware-next") === "1") throw new Error("the proxy handed this request to Next.js");
    return response;
  };

  const files = readdirSync(FIXTURES).filter((file) => file.endsWith(".json"));
  const firstExchange = (file: string) => loadFixture(path.join(FIXTURES, file)).exchanges[0]!;
  const proxyAnswered = files.filter((file) => !firstExchange(file).request.path.endsWith(".html") && firstExchange(file).response.status !== 200);

  it("finds the fixtures the proxy answers", () => {
    expect(proxyAnswered.length).toBeGreaterThan(0);
  });

  it.each(proxyAnswered)("%s", async (file) => {
    const result = await replayFixture(path.join(FIXTURES, file), {
      sql,
      transport: throughProxy,
      interceptHttp: true,
      // A controller spec bypasses the session middleware, so the session cookie is not recorded.
      compare: { subset: ["response.cookies"] },
    });
    assertParity(result);
  });

  it("leaves the legacy .html URL to Rails", async () => {
    const legacy = files.find((file) => firstExchange(file).request.path.endsWith(".html"))!;
    const { request } = firstExchange(legacy);
    const response = await proxy(new NextRequest(`http://${request.headers.host}${request.path}`));
    expect(response.headers.get("x-middleware-rewrite")).toBe(`http://rails.invalid${request.path}`);
  });
});
