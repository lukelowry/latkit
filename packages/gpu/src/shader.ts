/** Report compiler diagnostics consistently for a failed asynchronous pipeline build. */
export async function shaderFailure(
  label: string,
  modules: readonly GPUShaderModule[],
  cause: unknown,
): Promise<Error> {
  const lines: string[] = [];
  for (const module of modules) {
    const info = await module.getCompilationInfo?.();
    for (const message of info?.messages ?? []) {
      if (message.type === 'error')
        lines.push(`${module.label}:${message.lineNum}:${message.linePos} ${message.message}`);
    }
  }
  const detail = lines.length
    ? lines.join('\n')
    : cause instanceof Error
      ? cause.message
      : String(cause);
  return new Error(`${label} shader build failed:\n${detail}`, { cause });
}
