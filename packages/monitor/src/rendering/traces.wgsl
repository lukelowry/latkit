// One instance per row and frame step of a field page: the line from each frame to the next.
// One 256-byte slot; the page's rows and frames are its field layout's. A color layer takes each
// line's fixed color; a value layer its color and shade values, which composition colors.
struct View {
 size:vec4f,   // target width and height, pixel ratio, and the focused width
 base:vec4f,   // the trace's color, for rows without one
 focus:vec4f,  // the selected color; alpha -1 brightens instead, and -2 draws unfocused
 plot:vec2f,   // the plot's offset on the canvas
 interpolation:u32,
 x:LatkitChannel, y:LatkitChannel, color:LatkitChannel, width:LatkitChannel, visible:LatkitChannel, shade:LatkitChannel,
}
@group(1) @binding(0) var<uniform> view:View;
struct Point {p:vec2f,color:f32,shade:f32,width:f32,valid:bool}
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f,
 @location(1) length:f32, @location(2) color:f32,@location(3) shade:f32,@location(4) width:f32,@location(5) colored:f32 }
fn point(row:u32,frame:u32)->Point {
 let x=channelNumber(view.x,0u,frame);let y=channelNumber(view.y,row,frame);
 let visible=channelOn(view.visible,row,frame);
 let width=max(channelNumber(view.width,row,frame),view.size.w);
 return Point(vec2f(x,1.0-y)*view.size.xy,channelNumber(view.color,row,frame),channelNumber(view.shade,row,frame),width,visible&&finiteValue(x)&&finiteValue(y));
}
fn corner(vertex:u32)->vec2f {return array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1))[vertex];}
fn stroke(vertex:u32,leg:u32,originalA:Point,originalB:Point)->Vertex {
 var a=originalA;var b=originalB;
 if(view.interpolation!=0u){
   var middle=a;
   if(view.interpolation==1u){middle.p=vec2f(a.p.x,b.p.y);middle.color=b.color;middle.shade=b.shade;middle.width=b.width;}
   else{middle.p=vec2f(b.p.x,a.p.y);}
   if(leg==0u){b=middle;}else{a=middle;}
 }
 var out:Vertex;
 if(!a.valid||!b.valid){out.position=vec4f(2,2,0,1);return out;}
 let delta=b.p-a.p;let lengthPx=length(delta);let direction=select(vec2f(1,0),delta/max(lengthPx,0.0001),lengthPx>0.0001);
 let c=corner(vertex);let width=mix(a.width,b.width,c.x)*view.size.z*0.5;
 let p=mix(a.p,b.p,c.x)+(direction*(c.x*2.0-1.0)+vec2f(-direction.y,direction.x)*c.y)*(width+1.0);
 out.position=vec4f(p/view.size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
 out.uv=vec2f(mix(-width-1.0,lengthPx+width+1.0,c.x),c.y*(width+1.0));out.length=lengthPx;out.width=width;
 // A row without a color value reads NaN; Float16 holds a stored value within ±60000.
 let colored=finiteValue(a.color)&&finiteValue(b.color);
 out.colored=select(0.0,1.0,colored);
 out.color=select(0.0,clamp(mix(a.color,b.color,c.x),-60000.0,60000.0),colored);
 out.shade=mix(a.shade,b.shade,c.x);return out;
}
@vertex fn trace_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let factor=select(2u,1u,view.interpolation==0u);let item=instance/factor;
 let rows=latkitFields.rows;let row=item%rows;let frame=item/rows;
 return stroke(vertex,instance%factor,point(row,frame),point(row,min(frame+1u,latkitFields.frames-1u)));
}
fn coverage(v:Vertex)->f32 {return clamp(1.0-smoothstep(v.width-0.7,v.width+0.7,stroke_distance(v.uv,v.length)),0.0,1.0);}
// A color layer: each line's fixed color, selected or not, shaded as it draws.
@fragment fn color_main(v:Vertex)->@location(0) vec4f {
 let alpha=coverage(v);if(alpha<=0.0){discard;}
 var tint=view.base;
 if(view.focus.a>-1.5){if(view.focus.a>=0.0){tint=view.focus;}else{tint=vec4f(min(vec3f(1),tint.rgb*1.25),tint.a);}}
 tint=shade(ShadeFragment(tint,v.position.xy/view.size.z+view.plot,v.shade));return outputColor(tint,alpha);
}
// A coverage layer: each line's coverage alone, which composition colors by where it lies.
@fragment fn coverage_main(v:Vertex)->@location(0) vec4f {
 let alpha=coverage(v);if(alpha<=0.0){discard;}
 return vec4f(alpha,0.0,0.0,alpha);
}
// A value layer: under each line's coverage, its color value, its shade value, and whether it has
// a color value, premultiplied as colors are so overlapping lines blend.
@fragment fn value_main(v:Vertex)->@location(0) vec4f {
 let alpha=coverage(v);if(alpha<=0.0){discard;}
 return vec4f(v.color*v.colored,clamp(v.shade,-60000.0,60000.0),v.colored,1.0)*alpha;
}
