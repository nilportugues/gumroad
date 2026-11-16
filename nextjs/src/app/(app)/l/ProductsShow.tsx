"use client";

import { usePage } from "@/lib/navigation";
import * as React from "react";

import { cast } from "$app/utils/cast";

import { PoweredByFooter } from "$app/components/PoweredByFooter";
import { Layout, Props } from "$app/components/Product/Layout";

// Products/Show (app/javascript/pages/Products/Show.tsx), with this app's usePage.
export default function ProductsShow() {
  const props = cast<Props>(usePage().props);

  return (
    <>
      <Layout {...props} />
      <PoweredByFooter currencySelector shownCurrency={props.product.buyer_currency_display?.buyer_currency_shown} />
    </>
  );
}
