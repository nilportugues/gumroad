"use client";

import * as React from "react";

import ProductsDiscoverShow from "./ProductsDiscoverShow";
import ProductsIframeShow from "./ProductsIframeShow";
import ProductsProfileShow from "./ProductsProfileShow";
import ProductsShow from "./ProductsShow";

// LinksController#show renders one of four components (`layout`, `embed` and `overlay` choose); the server page names the one it rendered.
const PAGES: Record<string, () => React.ReactElement> = {
  "Products/Iframe/Show": ProductsIframeShow,
  "Products/Profile/Show": ProductsProfileShow,
  "Products/Discover/Show": ProductsDiscoverShow,
};

export default function ProductsPage({ component }: { component: string }) {
  const Page = PAGES[component] ?? ProductsShow;
  return <Page />;
}
