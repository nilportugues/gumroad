// Mcp::Server's protocol constants, kept apart from server.ts so protocol-telemetry.ts can read them without an import cycle.
export const LEGACY_PROTOCOL_VERSION = "2025-03-26";
// A client on this revision declares its version per request and never handshakes.
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_VERSIONS = [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION];
export const VERSION_HEADER = "MCP-Protocol-Version";
export const METHOD_HEADER = "Mcp-Method";
export const NAME_HEADER = "Mcp-Name";
export const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
// Feature.active?(:mcp_protocol_2026_07_28): the modern lane ships behind this flag.
export const MCP_PROTOCOL_FLAG = "mcp_protocol_2026_07_28";
// Reserved for the modern transport; the legacy -32000..-32019 sub-range is not extended.
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
