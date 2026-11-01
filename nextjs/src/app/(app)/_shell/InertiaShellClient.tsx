"use client";

// Client half of app/javascript/entrypoints/inertia.js: the providers AppWrapper sets up, the layout
// assignLayout picks, and the side effects the entry installs, around one converted page.
import * as React from "react";

import AppWrapper from "$app/inertia/app_wrapper";
import Layout, { LoggedInUserLayout, PublicLayout, StandaloneLayout } from "$app/inertia/layout";
import { installFileDropNavigationGuard } from "$app/utils/preventFileDropNavigation";
import { defaults as requestDefaults } from "$app/utils/request";

import { PagePropsProvider, usePage } from "@/lib/navigation";
import { configureRouteDefaults } from "@/lib/navigation/routes";

// Browser translation extensions move DOM nodes React owns; see the same patch in entrypoints/inertia.js.
if (typeof Node !== "undefined" && !(Node.prototype.removeChild as { patched?: boolean }).patched) {
  const originalRemoveChild = Node.prototype.removeChild;
  const removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child;
    return originalRemoveChild.call(this, child) as T;
  };
  Object.assign(removeChild, { patched: true });
  Node.prototype.removeChild = removeChild;

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, newNode: T, referenceNode: Node | null): T {
    if (referenceNode && referenceNode.parentNode !== this) return newNode;
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}

// Which Rails layout wraps the page: `Page.publicLayout = true` etc. in the original component.
export type ShellLayout = "default" | "public" | "loggedInUser" | "standalone";

const LAYOUTS: Record<ShellLayout, React.ComponentType<{ children: React.ReactNode }>> = {
  default: Layout,
  public: PublicLayout,
  loggedInUser: LoggedInUserLayout,
  standalone: StandaloneLayout,
};

type GlobalProps = React.ComponentProps<typeof AppWrapper>["global"];

function Providers({ layout, href, children }: { layout: ShellLayout; href: string; children: React.ReactNode }) {
  const props = usePage().props as unknown as GlobalProps & { authenticity_token?: string };
  const { scheme, app_domain: appDomain } = props.domain_settings;
  configureRouteDefaults(scheme, appDomain);

  // `request()` sends this token; Inertia refreshed it from the shared prop after every visit.
  React.useEffect(() => {
    if (props.authenticity_token) requestDefaults.headers = { ...requestDefaults.headers, "X-CSRF-Token": props.authenticity_token };
  }, [props.authenticity_token]);

  React.useEffect(() => installFileDropNavigationGuard(), []);

  const PageLayout = LAYOUTS[layout];
  return (
    // `href` feeds SSRLocationProvider: Rails never rendered these pages on the server, so it is not a prop.
    <AppWrapper global={{ ...props, href }}>
      <PageLayout>{children}</PageLayout>
    </AppWrapper>
  );
}

export function InertiaShell({
  page: { component, props, href },
  layout = "default",
  children,
}: {
  page: { component: string; props: Record<string, unknown>; href: string };
  layout?: ShellLayout;
  children: React.ReactNode;
}) {
  return (
    <PagePropsProvider component={component} props={props}>
      <Providers layout={layout} href={href}>
        {children}
      </Providers>
    </PagePropsProvider>
  );
}
