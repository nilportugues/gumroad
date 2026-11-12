// FollowersController#cancel for an HTML request (GET /follow/:id/cancel): the unsubscribe link of a follow. `fetch_follower` is the
// 404, the action removes the follow and then renders Followers/Cancel, so the write happens in the filters, ahead of the render. The
// JSON answer of the same route is controllers/followers-mutations.ts.
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { findByExternalId, markDeletedBang, withOptOutLockWait } from "../../models/follower.ts";
import { RecordInvalid } from "../../models/runtime/errors.ts";
import { isLockWaitTimeout } from "../../models/sql.ts";
import { NotPortedError } from "../../models/user.ts";
import type { PageSpec } from "../pages.ts";

const CANCEL_PATH = /^\/follow\/([^/.]+)\/cancel$/u;

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

async function cancelFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  const match = CANCEL_PATH.exec(chain.request.path);
  if (match === null) throw new RoutingError("Not Found");
  const follower = await findByExternalId(safeDecode(match[1]!));
  if (follower === null) throw new RoutingError("Not Found");

  try {
    await withOptOutLockWait(() => markDeletedBang(follower));
  } catch (error) {
    // Rails answers a lock wait timeout with a 503 and Retry-After, and a follow that no longer validates raises; neither is
    // reproduced, and the transaction has rolled back.
    if (isLockWaitTimeout(error)) throw new HandBackToRails("a follow held by a post handoff (LockWaitTimeout)");
    if (error instanceof RecordInvalid) throw new HandBackToRails("a follow that fails validation");
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
  return { state: {} };
}

export const followersCancelPage: PageSpec = {
  component: "Followers/Cancel",
  options: { filters: cancelFilters },
  props: () => ({}),
};
