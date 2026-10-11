/** An edge's ends: their world points, and their longitudes and latitudes from the camera center. */
struct Ends { a: vec3f, b: vec3f, ra: vec2f, rb: vec2f }
/** A world point as a direction from the globe's center: on a plane, its longitude and latitude's. */
fn curve_unit(p:vec3f,u:Uniforms)->vec3f {
  if(u.view.w>1.5){return normalize(p+vec3f(0,0,1));}
  var y=p.y+u.center.y;
  // The mercator plane holds a latitude where mercator stretches it, from the center's place.
  if(u.geo.w>1.5){y=projection_latitude(p.y+u.pose.z);}
  let lon=(p.x+u.center.x)*0.017453292519943295;let lat=y*0.017453292519943295;
  return vec3f(cos(lat)*cos(lon),sin(lat),cos(lat)*sin(lon));
}
/** The angle between two world points, seen from the globe's center, in radians. */
fn curve_angle(a:vec3f,b:vec3f,u:Uniforms)->f32 {return acos(clamp(dot(curve_unit(a,u),curve_unit(b,u)),-1.0,1.0));}
/** The great circle between two world points, `t` of the way along. */
fn curve_geodesic(a:vec3f,b:vec3f,t:f32,u:Uniforms)->vec3f {
  let x=curve_unit(a,u);let y=curve_unit(b,u);let cosine=clamp(dot(x,y),-1.0,1.0);
  var unit=normalize(mix(x,y,t));
  if(cosine<0.99985){
    var tangent=y-x*cosine;var n=length(tangent);
    if(n<0.000001){var north=vec3f(0,1,0);var east=vec3f(1,0,0);
    if(u.view.w>1.5){north=vec3f(0,u.geo.y,u.geo.x);east=vec3f(-u.center.z,-u.center.w*u.geo.x,u.center.w*u.geo.y);}
    let axis=select(east,north,abs(dot(x,north))<0.9);tangent=axis-x*dot(axis,x);n=length(tangent);}
    let angle=acos(cosine)*t;unit=x*cos(angle)+tangent*(sin(angle)/n);
  }
  if(u.view.w>1.5){return unit*mix(length(a+vec3f(0,0,1)),length(b+vec3f(0,0,1)),t)-vec3f(0,0,1);}
  let latitude=asin(clamp(unit.y,-1.0,1.0))*57.295779513;
  var plane=latitude-u.center.y;
  if(u.geo.w>1.5){plane=projection_mercator(latitude)-u.pose.z;}
  return vec3f(atan2(unit.z,unit.x)*57.295779513-u.center.x,plane,mix(a.z,b.z,t));
}
/**
 * A point `t` of the way along an edge's route over the earth: along the great circle, or straight in
 * longitude and latitude, which the globe drapes over its surface and a plane draws as the segment.
 */
fn curve_world(e:Ends,t:f32,straight:bool,u:Uniforms)->vec3f {
  if(!straight){return curve_geodesic(e.a,e.b,t,u);}
  if(u.view.w<1.5){return mix(e.a,e.b,t);}
  var d=e.rb-e.ra;d.x-=360.0*round(d.x/360.0);
  let lift=mix(length(e.a+vec3f(0,0,1)),length(e.b+vec3f(0,0,1)),t);
  return (projection_world(e.ra+d*t,0.0,projectionOf(u))+vec3f(0,0,1))*lift-vec3f(0,0,1);
}

// Split at the geographic seam before projection; both passes use the same endpoints.
fn curve_segment(a:vec3f,b:vec3f,side:u32,u:Uniforms)->mat2x3f {
  if(side==0u){return mat2x3f(a,b);}
  let x=a.x+u.center.x;let y=b.x+u.center.x;
  let seam=select(-180.0,180.0,x>0.0);
  let adjusted=y+select(-360.0,360.0,x>0.0);
  let middle=mix(a,b,(seam-x)/(adjusted-x));
  if(side==1u){return mat2x3f(a,vec3f(seam-u.center.x,middle.yz));}
  return mat2x3f(vec3f(-seam-u.center.x,middle.yz),b);
}
