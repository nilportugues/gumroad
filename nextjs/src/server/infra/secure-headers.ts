import { randomBytes } from "node:crypto";

import { domainConfig, type DomainConfig } from "./domain.ts";
import { storageConfig, type StorageConfig } from "./storage.ts";

// Port of config/initializers/secure_headers.rb rendered the way secure_headers 7.3 renders it.
// Only source-list directives are supported, which is all the Rails config uses.

export const CSP_DIRECTIVES = [
  "base_uri",
  "child_src",
  "connect_src",
  "default_src",
  "font_src",
  "form_action",
  "frame_ancestors",
  "frame_src",
  "img_src",
  "manifest_src",
  "media_src",
  "object_src",
  "prefetch_src",
  "script_src",
  "script_src_attr",
  "script_src_elem",
  "style_src",
  "style_src_attr",
  "style_src_elem",
  "worker_src",
] as const;

export type CspDirective = (typeof CSP_DIRECTIVES)[number];
export type CspDirectives = Partial<Record<CspDirective, string[]>>;

// Fetch directives fall back to default-src when appended to while unset.
const NON_FETCH_DIRECTIVES = new Set<CspDirective>(["base_uri", "form_action", "frame_ancestors"]);

export type CspInputs = {
  domain: DomainConfig;
  storage: Pick<StorageConfig, "s3Endpoint" | "s3Bucket" | "publicStorageS3Bucket" | "fileDownloadDistributionUrl" | "hlsDistributionUrl">;
};

export function defaultCspInputs(): CspInputs {
  return { domain: domainConfig(), storage: storageConfig() };
}

export function defaultCspDirectives({ domain, storage }: CspInputs = defaultCspInputs()): CspDirectives {
  const { s3Endpoint, s3Bucket, publicStorageS3Bucket } = storage;
  const csp: Required<Pick<CspDirectives, "default_src" | "frame_src" | "worker_src" | "object_src" | "child_src" | "base_uri" | "img_src" | "font_src" | "media_src" | "connect_src" | "script_src" | "style_src">> = {
    // "https:" with the colon: a bare "https" is a host-source matching nothing.
    default_src: ["https:", "'self'"],
    frame_src: ["*", "data:", "blob:"],
    worker_src: ["'self'", "blob:"],
    object_src: ["'none'"],
    child_src: ["'self'", "blob:"],
    base_uri: ["'self'"],
    img_src: ["*", "data:", "blob:"],
    font_src: ["*", "data:", "blob:"],
    media_src: ["*", "data:", "blob:"],
    connect_src: [
      "'self'",
      "blob:",
      "www.dropbox.com",
      "api.dropboxapi.com",
      `${s3Endpoint}/${s3Bucket}`,
      `${s3Endpoint}/${s3Bucket}/`,
      `${s3Endpoint}/${publicStorageS3Bucket}`,
      `${s3Endpoint}/${publicStorageS3Bucket}/`,
      `${publicStorageS3Bucket}.s3.amazonaws.com`,
      `${publicStorageS3Bucket}.s3.amazonaws.com/`,
      `s3.amazonaws.com/${publicStorageS3Bucket}`,
      `s3.amazonaws.com/${publicStorageS3Bucket}/`,
      "www.google.com",
      "www.gstatic.com",
      "*.facebook.com",
      "*.facebook.net",
      "*.google-analytics.com",
      "*.g.doubleclick.net",
      "*.googletagmanager.com",
      "analytics.google.com",
      "*.analytics.google.com",
      "analytics.tiktok.com",
      storage.fileDownloadDistributionUrl,
      storage.hlsDistributionUrl,
      "entitlements.jwplayer.com",
      "*.braintreegateway.com",
      "www.paypalobjects.com",
      "*.paypal.com",
      "*.braintree-api.com",
      "iframe.ly",
      "iframely.net",
      "help.gumroad.com",
      "unpkg.com/@lottiefiles/lottie-player@2.0.12/",
    ],
    script_src: [
      "'self'",
      "'unsafe-eval'",
      "ajax.cloudflare.com",
      "static.cloudflareinsights.com",
      "js.stripe.com",
      "api.stripe.com",
      "*.braintreegateway.com",
      "*.braintree-api.com",
      "www.paypalobjects.com",
      "*.paypal.com",
      "*.google-analytics.com",
      "*.googletagmanager.com",
      "optimize.google.com",
      "www.googleadservices.com",
      "www.google.com",
      "www.gstatic.com",
      "*.facebook.net",
      "*.facebook.com",
      "www.dropbox.com",
      "s.ytimg.com",
      "www.google.com",
      "cdn.iframe.ly",
      "platform.twitter.com",
      "cdn.jwplayer.com",
      "*.jwpcdn.com",
      "gumroad.us3.list-manage.com",
      "analytics.twitter.com",
      "analytics.tiktok.com",
      "help.gumroad.com",
      "unpkg.com/@lottiefiles/lottie-player@2.0.12/",
    ],
    style_src: ["'self'", "'unsafe-inline'", "s.ytimg.com", "optimize.google.com", "fonts.googleapis.com"],
  };

  csp.connect_src.push(domain.domain);
  csp.script_src.push(domain.domain);
  csp.connect_src.push(`wss://${domain.anycableHost}`);

  if (domain.assetHost) {
    csp.connect_src.push(domain.assetHost);
    csp.script_src.push(domain.assetHost);
    csp.style_src.push(domain.assetHost);
    csp.worker_src.push(domain.assetHost);
  }

  if (domain.env === "test") {
    csp.default_src = ["'self'"];
    csp.style_src.push("blob:");
    const port = new URL(`${domain.protocol}://${domain.domain}`).port || (domain.protocol === "https" ? "443" : "80");
    csp.script_src.push(`test-custom-domain.gumroad.com:${port}`);
    csp.script_src.push(domain.rootDomain);
    csp.connect_src.push(`ws://${domain.anycableHost}:8080`);
    csp.connect_src.push(`wss://${domain.anycableHost}:8080`);
  } else if (domain.env === "development") {
    csp.default_src = ["'self'"];
    const vitePort = process.env.VITE_RUBY_PORT?.trim() || "3036";
    for (const host of ["localhost", "app.localhost"]) {
      csp.script_src.push(`${host}:${vitePort}`);
      csp.connect_src.push(`${host}:${vitePort}`);
      csp.connect_src.push(`ws://${host}:${vitePort}`);
      csp.worker_src.push(`${host}:${vitePort}`);
    }
    const cableScheme = domain.protocol === "https" ? "wss" : "ws";
    const cablePort = process.env.ANYCABLE_PORT?.trim() || (domain.protocol === "https" ? "8081" : "8080");
    csp.connect_src.push(`${cableScheme}://${domain.anycableHost}:${cablePort}`);
    csp.connect_src.push("http:");
    csp.script_src.push("http:");
  }

  return csp;
}

