/**
 * Custom markers' WGSL, translated to GLSL for WebGL2. latkit's WebAssembly carries no WGSL
 * compiler, so the translator is a module of its own, loaded the first time a page draws a custom
 * marker.
 */

let translator: Promise<(wgsl: string) => string> | undefined;

/**
 * Translates the WGSL of a custom marker's shader, loading the translator on first use. Resolves to
 * a JSON object of each entry point's GLSL, or of the `error` that stopped the translation. A
 * translator that fails to load is loaded again on the next call.
 */
export function translate(wgsl: string): Promise<string> {
  translator ??= import('../pkg/latkit_wgsl.js').then(async (module) => {
    await module.default();
    return module.translate;
  });
  return translator.then(
    (translate) => translate(wgsl),
    (cause: unknown) => {
      translator = undefined;
      throw cause;
    },
  );
}
