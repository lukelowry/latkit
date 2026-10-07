// One instance per row and frame step of a field page: the line from each frame to the next.
// One 256-byte slot; the page's rows and frames are its field layout's. A color layer takes each
// line's fixed color; a value layer its color and shade values, which composition colors.
struct View {
 size:vec4f,   // target width and height, pixel ratio, and a selected line's glow in CSS pixels
 base:vec4f,   // the trace's color, for rows without one
 focus:vec4f,  // the selected color; alpha -1 brightens instead, and -2 draws unfocused
 plot:vec2f,   // the plot's offset on the canvas
 // The steps in the low two bits; 4 when the page's first drawn frame joins lines drawn before, and
 // 8 when its first frame only shows where those came from, drawing nothing.
 interpolation:u32,
 x:LatkitChannel, y:LatkitChannel, color:LatkitChannel, width:LatkitChannel, visible:LatkitChannel, shade:LatkitChannel,
}
@group(1) @binding(0) var<uniform> view:View;
struct Point {p:vec2f,color:f32,shade:f32,width:f32,valid:bool}
// A selected line's piece also carries where the pieces beside it start and end, as `uv` runs.
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f,
 @location(1) length:f32, @location(2) color:f32,@location(3) shade:f32,@location(4) width:f32,@location(5) colored:f32,
 @location(6) @interpolate(flat) beside:vec4f }
