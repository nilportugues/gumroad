// GumroadBlog::PostsController#index (props in server/page-props/gumroad-blog.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import IndexPage from "./BlogIndex";

export default async function Page() {
  const page = await renderPage("/blog", {});

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <IndexPage />
    </InertiaShell>
  );
}
