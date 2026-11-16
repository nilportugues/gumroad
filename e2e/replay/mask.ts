// The documented mask of known-volatile values. Two servers (or two runs of one) never agree on these, so replay
// hashes bodies after masking and the diff compares paths and Location headers after masking. Every rule is listed
// in MASK_RULES; e2e/README.md describes them for humans. Add a rule here, never a per-run exception.

export const MASK_PLACEHOLDER = "<masked>";

type Rule = { name: string; pattern: RegExp; replace: string };

// JSON appears raw in API responses and HTML-escaped (&quot;) inside the Inertia `data-page` attribute.
const QUOTE = String.raw`(?:"|&quot;)`;

export const MASK_RULES: Rule[] = [
  {
    name: "csrf-meta",
    pattern: /(<meta\s+name="csrf-token"\s+content=")[^"]*(")/giu,
    replace: `$1${MASK_PLACEHOLDER}$2`,
  },
  {
    name: "csrf-form-field",
    pattern: /(name="authenticity_token"\s+value=")[^"]*(")/giu,
    replace: `$1${MASK_PLACEHOLDER}$2`,
  },
  {
    // csrf_token, authenticity_token, nonce, token, *_token inside JSON.
    name: "token-keys",
    pattern: new RegExp(`(${QUOTE}(?:[a-z_]*token|nonce)${QUOTE}\\s*:\\s*${QUOTE})[^"&]*(${QUOTE})`, "giu"),
    replace: `$1${MASK_PLACEHOLDER}$2`,
  },
  {
    // ISO 8601 with a time part, optionally fractional and zoned.
    name: "iso-timestamp",
    pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu,
    replace: MASK_PLACEHOLDER,
  },
  {
    // "id": 12, "product_id": "abc", "external_id": "xyz": generated per server.
    name: "id-keys",
    pattern: new RegExp(`(${QUOTE}(?:[a-z_]*_id|id)${QUOTE}\\s*:\\s*)(?:${QUOTE}[^"&]*${QUOTE}|\\d+)`, "giu"),
    replace: `$1${MASK_PLACEHOLDER}`,
  },
];

export const maskBody = (text: string) =>
  MASK_RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replace), text);

const VOLATILE_QUERY_KEYS = new Set(["_", "t", "ts", "timestamp", "token", "authenticity_token", "nonce"]);
const NUMERIC_SEGMENT = /^\d+$/u;
// Permalinks are short and meaningful (`/l/demo`); generated ids and signed tokens are long and opaque.
const OPAQUE_SEGMENT = /^(?=[\w-]*\d)[\w-]{20,}$/u;

/** Masks numeric and opaque path segments and volatile query values, keeping everything else (so `/l/demo` stays). */
export const maskPath = (pathAndQuery: string) => {
  const [pathname = "", query] = pathAndQuery.split("?", 2);
  const path = pathname
    .split("/")
    .map((segment) => (NUMERIC_SEGMENT.test(segment) || OPAQUE_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
  if (query === undefined) return path;
  const params = query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [key = "", value] = pair.split("=", 2);
      return value !== undefined && VOLATILE_QUERY_KEYS.has(key.toLowerCase()) ? `${key}=${MASK_PLACEHOLDER}` : pair;
    });
  return params.length > 0 ? `${path}?${params.join("&")}` : path;
};

/** A Location header may be absolute (other port, other host) or relative; compare only the masked path. */
export const maskLocation = (location: string) => {
  try {
    const url = new URL(location, "http://placeholder.invalid");
    return maskPath(`${url.pathname}${url.search}`);
  } catch {
    return location;
  }
};
