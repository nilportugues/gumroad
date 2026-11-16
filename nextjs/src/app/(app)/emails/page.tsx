// EmailsController#index only redirects (the guard in server/page-props/emails/pages.ts answers it).
import { notFound } from "next/navigation";

export default function Page() {
  notFound();
}
