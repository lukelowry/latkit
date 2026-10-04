// One instance per row and frame step of a field page: the line from each frame to the next.
struct View {
 size:vec4f, base:vec4f, focus:vec4f,
 style:vec4f,  // width, focused, pixel ratio, colored
 slots:vec4u,  // value, coordinate, color, shade fields
 mode:vec4u,   // visible field, unused, interpolation, unused
 shape:vec4u,  // rows, frames
 extra:vec4f,  // shade origin, unused, plot offset
 x:LatkitScale, y:LatkitScale, color:LatkitScale,
}
@group(1) @binding(0) var<uniform> view:View;
struct Point {p:vec2f,color:f32,shade:f32,valid:bool}
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f,
 @location(1) length:f32, @location(2) color:f32,@location(3) shade:f32 }
fn point(row:u32,frame:u32)->Point {
 let valid=fieldValid(view.slots.x,row,frame);
 let value=fieldFloat(view.slots.x,row,frame,0u);
 let coordinate=fieldFloat(view.slots.y,0u,frame,0u);
 let x=scaleMapped(coordinate,true,view.x,0.0);let y=scaleMapped(value,valid,view.y,0.0);
 let visible=fieldNumber(view.mode.x,row,frame,0.0,1.0)!=0.0;
 let color=fieldScaled(view.slots.z,row,frame,view.color,-1.0);
 let shade=fieldNumber(view.slots.w,row,frame,view.extra.x,0.0);
 return Point(vec2f(x,1.0-y)*view.size.xy,color,shade,valid&&visible&&scaleFinite(value)&&scaleFinite(coordinate));
}
fn corner(vertex:u32)->vec2f {return array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1))[vertex];}
fn stroke(vertex:u32,leg:u32,originalA:Point,originalB:Point)->Vertex {
 var a=originalA;var b=originalB;
 if(view.mode.z!=0u){
   var middle=a;
   if(view.mode.z==1u){middle.p=vec2f(a.p.x,b.p.y);middle.color=b.color;middle.shade=b.shade;}
   else{middle.p=vec2f(b.p.x,a.p.y);}
   if(leg==0u){b=middle;}else{a=middle;}
 }
 var out:Vertex;
 if(!a.valid||!b.valid){out.position=vec4f(2,2,0,1);return out;}
 let delta=b.p-a.p;let lengthPx=length(delta);let direction=select(vec2f(1,0),delta/max(lengthPx,0.0001),lengthPx>0.0001);
 let c=corner(vertex);let width=view.style.x*view.style.z*0.5;
 let p=mix(a.p,b.p,c.x)+(direction*(c.x*2.0-1.0)+vec2f(-direction.y,direction.x)*c.y)*(width+1.0);
 out.position=vec4f(p/view.size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
 out.uv=vec2f(mix(-width-1.0,lengthPx+width+1.0,c.x),c.y*(width+1.0));out.length=lengthPx;
 out.color=select(mix(a.color,b.color,c.x),-1.0,a.color<0.0||b.color<0.0);out.shade=mix(a.shade,b.shade,c.x);return out;
}
@vertex fn trace_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let factor=select(2u,1u,view.mode.z==0u);let item=instance/factor;
 let row=item%view.shape.x;let frame=item/view.shape.x;
 return stroke(vertex,instance%factor,point(row,frame),point(row,min(frame+1u,view.shape.y-1u)));
}
@fragment fn fragment_main(v:Vertex)->@location(0) vec4f {
 let distance=stroke_distance(v.uv,v.length);let width=view.style.x*view.style.z*0.5;
 let alpha=1.0-smoothstep(width-0.7,width+0.7,distance);if(alpha<=0.0){discard;}
 var color=view.base;if(v.color>=0.0 && view.style.w!=0.0){color=colormapColor(v.color);}
 if(view.style.y!=0.0){if(view.focus.a>=0.0){color=view.focus;}else{color=vec4f(min(vec3f(1),color.rgb*1.25),color.a);}}
 color=shade(ShadeFragment(color,v.position.xy/view.style.z+view.extra.zw,v.shade));return outputColor(color,alpha);
}
