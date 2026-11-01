// User::PasswordsController#new (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import PasswordsNew from "./PasswordsNew";

export default async function Page() {
  const page = await renderPage("/users/forgot_password/new", {});

  return (
    <InertiaShell page={page} layout="public" clientOnly>
      <PasswordsNew />
    </InertiaShell>
  );
}
