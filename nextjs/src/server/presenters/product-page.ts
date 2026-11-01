// The part of LinksController#show that renders Products/Show. The port serves the pages it can prove and
// hands every other request back to Rails (HandBackToRails), so no visitor gets a guess.
import { HandBackToRails } from "../controllers/application-controller.ts";
import type { Chain } from "../controllers/application-controller.ts";
import type { Query } from "../controllers/rails-query.ts";
import type { LinkRow, UserRow } from "./product-reads.ts";

export type RenderContext = { chain: Chain; product: LinkRow; seller: UserRow; query: Query; code: string | null; isUserCustomDomain: boolean };

export async function assertRenderable(_context: RenderContext): Promise<void> {
  throw new HandBackToRails();
}
