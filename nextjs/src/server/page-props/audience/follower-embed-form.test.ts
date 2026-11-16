import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { castRow } from "../../models/sql.ts";
import { Users } from "../../models/user.ts";

import { embedFormCaptchaProps, embedFormFollowedProps, FROM_EMBED_FORM_COMPONENT } from "./follower-embed-form.ts";

// Rails' own answers, recorded in spec/requests/followers_create_parity_spec.rb: the "hands ..." examples of POST /follow_from_embed_form
// whose HTML answer is the Followers/FromEmbedForm page. The page's own props are the last keys of the Inertia props .
const FIXTURES = path.join(import.meta.dirname, "../../../../parity/fixtures/requests/followers_create_parity_spec");

type Recorded = {
  example: string;
  exchanges: {
    request: { body?: string };
    seed: { tables: { users: { rows: Record<string, unknown>[] } } };
    response: { inertia?: { component: string; props: Record<string, unknown> } };
  }[];
};

const recorded = readdirSync(FIXTURES)
  .filter((file) => file.includes("post-follow-from-embed-form-hands-") && file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as Recorded)
  .filter(({ exchanges }) => exchanges.at(-1)!.response.inertia?.component === FROM_EMBED_FORM_COMPONENT);

describe("Followers/FromEmbedForm props", () => {
  beforeEach(() => vi.stubEnv("RAILS_ENV", "test"));
  afterEach(() => vi.unstubAllEnvs());

  it("covers the unconfirmed, confirmed and CAPTCHA renders of the embed form", () => {
    expect(recorded.map(({ example }) => example.replace(/^.*POST \/follow_from_embed_form /u, "")).sort()).toEqual(
      [
        "hands a form post of the embed form to Rails",
        "hands a CAPTCHA refusal of the embed form to Rails, pointing at the seller's subscribe page",
        "hands a CAPTCHA refusal of the embed form for a seller with no name or username to Rails",
        "hands a signed-in visitor's embed form result to Rails",
      ].sort(),
    );
  });

  it.each(recorded.map((fixture) => [fixture.example, fixture] as const))(
    "builds what Rails rendered: %s",
    (_, fixture) => {
      const exchange = fixture.exchanges.at(-1)!;
      const { props } = exchange.response.inertia!;
      const sellerId = new URLSearchParams(exchange.request.body).get("seller_id");
      const row = exchange.seed.tables.users.rows.find((user) => user.external_id === sellerId)!;
      const seller = Users.load(castRow<User>("User", row as never));

      const built =
        "subscribe_url" in props
          ? embedFormCaptchaProps(seller)
          : embedFormFollowedProps(seller, props.confirmed === true);
      // The page's own props, in the order Rails serialized them among the shared ones.
      const own = Object.keys(props).filter((key) => key in built);

      expect(JSON.stringify(Object.fromEntries(own.map((key) => [key, props[key]])))).toBe(JSON.stringify(built));
    },
  );
});
