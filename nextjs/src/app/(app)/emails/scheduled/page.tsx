// EmailsController (props in server/page-props/emails/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import EmailsScheduled from "./EmailsScheduled";

export default async function Page() {
  const page = await renderPage("/emails/scheduled", {});
  return (
    <InertiaShell page={page}>
      <EmailsScheduled />
    </InertiaShell>
  );
}
