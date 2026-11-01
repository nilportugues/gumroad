// Wishlists::FollowingController#index (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import WishlistsFollowingIndex from "./WishlistsFollowingIndex";

export default async function Page() {
  const page = await renderPage("/wishlists/following", {});

  return (
    <InertiaShell page={page}>
      <WishlistsFollowingIndex />
    </InertiaShell>
  );
}
