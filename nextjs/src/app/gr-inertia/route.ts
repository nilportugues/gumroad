// Internal target of the proxy's X-Inertia rewrites (server/controllers/inertia-page.ts). Never routed
// to from outside: the proxy sends any request for this path to Rails.
import { inertiaPageResponse } from "@/server/controllers/inertia-page";

export const GET = inertiaPageResponse;
export const HEAD = inertiaPageResponse;
