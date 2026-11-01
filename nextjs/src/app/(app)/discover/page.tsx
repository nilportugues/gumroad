// DiscoverController#index (props in server/page-props/discover/). The page reads `window` while rendering,
// as Rails never server-renders it either, so the shell waits for the client.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import DiscoverIndex from "./DiscoverIndex";

export default async function Page() {
  const page = await renderPage("/discover", {});
  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <DiscoverIndex />
    </InertiaShell>
  );
}
