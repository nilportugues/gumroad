// EmailsController#edit (props in server/page-props/emails/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import EmailsEdit from "./EmailsEdit";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/emails/:id/edit", { id });
  return (
    <InertiaShell page={page}>
      <EmailsEdit />
    </InertiaShell>
  );
}
