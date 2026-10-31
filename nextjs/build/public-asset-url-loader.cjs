// Mirrors Vite's default for `$assets/...` imports: the module's default export is a URL string.
// The proxy sends everything Next does not serve to Rails, which serves `public/` at the root.
const path = require("node:path");

module.exports = function publicAssetUrlLoader() {
  const { publicDir } = this.getOptions();
  const relative = path.relative(publicDir, this.resourcePath).split(path.sep).join("/");
  return `export default ${JSON.stringify(`/${relative}`)};`;
};

module.exports.raw = true;
