import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentRequest } from "../../models/concerns/paper-trail.ts";

import { mcp, mcpPaperTrailRequest } from "./ws17c-mcp.ts";

// PaperTrail is off in the request specs, so the replay cannot prove that the tools write versions with the request's ip, path and id.
// This pins what the replay cannot: the request a tool body runs under carries them, as the REST controllers' `withVersions` does.
const mocks = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: vi.fn().mockResolvedValue(false) }));
vi.mock("../../mcp/protocol-telemetry.ts", () => ({ recordProtocolTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../mcp/server.ts", () => ({
  rpcHttpStatus: () => 200,
  RpcSession: class {
    counts = {};
    protocolEra = null;
    async handle() {
      mocks.seen.push(currentRequest());
      return { jsonrpc: "2.0", id: 1, result: {} };
    }
  },
}));

const call = (headers: Record<string, string>, path = "/muse/v1/mcp") =>
  ({
    request: { method: "POST", path, headers: new Headers(headers) },
    rawBody: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" })),
    url: new URL(`https://app.example.com${path}`),
    owner: { id: 1n },
    token: { scopes: "edit_products" },
  }) as never;

beforeEach(() => {
  mocks.seen.length = 0;
});

describe("mcp paper trail request", () => {
  it("runs the tool call with the request's ip, path and id and no whodunnit", async () => {
    await mcp(call({ "x-forwarded-for": "203.0.113.9", "x-request-id": "req-1" }));

    expect(mocks.seen).toEqual([
      {
        whodunnit: null,
        controllerInfo: { remote_ip: "203.0.113.9", request_path: "/muse/v1/mcp", request_uuid: "req-1" },
      },
    ]);
  });

  it("draws an id when the request has none, and leaves the context after the call", async () => {
    await mcp(call({ "x-forwarded-for": "203.0.113.9" }, "/claude/v1/mcp"));

    const [seen] = mocks.seen as { controllerInfo: Record<string, string> }[];
    expect(seen!.controllerInfo.request_uuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(seen!.controllerInfo.request_path).toBe("/claude/v1/mcp");
    expect(currentRequest()).toEqual({});
  });

  it("takes the last public address of the forwarded chain as Rails' remote_ip does", () => {
    const request = { path: "/muse/v1/mcp", headers: new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.2" }) };

    expect(mcpPaperTrailRequest(request as never).controllerInfo?.remote_ip).toBe("198.51.100.4");
  });
});
