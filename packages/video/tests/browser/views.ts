import { kit, type Gpu, type View, type ViewConfig, type ViewEvents } from '@latkit/gpu';
interface Hooks {
  prepare?(frame: kit.Preparation): Promise<void> | void;
  encode(frame: kit.Encoding): void;
  pending?(): Promise<void> | undefined;
  release?(): void;
}
class HookView extends kit.BaseView<ViewConfig, ViewEvents> {
  constructor(
    gpu: Gpu,
    private readonly hooks: Hooks,
  ) {
    super(gpu, {});
    this.start();
  }
  protected configure(): void {}
  protected async prepare(frame: kit.Preparation): Promise<void> {
    await this.hooks.prepare?.(frame);
  }
  protected encode(frame: kit.Encoding): void {
    this.hooks.encode(frame);
  }
  protected get pending(): Promise<void> | undefined {
    return this.hooks.pending?.();
  }
  protected release(): void {
    this.hooks.release?.();
  }
}
/** A view drawn by the given hooks, for checks. */
export function view(gpu: Gpu, hooks: Hooks): View {
  return new HookView(gpu, hooks);
}
