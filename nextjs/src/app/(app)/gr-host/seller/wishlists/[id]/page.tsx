// WishlistsController#show on a seller subdomain or custom domain (props in server/page-props/storefront/wishlist-pages.ts).
// The proxy rewrites `/wishlists/:id` here for those hosts only (/gr-host/seller/...).
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import WishlistsShow from "./WishlistsShow";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("seller:/wishlists/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <WishlistsShow />
    </InertiaShell>
  );
}
