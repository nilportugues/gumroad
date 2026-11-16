// FollowersController#index (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import FollowersIndex from "./FollowersIndex";

export default async function Page() {
  const page = await renderPage("/followers", {});
  return (
    <InertiaShell page={page}>
      <FollowersIndex />
    </InertiaShell>
  );
}
