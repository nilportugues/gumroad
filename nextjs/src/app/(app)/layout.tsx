// Shell for pages converted from Inertia. Everything per-page (shared props, the Rails layout component)
// is rendered by each page through <InertiaShell>, because Inertia layouts receive page props.
import "$app/stylesheets/tailwind.css";
import "./design.scss";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return children;
}
