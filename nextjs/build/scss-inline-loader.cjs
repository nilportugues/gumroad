// Vite's `import css from "./x.scss?inline"`: the compiled stylesheet as the module's default export string.
const path = require("node:path");

module.exports = function scssInlineLoader() {
  const sass = require("sass");
  const { css, loadedUrls } = sass.compile(this.resourcePath, { loadPaths: [path.dirname(this.resourcePath)], quietDeps: true, silenceDeprecations: ["import", "global-builtin", "color-functions", "mixed-decls"] });
  for (const url of loadedUrls) if (url.protocol === "file:") this.addDependency(require("node:url").fileURLToPath(url));
  return `export default ${JSON.stringify(css)};`;
};
