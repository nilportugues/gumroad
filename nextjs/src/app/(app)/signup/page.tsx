// SignupController#new at /signup (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import SignupNew from "../_auth/SignupNew";

export default async function Page() {
  const page = await renderPage("/signup", {});

  return (
    <InertiaShell page={page} layout="public" clientOnly>
      <SignupNew />
    </InertiaShell>
  );
}
