// EmailsController (props in server/page-props/emails/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import EmailsNew from "./EmailsNew";

export default async function Page() {
  const page = await renderPage("/emails/new", {});
  return (
    <InertiaShell page={page}>
      <EmailsNew />
    </InertiaShell>
  );
}
