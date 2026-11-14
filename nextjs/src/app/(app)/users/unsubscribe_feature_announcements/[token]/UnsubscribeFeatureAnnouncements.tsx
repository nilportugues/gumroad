"use client";

import * as React from "react";

// The page component is shared with the Rails app (Vite), which passes it the page props; `@inertiajs/*` resolves to the compat layer here.
import UnsubscribeFeatureAnnouncementsPage from "$app/pages/Users/FeatureAnnouncements/Unsubscribe";
import { cast } from "$app/utils/cast";
import { usePage } from "@/lib/navigation";

export default function UnsubscribeFeatureAnnouncements() {
  return (
    <UnsubscribeFeatureAnnouncementsPage
      {...cast<React.ComponentProps<typeof UnsubscribeFeatureAnnouncementsPage>>(usePage().props)}
    />
  );
}
