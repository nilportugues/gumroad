// Answers a converted route from the proxy when Rails would not render the page at all. A page's
// redirect() can only send 307/308, so a redirect Rails sends as 302 is answered here instead, with
// the rest of what Rails' controller sends alongside it (processAction).
import * as Routes from "@/lib/navigation/routes";

import { processAction } from "./controllers/application-controller.ts";
import { findCategoryBySlug } from "./page-props/help-center.ts";

type Preflight = (request: Request, url: URL) => Promise<Response | null>;

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const PREFLIGHTS: Record<string, Preflight> = {
  // HelpCenter::BaseController: `rescue_from ActiveHash::RecordNotFound` redirects to the help
  // center root with a 302, after the before_actions and without the after_actions.
  "/help/category/:slug": async (request, url) => {
    const slug = decodeSegment(url.pathname.split("/").at(-1) ?? "");
    if (findCategoryBySlug(slug)) return null;
    return processAction(request, {}, async () => ({ status: 302, location: Routes.help_center_root_path(), rescued: true }));
  },
};

export function routePreflight(pattern: string, request: Request, url: URL): Promise<Response | null> {
  return PREFLIGHTS[pattern]?.(request, url) ?? Promise.resolve(null);
}
