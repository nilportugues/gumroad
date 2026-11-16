// Users::ReviewRemindersController#unsubscribe (filters in server/controllers/review-reminders.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ReviewRemindersUnsubscribe from "../ReviewRemindersUnsubscribe";

export default async function Page() {
  const page = await renderPage("/users/unsubscribe_review_reminders", {});

  return (
    <InertiaShell page={page} layout="public">
      <ReviewRemindersUnsubscribe />
    </InertiaShell>
  );
}
