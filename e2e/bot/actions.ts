import type { Page } from "@playwright/test";

import { startCheckout, completeFreeCheckout } from "../support/buyer";
import { SEED, uniqueSuffix } from "../support/env";
import { createPost, createWorkflow } from "../support/seller";
import type { Rng } from "./rng";

export type Actor = "buyer" | "seller";

export type BotContext = {
  rng: Rng;
  buyer: Page;
  seller: Page;
  /** Product permalinks learned while browsing. */
  seenProducts: Set<string>;
  searchTerms: readonly string[];
};

export type BotAction = {
  name: string;
  weight: number;
  actor: Actor;
  run: (bot: BotContext) => Promise<string>;
};

const SETTINGS_PATHS = [
  "/settings",
  "/settings/payments",
  "/settings/password",
  "/settings/profile",
  "/settings/advanced",
  "/settings/third_party_analytics",
  "/settings/team",
  "/dashboard",
  "/products",
  "/customers",
  "/payouts",
  "/emails",
  "/workflows",
  "/checkout/discounts",
  "/affiliates",
  "/collaborators",
];

const harvestProductLinks = async (page: Page, seen: Set<string>) => {
  const hrefs = await page.$$eval("a[href*='/l/']", (anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  for (const href of hrefs) {
    const match = /\/l\/([^/?#]+)/.exec(href);
    if (match) seen.add(match[1]!);
  }
};

const pickProduct = (bot: BotContext) => {
  const known = [...bot.seenProducts];
  return known.length > 0 ? bot.rng.pick(known) : SEED.freeProductPermalink;
};

export const ACTIONS: BotAction[] = [
  {
    name: "browse",
    weight: 20,
    actor: "buyer",
    run: async ({ buyer, seenProducts, rng }) => {
      const path = rng.pick(["/discover", "/discover?sort=hot_and_new", "/discover?sort=best_sellers", "/discover?sort=featured", "/"]);
      await buyer.goto(path);
      await harvestProductLinks(buyer, seenProducts);
      return path;
    },
  },
  {
    name: "search",
    weight: 15,
    actor: "buyer",
    run: async ({ buyer, rng, searchTerms, seenProducts }) => {
      const term = rng.pick(searchTerms);
      await buyer.goto(`/discover?query=${encodeURIComponent(term)}`);
      await buyer.waitForLoadState("networkidle").catch(() => undefined);
      await harvestProductLinks(buyer, seenProducts);
      return term;
    },
  },
  {
    name: "view_product",
    weight: 20,
    actor: "buyer",
    run: async (bot) => {
      const permalink = pickProduct(bot);
      await bot.buyer.goto(`/l/${permalink}`);
      return permalink;
    },
  },
  {
    name: "add_to_cart",
    weight: 8,
    actor: "buyer",
    run: async (bot) => {
      const permalink = pickProduct(bot);
      await bot.buyer.goto(`/l/${permalink}`);
      await startCheckout(bot.buyer, permalink);
      return permalink;
    },
  },
  {
    name: "buy_free_product",
    weight: 8,
    actor: "buyer",
    run: async (bot) => {
      await bot.buyer.goto(`/l/${SEED.freeProductPermalink}`);
      await startCheckout(bot.buyer, SEED.freeProductPermalink);
      await completeFreeCheckout(bot.buyer);
      return SEED.freeProductPermalink;
    },
  },
  {
    name: "library",
    weight: 8,
    actor: "buyer",
    run: async ({ buyer, rng }) => {
      const path = rng.pick(["/library", "/library?sort=purchase_date", "/library?search=widget"]);
      await buyer.goto(path);
      return path;
    },
  },
  {
    name: "settings_visit",
    weight: 10,
    actor: "seller",
    run: async ({ seller, rng }) => {
      const path = rng.pick(SETTINGS_PATHS);
      await seller.goto(path);
      return path;
    },
  },
  {
    name: "create_post",
    weight: 4,
    actor: "seller",
    run: async ({ seller }) => {
      const title = `Bot post ${uniqueSuffix()}`;
      await createPost(seller, { title, body: "Written by the e2e bot." });
      return title;
    },
  },
  {
    name: "create_workflow",
    weight: 3,
    actor: "seller",
    run: async ({ seller }) => {
      const name = `Bot workflow ${uniqueSuffix()}`;
      await createWorkflow(seller, name);
      return name;
    },
  },
];
