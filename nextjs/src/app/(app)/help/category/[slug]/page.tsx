// HelpCenter::CategoriesController#show
import { redirect } from "next/navigation";

import { categoryProps, findCategoryBySlug } from "@/server/page-props/help-center";
import { loadPage } from "@/server/page-props/load-page";
import * as Routes from "@/lib/navigation/routes";

import { InertiaShell } from "../../../_shell/InertiaShell";
import HelpCenterCategory from "./HelpCenterCategory";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // rescue_from ActiveHash::RecordNotFound. The proxy answers this with Rails' 302 first
  // (server/proxy-preflight.ts); redirect() can only send 307, so this is a fallback.
  const category = findCategoryBySlug(slug);
  if (!category) redirect(Routes.help_center_root_path());

  const page = await loadPage(
    "HelpCenter/Categories/Show",
    ({ meta, urlOptions }) => {
      // HelpCenter::BaseController before_action
      meta.set({ property: "og:type", content: "website" });
      meta.set({ name: "twitter:card", content: "summary" });

      meta.set({ title: `${category.title} - Gumroad Help Center` });
      meta.set({
        tag_name: "link",
        rel: "canonical",
        href: Routes.help_center_category_url(category.slug, urlOptions),
        head_key: "canonical",
      });
      return categoryProps(category);
    },
    { url: Routes.help_center_category_path(category.slug) },
  );

  return (
    <InertiaShell page={page}>
      <HelpCenterCategory />
    </InertiaShell>
  );
}
