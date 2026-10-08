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
/** No piece beside a piece of a line, as \`stroke_nearest\` reads its neighbors. */
const STROKE_NONE:f32=1e8;
/** A piece beside it drawn apart, the line cut square across it there, its direction at angle y. */
const STROKE_CUT:f32=4e8;
fn stroke_segment_distance(p:vec2f,a:vec2f,b:vec2f)->f32 {
  let ab=b-a;let t=clamp(dot(p-a,ab)/max(dot(ab,ab),0.000001),0.0,1.0);return length(p-a-ab*t);
}
/**
 * Whether a piece of a line, from (0, 0) to (lengthPx, 0) as \`uv\` runs, is nearer a point than the
 * pieces beside it: the one from \`before\` to its start and the one from its end to \`after\`; an x
 * of STROKE_NONE where none is, and of STROKE_CUT where one drawn apart meets it, cut square across
 * the line's direction there, at angle y. The nearest piece always wins, so a line's glow draws once
 * at each pixel, never doubling where pieces meet.
 */
fn stroke_nearest(uv:vec2f,lengthPx:f32,before:vec2f,after:vec2f)->bool {
  let own=stroke_distance(uv,lengthPx);
  if(before.x>=STROKE_CUT*0.5){if(dot(uv,vec2f(cos(before.y),sin(before.y)))<0.0){return false;}}
  else if(before.x<STROKE_NONE*0.5&&stroke_segment_distance(uv,before,vec2f(0.0))<=own){return false;}
  let end=vec2f(lengthPx,0.0);
  if(after.x>=STROKE_CUT*0.5){if(dot(uv-end,vec2f(cos(after.y),sin(after.y)))>=0.0){return false;}}
  else if(after.x<STROKE_NONE*0.5&&stroke_segment_distance(uv,end,after)<own){return false;}
  return true;
}
`;
}
