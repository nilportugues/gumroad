// ProductBuildDemosController (GET /demo/:id and /demo/:id/product) and ProductBuildDemoFilesController (GET /demo/:id/:grant(/*path)),
// the public demo of a product's web build.
//
// Served: the 404 of a product that does not exist or has no live or chosen build (`ProductBuild.demo_for` is nil whatever the flags
// say), and the files under a demo grant that no demo check guards (an svg or xml document is handed back: it gets the CSP that lets X frame it). Handed to Rails: the page and the product link of a product that
// has such a build, since whether it is a demo (`ProductBuild#demo?`: the seller's flags, an unproven seller, the sale state) is not
// ported, and a page of the build, which gets the save shim.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { PLAYER_DEMO_GRANT_PURPOSE } from "../page-props/product-builds/demo.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { serveBuildFile } from "./product-build-player-files.ts";

// ProductBuildDemosController#set_build, up to the point where `demo?` decides: e404 unless a build could be the demo.
async function requireDemoCandidate(externalId: string): Promise<void> {
  const id = decrypt(externalId);
  const [product] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "id")} = ${id} LIMIT 1`,
        );
  if (product === undefined) throw new RoutingError("Not Found");
  const [candidate] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${id}
      AND (${column("product_builds", "status")} = 'live' OR ${column("product_builds", "demo_selected_at")} IS NOT NULL) LIMIT 1`,
  );
  if (candidate === undefined) throw new RoutingError("Not Found");
}

async function showOrProduct(input: MutationInput): Promise<ActionResult> {
  await requireDemoCandidate(input.routeParams.id!);
  throw new HandBackToRails("a demo build, whose `demo?` is not ported");
}

const serveDemoFile = (input: MutationInput) =>
  serveBuildFile(input, { purpose: PLAYER_DEMO_GRANT_PURPOSE, demo: true });

registerMutations(
  { method: "GET", pattern: "/demo/:id", skipForgeryProtection: true, run: showOrProduct },
  { method: "GET", pattern: "/demo/:id/product", skipForgeryProtection: true, run: showOrProduct },
  { method: "GET", pattern: "/demo/:id/:grant", skipForgeryProtection: true, run: serveDemoFile },
  { method: "GET", pattern: "/demo/:id/:grant/*path", skipForgeryProtection: true, run: serveDemoFile },
);
