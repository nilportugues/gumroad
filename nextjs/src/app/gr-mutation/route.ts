// Internal target of the proxy's rewrites of mutations Node ports (server/controllers/mutation.ts). Never routed to from
// outside: the proxy sends any request for this path to Rails.
import "@/server/controllers/emails-mutations";
import "@/server/controllers/workflows-mutations";
import "@/server/controllers/products-mutations";
import "@/server/controllers/settings-mutations";
import "@/server/controllers/settings-team-mutations";
import "@/server/controllers/settings-payments-mutations";
import "@/server/controllers/social-callbacks";
import "@/server/controllers/connections-mutations";
import "@/server/controllers/oauth-applications-mutations";
import "@/server/controllers/dashboard-json";
import "@/server/controllers/events-mutations";
import "@/server/controllers/customer-surcharge";
import "@/server/controllers/wishlists-mutations";
import "@/server/controllers/customer-actions";
import "@/server/controllers/purchase-access-writes";
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
import "@/server/controllers/auth-mutations";
import "@/server/controllers/auth-account-mutations";
import "@/server/controllers/internal-admin/index";
import "@/server/controllers/internal-api";
import "@/server/controllers/utm-links-mutations";
import "@/server/controllers/wishlist-items-mutations";
import "@/server/controllers/post-views-mutations";
import "@/server/controllers/profile-sections-mutations";
import "@/server/controllers/product-editor-json";
import "@/server/controllers/product-editor-mutations";
import "@/server/controllers/url-redirects/mutations";
import { mutationResponse } from "@/server/controllers/mutation";

// GET: the logout and emailed two-factor links, which change state without a form.
export const GET = mutationResponse;
export const POST = mutationResponse;
export const PUT = mutationResponse;
export const PATCH = mutationResponse;
export const DELETE = mutationResponse;
