// Port of app/sidekiq/seller_updates_worker.rb, which does nothing: it passes a block to the
// `User.by_sales_revenue` scope, Rails scopes drop blocks, and the relation it returns is never
// loaded, so no query runs and no SellerUpdateWorker is enqueued (seller-updates-worker.golden.json
// records this from the real classes). Kept as a no-op until the Ruby is fixed, so both stay identical.
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

export const sellerUpdatesWorker: JobHandler = async (args) => {
  checkArity(args, 0);
};
