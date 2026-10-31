// Ports of the `def self.lock_args(args)` methods in app/sidekiq. sidekiq-unique-jobs hashes the
// result into the lock digest, so a port that differs from Ruby by one element splits the lock
// in two. `npm run jobs:generate` fails if a Ruby job defines lock_args and this map does not.
import type { JsonValue } from "./sidekiq/ruby-json.ts";

// Ruby truthiness: only nil and false are falsy, so `!!0` and `!!""` are true.
const rubyTruthy = (value: JsonValue | undefined) => value !== undefined && value !== null && value !== false;
const first = (args: JsonValue[]): JsonValue[] => [args[0] ?? null];

export const LOCK_ARGS: Record<string, (args: JsonValue[]) => JsonValue[]> = {
  DeliverFilesReadyNotificationJob: first,
  GenerateSslCertificate: first,
  RefundAllForFraudWorker: first,
  RefundUnpaidPurchasesWorker: first,
  SendChargeReceiptJob: first,
  SendPurchaseReceiptJob: (args) => [args[0] ?? null, rubyTruthy(args[1])],
  StampPdfForPurchaseJob: first,
};
