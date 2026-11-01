// The EsClient actions the indexing code calls, with elasticsearch-api 7.11.2's paths, methods
// and query params.
import { esJson, type JsonValue } from "./es-json.ts";
import { type EsResponse, isNotFound, perform } from "./transport.ts";

// Utils.__escape is CGI.escape: everything but [A-Za-z0-9_.~-] percent-encoded, space as "+".
export function cgiEscape(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/u.test(ch)) out += ch;
    else if (ch === " ") out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const segment = (value: string | number | bigint) => cgiEscape(String(value));

export type DocumentId = string | number | bigint;

export function indexDocument(params: { index: string; id: DocumentId; body: JsonValue; ignore?: readonly number[] }): Promise<EsResponse> {
  return perform({
    method: "PUT",
    path: `/${segment(params.index)}/_doc/${segment(params.id)}`,
    body: esJson(params.body),
    ...(params.ignore ? { ignore: params.ignore } : {}),
  });
}

export function updateDocument(params: { index: string; id: DocumentId; body: JsonValue; ignore?: readonly number[] }): Promise<EsResponse> {
  return perform({
    method: "POST",
    path: `/${segment(params.index)}/_update/${segment(params.id)}`,
    body: esJson(params.body),
    ...(params.ignore ? { ignore: params.ignore } : {}),
  });
}

export function deleteDocument(params: { index: string; id: DocumentId; ignore?: readonly number[] }): Promise<EsResponse> {
  return perform({ method: "DELETE", path: `/${segment(params.index)}/_doc/${segment(params.id)}`, ...(params.ignore ? { ignore: params.ignore } : {}) });
}

export function updateByQuery(params: { index: string; body: JsonValue }): Promise<EsResponse> {
  return perform({ method: "POST", path: `/${segment(params.index)}/_update_by_query`, body: esJson(params.body) });
}

// `search(index:, scroll:, size:, sort:, _source:, body:)`: list params are comma-joined.
export function search(params: { index: string; body: JsonValue; scroll?: string; size?: number; sort?: string[]; source?: boolean }): Promise<EsResponse> {
  const query: Record<string, string> = {};
  if (params.scroll !== undefined) query.scroll = params.scroll;
  if (params.size !== undefined) query.size = String(params.size);
  if (params.sort !== undefined) query.sort = params.sort.join(",");
  if (params.source !== undefined) query._source = String(params.source);
  return perform({ method: "POST", path: `/${segment(params.index)}/_search`, query, body: esJson(params.body) });
}

// `count(index:, terminate_after:, body:)`: terminate_after goes in the query string.
export function count(params: { index: string; body: JsonValue; terminateAfter?: number }): Promise<EsResponse> {
  const query: Record<string, string> = {};
  if (params.terminateAfter !== undefined) query.terminate_after = String(params.terminateAfter);
  return perform({ method: "POST", path: `/${segment(params.index)}/_count`, query, body: esJson(params.body) });
}

// `scroll(index:, body: { scroll_id: }, scroll:)`: the index is not part of the 7.x path.
export function scroll(params: { scrollId: string; scroll: string }): Promise<EsResponse> {
  return perform({ method: "POST", path: "/_search/scroll", query: { scroll: params.scroll }, body: esJson({ scroll_id: params.scrollId }) });
}

export function clearScroll(scrollId: string | null): Promise<EsResponse> {
  return perform({ method: "DELETE", path: scrollId === null ? "/_search/scroll" : `/_search/scroll/${segment(scrollId)}` });
}

// `indices.exists?`: HEAD, and a 404 is `false` rather than an error.
export async function indicesExists(index: string): Promise<boolean> {
  try {
    await perform({ method: "HEAD", path: `/${segment(index)}` });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// `bulk(index:, body: [...])` with `{ index: { _id:, data: } }` entries, as Model.import sends
// them: the action line, then the document.
export function bulkIndex(params: { index: string; documents: { id: DocumentId; body: JsonValue }[] }): Promise<EsResponse> {
  const lines = params.documents.flatMap(({ id, body }) => [esJson({ index: { _id: id } }), esJson(body)]);
  return perform({ method: "POST", path: `/${segment(params.index)}/_bulk`, body: `${lines.join("\n")}\n`, ndjson: true });
}
