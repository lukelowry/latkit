struct View {
 size:vec4f, base:vec4f, focus:vec4f, style:vec4f,
 slots:vec4u, mode:vec4u, shape:vec4u, extra:vec4f, origins:vec4f,
 x:array<LatkitScale,4>, y:array<LatkitScale,4>, color:array<LatkitScale,4>
}
@group(1) @binding(0) var<uniform> view:View;
@group(1) @binding(1) var<storage,read> segments:array<vec4u>;
@group(1) @binding(2) var<storage,read> seams:array<vec4f>;
@group(1) @binding(3) var<storage,read> styles:array<vec4f>;
struct Point {p:vec2f,color:f32,shade:f32,valid:bool}
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f,
 @location(1) length:f32, @location(2) color:f32,@location(3) shade:f32 }
fn point(row:u32,frame:u32,lane:u32)->Point {
 let valid=fieldValid(view.slots.x,row,frame);
 let value=fieldFloat(view.slots.x,row,frame,lane);
 let coordinate=fieldFloat(view.slots.y,select(0u,row,view.mode.x==1u),frame,select(0u,lane,view.mode.x==1u));
 let x=scaleMapped(coordinate,true,view.x[lane],0.0);let y=scaleMapped(value,valid,view.y[lane],0.0);
 var visible=true;var color=-1.0;var shade=0.0;
 if(view.mode.x==1u){
   let style=styles[row+view.shape.z];visible=style.y!=0.0;
   color=style.x;shade=style.z;
   if((view.shape.w&2u)!=0u){color=scaleMapped(value,valid,view.color[lane],-1.0);}
   if((view.shape.w&4u)!=0u){shade=value+view.origins[lane];}
 }else{
   if(view.mode.y!=0xffffffffu && fieldPresent(view.mode.y,row,frame)) {
     visible=fieldValid(view.mode.y,row,frame);
     if(visible){if((view.shape.w&1u)!=0u){visible=fieldBool(view.mode.y,row,frame);}else{visible=fieldFloat(view.mode.y,row,frame,0u)!=0.0;}}
   }
   if(view.slots.z!=0xffffffffu){color=scaleMapped(fieldFloat(view.slots.z,row,frame,0u),fieldValid(view.slots.z,row,frame),view.color[0],-1.0);}
   if(view.slots.w!=0xffffffffu && fieldValid(view.slots.w,row,frame)){shade=fieldFloat(view.slots.w,row,frame,0u)+view.origins.x;}
 }
 return Point(vec2f(x,1.0-y)*view.size.xy,color,shade,valid&&visible&&scaleFinite(value)&&scaleFinite(coordinate));
}
fn corner(vertex:u32)->vec2f {return array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1))[vertex];}
fn stroke(vertex:u32,leg:u32,originalA:Point,originalB:Point)->Vertex {
 var a=originalA;var b=originalB;
 if(view.mode.w!=0u){
   var middle=a;
   if(view.mode.w==1u){middle.p=vec2f(a.p.x,b.p.y);middle.color=b.color;middle.shade=b.shade;}
   else{middle.p=vec2f(b.p.x,a.p.y);}
   if(leg==0u){b=middle;}else{a=middle;}
 }
 var out:Vertex;
 if(!a.valid||!b.valid){out.position=vec4f(2,2,0,1);return out;}
 let delta=b.p-a.p;let lengthPx=length(delta);let direction=select(vec2f(1,0),delta/max(lengthPx,0.0001),lengthPx>0.0001);
 let c=corner(vertex);let width=view.style.x*view.extra.y*0.5;
 let p=mix(a.p,b.p,c.x)+(direction*(c.x*2.0-1.0)+vec2f(-direction.y,direction.x)*c.y)*(width+1.0);
 out.position=vec4f(p/view.size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
 out.uv=vec2f(mix(-width-1.0,lengthPx+width+1.0,c.x),c.y*(width+1.0));out.length=lengthPx;
 out.color=select(mix(a.color,b.color,c.x),-1.0,a.color<0.0||b.color<0.0);out.shade=mix(a.shade,b.shade,c.x);return out;
}
@vertex fn raw_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let factor=select(2u,1u,view.mode.w==0u);let item=instance/factor;let row=item%view.shape.x;let frame=item/view.shape.x;
 return stroke(vertex,instance%factor,point(row,frame,0u),point(row,min(frame+1u,view.shape.y-1u),0u));
}
@vertex fn envelope_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let factor=select(2u,1u,view.mode.w==0u);let at=(instance/factor)*2u;let a=segments[at];let b=segments[at+1u];
 return stroke(vertex,instance%factor,point(a.x,a.y,a.z),point(b.x,b.y,b.z));
}
@vertex fn seam_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let factor=select(2u,1u,view.mode.w==0u);let at=(instance/factor)*2u;let a=seams[at];let b=seams[at+1u];
 return stroke(vertex,instance%factor,Point(vec2f(a.x,1.0-a.y)*view.size.xy,a.z,a.w,true),Point(vec2f(b.x,1.0-b.y)*view.size.xy,b.z,b.w,true));
}
@fragment fn fragment_main(v:Vertex)->@location(0) vec4f {
 let distance=stroke_distance(v.uv,v.length);let width=view.style.x*view.extra.y*0.5;
 let alpha=1.0-smoothstep(width-0.7,width+0.7,distance);if(alpha<=0.0){discard;}
 var color=view.base;if(v.color>=0.0 && view.style.w!=0.0){color=colormapColor(v.color);}
 if(view.style.y!=0.0){if(view.focus.a>=0.0){color=view.focus;}else{color=vec4f(min(vec3f(1),color.rgb*1.25),color.a);}}
 color=shade(ShadeFragment(color,v.position.xy/view.extra.y+view.extra.zw,v.shade));return outputColor(color,alpha);
}
