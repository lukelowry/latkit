/**
 * Custom markers' WGSL, translated to GLSL for WebGL2. latkit's WebAssembly carries no WGSL
 * compiler, so the translator is a module of its own, loaded the first time a page draws a custom
 * marker.
 */

/**
 * Returns the translator of custom markers' shaders, which loads its WebAssembly from `wasm` on
 * first use, or from beside its module without one. It resolves to a JSON object of each entry
 * point's GLSL, or of the `error` that stopped the translation. A translator that fails to load is
 * loaded again on the next call.
 */
export function translator(wasm?: string | WebAssembly.Module): (wgsl: string) => Promise<string> {
  let loading: Promise<(wgsl: string) => string> | undefined;
  return (wgsl) => {
    loading ??= import('../pkg/latkit_wgsl.js').then(async (module) => {
      await module.default(wasm === undefined ? undefined : { module_or_path: wasm });
      return module.translate;
    });
    return loading.then(
      (translate) => translate(wgsl),
      (cause: unknown) => {
        loading = undefined;
        throw cause;
      },
    );
  };
}
