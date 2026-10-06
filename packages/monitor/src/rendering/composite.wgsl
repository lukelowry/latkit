// A layer of history, mapped from its own window and values into the camera's. A color layer
// holds premultiplied colors. A coverage layer holds coverage alone: its value is where it lies. A
// value layer holds, premultiplied by coverage, the color value stored against its domain, the
// shade value, how much carries a color value, and coverage.
struct Layer {
 size:vec4f,   // canvas width and height, pixel ratio, and the layer's opacity
 plot:vec4f,   // the plot's offset and size
 map:vec4f,    // the image's uv at the plot's: offset, then scale
 base:vec4f,   // the color of values without a color value, or of all of them without a domain
 focus:vec4f,  // the selected color; alpha -1 brightens instead, and -2 draws unselected
 look:vec4f,   // a value's place in the colormap is x*value+y; z colors by it, w clamps
}
@group(0) @binding(0) var<uniform> layer:Layer;
@group(0) @binding(1) var history:texture_2d<f32>;
@group(0) @binding(2) var historySampler:sampler;
struct V { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn main(@builtin(vertex_index) i:u32)->V {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];var v:V;v.position=vec4f(p,0,1);v.uv=p*vec2f(0.5,-0.5)+vec2f(0.5);return v;
}
fn plotUv(v:V)->vec2f {return (v.uv*layer.size.xy-layer.plot.xy)/layer.plot.zw;}
fn texel(uv:vec2f)->vec4f {
 let at=uv*layer.map.zw+layer.map.xy;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))||any(at<vec2f(0))||any(at>vec2f(1))){return vec4f(0);}
 return textureSampleLevel(history,historySampler,at,0.0);
}
// The colormap's color for a value, which `look` places.
fn placed(value:f32)->vec4f {
 var t=value*layer.look.x+layer.look.y;
 if(layer.look.w!=0.0){t=clamp(t,0.0,1.0);}
 return colormapColor(t);
}
// A look's color as the screen shows it: selected, shaded, over `coverage`.
fn shown(color:vec4f,v:V,shadeValue:f32,coverage:f32)->vec4f {
 var tint=color;
 if(layer.focus.a>-1.5){if(layer.focus.a>=0.0){tint=layer.focus;}else{tint=vec4f(min(vec3f(1),tint.rgb*1.25),tint.a);}}
 tint=shade(ShadeFragment(tint,v.position.xy/layer.size.z,shadeValue));
 let alpha=tint.a*min(coverage,1.0)*layer.size.w;
 return vec4f(tint.rgb*alpha,alpha);
}
// A color layer fades, and draws as it is.
@fragment fn color_layer(v:V)->@location(0) vec4f {return texel(plotUv(v))*layer.size.w;}
// A coverage layer's value is its height in the plot, which `look` places from top to bottom.
@fragment fn coverage_layer(v:V)->@location(0) vec4f {
 let uv=plotUv(v);let c=texel(uv).r;if(c<=0.0){return vec4f(0);}
 return shown(placed(uv.y),v,0.0,c);
}
// A value layer's stored value, colored where it carries one and in the base color where not.
@fragment fn value_layer(v:V)->@location(0) vec4f {
 let s=texel(plotUv(v));if(s.a<=0.0){return vec4f(0);}
 var tint=layer.base;
 if(layer.look.z!=0.0&&s.b>0.0){tint=mix(layer.base,placed(s.r/s.b),clamp(s.b/s.a,0.0,1.0));}
 return shown(tint,v,s.g/s.a,s.a);
}
