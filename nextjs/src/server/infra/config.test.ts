import { afterEach, beforeAll, describe, expect, it } from "vitest";

import credentialsGolden from "./__fixtures__/credentials.golden.json" with { type: "json" };
import globalConfigGolden from "./__fixtures__/global-config.golden.json" with { type: "json" };
import { digConfig, getConfig, getConfigValue, setCredentialsForTesting } from "./config.ts";
import { decryptEncryptedFile, parseCredentialsYaml } from "./credentials.ts";

type GoldenCase = {
  env: Record<string, string>;
  method: "get" | "dig";
  args: string | string[];
  default?: string | null;
  value?: unknown;
  error?: string;
};

describe("Rails encrypted credentials", () => {
  it("decrypts a file written by ActiveSupport::EncryptedConfiguration", () => {
    const yaml = decryptEncryptedFile(credentialsGolden.encrypted, credentialsGolden.key);
    expect(parseCredentialsYaml(yaml)).toEqual(credentialsGolden.config);
  });

  it("rejects a tampered file", () => {
    const tampered = credentialsGolden.encrypted.replace(/^./u, (c) => (c === "A" ? "B" : "A"));
    expect(() => decryptEncryptedFile(tampered, credentialsGolden.key)).toThrow();
  });

  it("parses YAML 1.1 booleans the way Psych does", () => {
    expect(parseCredentialsYaml("flag: yes\nother: off\n")).toEqual({ flag: true, other: false });
  });
});

describe("GlobalConfig parity with Ruby", () => {
  const savedEnv = { ...process.env };

  beforeAll(() => {
    setCredentialsForTesting(
      parseCredentialsYaml(decryptEncryptedFile(credentialsGolden.encrypted, credentialsGolden.key)),
    );
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it.each(
    (globalConfigGolden as GoldenCase[]).map((c) => [JSON.stringify([c.env, c.method, c.args, c.default]), c] as const),
  )("%s", (_label, c) => {
    Object.assign(process.env, c.env);
    const hasDefault = Object.hasOwn(c, "default");
    const defaultValue = c.default === null ? undefined : c.default;
    const call = () =>
      c.method === "dig"
        ? hasDefault
          ? digConfig(c.args as string[], defaultValue)
          : digConfig(c.args as string[])
        : hasDefault
          ? getConfigValue(c.args as string, defaultValue)
          : getConfigValue(c.args as string);

    if (c.error) {
      expect(call).toThrow(TypeError);
    } else {
      expect(call() ?? null).toEqual(c.value);
    }
  });

  it("stringifies scalar credentials through getConfig", () => {
    expect(getConfig("STRIPE__MAX_RETRIES")).toBe("3");
    expect(getConfig("GC_MISSING", "fallback")).toBe("fallback");
    expect(() => getConfig("STRIPE")).toThrow(TypeError);
  });
});
