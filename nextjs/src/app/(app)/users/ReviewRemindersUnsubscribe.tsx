"use client";

import { Link } from "@/lib/navigation";
import * as Routes from "@/lib/navigation/routes";
import * as React from "react";

import { Layout } from "$app/components/EmailAction/Layout";

// subscribe_url is absent when the visitor arrived with a session rather than from an email link.
export default function UnsubscribeReviewRemindersPage({ subscribe_url }: { subscribe_url?: string }) {
  return (
    <Layout heading="You will no longer receive review reminder emails.">
      If you wish to resubscribe to all review reminder emails, please click{" "}
      <Link href={subscribe_url ?? Routes.user_subscribe_review_reminders_path()} className="underline">
        here
      </Link>
      .
    </Layout>
  );
}
