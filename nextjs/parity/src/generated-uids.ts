// A file embed that `ProductBuild#swap_file_embed` adds to a page carries a fresh `SecureRandom.uuid`. Both sides of a replay are compared with
// it masked (the specs' own embeds use 00000000-... uids, which stay visible), so the node still has to be there with the same id and shape.
import { compareExchange } from "./compare";
import type { CapturedExchange, Exchange } from "./fixture";

const GENERATED_UID =
  /(\\?"uid\\?": \\?")(?!00000000-)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu;

const mask = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(GENERATED_UID, "$1<uuid>");
  if (Array.isArray(value)) return value.map(mask);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mask(entry)]));
  return value;
};

export function maskGeneratedUids(
  exchange: { expected: Exchange; actual: CapturedExchange; differences: unknown[] },
  compare: Parameters<typeof compareExchange>[2],
) {
  exchange.expected = mask(exchange.expected) as Exchange;
  exchange.actual = mask(exchange.actual) as CapturedExchange;
  exchange.differences = compareExchange(exchange.expected, exchange.actual, compare);
}
