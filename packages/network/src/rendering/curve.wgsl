fn curve_unit(p:vec3f,u:Uniforms)->vec3f {
  if(u.view.w>1.5){return normalize(p+vec3f(0,0,1));}
  let lon=(p.x+u.center.x)*0.017453292519943295;let lat=(p.y+u.center.y)*0.017453292519943295;
  return vec3f(cos(lat)*cos(lon),sin(lat),cos(lat)*sin(lon));
}
fn curve_angle(a:vec3f,b:vec3f,u:Uniforms)->f32 {return acos(clamp(dot(curve_unit(a,u),curve_unit(b,u)),-1.0,1.0));}
fn curve_world(a:vec3f,b:vec3f,t:f32,u:Uniforms)->vec3f {
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
  return vec3f(atan2(unit.z,unit.x)*57.295779513-u.center.x,asin(clamp(unit.y,-1.0,1.0))*57.295779513-u.center.y,mix(a.z,b.z,t));
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
