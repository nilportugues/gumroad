import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, eligibleForStoreAgent, railsEnv } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  eligibleForStoreAgent: vi.fn(),
  railsEnv: vi.fn(() => "test"),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../page-props/signed-in/policy-props.ts", () => ({ eligibleForStoreAgent }));
vi.mock("../infra/rails-env.ts", () => ({ railsEnv }));

await import("./mobile-agent.ts");

const action = actions.find((registered) => registered.pattern === "/mobile/agent/meta")!;
const auth = { owner: { id: 7n } } as unknown as MobileAuth;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);

beforeEach(() => {
  eligibleForStoreAgent.mockReset();
  railsEnv.mockReturnValue("test");
});

describe("GET /mobile/agent/meta", () => {
  it("registers a read that needs the mobile_api scope", () => {
    expect([action.method, action.scopes]).toEqual(["GET", ["mobile_api"]]);
    expect(actions).toHaveLength(1);
  });

  it("answers the greeting and the starter suggestions to an eligible seller", async () => {
    eligibleForStoreAgent.mockResolvedValue(true);
    const result = await action.run({} as MobileInput, auth);
    expect((result as { status: number }).status).toBe(200);
    expect(body(result)).toEqual({
      success: true,
      enabled: true,
      greeting: "Hi! Ask about your store, or tell me a change to make — I'll always check with you first.",
      suggestions: ["How are my sales doing?", "List my products", "Create a 20% off code called LAUNCH"],
    });
    expect(eligibleForStoreAgent).toHaveBeenCalledWith(auth.owner, false);
  });

  it("refuses a seller who has not earned the agent with a 403 that halts the chain", async () => {
    eligibleForStoreAgent.mockResolvedValue(false);
    const result = await action.run({} as MobileInput, auth);
    expect(result).toMatchObject({ status: 403, rescued: true });
    expect(body(result)).toEqual({ success: false, error: "You don't have access to the store agent." });
  });

  it("skips the eligibility bar in development", async () => {
    railsEnv.mockReturnValue("development");
    eligibleForStoreAgent.mockResolvedValue(true);
    await action.run({} as MobileInput, auth);
    expect(eligibleForStoreAgent).toHaveBeenCalledWith(auth.owner, true);
  });
});
