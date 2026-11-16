// UsersController#subscribe_preview on the Gumroad domain (filters and props in server/page-props/storefront/profile-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";

import UsersSubscribePreview from "./UsersSubscribePreview";

export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const page = await renderPage("/:username/subscribe_preview", { username });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UsersSubscribePreview />
    </InertiaShell>
  );
}
