/** Allows bundler raw imports for WGSL shader source files. */
declare module '*.wgsl?raw' {
  /** Shader source text emitted by the bundler raw-loader query. */
  const src: string;
  export default src;
}

/** Allows bundler raw imports for TypeScript source snippets. */
declare module '*.ts?raw' {
  /** Source text emitted by the bundler raw-loader query. */
  const src: string;
  export default src;
}
