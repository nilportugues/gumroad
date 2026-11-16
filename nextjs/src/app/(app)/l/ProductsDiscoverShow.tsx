"use client";

import { usePage } from "@/lib/navigation";
import * as React from "react";

import { cast } from "$app/utils/cast";
import { Taxonomy } from "$app/utils/discover";

import { Layout as DiscoverLayout } from "$app/components/Discover/Layout";
import { Layout, Props } from "$app/components/Product/Layout";

type PageProps = Props & {
  taxonomy_path: string | null;
  taxonomies_for_nav: Taxonomy[];
};

// Products/Discover/Show (app/javascript/pages/Products/Discover/Show.tsx), with this app's usePage.
export default function ProductsDiscoverShow() {
  const props = cast<PageProps>(usePage().props);

  return (
    <DiscoverLayout
      taxonomyPath={props.taxonomy_path ?? undefined}
      taxonomiesForNav={props.taxonomies_for_nav}
      forceDomain
    >
      <Layout hasHero {...props} />
      {/* Render an empty div for the add section button */}
      {"products" in props ? <div /> : null}
    </DiscoverLayout>
  );
}