fn point(row:u32,frame:u32)->Point {
 let x=channelNumber(view.x,0u,frame);let y=channelNumber(view.y,row,frame);
 let visible=channelOn(view.visible,row,frame);
 let width=channelNumber(view.width,row,frame);
 return Point(vec2f(x,1.0-y)*view.size.xy,channelNumber(view.color,row,frame),channelNumber(view.shade,row,frame),width,visible&&finiteValue(x)&&finiteValue(y));
}
fn corner(vertex:u32)->vec2f {return array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1))[vertex];}
fn stroke(vertex:u32,leg:u32,originalA:Point,originalB:Point)->Vertex {
 var a=originalA;var b=originalB;
 let steps=view.interpolation&3u;
 if(steps!=0u){
   var middle=a;
   if(steps==1u){middle.p=vec2f(a.p.x,b.p.y);middle.color=b.color;middle.shade=b.shade;middle.width=b.width;}
   else{middle.p=vec2f(b.p.x,a.p.y);}
   if(leg==0u){b=middle;}else{a=middle;}
 }
 var out:Vertex;
 if(!a.valid||!b.valid){out.position=vec4f(2,2,0,1);return out;}
 let delta=b.p-a.p;let lengthPx=length(delta);let direction=select(vec2f(1,0),delta/max(lengthPx,0.0001),lengthPx>0.0001);
 let c=corner(vertex);let width=mix(a.width,b.width,c.x)*view.size.z*0.5;
 // A selected line's quad reaches its glow.
 let extent=width+1.0+view.size.w*view.size.z;
 let p=mix(a.p,b.p,c.x)+(direction*(c.x*2.0-1.0)+vec2f(-direction.y,direction.x)*c.y)*extent;
 out.position=vec4f(p/view.size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
 out.uv=vec2f(mix(-extent,lengthPx+extent,c.x),c.y*extent);out.length=lengthPx;out.width=width;
 // A row without a color value reads NaN; Float16 holds a stored value within ±60000.
 let colored=finiteValue(a.color)&&finiteValue(b.color);
 out.colored=select(0.0,1.0,colored);
 out.color=select(0.0,clamp(mix(a.color,b.color,c.x),-60000.0,60000.0),colored);
 out.shade=mix(a.shade,b.shade,c.x);return out;
}
/** Where a step turns between two samples, as `stroke` draws it. */
fn turn(a:Point,b:Point,steps:u32)->vec2f {return select(vec2f(b.p.x,a.p.y),vec2f(a.p.x,b.p.y),steps==1u);}
@vertex fn trace_main(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let steps=view.interpolation&3u;
 let factor=select(2u,1u,steps==0u);let item=instance/factor;let leg=instance%factor;
 let rows=latkitFields.rows;let row=item%rows;let frame=item/rows;let last=latkitFields.frames-1u;
 let joined=(view.interpolation&4u)!=0u;let first=select(0u,1u,(view.interpolation&8u)!=0u);
 let a=point(row,frame);var b=point(row,min(frame+1u,last));
 // A sample between gaps draws as a dot, unless a line drawn before reaches it. A step after
 // holds it instead.
 var lone=last==0u;
 if(leg==0u&&steps!=2u&&a.valid&&!b.valid){
   var before=joined;
   if(frame>0u){before=point(row,frame-1u).valid;}
   if(!before){b=a;lone=true;}
 }
 var out=stroke(vertex,leg,a,b);
 // A selected line glows once at each pixel, from the piece nearest it; a dot glows whole. Pages draw
 // apart, so where one ends the line is cut square across it, and the next page cuts it there too.
 if(view.size.w>0.0&&out.position.x<2.0){
   out.beside=vec4f(STROKE_NONE,0.0,STROKE_NONE,0.0);
   let start=select(a.p,turn(a,b,steps),leg==1u);let end=select(b.p,turn(a,b,steps),leg==0u&&steps!=0u);
   let span=end-start;let size=length(span);
   // A leg of no length glows nowhere: the legs beside it cover its point.
   if(!lone&&size<=0.0001){out.beside=vec4f(0.0);}
   if(!lone&&size>0.0001){
     let own=span/size;let across=vec2f(-own.y,own.x);
     var before=vec2f(STROKE_NONE,0.0);var after=vec2f(STROKE_NONE,0.0);
     if(leg==1u){before=vec2f(dot(a.p-start,own),dot(a.p-start,across));}
     else if(frame>first){
       let earlier=point(row,frame-1u);
       let back=select(earlier.p,turn(earlier,a,steps),steps!=0u)-start;
       if(earlier.valid){before=vec2f(dot(back,own),dot(back,across));}
     }
     else if(joined){
       // The piece before was drawn in another page, and cut square across its own direction.
       var arrived=own;
       if(frame>0u){
         let earlier=point(row,frame-1u);
         let back=a.p-select(earlier.p,turn(earlier,a,steps),steps!=0u);
         if(earlier.valid&&length(back)>0.0001){arrived=normalize(back);}
       }
       before=vec2f(STROKE_CUT,atan2(dot(arrived,across),dot(arrived,own)));
     }
     if(leg==0u&&steps!=0u){after=vec2f(dot(b.p-start,own),dot(b.p-start,across));}
     else if(frame+1u<last){
       let later=point(row,frame+2u);
       let ahead=select(later.p,turn(b,later,steps),steps!=0u)-start;
       if(later.valid){after=vec2f(dot(ahead,own),dot(ahead,across));}
     }
     else{after=vec2f(STROKE_CUT,0.0);}
     out.beside=vec4f(before,after);
   }
 }
 return out;
}
// A line's coverage, and a selected line's glow past it, once at each pixel.
fn coverage(v:Vertex)->f32 {
 let d=stroke_distance(v.uv,v.length);
 let line=clamp(1.0-smoothstep(v.width-0.7,v.width+0.7,d),0.0,1.0);
 if(view.size.w<=0.0||!stroke_nearest(v.uv,v.length,v.beside.xy,v.beside.zw)){return line;}
 return max(line,glowAlpha(d-v.width,view.size.w*view.size.z));
}
// A color layer's line in `color`, selected or not, shaded as it draws.
fn painted(v:Vertex,color:vec4f,alpha:f32)->vec4f {
 var tint=color;
 if(view.focus.a>-1.5){if(view.focus.a>=0.0){tint=view.focus;}else{tint=vec4f(min(vec3f(1),tint.rgb*1.25),tint.a);}}
 tint=shade(ShadeFragment(tint,v.position.xy/view.size.z+view.plot,v.shade));return outputColor(tint,alpha);
}
// A color layer: each line's fixed color.
@fragment fn color_main(v:Vertex)->@location(0) vec4f {
 let alpha=coverage(v);if(alpha<=0.0){discard;}
 return painted(v,view.base,alpha);
}
// A color layer's line in a look baked in, past the looks an image keeps apart.
@fragment fn bake_main(v:Vertex)->@location(0) vec4f {
 let alpha=coverage(v);if(alpha<=0.0){discard;}
 return painted(v,select(view.base,colormapColor(v.color),v.colored>0.0),alpha);
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
