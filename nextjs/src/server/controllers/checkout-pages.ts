// CheckoutController#show's before_action (`process_cart_id_param`) and the decision of what the port can render.
// Anything it cannot prove goes to Rails whole, ahead of any write: the cart merge is the only write on this page.
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { decryptSecureExternalId } from "../models/secure-external-id.ts";
import { selectRows } from "../models/sql.ts";
import {
  fetchCart,
  storedDiscountCodeCount,
  visibleCartProductCount,
  cartStateOf,
} from "../page-props/checkout/checkout.ts";
import { domainConfig } from "../page-props/domain.ts";

import { HandBackToRails, type ActionOptions, type Chain, type FilterOutcome } from "./application-controller.ts";
import { assertFlatQuery, requestFormat } from "./rails-params.ts";
import { parseQuery, toQuery } from "./rails-query.ts";
import { isPresent, queryParam } from "./rails-request.ts";

const CART_LOGIN_SCOPE = "cart_login";
const LOGIN_REQUIRED_MESSAGE = "Please log in to complete checkout.";
const GUID_COOKIE = "_gumroad_guid";
// Params that put a product on the page (CheckoutPresenter#checkout_arrival_props).
const ARRIVAL_PARAMS = ["product", "wishlist", "gift_wishlist_product"];
const RECOMMENDED_PRODUCTS_PROP = "recommended_products";

// The browser's guid as `cookies[:_gumroad_guid]` reads it in the action: the cookie, else the one set_gumroad_guid minted.
function browserGuid(chain: Chain): string | null {
  const sent = chain.request.cookies.get(GUID_COOKIE);
  if (sent !== undefined) return sent;
  return chain.guid ? (/^_gumroad_guid=([^;]+)/.exec(chain.guid)?.[1] ?? null) : null;
}

type CartLoginRow = { id: bigint; browser_guid: string | null; user_id: bigint | null; user_email: string | null };

async function findCartForLogin(token: string): Promise<CartLoginRow | null> {
  const id = decryptSecureExternalId("Cart", token, CART_LOGIN_SCOPE);
  if (id === null) return null;
  const [row] = await selectRows<CartLoginRow>(
    Prisma.sql`SELECT \`carts\`.\`id\`, \`carts\`.\`browser_guid\`, \`carts\`.\`user_id\`, \`users\`.\`email\` AS user_email FROM \`carts\` LEFT JOIN \`users\` ON \`users\`.\`id\` = \`carts\`.\`user_id\` WHERE \`carts\`.\`deleted_at\` IS NULL AND \`carts\`.\`id\` = ${BigInt(id)} LIMIT 1`,
  );
  return row ?? null;
}

// CheckoutController#process_cart_id_param
async function processCartIdParam(chain: Chain): Promise<FilterOutcome | null> {
  const cartId = queryParam(chain.request, "cart_id");
  if (!isPresent(cartId)) return null;

  const config = domainConfig(process.env);
  const query = parseQuery(chain.request.queryString);
  delete query.cart_id;
  const pathWithoutCartId = `${chain.request.path}?${toQuery({ ...query, referrer: `${config.protocol}://${config.discoverDomain}` }).join("&")}`;
  const redirect = { halt: { status: 302, location: pathWithoutCartId, rescued: true } };

  if (railsLoggedInUser(chain.auth.context)) return redirect;
  const cart = await findCartForLogin(cartId);
  if (cart === null) return redirect;
  if (cart.user_id !== null) {
    const login = toQuery({ next: pathWithoutCartId, email: cart.user_email ?? "" }).join("&");
    return {
      halt: {
        status: 302,
        rescued: true,
        location: `${chain.request.protocol}${chain.request.hostWithPort}/login?${login}`,
        flash: { alert: LOGIN_REQUIRED_MESSAGE },
      },
    };
  }
  // The visitor's own guest cart would be merged into this one (MergeCartsService writes).
  if ((cart.browser_guid ?? null) !== browserGuid(chain)) throw new HandBackToRails();
  return redirect;
}

// The page holds nothing the port cannot render: no product from the URL, and a cart without lines or stored codes.
async function checkoutFilters(chain: Chain): Promise<FilterOutcome> {
  if (!chain.request.headers.has("x-inertia") && requestFormat(chain.request) !== "html") throw new HandBackToRails();
  assertFlatQuery(chain.request.queryString);

  const redirected = await processCartIdParam(chain);
  if (redirected) return redirected;

  for (const name of ARRIVAL_PARAMS) if (queryParam(chain.request, name) !== undefined) throw new HandBackToRails();
  // InertiaRails.optional: only a partial reload that names it computes the recommendations.
  const partial = chain.request.headers.get("x-inertia-partial-data") ?? "";
  if (partial.split(",").some((name) => name.trim() === RECOMMENDED_PRODUCTS_PROP)) throw new HandBackToRails();

  const user = railsLoggedInUser(chain.auth.context);
  const cart = await fetchCart(user?.id ?? null, browserGuid(chain));
  if (cart === null) return { state: { cart: null } };
  if (storedDiscountCodeCount(cart) > 0 || (await visibleCartProductCount(cart.id)) > 0) throw new HandBackToRails();
  return { state: { cart: cartStateOf(cart) } };
}

export const CHECKOUT_OPTIONS: ActionOptions = { filters: checkoutFilters };
