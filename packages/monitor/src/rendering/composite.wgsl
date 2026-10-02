// History and focus images, each mapped from its own window and values into the camera's.
struct Screen {size:vec4f,plot:vec4f,history:vec4f,focus:vec4f,background:vec4f,options:vec4f}
@group(0) @binding(0) var<uniform> screen:Screen;
@group(0) @binding(1) var history:texture_2d<f32>;
@group(0) @binding(2) var focus:texture_2d<f32>;
@group(0) @binding(3) var imageSampler:sampler;
struct V { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn main(@builtin(vertex_index) i:u32)->V {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];var v:V;v.position=vec4f(p,0,1);v.uv=p*vec2f(0.5,-0.5)+vec2f(0.5);return v;
}
fn layer(image:texture_2d<f32>,uv:vec2f,map:vec4f)->vec4f {
 let at=uv*map.zw+map.xy;
 if(any(at<vec2f(0))||any(at>vec2f(1))){return vec4f(0);}
 return textureSampleLevel(image,imageSampler,at,0.0);
}
@fragment fn background(v:V)->@location(0) vec4f {return vec4f(screen.background.rgb*screen.background.a,screen.background.a);}
@fragment fn color(v:V)->@location(0) vec4f {
 let px=v.uv*screen.size.xy;let uv=(px-screen.plot.xy)/screen.plot.zw;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return vec4f(0);}
 var base=vec4f(0);if(screen.options.z!=0.0){base=layer(history,uv,screen.history)*screen.options.x;}
 var selected=vec4f(0);if(screen.options.y!=0.0){selected=layer(focus,uv,screen.focus);}
 return selected+base*(1.0-selected.a);
}
