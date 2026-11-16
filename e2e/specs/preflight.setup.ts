import { expect, test as setup } from "@playwright/test";

import { SEED } from "../support/env";

const HELP = `
The e2e suite needs a running, seeded local Gumroad app. Precondition:
  1. Boot a dev lane (docs/local-dev-parallel-lanes.md), e.g. bin/dev-lane 1  -> http://localhost:3001
  2. Seed it:  bin/rails db:seed   (with that lane's environment)
  3. Point the suite at it:  BASE_URL=http://localhost:3001 npm run e2e
`;

setup("app is reachable and seeded", async ({ request, baseURL }) => {
  const login = await request.get("/login", { timeout: 120_000 }).catch((error: unknown) => {
    throw new Error(`Cannot reach ${baseURL}/login (${String(error)}).${HELP}`);
  });
  expect(login.status(), `GET ${baseURL}/login did not return 200.${HELP}`).toBe(200);

  // The product URL redirects to the seller's subdomain; checking the redirect avoids resolving *.localhost from Node.
  const product = await request.get(`/l/${SEED.freeProductPermalink}`, { maxRedirects: 0 });
  const location = product.headers()["location"] ?? "";
  expect(
    product.status() === 200 || (product.status() >= 300 && location.includes(`/l/${SEED.freeProductPermalink}`)),
    `Seed data missing: /l/${SEED.freeProductPermalink} (${SEED.freeProductName}) answered ${product.status()} on ${baseURL}. Run bin/rails db:seed.${HELP}`,
  ).toBe(true);

  const discover = await request.get("/discover");
  expect(
    await discover.text(),
    `Seed data missing: /discover lists no seeded products. Run bin/rails db:seed.${HELP}`,
  ).toContain("widget");
});
