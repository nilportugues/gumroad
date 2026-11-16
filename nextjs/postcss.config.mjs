import path from "node:path";

// Same pipeline as the Rails app's package.json "postcss" key, so app/javascript/stylesheets compile
// unchanged; the first plugin only redirects Tailwind's package imports to this app's node_modules.
// Turbopack requires plugins by name from a bundled chunk (where import.meta.url is virtual), so the
// local one is an absolute path from the directory `next` runs in.
export default {
  plugins: {
    [path.join(process.cwd(), "build", "postcss-resolve-tailwind-packages.cjs")]: {},
    "@tailwindcss/postcss": {},
  },
};
