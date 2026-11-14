// Port of app/services/mcp/server.rb: the JSON-RPC layer of the MCP endpoint (revision negotiation, header checks, batches,
// envelopes, initialize, ping, server/discover, tools/list and the argument checks of tools/call).
// A valid tools/call runs here only for the tools in ./tool-bodies.ts; the rest read and write the seller's store and hand back to Rails.
import { HandBackToRails } from "../controllers/application-controller.ts";

import {
  HEADER_MISMATCH,
  LEGACY_PROTOCOL_VERSION,
  METHOD_HEADER,
  MODERN_PROTOCOL_VERSION,
  NAME_HEADER,
  SERVER_ERROR,
  SERVER_INFO_META_KEY,
  SUPPORTED_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
  VERSION_HEADER,
  VERSION_META_KEY,
} from "./constants.ts";
import { protocolBucket } from "./protocol-telemetry.ts";
import { ScopeError, toolBody, ToolError, toolText, ToolRpcError, type ToolContext } from "./tool-bodies.ts";
import { findTool, TOOLS, toolArgumentError } from "./tools.ts";

const TRANSPORT_ERROR_CODES = [HEADER_MISMATCH, UNSUPPORTED_PROTOCOL_VERSION];
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
// A caller only ever sees their own store, so no tools/list result is shareable between callers.
const TOOLS_LIST_CACHE = { ttlMs: 0, cacheScope: "private" };
// Nothing in it is caller-specific, but its versions follow the flag, so it is never fresh.
const DISCOVER_CACHE = { ttlMs: 0, cacheScope: "public" };
export const INSTRUCTIONS =
  "Use these tools for a connected creator's own store: products, sales, and payouts. search_products also searches the rest of Gumroad's catalogue. Confirm with the person before publishing or unpublishing. Buyers still check out on the product URL. This server does not take payment.";
const SERVER_INFO = { name: "gumroad", title: "Gumroad", version: "1.0.0" };

type Hash = Record<string, unknown>;
export type RpcReply = Record<string, unknown>;

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const isHash = (value: unknown): value is Hash =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// String#presence: a blank header is no header.
const presence = (value: string | null): string | null => (value === null || value.trim() === "" ? null : value);

// The notification and error rules of JSON-RPC 2.0, with this endpoint's id type: a string or an integer.
// A JSON number with a fraction is refused in the controller before parsing, so Number.isInteger is exact here.
const validId = (id: unknown): id is string | number => typeof id === "string" || Number.isInteger(id);

