import type { ThrottleRule } from "./rack-attack.ts";

// The rules of config/initializers/rack_attack.rb that Node counts for the routes it serves. rack-attack-throttles.test.ts reads each one back
// from the Ruby file, so a changed limit or path there fails until this follows.
export const THROTTLE_RULES = {
  commentCreate: {
    kind: "ip",
    path: { regexpSource: String.raw`\A\/posts\/.+\/comments\z` },
    method: "post",
    requests: 5,
    periodSeconds: 60,
  },
  commentUpdate: {
    kind: "ip",
    path: { regexpSource: String.raw`\A\/posts\/.+\/comments\/.+\z` },
    method: "put",
    requests: 5,
    periodSeconds: 60,
  },
  chatMessageCreate: {
    kind: "ip_for_period",
    path: { regexpSource: String.raw`\A\/communities\/[^\/]+\/chat_messages\z` },
    method: "post",
    requests: 60,
    periodSeconds: 60,
  },
  // Inside `if Rails.env.production?`.
  followIp: {
    kind: "ip",
    path: { literal: "/follow" },
    method: "post",
    requests: 3,
    periodSeconds: 20,
    productionOnly: true,
  },
  followIpAndSeller: {
    kind: "ip_and_params",
    path: { literal: "/follow" },
    method: "post",
    requests: 3,
    periodSeconds: 60,
    maxLevel: 6,
    param: (params) => params.seller_id,
  },
  followEmbedIp: {
    kind: "ip",
    path: { literal: "/follow_from_embed_form" },
    requests: 3,
    periodSeconds: 20,
    productionOnly: true,
  },
  followEmbedIpAndSeller: {
    kind: "ip_and_params",
    path: { literal: "/follow_from_embed_form" },
    requests: 3,
    periodSeconds: 60,
    maxLevel: 6,
    param: (params) => params.seller_id,
  },
} as const satisfies Record<string, ThrottleRule>;
