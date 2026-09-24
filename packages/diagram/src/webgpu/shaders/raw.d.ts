/** Allows bundler raw imports for WGSL shader source files. */
declare module '*.wgsl?raw' {
  /** Shader source text emitted by the bundler raw-loader query. */
  const src: string;
  export default src;
}
