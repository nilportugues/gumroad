import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { blobSignedId, isVariable, publicStorageUrl, resizeToLimitDigest } from "./active-storage.ts";
import { cdnUrlFor } from "./cdn-url.ts";
import { storageConfig } from "./storage.ts";

// active-storage.golden.json is written by nextjs/scripts/golden/active-storage.rb from the real
// Active Storage, CdnUrlHelper and Aws::S3::Object#public_url.
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/active-storage.golden.json", import.meta.url), "utf8"),
) as {
  digests: { filename: string; content_type: string; digest: string }[];
  // Written by the script's newer revision: absent until the golden is re-recorded from Rails.
  thumbnail_digests?: { filename: string; content_type: string; digest: string }[];
  signed_ids?: { secret_key_base: string; results: [number, string][] };
  variable: Record<string, boolean>;
  cdn: { env: "production" | "staging" | "development" | "test"; endpoint: string; results: [string, string][] }[];
  urls: {
    test: { endpoint: string; bucket: string; results: [string, string][] };
    production: { bucket: string; results: [string, string][] };
  };
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("variation digest", () => {
  it.each(golden.digests.map((c) => [`${c.filename} (${c.content_type})`, c] as const))("%s", (_name, recorded) => {
    expect(resizeToLimitDigest(recorded.content_type, recorded.filename, 400)).toBe(recorded.digest);
  });

  it.each((golden.thumbnail_digests ?? []).map((c) => [`${c.filename} (${c.content_type})`, c] as const))(
    "1280x720 %s",
    (_name, recorded) => {
      expect(resizeToLimitDigest(recorded.content_type, recorded.filename, 1280, 720)).toBe(recorded.digest);
    },
  );

  it("knows which content types Active Storage can make variants of", () => {
    for (const [type, expected] of Object.entries(golden.variable))
      expect([type, isVariable(type)]).toEqual([type, expected]);
    expect(isVariable(null)).toBe(false);
  });
});

describe("cdn_url_for", () => {
  it.each(golden.cdn.map((c) => [c.env, c] as const))("rewrites as the %s CDN_URL_MAP does", (_env, recorded) => {
    process.env.AWS_S3_ENDPOINT = recorded.endpoint;
    const config = storageConfig(recorded.env);
    for (const [url, expected] of recorded.results) expect([url, cdnUrlFor(url, config)]).toEqual([url, expected]);
  });
});

describe("the public storage URL", () => {
  it("is path style against MinIO in test", () => {
    process.env.RAILS_ENV = "test";
    process.env.AWS_S3_ENDPOINT = golden.urls.test.endpoint;
    for (const [key, expected] of golden.urls.test.results)
      expect([key, publicStorageUrl(key)]).toEqual([key, expected]);
  });

  it("names the bucket in the host of the global S3 endpoint in production", () => {
    process.env.RAILS_ENV = "production";
    for (const [key, expected] of golden.urls.production.results)
      expect([key, publicStorageUrl(key)]).toEqual([key, expected]);
  });
});

describe("blob signed_id", () => {
  // Computed with the verifier port that matches Rails' goldens for another verifier (auth/message-verifier.test.ts), not recorded from
  // Rails: the payload is `{"_rails":{"data":<id>,"pur":"blob_id"}}`. nextjs/scripts/golden/active-storage.rb records the real tokens.
  const SECRET_KEY_BASE = "ws55-message-verifier-golden-secret";
  const DERIVED: [number, string][] = [
    [1, "eyJfcmFpbHMiOnsiZGF0YSI6MSwicHVyIjoiYmxvYl9pZCJ9fQ==--20e8c6100f65ba14cbd2af511beac8badeadcbad"],
    [42, "eyJfcmFpbHMiOnsiZGF0YSI6NDIsInB1ciI6ImJsb2JfaWQifX0=--ac1b4dea0bf30d776df23d146e2191c51d35f80a"],
    [123456, "eyJfcmFpbHMiOnsiZGF0YSI6MTIzNDU2LCJwdXIiOiJibG9iX2lkIn19--2627a69df0facd96e1a7256eb80c927f1fc01c80"],
  ];

  it.each(DERIVED)("signs blob %i with the ActiveStorage verifier and the blob_id purpose", (id, token) => {
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    expect(blobSignedId(BigInt(id))).toBe(token);
  });

  it.each(golden.signed_ids?.results ?? [])("matches the Rails token for blob %i", (id, token) => {
    process.env.SECRET_KEY_BASE = golden.signed_ids!.secret_key_base;
    expect(blobSignedId(BigInt(id))).toBe(token);
  });
});
