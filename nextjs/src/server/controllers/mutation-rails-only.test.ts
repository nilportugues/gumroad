import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  forwardToRails: vi.fn(),
  processAction: vi.fn(),
  run: vi.fn(),
}));

vi.mock("./application-controller.ts", async (original) => ({
  ...(await original<typeof import("./application-controller.ts")>()),
  forwardToRails: mocks.forwardToRails,
  processAction: mocks.processAction,
}));

// The counter itself is covered by rack-attack.test.ts; here no rule applies.
vi.mock("./rack-attack.ts", () => ({
  countRackAttack: vi.fn().mockResolvedValue(null),
  uncountRackAttack: vi.fn().mockResolvedValue(undefined),
}));

import { PAGE_URL_HEADER } from "../page-props/render-state.ts";

import { mutationResponse, registerMutations } from "./mutation.ts";

// A request the proxy rewrote to /gr-mutation: the original URL travels in PAGE_URL_HEADER.
const rewritten = (method: string, pathname: string) =>
  new Request("http://localhost/gr-mutation", {
    method,
    headers: { [PAGE_URL_HEADER]: pathname, host: "app.example.com" },
    body: method === "GET" ? undefined : "a=1",
  });

describe("mutationResponse", () => {
  beforeEach(() => {
    mocks.forwardToRails.mockReset().mockResolvedValue(new Response("rails", { status: 200 }));
    mocks.processAction.mockReset().mockResolvedValue(new Response("node", { status: 200 }));
  });

  it("hands a spec marked railsOnly to Rails whole", async () => {
    registerMutations({
      method: "GET",
      pattern: "/throttled-example",
      skipForgeryProtection: true,
      railsOnly: "example/ip",
      run: mocks.run,
    });
    const response = await mutationResponse(rewritten("GET", "/throttled-example"));
    expect(await response.text()).toBe("rails");
    expect(mocks.forwardToRails).toHaveBeenCalledTimes(1);
    expect(mocks.processAction).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("runs a spec that is not marked railsOnly in Node", async () => {
    registerMutations({ method: "GET", pattern: "/unthrottled-example", skipForgeryProtection: true, run: mocks.run });
    const response = await mutationResponse(rewritten("GET", "/unthrottled-example"));
    expect(await response.text()).toBe("node");
    expect(mocks.processAction).toHaveBeenCalledTimes(1);
    expect(mocks.forwardToRails).not.toHaveBeenCalled();
  });
});
