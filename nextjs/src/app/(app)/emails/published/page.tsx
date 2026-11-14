// EmailsController (props in server/page-props/emails/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import EmailsPublished from "./EmailsPublished";

export default async function Page() {
  const page = await renderPage("/emails/published", {});
  return (
    <InertiaShell page={page}>
      <EmailsPublished />
    </InertiaShell>
  );
}
