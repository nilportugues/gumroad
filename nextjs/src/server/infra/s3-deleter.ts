// The two S3 calls RemoveDeletedFilesFromS3Job makes with the deleter credentials: `client.delete_objects(quiet: true)` and
// `bucket.objects(prefix:)` (ListObjectsV2, paged by continuation token). Configured as config/initializers/aws.rb configures the
// Ruby client (path-style against MinIO outside production).
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { getConfig } from "./config.ts";
import { storageConfig } from "./storage.ts";

export type S3Deleter = {
  // Aws::S3::Client#delete_objects(delete: { objects: keys.map { { key: _1 } }, quiet: true })
  deleteObjects(bucket: string, keys: string[]): Promise<void>;
  // `bucket.objects(prefix:).map(&:key)`
  listKeys(bucket: string, prefix: string): Promise<string[]>;
};

let client: S3Client | undefined;

function deleterClient(): S3Client {
  if (client) return client;
  const config = storageConfig();
  const accessKeyId = getConfig("S3_DELETER_ACCESS_KEY_ID");
  const secretAccessKey = getConfig("S3_DELETER_SECRET_ACCESS_KEY");
  client = new S3Client({
    region: config.region,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(config.env === "development" || config.env === "test"
      ? { endpoint: config.s3Endpoint, forcePathStyle: true }
      : {}),
  });
  return client;
}

export const defaultS3Deleter: S3Deleter = {
  async deleteObjects(bucket, keys) {
    await deleterClient().send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
    );
  },
  async listKeys(bucket, prefix) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await deleterClient().send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return keys;
  },
};
