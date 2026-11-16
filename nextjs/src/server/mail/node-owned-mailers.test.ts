import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { nodeMailerMethods } from "./delivery.ts";

describe("node-owned-mailers.generated.json", () => {
  it("lists exactly the mailer methods Node can deliver, for the Rails bridge to divert", () => {
    const file = JSON.parse(readFileSync(new URL("./node-owned-mailers.generated.json", import.meta.url), "utf8"));
    expect(file).toEqual(nodeMailerMethods());
  });
});
