import {
  createGpu,
  createCanvasView,
  colormaps,
  colormapShader,
  colormapCss,
  createColormap,
  sampleColormap,
  reverseColormap,
  type Colormap,
  type Renderer,
  type CanvasView,
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
  return { row, map: map as Colormap, cpu, css, canvas, view: undefined as CanvasView | undefined };
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
      const color = sampleColormap(map, (x + 0.5) / 512);
      for (let c = 0; c < 4; c++) pixels.data[x * 4 + c] = Math.round(color[c]! * 255);
    }
    context.putImageData(pixels, 0, 0);
    item.view?.request();
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

async function main(): Promise<void> {
  const gpu = await createGpu();
  const module = gpu.device.createShaderModule({
    code:
      colormapShader({ group: 0 }) +
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
    let binding: GPUBindGroup, pipeline: GPURenderPipeline;
    let counted = false;
    const renderer: Renderer = {
      async prepare(frame) {
        binding = frame.colormap(selected(item.map));
        pipeline = await gpu.renderPipeline({
          layout,
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: frame.format }] },
        });
      },
      encode(frame) {
        const pass = frame.encoder.beginRenderPass({
          colorAttachments: [
            { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, binding);
        pass.draw(3);
        pass.end();
      },
      destroy() {},
    };
    item.view = createCanvasView({
      gpu,
      canvas: item.canvas,
      renderer,
      onError: fail,
      onRendered: () => {
        if (!counted) {
          counted = true;
          rendered++;
        }
        status.textContent = `${rendered} / ${rows.length} GPU previews ready`;
      },
    });
    item.view.request();
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
