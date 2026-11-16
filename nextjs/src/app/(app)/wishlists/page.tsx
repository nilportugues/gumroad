// WishlistsController#index (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import WishlistsIndex from "./WishlistsIndex";

export default async function Page() {
  const page = await renderPage("/wishlists", {});

  return (
    <InertiaShell page={page}>
      <WishlistsIndex />
    </InertiaShell>
  );
}
