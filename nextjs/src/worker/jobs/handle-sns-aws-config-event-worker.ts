// Port of app/sidekiq/handle_sns_aws_config_event_worker.rb
import { getConfig } from "../../server/infra/config.ts";
import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { rubyToS } from "../../lib/ruby-to-s.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const MESSAGE_TYPES_TO_IGNORE = ["ConfigurationSnapshotDeliveryStarted", "ConfigurationSnapshotDeliveryCompleted", "ConfigurationHistoryDeliveryCompleted"];

// The Ruby fallback passes `attachments:` as a keyword, i.e. a Symbol-keyed Hash, which Sidekiq 7's
// default strict args refuse at push time. So that branch has never enqueued anything: it raises
// and the job goes through its retries. Kept as is until the Ruby side is fixed.
const STRICT_ARGS_ERROR =
  "Job arguments to InternalNotificationWorker must be native JSON types, but :attachments is a Symbol.\n" +
  "See https://github.com/sidekiq/sidekiq/wiki/Best-Practices\n" +
  "To disable this error, add `Sidekiq.strict_args!(false)` to your initializer.\n";

const isIntegerValue = (value: JsonValue) => typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value));
const isTruthy = (value: JsonValue) => value !== null && value !== false;

// `value["key"]` on a parsed JSON value, raising where Ruby raises.
function index(value: JsonValue, key: string): JsonValue {
  if (typeof value === "string") return value.includes(key) ? key : null;
  if (Array.isArray(value) || isIntegerValue(value)) throw new TypeError("no implicit conversion of String into Integer");
  if (value === null || typeof value !== "object" || value instanceof RubyFloat) throw new TypeError(`undefined method '[]' for ${String(value)}`);
  return Object.hasOwn(value, key) ? value[key]! : null;
}

// `value.try(:[], "key")`: nil for values without a `[]` method (nil, true, false, Float).
function tryIndex(value: JsonValue, key: string): JsonValue {
  if (value === null || typeof value === "boolean" || value instanceof RubyFloat || (typeof value === "number" && !Number.isInteger(value))) return null;
  return index(value, key);
}

function buildMessage(message: JsonValue): string | null {
  const configurationItem = index(message, "configurationItem");
  const configurationItemDiff = index(message, "configurationItemDiff");
  if (configurationItem === null || configurationItemDiff === null) return null;

  const awsRegion = index(configurationItem, "awsRegion");
  const region = isTruthy(awsRegion) ? awsRegion : getConfig("AWS_DEFAULT_REGION", "us-east-1");
  const timestamp = index(configurationItem, "configurationItemCaptureTime");
  const resourceType = index(configurationItem, "resourceType");
  const resourceId = index(configurationItem, "resourceId");
  const resourceName = tryIndex(index(configurationItem, "tags"), "Name");
  const relatedCloudtrailEvents = index(configurationItem, "relatedEvents");
  if (timestamp === null || resourceType === null || resourceId === null || relatedCloudtrailEvents === null) return null;

  const configUrl = `https://console.aws.amazon.com/config/home?region=${rubyToS(region)}#/timeline/${rubyToS(resourceType)}/${rubyToS(resourceId)}?time=${rubyToS(timestamp)}`;
  return `${rubyToS(resourceId)} • ${rubyToS(resourceName)} • <${configUrl}|AWS Config>`;
}

export const handleSnsAwsConfigEventWorker: JobHandler = async (args, { runtime }) => {
  checkArity(args, 1);
  const params = args[0]!;

  let message: string | null = null;
  if (index(params, "Type") === "Notification") {
    const raw = index(params, "Message");
    if (typeof raw !== "string") throw new TypeError(`no implicit conversion of ${raw === null ? "nil" : typeof raw} into String`);
    const messageContent = parseRubyJson(raw);
    const messageType = index(messageContent, "messageType");
    if (typeof messageType === "string" && MESSAGE_TYPES_TO_IGNORE.includes(messageType)) return;

    message = buildMessage(messageContent);
  }

  if (message === null) throw new Error(STRICT_ARGS_ERROR);
  await enqueueWith(runtime, "InternalNotificationWorker", ["internals_log", "AWS Config", message, "gray"]);
};
