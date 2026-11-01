// AgentController#index (props in server/page-props/agent/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import AgentIndex from "./AgentIndex";

export default async function Page() {
  const page = await renderPage("/agent", {});
  return (
    <InertiaShell page={page}>
      <AgentIndex />
    </InertiaShell>
  );
}
