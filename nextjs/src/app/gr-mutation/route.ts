// Internal target of the proxy's rewrites of mutations Node ports (server/controllers/mutation.ts). Never routed to from
// outside: the proxy sends any request for this path to Rails.
import "@/server/controllers/emails-mutations";
import "@/server/controllers/workflows-mutations";
import "@/server/controllers/products-mutations";
import "@/server/controllers/settings-mutations";
import "@/server/controllers/social-callbacks";
import "@/server/controllers/connections-mutations";
import "@/server/controllers/oauth-applications-mutations";
import { mutationResponse } from "@/server/controllers/mutation";

export const POST = mutationResponse;
export const PUT = mutationResponse;
export const PATCH = mutationResponse;
export const DELETE = mutationResponse;
