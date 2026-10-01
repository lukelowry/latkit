import { GpuError, type Gpu } from '@latkit/gpu';
interface Loss {
  readonly listeners: Set<AbortController>;
  error?: GpuError;
}
const observers = new WeakMap<Gpu, Loss>();
export function observeLoss(gpu: Gpu, stop: AbortController): () => void {
  let loss = observers.get(gpu);
  if (!loss) {
    loss = { listeners: new Set() };
    observers.set(gpu, loss);
    const own = loss;
    void gpu.lost.then((info) => {
      own.error = new GpuError('unavailable', `Video GPU lost: ${info.message}`);
      for (const listener of own.listeners) listener.abort(own.error);
      own.listeners.clear();
    });
  }
  if (loss.error) stop.abort(loss.error);
  else loss.listeners.add(stop);
  return () => {
    loss.listeners.delete(stop);
  };
}
