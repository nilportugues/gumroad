// next.config.ts turns `$assets/...` images into URL strings, as Vite does; Next's own global
// declaration would type a PNG as an object.
declare module "$assets/*.png" {
  const url: string;
  export default url;
}
