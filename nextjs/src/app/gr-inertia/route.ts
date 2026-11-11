// Internal target of the proxy's X-Inertia rewrites (server/controllers/inertia-page.ts). Never routed
// to from outside: the proxy sends any request for this path to Rails.
import { inertiaPageResponse } from "@/server/controllers/inertia-page";

export const GET = inertiaPageResponse;
export const HEAD = inertiaPageResponse;
// An Inertia visit that is not a GET and renders a page, as the unsubscribe button of a feature announcement does.
export const POST = inertiaPageResponse;
