export type ClipPoint = readonly [number, number, number, number];
/** Clip a homogeneous segment to WebGPU near/far planes before pixel expansion. */
export function clipStroke(a: ClipPoint, b: ClipPoint): readonly [number, number] | null {
  let lo = 0,
    hi = 1;
  for (const [x, y] of [
    [a[2], b[2]],
    [a[3] - a[2], b[3] - b[2]],
    [a[3] - 1e-9, b[3] - 1e-9],
  ]) {
    if (x < 0 && y < 0) return null;
    if (x < 0) lo = Math.max(lo, x / (x - y));
    else if (y < 0) hi = Math.min(hi, x / (x - y));
  }
  return lo <= hi ? [lo, hi] : null;
}
/** Shared round-cap/round-join stroke primitives; dimensions are CSS pixels. */
export function strokeShader(): string {
  return `
fn stroke_clip(a:vec4f,b:vec4f)->vec2f {
  var range=vec2f(0.0,1.0);
  let x=vec3f(a.z,a.w-a.z,a.w-0.000000001);let y=vec3f(b.z,b.w-b.z,b.w-0.000000001);
  for(var i=0u;i<3u;i++){
    if(x[i]<0.0&&y[i]<0.0){return vec2f(1.0,0.0);}
    if(x[i]<0.0){range.x=max(range.x,x[i]/(x[i]-y[i]));}
    else if(y[i]<0.0){range.y=min(range.y,x[i]/(x[i]-y[i]));}
  }
  return range;
}
fn stroke_distance(uv:vec2f,lengthPx:f32)->f32 { return length(vec2f(uv.x-clamp(uv.x,0.0,lengthPx),uv.y)); }
fn stroke_dash(distancePx:f32,periodPx:f32)->bool {return fract(max(distancePx,0.0)/max(1.0,periodPx))<=0.55;}
`;
}
