@group(0) @binding(0) var<uniform> u:Uniforms;
@group(0) @binding(1) var<storage,read> anchors:array<vec4f>;
struct Label { @builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f }
@vertex fn label_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Label {
  let text=textVertex(v,i);let anchor=anchors[text.anchor];
  var out:Label;
  out.position=vec4f((anchor.x+text.position.x)*2.0/u.view.x-1.0,1.0-(anchor.y+text.position.y)*2.0/u.view.y,anchor.z,1.0);
  if(anchor.w<0.5){out.position=vec4f(2,2,2,1);}
  out.uv=text.uv;out.color=text.color;return out;
}
@fragment fn label_fragment(v:Label)->@location(0) vec4f {return textColor(v.uv,v.color);}
