import path from "node:path";

import { expect, test } from "@playwright/test";

import { logInAsSeededSeller, signUp } from "../support/auth";
import { uniqueEmail } from "../support/env";
import { blockExternalRequests } from "../support/fixtures";
import { attachRecorder, OUT_DIR, type RecorderState } from "../support/recorder";
import { ACTIONS, type BotContext } from "./actions";
import { createRng, seedFromString } from "./rng";

const SEED_TEXT = process.env.BOT_SEED ?? "1";
const SESSIONS = Number(process.env.BOT_SESSIONS ?? 2);
const STEPS = Number(process.env.BOT_STEPS ?? 15);
const WITH_HAR = process.env.BOT_HAR === "1";
const SEARCH_TERMS = (process.env.BOT_SEARCH_TERMS ?? "widget,music,film,design,book,course").split(",");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_FILE = process.env.BOT_OUT ?? path.join(OUT_DIR, `bot-${SEED_TEXT}-${stamp}.jsonl`);

// Same BOT_SEED + same app data => same action sequence, so a replay tool can line two servers up step by step.
test.describe.configure({ mode: "serial" });

for (let session = 0; session < SESSIONS; session += 1) {
  test(`bot session ${session} (seed ${SEED_TEXT}, ${STEPS} steps)`, async ({ browser }) => {
    const rng = createRng(seedFromString(`${SEED_TEXT}:${session}`));
    const state: RecorderState = { session: `${SEED_TEXT}-${session}`, step: 0, actor: "setup", action: "setup" };
    const harDir = path.join(OUT_DIR, "har");
    const newContext = async (actor: string) => {
      const context = await browser.newContext(
        WITH_HAR ? { recordHar: { path: path.join(harDir, `${state.session}-${actor}.har`) } } : {},
      );
      await blockExternalRequests(context);
      // Both actors share one cursor so each recorded exchange is tagged with the step that caused it.
      attachRecorder(context, OUT_FILE, state);
      return context;
    };

    const buyerContext = await newContext("buyer");
    const sellerContext = await newContext("seller");
    const buyer = await buyerContext.newPage();
    const seller = await sellerContext.newPage();
    buyer.setDefaultTimeout(30_000);
    seller.setDefaultTimeout(30_000);

    state.actor = "buyer";
    await signUp(buyer, uniqueEmail("bot-buyer"));
    state.actor = "seller";
    await logInAsSeededSeller(seller);

    const bot: BotContext = { rng, buyer, seller, seenProducts: new Set(), searchTerms: SEARCH_TERMS };
    const results: { step: number; action: string; ok: boolean; detail: string }[] = [];

    for (let step = 1; step <= STEPS; step += 1) {
      const action = rng.weighted(ACTIONS);
      state.step = step;
      state.actor = action.actor;
      state.action = action.name;
      try {
        const detail = await action.run(bot);
        results.push({ step, action: action.name, ok: true, detail });
      } catch (error) {
        // A failing step is data, not a reason to stop the traffic generator.
        results.push({ step, action: action.name, ok: false, detail: String(error).split("\n")[0]! });
      }
    }

    console.log(`session ${session}:\n${results.map((r) => `  ${r.step} ${r.ok ? "ok " : "ERR"} ${r.action} ${r.detail}`).join("\n")}`);
    await buyerContext.close();
    await sellerContext.close();
    expect(results.length).toBe(STEPS);
  });
}
