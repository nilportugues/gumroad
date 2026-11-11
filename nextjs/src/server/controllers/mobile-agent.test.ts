import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, eligibleForStoreAgent, railsEnv, latestConversation, turnStatus } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  eligibleForStoreAgent: vi.fn(),
  railsEnv: vi.fn(() => "test"),
  latestConversation: vi.fn(),
  turnStatus: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../page-props/signed-in/policy-props.ts", () => ({ eligibleForStoreAgent }));
vi.mock("../infra/rails-env.ts", () => ({ railsEnv }));
vi.mock("./internal-agent.ts", () => ({ latestConversation, turnStatus }));

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
    expect(actions).toHaveLength(6);
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

describe("the other mobile agent routes", () => {
  const route = (method: string, pattern: string) =>
    actions.find((registered) => registered.method === method && registered.pattern === pattern)!;

  it("reads the latest conversation of an eligible seller, hiding claimed actions", async () => {
    eligibleForStoreAgent.mockResolvedValue(true);
    latestConversation.mockResolvedValue({ status: 200 });
    const result = await route("GET", "/mobile/agent/conversations/latest").run({} as MobileInput, auth);
    expect(result).toEqual({ status: 200 });
    expect(latestConversation).toHaveBeenCalledWith(7n, true);
  });

  it("reads a turn's status for an eligible seller, hiding claimed actions", async () => {
    eligibleForStoreAgent.mockResolvedValue(true);
    turnStatus.mockResolvedValue({ status: 200 });
    await route("GET", "/mobile/agent/turns/:client_turn_id").run(
      { routeParams: { client_turn_id: "abc-1" } } as unknown as MobileInput,
      auth,
    );
    expect(turnStatus).toHaveBeenCalledWith(7n, "abc-1", true);
  });

  it("refuses the reads of a seller who has not earned the agent", async () => {
    eligibleForStoreAgent.mockResolvedValue(false);
    const result = await route("GET", "/mobile/agent/conversations/latest").run({} as MobileInput, auth);
    expect(result).toMatchObject({ status: 403, rescued: true });
  });

  it("hands a turn of an eligible seller back to Rails", async () => {
    eligibleForStoreAgent.mockResolvedValue(true);
    await expect(route("POST", "/mobile/agent/messages").run({} as MobileInput, auth)).rejects.toThrow("an agent turn");
    await expect(route("POST", "/mobile/agent/messages/stream").run({} as MobileInput, auth)).rejects.toThrow(
      "a streamed agent turn",
    );
    await expect(route("POST", "/mobile/agent/actions").run({} as MobileInput, auth)).rejects.toThrow(
      "a confirmed agent action",
    );
  });

  it("refuses a turn of a seller who has not earned the agent before handing anything back", async () => {
    eligibleForStoreAgent.mockResolvedValue(false);
    const result = await route("POST", "/mobile/agent/messages").run({} as MobileInput, auth);
    expect(result).toMatchObject({ status: 403, rescued: true });
  });
});
