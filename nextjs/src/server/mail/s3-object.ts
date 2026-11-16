// The two requests InternalNotificationMailer makes of an S3 object through `Aws::S3::Resource`:
// HEAD for `content_length`, then GET for `get.body.read`. Configured as config/initializers/aws.rb
// configures the Ruby client (path-style against MinIO outside production), and without the
// x-amz-checksum-mode header the JavaScript SDK adds to a GET by default, which aws-sdk-s3 does not send.
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { storageConfig } from "../infra/storage.ts";

export type S3Reader = {
  // `Aws::S3::Object#content_length`; nil when the response has none.
  contentLength(bucket: string, key: string): Promise<number | undefined>;
  // `Aws::S3::Object#get.body.read`
  read(bucket: string, key: string): Promise<Uint8Array>;
};

let client: S3Client | undefined;

function s3Client(): S3Client {
  if (client) return client;
  const config = storageConfig();
  client = new S3Client({
    region: config.region,
    credentials: config.accessKeyId && config.secretAccessKey ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(config.env === "development" || config.env === "test" ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
  });
  return client;
}

export const defaultS3Reader: S3Reader = {
  async contentLength(bucket, key) {
    return (await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength;
  },
  async read(bucket, key) {
    const { Body } = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Body ? Body.transformToByteArray() : new Uint8Array();
  },
};

// Tests point the reader at a local server.
export function useS3ClientForTesting(next: S3Client | undefined): void {
  client = next;
}
