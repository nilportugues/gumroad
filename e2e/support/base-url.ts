export const DEFAULT_BASE_URL = "http://localhost:3001";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export const isSafeHost = (hostname: string) => {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  // `example.<tld>` or `<anything>.example.<tld>` only: the reserved label must sit directly left of the TLD.
  const labels = host.split(".");
  return labels.length >= 2 && labels[labels.length - 2] === "example";
};

/** Returns a normalized origin or throws. Never allows a non-local, non-example host, so the suite cannot hit production. */
export const resolveBaseUrl = (raw: string | undefined = process.env.BASE_URL): string => {
  const value = raw?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`BASE_URL "${value}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`BASE_URL "${value}" must use http or https.`);
  }
  if (!isSafeHost(url.hostname)) {
    throw new Error(
      `Refusing to run: BASE_URL host "${url.hostname}" is not localhost, 127.0.0.1, *.localhost or an example.* domain. ` +
        "The e2e suite and bot create real records and must only target a local app.",
    );
  }
  return url.origin;
};
