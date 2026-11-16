// Users::ReviewRemindersController#subscribe_by_token (filters in server/controllers/review-reminders.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import ReviewRemindersSubscribe from "../../ReviewRemindersSubscribe";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/users/subscribe_review_reminders/:id", { id });

  return (
    <InertiaShell page={page} layout="public">
      <ReviewRemindersSubscribe />
    </InertiaShell>
  );
}
