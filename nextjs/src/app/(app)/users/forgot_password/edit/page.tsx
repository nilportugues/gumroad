// User::PasswordsController#edit (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import PasswordsEdit from "./PasswordsEdit";

export default async function Page() {
  const page = await renderPage("/users/forgot_password/edit", {});

  return (
    <InertiaShell page={page} layout="public" clientOnly>
      <PasswordsEdit />
    </InertiaShell>
  );
}
