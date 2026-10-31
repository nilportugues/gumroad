import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(projectDir, "..");

// Shared components under app/javascript still import Inertia. Pointing the package at the compat
// module lets them run unchanged; `@/lib/navigation` is the only implementation in this app.
const navigationCompat = "./src/lib/navigation/index.ts";

// app/javascript resolves bare imports from the repo root's node_modules, which belongs to the Rails
// app (React 18) and is not installed in CI. Every package the shared components use is installed
// here and aliased, so both apps can pin different versions without a workspace.
const sharedPackages = [
  "@boxicons/react",
  "@radix-ui/react-dialog",
  "@radix-ui/react-popover",
  "@radix-ui/react-slot",
  "class-variance-authority",
  "cn",
];

const config: NextConfig = {
  // Next 16 writes an AGENTS.md into the project on `next dev`; the repo root already has one.
  agentRules: false,
  // The same build-time values vite.config.ts `define`s for the Rails bundle, with its defaults.
  env: {
    RAILS_ENV: process.env.RAILS_ENV || "test",
    PROTOCOL: process.env.PROTOCOL || "https",
  },
  // Rails URLs never carry trailing slashes; matching that keeps redirects identical.
  trailingSlash: false,
  // Without this Next strips the RSC headers before src/proxy.ts runs, so it cannot tell a client
  // router fetch of a Rails page apart from a browser visit (see decide.ts).
  skipProxyUrlNormalize: true,
  turbopack: {
    // Files outside the root are not resolved, and the pages import ../app/javascript.
    root: repoRoot,
    resolveAlias: {
      "@inertiajs/react": navigationCompat,
      "@inertiajs/core": navigationCompat,
      "$next-routes": "./src/lib/navigation/routes.ts",
      ...Object.fromEntries(sharedPackages.map((name) => [name, `./node_modules/${name}`])),
      // Local rendering before the Rails-session bridge (WS-03) exists; never set in deployed envs.
      ...(process.env.NEXTJS_SIGNED_OUT_CONTEXT === "1"
        ? { "@/server/auth/context": "./src/server/page-props/dev/signed-out-request-context.ts" }
        : {}),
    },
    rules: {
      // Vite turns `$assets/...` images into URL strings; Next would turn them into objects.
      "*.{png,jpg,svg,webp,gif}": {
        condition: { path: /(^|[\\/])public[\\/]/ },
        loaders: [{ loader: "./build/public-asset-url-loader.cjs", options: { publicDir: path.join(repoRoot, "public") } }],
        as: "*.js",
      },
      // The Vite build auto-imports the js-routes `Routes` global into every module that uses it.
      "*.{ts,tsx}": {
        condition: { path: /(^|[\\/])app[\\/]javascript[\\/]/ },
        loaders: ["./build/routes-auto-import-loader.cjs"],
      },
    },
  },
  compiler: {
    // The shared components were written for react-on-rails SSR, which defined this global.
    define: { SSR: "(typeof window === 'undefined')" },
  },
};

export default config;
