import { describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions } = vi.hoisted(() => ({ actions: [] as MobileAction[] }));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));

await import("./mobile-agent.ts");

describe("GET /mobile/agent/meta", () => {
  it("registers only the tombstone read, behind the mobile_api scope", () => {
    expect(actions.map((registered) => [registered.method, registered.pattern, registered.scopes])).toEqual([
      ["GET", "/mobile/agent/meta", ["mobile_api"]],
    ]);
  });

  it("answers that the chat is disabled and points to the MCP connectors", async () => {
    const result = await actions[0]!.run({} as MobileInput, { owner: { id: 7n } } as unknown as MobileAuth);
    expect((result as { status: number }).status).toBe(200);
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      success: true,
      enabled: false,
      greeting: "",
      suggestions: [],
      available: false,
      notice: "The Agent tab is gone. Connect Claude or ChatGPT to your store at gumroad.com/mcp.",
    });
  });
});
