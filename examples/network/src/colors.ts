import {
  createGpu,
  colormaps,
  colormapCss,
  createColormap,
  reverseColormap,
  kit,
  type Colormap,
  type Gpu,
  type ViewConfig,
  type ViewEvents,
} from '@latkit/gpu';
import './colors.css';

const catalog = document.getElementById('catalog')!;
const status = document.getElementById('status')!;
const maps = [
  ...Object.entries(colormaps),
  [
    'alpha',
    createColormap({
      label: 'Alpha diagnostic',
      colors: [
        [1, 0, 0, 0],
        [0, 0, 1, 1],
      ],
    }),
  ] as const,
];
const rows = maps.map(([name, map]) => {
  const row = document.createElement('div');
  row.className = 'palette-row';
  row.dataset.kind = map.kind;
  const label = document.createElement('div');
  label.className = 'palette-name';
  label.append(document.createTextNode(map.label ?? name));
  const kind = document.createElement('small');
  kind.textContent = map.kind;
  label.append(kind);
  const cpu = document.createElement('canvas');
  cpu.width = 512;
  cpu.height = 1;
  cpu.setAttribute('aria-label', `${map.label} CPU preview`);
  const css = document.createElement('div');
  css.className = 'palette-css';
  css.setAttribute('aria-label', `${map.label} CSS preview`);
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', `${map.label} GPU preview`);
  row.append(label, cpu, css, canvas);
  catalog.append(row);
  return { row, map: map as Colormap, cpu, css, canvas, view: undefined as Preview | undefined };
});
let reversed = false;
function selected(map: Colormap): Colormap {
  return reversed ? reverseColormap(map) : map;
}
function update(): void {
  for (const item of rows) {
    const map = selected(item.map);
    item.css.style.backgroundImage = colormapCss(map, { direction: 'to right' });
    const context = item.cpu.getContext('2d')!;
    const pixels = context.createImageData(512, 1);
    for (let x = 0; x < 512; x++) {
      const color = kit.sampleColormap(map, (x + 0.5) / 512);
      for (let c = 0; c < 4; c++) pixels.data[x * 4 + c] = Math.round(color[c]! * 255);
    }
    context.putImageData(pixels, 0, 0);
    item.view?.set({ colormap: map });
  }
}
const reverse = document.getElementById('reverse')!;
reverse.onclick = () => {
  reversed = !reversed;
  reverse.setAttribute('aria-pressed', String(reversed));
  update();
};
const background = document.getElementById('background')!;
background.onclick = () =>
  background.setAttribute('aria-pressed', String(document.body.classList.toggle('light')));
const kind = document.getElementById('kind') as HTMLSelectElement;
kind.onchange = () => {
  for (const item of rows) item.row.hidden = kind.value !== 'all' && item.map.kind !== kind.value;
};
update();

interface PreviewConfig extends ViewConfig {
  readonly colormap: Colormap;
}
/** What one prepared frame draws. */
interface Drawn {
  readonly binding: GPUBindGroup;
  readonly pipeline: GPURenderPipeline;
}
/** A colormap swept left to right by the shared WGSL sampler. */
class Preview extends kit.BaseView<PreviewConfig, ViewEvents, PreviewConfig, Drawn> {
  constructor(
    gpu: Gpu,
    config: PreviewConfig,
    private readonly module: GPUShaderModule,
    private readonly layout: GPUPipelineLayout,
  ) {
    super(gpu, config);
    this.start();
  }
  protected configure(): void {
    this.invalidate();
  }
  protected async prepare(frame: kit.Preparation): Promise<Drawn> {
    return {
      binding: frame.colormap(this.frameConfig.colormap),
      pipeline: await this.gpu.renderPipeline({
        layout: this.layout,
        vertex: { module: this.module, entryPoint: 'vertex' },
        fragment: {
          module: this.module,
          entryPoint: 'fragment',
          targets: [{ format: frame.format }],
        },
      }),
    };
  }
  protected encode(frame: kit.Encoding, drawn: Drawn): void {
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(drawn.pipeline);
    pass.setBindGroup(0, drawn.binding);
    pass.draw(3);
    pass.end();
  }
  protected release(): void {}
}

async function main(): Promise<void> {
  const gpu = await createGpu();
  const module = gpu.device.createShaderModule({
    code:
      kit.colormapShader({ group: 0 }) +
      `
    struct Vertex { @builtin(position) position:vec4f, @location(0) t:f32 }
    @vertex fn vertex(@builtin(vertex_index) id:u32)->Vertex {
      let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[id];
      return Vertex(vec4f(p,0,1),(p.x+1.0)*0.5);
    }
    @fragment fn fragment(v:Vertex)->@location(0) vec4f {
      let color=colormapColor(v.t);
      return vec4f(color.rgb*color.a,color.a);
    }
  `,
  });
  const layout = gpu.device.createPipelineLayout({ bindGroupLayouts: [gpu.colormapLayout] });
  let rendered = 0;
  for (const item of rows) {
    const view = new Preview(
      gpu,
      { canvas: item.canvas, colormap: selected(item.map) },
      module,
      layout,
    );
    view.on('error', fail);
    const off = view.on('frame', () => {
      off();
      status.textContent = `${++rendered} / ${rows.length} GPU previews ready`;
    });
    item.view = view;
  }
  Object.assign(window, { colorGallery: { gpu, rows } });
  const dispose = (): void => {
    for (const item of rows) item.view?.destroy();
    gpu.destroy();
  };
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
  });
  import.meta.hot?.dispose(dispose);
}
function fail(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.setAttribute('role', 'alert');
  console.error(error);
}
void main().catch(fail);
