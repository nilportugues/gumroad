// Faraday's query encoding, which OmniAuth's OAuth2 strategies and the oauth2 gem build authorize URLs, token bodies and parameters with.
// Faraday::Utils.escape: everything but letters, digits and ". ~ _ -" is percent-encoded byte by byte, and a space is a plus.
export function faradayEscape(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[a-zA-Z0-9.~_-]/u.test(char)) return char;
      return char === " " ? "+" : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

// Faraday's NestedParamsEncoder sorts the keys; a nil value is written as the bare key.
export function faradayQuery(params: Record<string, string | null>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => (value === null ? faradayEscape(key) : `${faradayEscape(key)}=${faradayEscape(value)}`))
    .join("&");
}
