declare module '*.wgsl' {
  const source: string;
  export default source;
}
/** A worker module, bundled into its script's source text at build time. */
declare module '*?worker' {
  const source: string;
  export default source;
}