/** SecureHeaders.append_content_security_policy_directives */
export function appendCspDirectives(base: CspDirectives, additions: CspDirectives): CspDirectives {
  const result: CspDirectives = structuredClone(base);
  for (const [directive, values] of Object.entries(additions) as [CspDirective, string[] | undefined][]) {
    if (result[directive] === undefined && !NON_FETCH_DIRECTIVES.has(directive)) {
      result[directive] = result.default_src ? [...result.default_src] : undefined;
    }
    result[directive] = [...new Set([...(result[directive] ?? []), ...(values ?? [])])];
    if (result[directive]!.length === 0) delete result[directive];
  }
  return result;
}

/** SecureHeaders.override_content_security_policy_directives */
export function overrideCspDirectives(base: CspDirectives, overrides: CspDirectives): CspDirectives {
  return { ...structuredClone(base), ...structuredClone(overrides) };
}

const WILDCARD_SOURCES = new Set(["'unsafe-eval'", "'unsafe-inline'", "*", "data:", "blob:"]);

// Ruby URI(source).path == "/" — true only for an absolute URI whose path is exactly "/".
function hasRootPath(source: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*\/(?:[?#].*)?$/u.test(source) && !/[\s"<>\\^`{|}]/u.test(source);
}

function normalizeUriPath(source: string): string {
  if (hasRootPath(source)) return source.replace(/\/$/u, "");
  const chomped = source.replace(/\/$/u, "");
  return chomped.includes("/") ? source : chomped;
}

function minifySourceList(directive: CspDirective, sources: string[], nonces: { script?: string; style?: string }): string[] {
  if (sources.includes("*")) return sources.filter((source) => WILDCARD_SOURCES.has(source));
  let list = [...sources];
  const nonce = directive === "script_src" ? nonces.script : directive === "style_src" ? nonces.style : undefined;
  if (nonce) list.push(`'nonce-${nonce}'`, "'unsafe-inline'");
  if (list.length > 1) list = list.filter((source) => source !== "'none'");
  list = list.map(normalizeUriPath).map((source) => source.replace(/^https?:\/\//u, ""));
  return [...new Set(list)];
}

/** The Content-Security-Policy value: default-src first, the rest alphabetically. */
export function buildCspHeader(directives: CspDirectives, nonces: { script?: string; style?: string } = {}): string {
  const order: CspDirective[] = ["default_src", ...CSP_DIRECTIVES.filter((d) => d !== "default_src")];
  return order
    .flatMap((directive) => {
      const sources = directives[directive];
      if (!sources || sources.length === 0) return [];
      const value = minifySourceList(directive, sources, nonces).join(" ").replace(/[\n\r;]/gu, " ");
      return [`${directive.replaceAll("_", "-")} ${value}`.trim()];
    })
    .join("; ");
}

/** SecureHeaders.content_security_policy_script_nonce: one per request, reused by script and style. */
export function generateCspNonce(): string {
  return randomBytes(32).toString("base64");
}

export type SecureHeadersOptions = {
  directives?: CspDirectives;
  scriptNonce?: string;
  styleNonce?: string;
  /** opt_out_of_header(:csp), as on PublicController and ThirdPartyAnalyticsController. */
  optOutOfCsp?: boolean;
};

/** SecureHeaders.header_hash_for(request) under the Rails configuration. */
export function secureHeaders(options: SecureHeadersOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-xss-protection": "1; mode=block",
    "x-download-options": "noopen",
    "x-permitted-cross-domain-policies": "none",
  };
  if (!options.optOutOfCsp) {
    headers["content-security-policy"] = buildCspHeader(options.directives ?? defaultCspDirectives(), {
      script: options.scriptNonce,
      style: options.styleNonce,
    });
  }
  return headers;
}
