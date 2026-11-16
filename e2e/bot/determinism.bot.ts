import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { requestSequence } from "../support/bot-trace";
import { OUT_DIR } from "../support/recorder";

const STEPS = "10";
const DIR = path.join(OUT_DIR, "determinism");

/** Runs the real bot in a child Playwright process, so BOT_SEED is read exactly as in a normal bot run. */
const runBot = (seed: string, name: string) => {
  const file = path.join(DIR, `${name}.jsonl`);
  execFileSync("npx", ["playwright", "test", "--project=bot", "e2e/bot/bot.bot.ts"], {
    env: { ...process.env, BOT_SEED: seed, BOT_SESSIONS: "1", BOT_STEPS: STEPS, BOT_OUT: file },
    stdio: "pipe",
  });
  return requestSequence(file);
};

test.describe.configure({ mode: "serial" });

test.describe("bot determinism", () => {
  test.beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  test("the same BOT_SEED produces the same request sequence twice", async () => {
    const first = runBot("determinism-a", "same-1");
    const second = runBot("determinism-a", "same-2");
    expect(first.length).toBeGreaterThan(Number(STEPS));
    expect(second).toEqual(first);
  });

  test("a different BOT_SEED produces a different request sequence", async () => {
    const first = requestSequence(path.join(DIR, "same-1.jsonl"));
    const other = runBot("determinism-b", "other");
    expect(other).not.toEqual(first);
  });
});
