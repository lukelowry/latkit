import { integer } from '../error.js';

/** Bind with Gpu.colormapLayout and Preparation.colormap. Outputs straight, sRGB-encoded RGBA. */
export function colormapShader(options: { readonly group: number }): string {
  const group = integer(options.group, 'colormap bind group', 0, 3);
  return /* wgsl */ `
@group(${group}) @binding(0) var latkitColormap: texture_2d<f32>;
@group(${group}) @binding(1) var latkitColormapSampler: sampler;
@group(${group}) @binding(2) var<uniform> latkitColormapInfo: vec4u;
fn latkitStraightColor(value:vec4f)->vec4f {
  if(value.a<=0.0){return vec4f(0.0);}
  return vec4f(value.rgb/value.a,value.a);
}
// Explicit integer lookup preserves application-assigned category codes.
fn paletteColor(index:u32)->vec4f {
  if(index>=latkitColormapInfo.y){return vec4f(0.0);}
  return latkitStraightColor(textureLoad(latkitColormap,vec2i(i32(index),0),0));
}
fn colormapColor(value:f32)->vec4f {
  if((bitcast<u32>(value)&0x7f800000u)==0x7f800000u){return vec4f(0.0);}
  var t=clamp(value,0.0,1.0);
  if(latkitColormapInfo.x==1u){t=fract(value);}
  if(latkitColormapInfo.x==2u){
    return paletteColor(min(u32(floor(t*f32(latkitColormapInfo.y))),latkitColormapInfo.y-1u));
  }
  let width=f32(textureDimensions(latkitColormap).x);
  let u=(t*(width-1.0)+0.5)/width;
  return latkitStraightColor(textureSampleLevel(latkitColormap,latkitColormapSampler,vec2f(u,0.5),0.0));
}
`;
}
