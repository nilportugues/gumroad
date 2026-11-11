// Stands in for unplugin-auto-import in vite.config.ts, which injects the js-routes `Routes` global
// into any module that references it without importing it.
// Turbopack only resolves bare specifiers here; next.config.ts aliases this one.
const routesModule = "$next-routes";
const usesRoutes = /(^|[^.\w$])Routes\./mu;
// A binding named Routes, not a statement that merely uses it (`const url = new URL(Routes.checkout_url())`).
const declaresRoutes = /\bimport\b[^;]*\bRoutes\b[^;]*\bfrom\b|\b(const|let|var|function|class)\s+Routes\b/u;

module.exports = function routesAutoImportLoader(source) {
  if (!usesRoutes.test(source) || declaresRoutes.test(source)) return source;
  return `import * as Routes from ${JSON.stringify(routesModule)};\n${source}`;
};
