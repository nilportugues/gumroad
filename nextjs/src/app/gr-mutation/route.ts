// Internal target of the proxy's rewrites of mutations Node ports (server/controllers/mutation.ts). Never routed to from
// outside: the proxy sends any request for this path to Rails.
import "@/server/controllers/emails-mutations";
import "@/server/controllers/workflows-mutations";
import "@/server/controllers/products-mutations";
import "@/server/controllers/settings-mutations";
import "@/server/controllers/social-callbacks";
import "@/server/controllers/connections-mutations";
import "@/server/controllers/oauth-applications-mutations";
import "@/server/controllers/dashboard-json";
import "@/server/controllers/events-mutations";
import "@/server/controllers/wishlists-mutations";
import "@/server/controllers/customer-actions";
import "@/server/controllers/product-review-responses";
import "@/server/controllers/shipments";
import "@/server/controllers/imported-customers";
import "@/server/controllers/library-mutations";
import "@/server/controllers/communities-mutations";
import "@/server/controllers/secure-redirect-mutations";
import "@/server/controllers/dropbox-files";
import "@/server/controllers/media-locations";
import "@/server/controllers/public-mutations";
import "@/server/controllers/seller-mutations";
import "@/server/controllers/internal-api";
import { mutationResponse } from "@/server/controllers/mutation";

export const POST = mutationResponse;
export const PUT = mutationResponse;
export const PATCH = mutationResponse;
export const DELETE = mutationResponse;
