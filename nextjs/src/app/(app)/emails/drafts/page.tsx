// EmailsController (props in server/page-props/emails/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import EmailsDrafts from "./EmailsDrafts";

export default async function Page() {
  const page = await renderPage("/emails/drafts", {});
  return (
    <InertiaShell page={page}>
      <EmailsDrafts />
    </InertiaShell>
  );
}
