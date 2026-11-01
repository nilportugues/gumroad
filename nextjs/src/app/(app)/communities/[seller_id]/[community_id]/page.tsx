// CommunitiesController#show (props in server/page-props/communities/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import CommunitiesIndex from "../../CommunitiesIndex";

export default async function Page({ params }: { params: Promise<{ seller_id: string; community_id: string }> }) {
  const { seller_id, community_id } = await params;
  const page = await renderPage("/communities/:seller_id/:community_id", { seller_id, community_id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <CommunitiesIndex />
    </InertiaShell>
  );
}
