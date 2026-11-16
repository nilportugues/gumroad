// `URI.open(url).read` for an http(s) URL, as open-uri 0.5 (Ruby 3.4) does it: redirects (301, 302, 303,
// 307, 308) are followed with the loop and scheme checks of OpenURI.open_loop, any other non-2xx status
// raises OpenURI::HTTPError with "<code> <reason>". Golden: worker/jobs/__fixtures__/
// update-purchasing-power-parity-factors-job.golden.json.

// Net::HTTP's open and read timeouts, 60s each.
const OPEN_URI_TIMEOUT_MS = 120_000;
// OpenURI::Options[:max_redirects]
const MAX_REDIRECTS = 64;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export class OpenUriError extends Error {
  readonly rubyClass: string;
  constructor(rubyClass: string, message: string) {
    super(message);
    this.rubyClass = rubyClass;
    this.name = rubyClass;
  }
}

// `URI.parse(location)` rejects whitespace, control characters and non-ASCII; this is the part of that
// check a Location header can trip.
const invalidLocation = (location: string | null): boolean => location === null || /[^\x21-\x7e]/u.test(location);

export async function openUriRead(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  let current = new URL(url);
  const visited = new Set<string>();
  for (;;) {
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(OPEN_URI_TIMEOUT_MS) });
    if (response.status >= 200 && response.status < 300) return new Uint8Array(await response.arrayBuffer());
    if (!REDIRECT_STATUSES.has(response.status)) throw new OpenUriError("OpenURI::HTTPError", `${response.status} ${response.statusText}`);

    const location = response.headers.get("location");
    if (invalidLocation(location)) throw new OpenUriError("OpenURI::HTTPError", `${response.status} ${response.statusText} (Invalid Location URI)`);
    const target = new URL(location!, current);
    // OpenURI.redirectable?: the scheme stays, or http moves to https
    const from = current.protocol.slice(0, -1);
    const to = target.protocol.slice(0, -1);
    if (from !== to && !(from === "http" && to === "https")) throw new Error(`redirection forbidden: ${current.href} -> ${target.href}`);
    current = target;
    if (visited.has(current.href)) throw new Error(`HTTP redirection loop: ${current.href}`);
    visited.add(current.href);
    if (visited.size > MAX_REDIRECTS) throw new OpenUriError("OpenURI::TooManyRedirects", "Too many redirects");
  }
}
