"use client";

import { useForm, usePage } from "@/lib/navigation";
import * as React from "react";

import { Button } from "$app/components/Button";
import { PoweredByFooter } from "$app/components/PoweredByFooter";
import { Card, CardContent } from "$app/components/ui/Card";
import { Input } from "$app/components/ui/Input";

const PurchasesInvoiceConfirmationPage = () => {
  const { url } = usePage();
  // <Form> is not available in the App Router's Inertia compat module; the same POST goes through useForm.
  const form = useForm({ email: "" });

  return (
    <div className="flex flex-1 flex-col justify-between p-4">
      <Card asChild>
        <main className="mx-auto h-min w-full max-w-md">
          <CardContent asChild>
            <header className="text-center">
              <h2>Generate invoice</h2>
            </header>
          </CardContent>
          <CardContent asChild>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                form.post(url, { preserveScroll: true });
              }}
            >
              <Input
                type="text"
                name="email"
                placeholder="Email address"
                className="grow"
                value={form.data.email}
                onChange={(e) => form.setData("email", e.target.value)}
              />
              <Button type="submit" color="accent" disabled={form.processing}>
                Confirm email
              </Button>
            </form>
          </CardContent>
        </main>
      </Card>
      <PoweredByFooter />
    </div>
  );
};

PurchasesInvoiceConfirmationPage.publicLayout = true;
export default PurchasesInvoiceConfirmationPage;
