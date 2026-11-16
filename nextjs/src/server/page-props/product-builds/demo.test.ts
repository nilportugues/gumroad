import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openEnvelope } from "../../auth/player-grant.ts";

import { demoGrant, demoPageProps, PLAYER_DEMO_GRANT_PURPOSE, PRODUCT_BUILD_DEMO_COMPONENT } from "./demo.ts";

// Rails' own answers, recorded in spec/requests/product_build_demos_parity_spec.rb (GET /demo/:id).
const DIR = path.join(import.meta.dirname, "../../../../parity/fixtures/requests/product_build_demos_parity_spec");

// ProductBuild::PLAYER_DEMO_GRANT_VALID_FOR, written out so a change to the constant is caught here.
const ONE_HOUR_MS = 3_600_000;

type Row = Record<string, unknown>;
type Recorded = {
  example: string;
  secretKeyBase: string;
  exchanges: {
    request: { path: string };
    seed: { tables: Record<string, { rows: Row[] }> };
    response: { status: number; inertia?: { component: string; props: Record<string, unknown> } };
  }[];
};

const recorded = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Recorded)
  .filter(({ exchanges }) => exchanges.at(-1)!.response.status === 200);

describe("ProductBuildDemos/Show props", () => {
  let secretKeyBase = "";
  beforeEach(() => {
    secretKeyBase = recorded[0]!.secretKeyBase;
    vi.stubEnv("SECRET_KEY_BASE", secretKeyBase);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("covers a free product's live build and the build a seller chose for a paid product", () => {
    expect(recorded.map(({ example }) => example.replace(/^Product build demo page /u, "")).sort()).toEqual([
      "renders the build the seller chose for a paid product",
      "renders the live build of a free product",
    ]);
  });

  it.each(recorded.map((fixture) => [fixture.example, fixture] as const))(
    "builds what Rails rendered, and its grant names the build Rails chose: %s",
    (_, fixture) => {
      const exchange = fixture.exchanges.at(-1)!;
      const { component, props } = exchange.response.inertia!;
      expect(component).toBe(PRODUCT_BUILD_DEMO_COMPONENT);

      const product = exchange.seed.tables.links!.rows[0]!;
      const builds = exchange.seed.tables.product_builds!.rows;
      const build = builds.find((row) => row.demo_selected_at != null) ?? builds.find((row) => row.status === "live")!;
      const externalId = exchange.request.path.replace(/^\/demo\//u, "");
      const frameUrl = props.frame_url as string;
      const grant = frameUrl.slice(frameUrl.indexOf(externalId) + externalId.length + 1, -1);

      const built = demoPageProps({
        productName: product.name as string,
        productExternalId: externalId,
        requestPath: exchange.request.path,
        grant,
      });
      const own = Object.keys(props).filter((key) => key in built);
      expect(JSON.stringify(Object.fromEntries(own.map((key) => [key, props[key]])))).toBe(JSON.stringify(built));

      // The grant is encrypted afresh on every request: open Rails' and compare it with the one Node issues for the same instant.
      const railsGrant = openEnvelope(grant)!;
      const expiresAt = new Date(railsGrant.exp as string);
      const nodeGrant = openEnvelope(
        demoGrant(
          externalId,
          { id: build.id as number, product_id: build.product_id as number, number: build.number as number },
          new Date(expiresAt.getTime() - ONE_HOUR_MS),
        ),
      )!;
      expect(railsGrant.pur).toBe(PLAYER_DEMO_GRANT_PURPOSE);
      expect(JSON.stringify(nodeGrant)).toBe(JSON.stringify(railsGrant));
    },
  );

  // No recording has a trailing slash; this is `request.path.chomp("/")`.
  it("does not double the slash before the grant", () => {
    expect(
      demoPageProps({ productName: "A", productExternalId: "abc", requestPath: "/demo/abc/", grant: "g" }).frame_url,
    ).toBe("/demo/abc/g/");
  });
});
