struct Screen {size:vec4f,plot:vec4f,history:vec4f,background:vec4f,options:vec4f}
@group(0) @binding(0) var<uniform> screen:Screen;
@group(0) @binding(1) var history:texture_2d<f32>;
@group(0) @binding(2) var focus:texture_2d<f32>;
@group(0) @binding(3) var imageSampler:sampler;
struct V { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn main(@builtin(vertex_index) i:u32)->V {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];var v:V;v.position=vec4f(p,0,1);v.uv=p*vec2f(0.5,-0.5)+vec2f(0.5);return v;
}
@fragment fn background(v:V)->@location(0) vec4f {return vec4f(screen.background.rgb*screen.background.a,screen.background.a);}
@fragment fn color(v:V)->@location(0) vec4f {
 let px=v.uv*screen.size.xy;let uv=(px-screen.plot.xy)/screen.plot.zw;
 var result=vec4f(0);
 if(all(uv>=vec2f(0))&&all(uv<=vec2f(1))){
   let old=uv*screen.history.zw+screen.history.xy;
   var base=vec4f(0);if(all(old>=vec2f(0))&&all(old<=vec2f(1))&&screen.options.z!=0.0){base=textureSampleLevel(history,imageSampler,old,0.0)*screen.options.x;}
   var selected=vec4f(0);if(screen.options.y!=0.0){selected=textureSampleLevel(focus,imageSampler,uv,0.0);}
   let layers=selected+base*(1.0-selected.a);result=layers+result*(1.0-layers.a);
 }
 return result;
}
