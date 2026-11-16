// LoginsController#new at /login (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import LoginsNew from "../_auth/LoginsNew";

export default async function Page() {
  const page = await renderPage("/login", {});

  return (
    <InertiaShell page={page} layout="public" clientOnly>
      <LoginsNew />
    </InertiaShell>
  );
}
