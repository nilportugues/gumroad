// Api::V2::ProductBuildsController#select_demo and #unselect_demo.
import { Prisma } from "@prisma/client";

import {
  findDemoBuild,
  hasUnpackError,
  purchasedVersion,
  selectAsDemoBang,
  unselectAsDemoBang,
} from "../../models/product-build-demo.ts";
import { selectRows, table, column } from "../../models/sql.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  errorWithObject,
  loadProduct,
  registerApiV2,
  renderResponse,
} from "./base.ts";
import { productBuildJson } from "./records.ts";

// before_action :fetch_product, then :set_build
async function loadBuild(input: ApiV2Input) {
  const halted = await loadProduct("link_id")(input);
  if (halted) return halted;
  const [row] = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT ${column("product_builds", "id")} AS id FROM ${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${input.state.product.id} AND ${column("product_builds", "public_id")} = ${input.routeParams.id} ORDER BY ${column("product_builds", "id")} ASC LIMIT 1`,
  );
  if (row === undefined) return errorWithObject("build", null);
  input.state.build = (await findDemoBuild(BigInt(row.id)))!;
  return undefined;
}

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/products/:link_id/builds/:id/demo",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadBuild,
    async run({ state }) {
      if (hasUnpackError(state.build))
        return renderResponse(false, {
          message: "This build's zip could not be unpacked, so it cannot play. Deploy a fixed zip as a new build.",
        });
      if (await purchasedVersion(state.build))
        return renderResponse(false, {
          message: "This build is what buyers get. Deploy a separate build to use as the demo.",
        });
      const build = await selectAsDemoBang(state.build);
      return renderResponse(true, { build: productBuildJson(build, build.demo_selected_at !== null) });
    },
  },
  {
    method: "DELETE",
    pattern: "/v2/products/:link_id/builds/:id/demo",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadBuild,
    async run({ state }) {
      const build = await unselectAsDemoBang(state.build.id);
      return renderResponse(true, { build: productBuildJson(build, build.demo_selected_at !== null) });
    },
  },
);