export function rpcError(id: unknown, message: string, code: number, data?: unknown): RpcReply {
  const error: Hash = { code, message };
  if (data !== undefined && data !== null) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

// The declared version of a request's `params._meta` or top-level `_meta`. Rails compares these with `to_s`, so a non-string
// declaration is left to Rails.
function declaredVersion(container: unknown): string | null {
  const meta = isHash(container) ? container._meta : undefined;
  if (!isHash(meta)) return null;
  const value = meta[VERSION_META_KEY];
  if (value === undefined || value === null || value === false) return null;
  if (typeof value === "string") return presence(value);
  throw new HandBackToRails("a protocol version that is not a string");
}

function isClientResponse(body: Hash): boolean {
  if ("method" in body || "params" in body || !validId(body.id)) return false;
  // Exactly one of result and error (XOR).
  if ("result" in body === "error" in body) return false;
  if ("result" in body) return isHash(body.result);
  const error = body.error;
  return isHash(error) && Number.isInteger(error.code) && typeof error.message === "string";
}

export type InsufficientScope = { scope: string; message: string };

export type RpcHeaders = { protocolVersion: string | null; method: string | null; name: string | null };

// One HTTP request. `modernServed` is Feature.active?(:mcp_protocol_2026_07_28), asked only when a request declares a version.
export class RpcSession {
  readonly counts = new Map<string, number>();
  private era: "legacy" | "modern" = "legacy";
  private batch = false;
  private stepUp: InsufficientScope | null = null;
  private modern: boolean | undefined;

  constructor(
    private readonly headers: RpcHeaders,
    private readonly modernServed: () => Promise<boolean>,
    private readonly tools?: ToolContext,
  ) {}

  // The scope failure of this request, for the controller's RFC 6750 challenge (Mcp::Server#insufficient_scope).
  get insufficientScope(): InsufficientScope | null {
    return this.stepUp;
  }

  get protocolEra(): "legacy" | "modern" {
    return this.era;
  }

  // Returns the JSON-RPC reply for the body, or null when nothing is answered (notifications and client replies only).
  async handle(body: unknown): Promise<RpcReply | RpcReply[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) return rpcError(null, "Invalid Request", INVALID_REQUEST);
      // A batch gets no scope challenge (see the Rails comment), so the batch flag only matters to tools, which hand back.
      this.batch = true;
      const replies: RpcReply[] = [];
      for (const message of body) {
        const reply = await this.handleMessage(message);
        if (reply !== null) replies.push(reply);
      }
      return replies.length > 0 ? replies : null;
    }
    return this.handleMessage(body);
  }

  private async supportedVersions(): Promise<string[]> {
    this.modern ??= await this.modernServed();
    return this.modern ? SUPPORTED_VERSIONS : [LEGACY_PROTOCOL_VERSION];
  }

  private async handleMessage(body: unknown): Promise<RpcReply | null> {
    if (!isHash(body)) return rpcError(null, "Invalid Request", INVALID_REQUEST);

    const id = validId(body.id) ? body.id : null;
    let notification = false;
    try {
      // A version error is a transport error and is answered even for a notification.
      await this.resolveEra(body);
      if (body.jsonrpc !== "2.0") return rpcError(id, "Invalid Request", INVALID_REQUEST);
      // No server requests are issued, so an unsolicited client reply needs no dispatch and no response.
      if (isClientResponse(body)) return null;
      if (
        !(
          typeof body.method === "string" &&
          (!("id" in body) || validId(body.id)) &&
          !("result" in body) &&
          !("error" in body)
        )
      ) {
        return rpcError(id, "Invalid Request", INVALID_REQUEST);
      }

      notification = !("id" in body);
      const method = body.method;
      const params = "params" in body ? body.params : {};
      if (!isHash(params)) throw new McpError("params must be an object", INVALID_PARAMS);
      this.validateModernTransport(method, params);

      const result = await this.dispatch(method, params);
      return notification ? null : this.envelope(id, result);
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      if (TRANSPORT_ERROR_CODES.includes(error.code)) return rpcError(id, error.message, error.code, error.data);
      return notification ? null : rpcError(id, error.message, error.code, error.data);
    }
  }

  // Era is per request: an undeclared request is legacy. The 2026-07-28 schema declares the version in `params._meta`; a top-level
  // `_meta` is still honoured. The header must agree with the declaration; a header alone stays legacy.
  private async resolveEra(body: Hash): Promise<void> {
    const nested = declaredVersion(body.params);
    const topLevel = declaredVersion(body);
    const declared = nested ?? topLevel;
    // Counted before the checks below, so a client on a revision we do not serve yet still shows in the mix.
    const bucket = protocolBucket(declared, body.method);
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
    if (declared === null) return;

    if (nested !== null && topLevel !== null && nested !== topLevel) {
      throw new McpError(`_meta ${VERSION_META_KEY} must not differ between params and the request`, HEADER_MISMATCH, {
        declared: nested,
        top_level: topLevel,
      });
    }
    const header = presence(this.headers.protocolVersion);
    if (header === null || declared !== header) {
      throw new McpError(`${VERSION_HEADER} and _meta ${VERSION_META_KEY} must agree`, HEADER_MISMATCH, {
        header,
        declared,
      });
    }
    const supported = await this.supportedVersions();
    if (!supported.includes(declared)) {
      throw new McpError(`Unsupported protocol version: ${declared}`, UNSUPPORTED_PROTOCOL_VERSION, {
        supported,
        requested: declared,
      });
    }
    if (declared === MODERN_PROTOCOL_VERSION) this.era = "modern";
  }

  private validateModernTransport(method: string, params: Hash): void {
    if (this.era !== "modern") return;
    if (presence(this.headers.method) !== method) {
      throw new McpError(`${METHOD_HEADER} must repeat the request method`, HEADER_MISMATCH, {
        header: this.headers.method,
        method,
      });
    }
    if (method !== "tools/call") return;
    const name = params.name ?? null;
    if (presence(this.headers.name) === null || this.headers.name !== name) {
      throw new McpError(`${NAME_HEADER} must repeat the tool name`, HEADER_MISMATCH, {
        header: this.headers.name,
        name,
      });
    }
  }

  // The removed handshake and ping are not methods of the modern revision.
  private async dispatch(method: string, params: Hash): Promise<Hash | null> {
    if (this.era === "modern") {
      switch (method) {
        case "server/discover":
          return this.discoverResult();
        case "tools/list":
          return { tools: TOOLS, ...TOOLS_LIST_CACHE };
        case "tools/call":
          return await this.callTool(params);
        default:
          throw new McpError(`Method not found: ${method}`, METHOD_NOT_FOUND);
      }
    }
    switch (method) {
      case "initialize":
        return this.initializeResult();
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return await this.callTool(params);
      default:
        throw new McpError(`Method not found: ${method}`, METHOD_NOT_FOUND);
    }
  }

  private envelope(id: string | number | null, result: Hash | null): RpcReply {
    const merged = this.era === "modern" && result !== null ? { ...result, resultType: "complete" } : result;
    return { jsonrpc: "2.0", id, result: merged };
  }

  private async discoverResult(): Promise<Hash> {
    return {
      supportedVersions: await this.supportedVersions(),
      capabilities: { tools: { listChanged: false } },
      _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO },
      instructions: INSTRUCTIONS,
      ...DISCOVER_CACHE,
    };
  }

  private initializeResult(): Hash {
    return {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    };
  }

  // The argument checks run here so a bad call is answered without Rails; a valid call runs the tool here when it is ported.
  private async callTool(params: Hash): Promise<Hash> {
    const name = params.name;
    if (typeof name !== "string") throw new HandBackToRails("a tool name that is not a string");
    const definition = findTool(name);
    if (definition === undefined) throw new McpError(`Unknown tool: ${name}`, INVALID_PARAMS);
    const args = "arguments" in params ? params.arguments : {};
    if (!isHash(args)) throw new McpError("arguments must be an object", INVALID_PARAMS);
    const failure = toolArgumentError(definition.inputSchema, args);
    if (failure !== null) throw new McpError(failure, INVALID_PARAMS);
    if (this.tools === undefined) throw new HandBackToRails("an MCP tool call");
    let payload: Hash | undefined;
    try {
      payload = await toolBody(name, args, this.tools);
    } catch (error) {
      if (error instanceof ToolRpcError) throw new McpError(error.message, error.code);
      if (error instanceof ScopeError) {
        // A batch gets a plain error: a step-up would fail the other calls in it.
        if (!this.batch && error.scope !== null) this.stepUp = { scope: error.scope, message: error.message };
        throw new McpError(error.message, SERVER_ERROR);
      }
      if (error instanceof ToolError) return { content: [{ type: "text", text: error.message }], isError: true };
      throw error;
    }
    if (payload === undefined) throw new HandBackToRails("an MCP tool call");
    return {
      content: [{ type: "text", text: toolText(payload) }],
      structuredContent: JSON.parse(JSON.stringify(payload)) as Hash,
    };
  }
}

// Api::V2::McpController#rpc_http_status
export function rpcHttpStatus(result: unknown, era: "legacy" | "modern"): number {
  if (!isHash(result) || !isHash(result.error)) return 200;
  switch (result.error.code) {
    case -32700:
    case INVALID_REQUEST:
    case HEADER_MISMATCH:
    case UNSUPPORTED_PROTOCOL_VERSION:
      return 400;
    // Only a modern client is told at the transport level that the method does not exist.
    case METHOD_NOT_FOUND:
      return era === "modern" ? 404 : 200;
    default:
      return 200;
  }
}
