// The props of `ProductBuildDemos/Show` (GET /demo/:id, ProductBuildDemosController#show). Built and proven against Rails' own
// answers in demo.test.ts, not served: whether a build is a public demo (`ProductBuild#demo?`: the seller's feature flags, an
// unproven seller, the chosen build) is not ported, so /demo/:id stays in Rails.
import { issuePlayerGrant } from "../../auth/player-grant.ts";

export const PRODUCT_BUILD_DEMO_COMPONENT = "ProductBuildDemos/Show";

// ProductBuild::PLAYER_DEMO_GRANT_PURPOSE and PLAYER_DEMO_GRANT_VALID_FOR
export const PLAYER_DEMO_GRANT_PURPOSE = "product_build_player_demo";
export const PLAYER_DEMO_GRANT_VALID_FOR_MS = 60 * 60 * 1000;

export type DemoBuild = { id: bigint | number; product_id: bigint | number; number: number };

// ProductBuild#site_prefix
const sitePrefix = (build: DemoBuild) => `builds/${build.product_id}/${build.number}/site`;

// ProductBuild#demo_grant: the product's external id stands in for a content-page token.
export function demoGrant(productExternalId: string, build: DemoBuild, now = new Date()): string {
  return issuePlayerGrant(
    { token: productExternalId, build_id: Number(build.id), site_prefix: sitePrefix(build) },
    { purpose: PLAYER_DEMO_GRANT_PURPOSE, validForMs: PLAYER_DEMO_GRANT_VALID_FOR_MS, now },
  );
}

export function demoPageProps({
  productName,
  productExternalId,
  requestPath,
  grant,
}: {
  productName: string;
  productExternalId: string;
  requestPath: string;
  grant: string;
}) {
  return {
    title: productName,
    // The trailing slash makes the build's relative file paths resolve under the grant.
    frame_url: `${requestPath.replace(/\/$/u, "")}/${grant}/`,
    product_url: `/demo/${productExternalId}/product`,
  };
}
