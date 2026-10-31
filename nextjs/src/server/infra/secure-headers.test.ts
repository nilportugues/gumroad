import { afterEach, beforeAll, describe, expect, it } from "vitest";

import golden from "./__fixtures__/secure-headers.golden.json" with { type: "json" };
import { setCredentialsForTesting } from "./config";
import { domainConfig } from "./domain";
import {
  appendCspDirectives,
  defaultCspDirectives,
  generateCspNonce,
  overrideCspDirectives,
  secureHeaders,
  type SecureHeadersOptions,
} from "./secure-headers";

// Vectors were produced by secure_headers 7.3.0 loading the real domain.rb, aws.rb and
// secure_headers.rb in each Rails env (generators/secure_headers.rb).
const CLEARED = [
  "RAILS_ENV",
  "RACK_ENV",
  "AWS_S3_ENDPOINT",
  "VITE_RUBY_PORT",
  "CUSTOM_PROTOCOL",
  "CUSTOM_DOMAIN",
  "ANYCABLE_PORT",
  "DEV_LANE_PORT",
  "ASSET_DOMAIN",
  "FILE_DOWNLOAD_DISTRIBUTION_URL_PROD",
  "FILE_DOWNLOAD_DISTRIBUTION_URL_DEV",
  "HLS_DISTRIBUTION_URL_PROD",
  "HLS_DISTRIBUTION_URL_DEV",
];

type Variant = keyof (typeof golden)["production"]["headers"];

function optionsFor(variant: Variant, nonce: string): SecureHeadersOptions {
  const base = defaultCspDirectives();
  const assetSources = [domainConfig().assetHost].filter((host): host is string => Boolean(host));
  switch (variant) {
    case "default":
      return {};
    case "script_nonce":
      return { scriptNonce: nonce };
    case "script_and_style_nonce":
      return { scriptNonce: nonce, styleNonce: nonce };
    case "flipper_ui":
      return {
        directives: appendCspDirectives(base, {
          script_src: ["code.jquery.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
          style_src: ["cdn.jsdelivr.net"],
        }),
      };
    case "sidekiq_web":
      return { directives: appendCspDirectives(base, { script_src: ["'unsafe-inline'"] }) };
    case "append_unset_directive":
      return { directives: appendCspDirectives(base, { manifest_src: ["example.com"], form_action: ["example.org"] }) };
    case "epub_reader":
      return {
        directives: overrideCspDirectives(base, {
          child_src: ["'self'", "data:", "blob:"],
          font_src: ["'self'", "data:", "blob:", ...assetSources],
          frame_src: ["'self'", "data:", "blob:"],
          img_src: ["'self'", "data:", "blob:"],
          media_src: ["'self'", "data:", "blob:"],
          object_src: ["'self'", "data:", "blob:"],
          style_src: ["'self'", "'unsafe-inline'", "blob:", ...assetSources],
        }),
      };
    case "opt_out":
      return { optOutOfCsp: true };
  }
}

describe("secure_headers parity with Ruby", () => {
  const savedEnv = { ...process.env };
  beforeAll(() => setCredentialsForTesting({}));
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const cases = Object.entries(golden).flatMap(([scenario, { env, nonce, headers }]) =>
    Object.entries(headers).map(([variant, expected]) => ({ scenario, variant: variant as Variant, env, nonce, expected })),
  );

  it.each(cases)("$scenario: $variant", ({ env, nonce, variant, expected }) => {
    for (const key of CLEARED) delete process.env[key];
    Object.assign(process.env, env);
    expect(secureHeaders(optionsFor(variant, nonce))).toEqual(expected);
  });

  it("generates 32-byte base64 nonces like SecureRandom.base64(32)", () => {
    expect(generateCspNonce()).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
  });
});
