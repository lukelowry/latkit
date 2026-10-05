@group(0) @binding(0) var<uniform> u:Uniforms;
@group(0) @binding(1) var<storage,read> anchors:array<vec4f>;
struct Label { @builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f }
@vertex fn label_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Label {
  let text=textVertex(v,i);let anchor=latkitAnchor(anchors[text.anchor]);
  let p=anchor.position+text.position;
  var out:Label;
  out.position=vec4f(p.x*2.0/u.view.x-1.0,1.0-p.y*2.0/u.view.y,anchor.depth,1.0);
  if(!anchor.shown){out.position=vec4f(2,2,2,1);}
  out.uv=text.uv;out.color=text.color;return out;
}
struct LabelOut { @location(0) color:vec4f, @builtin(frag_depth) depth:f32 }
// A halo of the ground the label lies on keeps lines from cutting through it, and the globe's
// surface never cuts the label.
@fragment fn label_fragment(v:Label)->LabelOut {
  var out:LabelOut;out.color=textColor(v.uv,v.color,vec4f(u.surface.rgb,1.0),u.labelHaloPx);
  out.depth=billboardDepth(v.position,u);return out;
}
