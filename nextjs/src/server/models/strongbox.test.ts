// Replays strongbox-tax-ids.golden.json (scripts/golden/strongbox-tax-ids.rb): ciphertexts Ruby's Strongbox
// wrote with the test key, and what SettingsPresenter made of them.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasTaxId, taxIdIsLastFourOnly, taxIdLastFour } from "./user-compliance-info.ts";
import { isStrongboxBlank, strongboxDecrypt } from "./strongbox.ts";

type Case = { name: string; ciphertext: string | null; plaintext_base64: string; present: boolean; last_four: string | null; is_last_four_only: boolean };

const golden = JSON.parse(readFileSync(new URL("./__fixtures__/strongbox-tax-ids.golden.json", import.meta.url), "utf8")) as Case[];
const envTest = readFileSync(new URL("../../../../.env.test", import.meta.url), "utf8");
const saved = { key: process.env.STRONGBOX_GENERAL, password: process.env.STRONGBOX_GENERAL_PASSWORD };
const column = (testCase: Case) => (testCase.ciphertext === null ? null : Buffer.from(testCase.ciphertext, "base64"));

beforeAll(() => {
  // The key of the test environment, committed in .env.test.
  process.env.STRONGBOX_GENERAL = /^STRONGBOX_GENERAL="(.+)"$/mu.exec(envTest)![1]!.replaceAll("\\n", "\n");
  process.env.STRONGBOX_GENERAL_PASSWORD = /^STRONGBOX_GENERAL_PASSWORD="?([^"\n]+)"?$/mu.exec(envTest)![1];
});

afterAll(() => {
  for (const [name, value] of [["STRONGBOX_GENERAL", saved.key], ["STRONGBOX_GENERAL_PASSWORD", saved.password]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Strongbox", () => {
  it.each(golden.filter((testCase) => testCase.ciphertext !== null))("decrypts $name to what Ruby encrypted", (testCase) => {
    const plain = strongboxDecrypt(column(testCase), process.env.STRONGBOX_GENERAL_PASSWORD!);
    expect(plain?.toString("base64")).toBe(testCase.plaintext_base64);
  });

  it("reads a nil column as nil and an empty one as empty", () => {
    expect(strongboxDecrypt(null, "unused")).toBeNull();
    expect(strongboxDecrypt(new Uint8Array(), "unused")?.length).toBe(0);
    expect(isStrongboxBlank(null)).toBe(true);
    expect(isStrongboxBlank(new Uint8Array())).toBe(true);
  });

  it("refuses a ciphertext that does not decrypt to a padded block", () => {
    expect(() => strongboxDecrypt(Buffer.alloc(256, 1), process.env.STRONGBOX_GENERAL_PASSWORD!)).toThrow();
  });

  it("refuses a wrong password", () => {
    const first = golden.find((testCase) => testCase.ciphertext !== null)!;
    expect(() => strongboxDecrypt(column(first), "not the password")).toThrow();
  });
});

describe("tax id reads", () => {
  it.each(golden)("answers as SettingsPresenter does for $name", (testCase) => {
    const ciphertext = column(testCase);
    expect(hasTaxId(ciphertext)).toBe(testCase.present);
    expect(taxIdLastFour(ciphertext)).toBe(testCase.last_four);
    expect(taxIdIsLastFourOnly(ciphertext)).toBe(testCase.is_last_four_only);
  });
});
