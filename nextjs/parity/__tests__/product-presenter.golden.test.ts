import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prismaExecutor, seedDatabase } from "../src/db";

// ProductPresenter's card against the real Ruby presenter: spec/presenters/product_presenter_golden_spec.rb
// writes one database holding a matrix of product types and the card for each, with several request shapes.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const GOLDEN = path.join(process.cwd(), "src/server/presenters/__fixtures__/product-presenter.golden.json");
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");

type Case = { product: string; productId: number; input: string; args: Record<string, unknown>; card?: Record<string, unknown>; props?: Record<string, unknown>; error?: string };
type Golden = { seed: never; now: string; sellerHost: string; cards: Case[]; props: Case[]; descriptions: { description: string; plaintext: string; html: string | null }[] };

// Products whose card needs Rails code this port does not have yet; each must refuse with NotPortedError.
const UNPORTED_PRODUCTS = new Set(["default_offer_code"]);

describe.skipIf(!url)("ProductPresenter goldens", () => {
  let client: PrismaClient;
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
  const saved = { ...process.env };
  let presenter: typeof import("@/server/presenters/product");

  beforeAll(async () => {
    Object.assign(process.env, {
      RAILS_ENV: "test",
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
    });
    client = new PrismaClient({ datasourceUrl: url });
    await seedDatabase(prismaExecutor(client), golden.seed, new Date());
    const { setSqlClient } = await import("@/server/models/sql");
    setSqlClient(() => client);
    presenter = await import("@/server/presenters/product");
  });

  afterAll(async () => {
    await client?.$disconnect();
    process.env = saved;
  });

  const requestFor = (host: string) => ({ host, hostWithPort: `${host}:31337`, protocol: "http://", remoteIp: "127.0.0.1", params: {}, cookies: new Map<string, string | null>() });
  const optionsOf = (args: Record<string, unknown>) => ({
    ...(typeof args.host === "string" ? { request: requestFor(args.host === "elsewhere.example.com" ? args.host : args.host) } : {}),
    ...(args.recommended_by ? { recommendedBy: args.recommended_by as string } : {}),
    ...(args.target ? { target: args.target as string } : {}),
    ...(args.query ? { query: args.query as string } : {}),
    ...(args.affiliate_id ? { affiliateId: args.affiliate_id as string } : {}),
    ...(args.offer_code ? { offerCode: args.offer_code as string } : {}),
    ...(args.show_seller === false ? { showSeller: false } : {}),
    ...(args.compute_description === false ? { computeDescription: false } : {}),
    ...(args.compute_inventory === false ? { computeInventory: false } : {}),
    ...(args.description_max_length ? { descriptionMaxLength: args.description_max_length as number } : {}),
  });
  // Ruby's host_with_port keeps the port only when the request carries one; the golden's requests do for the seller host.
  const hostWithPort = (host: string) => (host === "elsewhere.example.com" ? host : `${host}:31337`);

  it("finds the cards", () => {
    expect(golden.cards.length).toBeGreaterThan(100);
  });

  it.each([...UNPORTED_PRODUCTS])("refuses the unported card of %s", async (name) => {
    const c = golden.cards.find((candidate) => candidate.product === name && candidate.input === "seller host")!;
    await expect(presenter.cardForWeb(BigInt(c.productId), optionsOf(c.args))).rejects.toThrow(/not ported/u);
  });

  it.each(golden.cards.map((c) => [`${c.product} / ${c.input}`, c] as const))("card %s", async (_name, c) => {
    const options = optionsOf(c.args);
    if (options.request) options.request = { ...options.request, hostWithPort: hostWithPort(options.request.host) };
    // A card that needs Rails code this port lacks must refuse, and only for the products listed above.
    const card = await presenter.cardForWeb(BigInt(c.productId), options).catch((error: Error) => error);
    if (card instanceof Error) {
      expect(UNPORTED_PRODUCTS.has(c.product), card.message).toBe(true);
      expect(card.message).toMatch(/not ported/u);
      return;
    }
    expect(JSON.parse(JSON.stringify(card))).toEqual(c.card);
  });

  // The description helpers answer what they can prove and refuse the rest.
  it.each(golden.descriptions.map((d) => [d.description, d] as const))("description %j", async (_name, d) => {
    const { plaintextDescription, htmlSafeDescription } = await import("@/server/presenters/description");
    const attempt = <T,>(run: () => T): T | "refused" => {
      try {
        return run();
      } catch (error) {
        expect((error as Error).message).toMatch(/not ported/u);
        return "refused";
      }
    };
    const plaintext = attempt(() => plaintextDescription(d.description));
    if (plaintext !== "refused") expect(plaintext).toBe(d.plaintext);
    const html = attempt(() => htmlSafeDescription(d.description));
    if (html !== "refused") expect(html).toBe(d.html);
  });

  it("proves most of the description corpus", async () => {
    const { plaintextDescription, htmlSafeDescription } = await import("@/server/presenters/description");
    const proven = (run: (d: string) => unknown) =>
      golden.descriptions.filter((d) => {
        try {
          run(d.description);
          return true;
        } catch {
          return false;
        }
      }).length;
    expect(proven(plaintextDescription)).toBeGreaterThan(golden.descriptions.length * 0.8);
    expect(proven(htmlSafeDescription)).toBeGreaterThan(golden.descriptions.length * 0.5);
  });
});
