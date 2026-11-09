import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./constants.ts";
import { protocolBucket, recordProtocolTelemetry } from "./protocol-telemetry.ts";
import { RpcSession, rpcHttpStatus, type RpcHeaders } from "./server.ts";
import { TOOLS, toolArgumentError } from "./tools.ts";

// The legacy bodies are copied from spec/requests/mcp_server_spec.rb (legacy_initialize_body, legacy_tools_body): what Rails sends.
const golden = (name: string) => readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf8");

const NO_HEADERS: RpcHeaders = { protocolVersion: null, method: null, name: null };

const session = (headers: Partial<RpcHeaders> = {}, modernServed = false) =>
  new RpcSession({ ...NO_HEADERS, ...headers }, async () => modernServed);

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: "tool", method: "tools/call", params: { name, arguments: args } });

const modern = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } },
});

const modernHeaders = (method: string, name: string | null = null): Partial<RpcHeaders> => ({
  protocolVersion: MODERN_PROTOCOL_VERSION,
  method,
  name,
});

describe("legacy wire bytes", () => {
  it("answers initialize with the bytes Rails sends", async () => {
    const reply = await session().handle({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(JSON.stringify(reply)).toBe(golden("legacy-initialize.golden.json"));
  });

  it("answers tools/list with the bytes Rails sends", async () => {
    const reply = await session().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(JSON.stringify(reply)).toBe(golden("legacy-tools-list.golden.json"));
  });

  it("keeps the version header alone as a legacy request", async () => {
    const reply = await session({ protocolVersion: LEGACY_PROTOCOL_VERSION }).handle({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(JSON.stringify(reply)).toBe(golden("legacy-initialize.golden.json"));
  });

  it("treats a revision declared only in the header as undeclared", async () => {
    const reply = await session({ protocolVersion: MODERN_PROTOCOL_VERSION }).handle({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(JSON.stringify(reply)).toBe(golden("legacy-initialize.golden.json"));
  });
});

describe("JSON-RPC messages", () => {
  it("answers ping with an empty result", async () => {
    expect(await session().handle({ jsonrpc: "2.0", id: "ok", method: "ping" })).toEqual({ jsonrpc: "2.0", id: "ok", result: {} });
  });

  it.each(["ping", "tools/list", "unknown_notification"])("does not reply to the %s notification", async (method) => {
    expect(await session().handle({ jsonrpc: "2.0", method })).toBeNull();
  });

  it("answers a missing method with -32601 under the request ID", async () => {
    expect(await session().handle({ jsonrpc: "2.0", id: 0, method: "resources/list" })).toEqual({
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32601, message: "Method not found: resources/list" },
    });
  });

  it("reports a tool call with non-object params as -32602", async () => {
    expect(await session().handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: [] })).toMatchObject({ id: 9, error: { code: -32602 } });
  });

  it("answers nothing to an unsolicited client response", async () => {
    expect(await session().handle({ jsonrpc: "2.0", id: "client", result: {} })).toBeNull();
    expect(await session().handle({ jsonrpc: "2.0", id: "client", error: { code: -32601, message: "Unknown method" } })).toBeNull();
  });

  it("rejects a malformed client response", async () => {
    expect(await session().handle({ jsonrpc: "2.0", id: "client", result: [] })).toMatchObject({ id: "client", error: { code: -32600 } });
    expect(await session().handle({ jsonrpc: "2.0", id: "client", error: { code: "bad", message: "No" } })).toMatchObject({ error: { code: -32600 } });
  });

  it.each([[], {}, null, true, 42, "ping"])("reports %j as an invalid request with a null id", async (body) => {
    expect(await session().handle(body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  });

  it.each([1.5, null, true, {}, []])("refuses the invalid ID %j before dispatching", async (id) => {
    expect(await session().handle({ jsonrpc: "2.0", id, method: "ping" })).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it.each([{ jsonrpc: null }, { jsonrpc: "1.0" }, { method: null }, { method: 12 }, { result: {} }, { error: { code: -1, message: "no" } }])(
    "rejects the envelope %j",
    async (invalid) => {
      expect(await session().handle({ ...toolCall("unpublish_product", { id: "x" }), ...invalid })).toMatchObject({ error: { code: -32600 } });
    },
  );

  it("rejects params that are not an object", async () => {
    expect(await session().handle({ jsonrpc: "2.0", id: 3, method: "ping", params: null })).toMatchObject({ error: { code: -32602 } });
  });

  it("answers each message of a batch under its own ID and leaves notifications out", async () => {
    const replies = await session().handle([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "ok", method: "ping" },
      toolCall("unknown_tool"),
      12,
      [],
      {},
      { jsonrpc: "2.0", method: "unknown_notification" },
    ]);

    expect(replies).toEqual([
      { jsonrpc: "2.0", id: "ok", result: {} },
      { jsonrpc: "2.0", id: "tool", error: { code: -32602, message: "Unknown tool: unknown_tool" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    ]);
  });

  it("answers a batch of notifications with nothing", async () => {
    expect(await session().handle([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "ping" }])).toBeNull();
  });

  it("answers an empty batch with one invalid request", async () => {
    expect(await session().handle([])).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  });
});

describe("tools/call before the tool runs", () => {
  it.each([
    [{ name: "nope" }, "Unknown tool: nope"],
    [{ name: "list_sales", arguments: [] }, "arguments must be an object"],
    [{ name: "list_sales", arguments: null }, "arguments must be an object"],
    [{ name: "list_products", arguments: { limit: true } }, "limit must be a integer"],
    [{ name: "list_products", arguments: { limit: "2" } }, "limit must be a integer"],
    [{ name: "list_sales", arguments: { payment: "some" } }, "payment must be one of: paid, free"],
    [{ name: "list_products", arguments: { sort: "x" } }, "Unknown argument: sort"],
    [{ name: "create_bundle", arguments: { name: "A" } }, "price_cents is required"],
    [{ name: "create_bundle", arguments: { name: "A", price_cents: 1, product_ids: "x" } }, "product_ids must be an array"],
  ])("answers %j with -32602 and the Rails message %s", async (params, message) => {
    expect(await session().handle({ jsonrpc: "2.0", id: "tool", method: "tools/call", params })).toEqual({
      jsonrpc: "2.0",
      id: "tool",
      error: { code: -32602, message },
    });
  });

  it("does not reply to a notification whose arguments are invalid", async () => {
    expect(await session().handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_products", arguments: { sort: "x" } } })).toBeNull();
  });

  // The limit range is checked by the tool, after the argument types, so 0 is valid here and Rails answers it.
  it("hands a call with an in-type but out-of-range limit back to Rails", async () => {
    await expect(session().handle(toolCall("list_products", { limit: 0 }))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a valid tool call back to Rails", async () => {
    await expect(session().handle(toolCall("list_products", { limit: 5 }))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a tool call with a name that is not a string back to Rails", async () => {
    await expect(session().handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 7 } })).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("the 2026-07-28 revision", () => {
  it("answers server/discover with the flag on", async () => {
    const reply = await session(modernHeaders("server/discover"), true).handle(modern("server/discover"));

    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        supportedVersions: [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION],
        capabilities: { tools: { listChanged: false } },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "gumroad", title: "Gumroad", version: "1.0.0" } },
        instructions: expect.stringContaining("check out on the product URL"),
        ttlMs: 0,
        cacheScope: "public",
        resultType: "complete",
      },
    });
  });

  it("adds the modern envelope to tools/list without changing the tools", async () => {
    const reply = (await session(modernHeaders("tools/list"), true).handle(modern("tools/list"))) as { result: Record<string, unknown> };

    expect(reply.result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    const tools = reply.result.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(Object.keys(tools[0]!)).toEqual(["name", "title", "description", "inputSchema", "annotations"]);
  });

  it("serves a tool call whose name header repeats the tool name up to the tool", async () => {
    const request = { ...modern("tools/call", { name: "list_sales", arguments: {} }) };
    await expect(session(modernHeaders("tools/call", "list_sales"), true).handle(request)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers initialize and ping with -32601 on the modern revision", async () => {
    for (const method of ["initialize", "ping"]) {
      const reply = await session(modernHeaders(method), true).handle(modern(method));

      expect(reply).toMatchObject({ error: { code: -32601, message: `Method not found: ${method}` } });
      expect(rpcHttpStatus(reply, "modern")).toBe(404);
    }
  });

  it("accepts a modern notification with no body", async () => {
    const request = { jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } } };

    expect(await session(modernHeaders("notifications/initialized"), true).handle(request)).toBeNull();
  });

  it("rejects a header and _meta that disagree", async () => {
    const reply = await session({ ...modernHeaders("server/discover"), protocolVersion: LEGACY_PROTOCOL_VERSION }, true).handle(modern("server/discover"));

    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32020,
        message: "MCP-Protocol-Version and _meta io.modelcontextprotocol/protocolVersion must agree",
        data: { header: LEGACY_PROTOCOL_VERSION, declared: MODERN_PROTOCOL_VERSION },
      },
    });
  });

  it("rejects a version declared only in _meta when the header is missing", async () => {
    const reply = await session({ method: "server/discover" }, true).handle(modern("server/discover"));

    expect(reply).toMatchObject({ error: { code: -32020, data: { header: null, declared: MODERN_PROTOCOL_VERSION } } });
  });

  it("rejects a modern request without the method header", async () => {
    expect(await session({ protocolVersion: MODERN_PROTOCOL_VERSION }, true).handle(modern("server/discover"))).toMatchObject({ error: { code: -32020 } });
  });

  it("rejects a modern tool call whose name header does not match", async () => {
    const reply = await session(modernHeaders("tools/call", "list_payouts"), true).handle(modern("tools/call", { name: "list_sales", arguments: {} }));

    expect(reply).toMatchObject({ error: { code: -32020, data: { header: "list_payouts", name: "list_sales" } } });
  });

  it("rejects a modern tool call with no name header", async () => {
    expect(await session(modernHeaders("tools/call"), true).handle(modern("tools/call", { name: "list_sales", arguments: {} }))).toMatchObject({
      error: { code: -32020 },
    });
  });

  it("answers a revision it does not serve with the revisions it does", async () => {
    const reply = await session({ ...modernHeaders("server/discover"), protocolVersion: "2025-11-25" }, true).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
    });

    expect(reply).toMatchObject({ error: { code: -32022, data: { supported: [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION], requested: "2025-11-25" } } });
  });

  it("keeps the modern revision unsupported while the flag is off", async () => {
    const reply = await session(modernHeaders("server/discover"), false).handle(modern("server/discover"));

    expect(reply).toMatchObject({ error: { code: -32022, data: { supported: [LEGACY_PROTOCOL_VERSION], requested: MODERN_PROTOCOL_VERSION } } });
    expect(rpcHttpStatus(reply, "modern")).toBe(400);
  });

  it("does not ask the flag about requests that declare no version", async () => {
    const modernServed = vi.fn(async () => true);
    await new RpcSession(NO_HEADERS, modernServed).handle({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(modernServed).not.toHaveBeenCalled();
  });
});

describe("rpcHttpStatus", () => {
  it.each([
    [{ error: { code: -32700 } }, "legacy", 400],
    [{ error: { code: -32600 } }, "legacy", 400],
    [{ error: { code: -32020 } }, "legacy", 400],
    [{ error: { code: -32022 } }, "legacy", 400],
    [{ error: { code: -32601 } }, "legacy", 200],
    [{ error: { code: -32601 } }, "modern", 404],
    [{ error: { code: -32602 } }, "modern", 200],
    [{ result: {} }, "modern", 200],
    [[{ error: { code: -32600 } }], "legacy", 200],
  ])("maps %j on the %s lane to %i", (result, era, status) => {
    expect(rpcHttpStatus(result, era as "legacy" | "modern")).toBe(status);
  });
});

describe("tool argument checks", () => {
  it("names the first missing required argument", () => {
    const definition = TOOLS.find((tool) => tool.name === "create_discount_code")!;

    expect(toolArgumentError(definition.inputSchema, { percent_off: 10 })).toBe("code is required");
  });

  it("accepts an explicit null for an argument it does not type-check", () => {
    const definition = TOOLS.find((tool) => tool.name === "update_product")!;

    expect(toolArgumentError(definition.inputSchema, { id: "x", permalink: "" })).toBeNull();
  });
});

describe("protocolBucket", () => {
  it("names an undeclared request and the methods this endpoint dispatches", () => {
    expect(protocolBucket(null, "tools/list")).toBe("undeclared|tools/list");
  });

  it("keeps the revisions it serves and collapses anything else", () => {
    expect(protocolBucket(MODERN_PROTOCOL_VERSION, "server/discover")).toBe("2026-07-28|server/discover");
    expect(protocolBucket("2099-01-01", "ping")).toBe("other|ping");
    expect(protocolBucket("2025-06-18", "made/up")).toBe("2025-06-18|other");
  });
});

describe("recordProtocolTelemetry", () => {
  const now = new Date("2026-11-09T12:00:00Z");

  it("increments each bucket of a connector in one script call on the UTC day", async () => {
    const redis = { eval: vi.fn(async () => 1) };

    await recordProtocolTelemetry("muse", new Map([["undeclared|ping", 2]]), redis as never, now);

    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("HINCRBY"), 1, "mcp:protocol_requests:2026-11-09", "7776000", "muse|undeclared|ping", "2");
  });

  it.each([
    ["an unknown connector", "elsewhere", new Map([["undeclared|ping", 1]])],
    ["no connector", null, new Map([["undeclared|ping", 1]])],
    ["no counts", "claude", new Map<string, number>()],
  ])("writes nothing for %s", async (_name, connector, counts) => {
    const redis = { eval: vi.fn(async () => 1) };

    await recordProtocolTelemetry(connector, counts, redis as never, now);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("swallows a Redis failure", async () => {
    const redis = {
      eval: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordProtocolTelemetry("chatgpt", new Map([["undeclared|ping", 1]]), redis as never, now)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("mcp_protocol_telemetry_failed Error");
    warn.mockRestore();
  });
});

describe("counts", () => {
  it("counts one bucket per message and leaves non-object messages out", async () => {
    const s = session();
    await s.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }, 12]);

    expect(Object.fromEntries(s.counts)).toEqual({ "undeclared|ping": 2 });
  });
});
