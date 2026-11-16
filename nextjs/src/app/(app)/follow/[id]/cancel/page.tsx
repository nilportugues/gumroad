// FollowersController#cancel (props in server/page-props/audience/follower-cancel.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

import FollowersCancel from "./FollowersCancel";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/follow/:id/cancel", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <FollowersCancel />
    </InertiaShell>
  );
}
