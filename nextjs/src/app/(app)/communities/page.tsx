// CommunitiesController#index (props in server/page-props/communities/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import CommunitiesIndex from "./CommunitiesIndex";

export default async function Page() {
  const page = await renderPage("/communities", {});

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <CommunitiesIndex />
    </InertiaShell>
  );
}
