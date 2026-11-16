// Subscriptions::MagicLinksController#new (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import MagicLinksNew from "./MagicLinksNew";

export default async function Page({ params }: { params: Promise<{ subscription_id: string }> }) {
  const { subscription_id } = await params;
  const page = await renderPage("/subscriptions/:subscription_id/magic_link/new", { subscription_id });

  return (
    <InertiaShell page={page} layout="public">
      <MagicLinksNew />
    </InertiaShell>
  );
}
