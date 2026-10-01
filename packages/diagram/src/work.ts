import { GpuError } from '@latkit/gpu';
/** Cooperative CPU preparation. Independent jobs own their deadlines and scratch. */
export class Work {
  private readonly started = performance.now();
  private nextYield = this.started + 8;
  constructor(
    private readonly signal: AbortSignal,
    private readonly maxMs = 30000,
  ) {}
  check(): void {
    this.signal.throwIfAborted();
    if (performance.now() - this.started > this.maxMs)
      throw new GpuError('resource-limit', 'Diagram preparation time exceeded');
  }
  async step(): Promise<void> {
    this.check();
    if (performance.now() >= this.nextYield) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.nextYield = performance.now() + 8;
      this.check();
    }
  }
}
