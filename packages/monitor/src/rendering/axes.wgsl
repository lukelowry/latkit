struct Screen {size:vec4f}
@group(1) @binding(0) var<uniform> screen:Screen;
@group(1) @binding(1) var<storage,read> lines:array<vec4f>;
struct V {@builtin(position) position:vec4f,@location(0) color:vec4f}
@vertex fn line_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->V {
 let line=lines[instance*2u];let color=lines[instance*2u+1u];let delta=line.zw-line.xy;let lengthPx=max(0.001,length(delta));let n=vec2f(-delta.y,delta.x)/lengthPx;
 let c=array<vec2f,6>(vec2f(0,-0.5),vec2f(1,-0.5),vec2f(0,0.5),vec2f(0,0.5),vec2f(1,-0.5),vec2f(1,0.5))[vertex];
 let p=mix(line.xy,line.zw,c.x)+n*c.y;var v:V;v.position=vec4f(p/screen.size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);v.color=color;return v;
}
@fragment fn line_color(v:V)->@location(0) vec4f{return vec4f(v.color.rgb*v.color.a,v.color.a);}
struct T {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f}
@vertex fn text_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->T {
 let text=textVertex(vertex,instance);var v:T;v.position=vec4f(text.position/screen.size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);v.uv=text.uv;v.color=text.color;return v;
}
@fragment fn text_color(v:T)->@location(0) vec4f{return textColor(v.uv,v.color);}
