// Users::ReviewRemindersController#unsubscribe_by_token (filters in server/controllers/review-reminders.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import ReviewRemindersUnsubscribe from "../../ReviewRemindersUnsubscribe";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/users/unsubscribe_review_reminders/:id", { id });

  return (
    <InertiaShell page={page} layout="public">
      <ReviewRemindersUnsubscribe />
    </InertiaShell>
  );
}
