// Users::ReviewRemindersController#subscribe (filters in server/controllers/review-reminders.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ReviewRemindersSubscribe from "../ReviewRemindersSubscribe";

export default async function Page() {
  const page = await renderPage("/users/subscribe_review_reminders", {});

  return (
    <InertiaShell page={page} layout="public">
      <ReviewRemindersSubscribe />
    </InertiaShell>
  );
}
