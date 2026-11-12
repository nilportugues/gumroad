// Users/Coffee on a seller subdomain or custom domain (props in server/page-props/storefront/profile-pages.ts).
// The proxy rewrites the path here for those hosts only (/gr-host/seller/...).
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import UsersCoffee from "./UsersCoffee";

export default async function Page() {
  const page = await renderPage("seller:/coffee", {});

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UsersCoffee />
    </InertiaShell>
  );
}
