import type { NextConfig } from "next";

const config: NextConfig = {
  // The existing React pages under app/javascript are imported directly, not copied.
  experimental: { externalDir: true },
  // Rails URLs never carry trailing slashes; matching that keeps redirects identical.
  trailingSlash: false,
};

export default config;
