// Stands in for unplugin-auto-import in vite.config.ts, which injects the js-routes `Routes` global
// into any module that references it without importing it.
// Turbopack only resolves bare specifiers here; next.config.ts aliases this one.
const routesModule = "$next-routes";
const usesRoutes = /(^|[^.\w$])Routes\./m;
const declaresRoutes = /\b(import|const|let|var|function)\b[^;\n]*\bRoutes\b/;

module.exports = function routesAutoImportLoader(source) {
  if (!usesRoutes.test(source) || declaresRoutes.test(source)) return source;
  return `import * as Routes from ${JSON.stringify(routesModule)};\n${source}`;
};
