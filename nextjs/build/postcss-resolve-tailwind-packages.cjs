// app/javascript/stylesheets/tailwind.css imports `tailwindcss/*.css` and `@tailwindcss/typography`,
// which Tailwind resolves next to that file: the Rails app's node_modules. Point them at this app's
// copies, so the stylesheet compiles unchanged without the Rails dependencies installed.
const path = require("node:path");

const PACKAGES = ["tailwindcss", "@tailwindcss/typography"];
const nodeModules = path.join(__dirname, "..", "node_modules");

function resolvePackagePath(specifier) {
  const name = PACKAGES.find((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
  if (!name) return null;
  if (specifier === name) return require.resolve(name, { paths: [nodeModules] });
  return path.join(nodeModules, specifier);
}

function rewrite(params) {
  return params.replace(/^(["'])([^"']+)\1/, (match, quote, specifier) => {
    const resolved = resolvePackagePath(specifier);
    return resolved ? `${quote}${resolved}${quote}` : match;
  });
}

// `Once`, not an AtRule visitor: Tailwind's plugin also runs in `Once`, and must see the rewritten paths.
module.exports = () => ({
  postcssPlugin: "resolve-tailwind-packages",
  Once(root) {
    root.walkAtRules(/^(import|plugin)$/, (rule) => {
      rule.params = rewrite(rule.params);
    });
  },
});
module.exports.postcss = true;
