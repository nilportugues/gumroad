// Users::FeatureAnnouncementsController#confirm_unsubscribe (filters in server/controllers/feature-announcements.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

import UnsubscribeFeatureAnnouncements from "./UnsubscribeFeatureAnnouncements";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const page = await renderPage("/users/unsubscribe_feature_announcements/:token", { token });

  return (
    <InertiaShell page={page} layout="public">
      <UnsubscribeFeatureAnnouncements />
    </InertiaShell>
  );
}
