import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { presignS3GetUrl, signedCloudfrontUrl } from "./signed-urls.ts";
import type { StorageConfig } from "./storage.ts";

// Signatures Rails itself produced, read back out of the request-spec fixtures: the test environment's own credentials (.env.test), the
// clock each URL carries (X-Amz-Date, Expires), and the bytes SignedUrlHelper and the AWS SDK wrote. Recomputing them proves the
// algorithms against the real helper with the credentials the application boots with, not only the stubbed vectors of signed-urls.golden.json.
const FIXTURES = path.join(process.cwd(), "parity", "fixtures", "requests");
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const MINIO_ENDPOINT = "http://localhost:9010";
const config: StorageConfig = {
  env: "test",
  accessKeyId: testEnv("AWS_ACCESS_KEY_ID"),
  secretAccessKey: testEnv("AWS_SECRET_ACCESS_KEY"),
  s3Endpoint: MINIO_ENDPOINT,
  region: "us-east-1",
  usingMinio: true,
  s3Bucket: "gumroad-specs",
  publicStorageS3Bucket: "gumroad-specs",
  invoicesS3Bucket: "gumroad-invoices",
  s3BaseUrl: `${MINIO_ENDPOINT}/gumroad-specs/`,
  hlsDistributionUrl: "https://d1jmbc8d0c0hid.cloudfront.net/",
  fileDownloadDistributionUrl: `${MINIO_ENDPOINT}/gumroad-specs/`,
  cloudfrontDownloadDistributionUrl: `${MINIO_ENDPOINT}/gumroad-specs/`,
  cloudfrontKeyPairId: testEnv("CLOUDFRONT_KEYPAIR_ID"),
  cloudfrontPrivateKey: JSON.parse(`"${/^CLOUDFRONT_PRIVATE_KEY="(.+)"$/mu.exec(envTest)![1]}"`) as string,
  cloudflareCacheLimit: 8_000_000_000,
  cdnS3ProxyHost: "https://test-static-2.gumroad.com",
  publicStorageCdnS3ProxyHost: "https://test-public-files.gumroad.com",
};

function* jsonFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) yield* jsonFiles(file);
    else if (file.endsWith(".json")) yield file;
  }
}

const recorded = (pattern: RegExp): string[] => {
  const found = new Set<string>();
  for (const file of jsonFiles(FIXTURES))
    for (const match of readFileSync(file, "utf8").replaceAll("\\u0026", "&").matchAll(pattern)) found.add(match[0]);
  return [...found].sort();
};

// A GET the SDK presigned for `host` alone: not an upload (x-amz-acl, content-md5) and not a multipart part
const S3_GET =
  /http:\/\/localhost:9010\/gumroad-specs\/[^"\\\s?]+\?[^"\\\s]*X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}/gu;
const CLOUDFRONT =
  /https:\/\/d1jmbc8d0c0hid\.cloudfront\.net\/[^"\\\s?]+\?Expires=\d{10}&Signature=[^"\\\s&]+&Key-Pair-Id=[A-Z0-9]+/gu;

const s3Gets = recorded(S3_GET).filter((url) => !url.includes("x-amz-acl=") && !url.includes("partNumber="));
const cloudfronts = recorded(CLOUDFRONT);

describe("signed URLs recorded from Rails", () => {
  it("finds the recorded URLs", () => {
    expect(s3Gets.length).toBeGreaterThan(3);
    expect(cloudfronts.length).toBeGreaterThan(0);
  });

  it.each(s3Gets.map((url) => [new URL(url).pathname.split("/").pop()!, url] as const))(
    "reproduces the presigned S3 GET of %s byte for byte",
    (_name, url) => {
      const { pathname, searchParams } = new URL(url);
      const amzDate = searchParams.get("X-Amz-Date")!;
      const now = new Date(
        `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
      );
      const key = decodeURIComponent(pathname.replace(/^\/gumroad-specs\//u, ""));
      const disposition = searchParams.get("response-content-disposition");

      expect(
        presignS3GetUrl(config.s3Bucket, key, {
          expiresIn: Number(searchParams.get("X-Amz-Expires")),
          responseContentDisposition: disposition ?? undefined,
          now,
          config,
        }),
      ).toBe(url);
    },
  );

  it.each(cloudfronts.map((url) => [new URL(url).pathname, url] as const))(
    "reproduces the CloudFront signature of %s byte for byte",
    (_name, url) => {
      const [unsigned, query] = url.split("?") as [string, string];
      const expires = Number(/Expires=(\d{10})/u.exec(query)![1]);

      expect(signedCloudfrontUrl(unsigned, { expiresIn: 0, now: new Date(expires * 1000), config })).toBe(url);
    },
  );
});
