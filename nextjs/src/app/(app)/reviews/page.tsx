// ReviewsController#index (props in server/page-props/buyer/pages.ts)
import type { ComponentProps } from "react";

import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import ReviewsIndex from "./ReviewsIndex";

export default async function Page() {
  const page = await renderPage("/reviews", {});

  return (
    <InertiaShell page={page}>
      <ReviewsIndex {...(page.props as unknown as ComponentProps<typeof ReviewsIndex>)} />
    </InertiaShell>
  );
}
