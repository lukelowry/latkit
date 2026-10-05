// A bank's rows written as drawn records: five vec4 per vertex, then a marked bank's inputs, two
// vec4 per vertex; three per edge or path row. Each page fits one 256-byte uniform slot.
struct VertexPage {
  rows: u32,
  /** The output row of the page's first. */
  first: u32,
  /** The x and y the page's values are relative to, less the camera center. */
  origin: vec2f,
  /** The type's color, for rows without one. */
  color: vec4f,
  x: LatkitChannel,
  y: LatkitChannel,
  z: LatkitChannel,
  size: LatkitChannel,
  tint: LatkitChannel,
  visible: LatkitChannel,
  shade: LatkitChannel,
}
struct LinePage {
  rows: u32,
  first: u32,
  /** The type's color; a negative alpha colors each line by its ends. */
  color: vec4f,
  tint: LatkitChannel,
  width: LatkitChannel,
  visible: LatkitChannel,
  shade: LatkitChannel,
  dash: LatkitChannel,
  flow: LatkitChannel,
  lane: LatkitChannel,
}
/** A marked bank's page of inputs: eight channels, a slot of their own. */
struct MarkerPage { inputs: array<LatkitChannel, 8> }
/** A marked bank's rows, where its inputs begin, and the inputs that step rather than ease, a bit each. */
struct MarkedBank { rows: u32, steps: u32 }
@group(1) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(1) var<uniform> vertexPage: VertexPage;
@group(1) @binding(1) var<uniform> linePage: LinePage;
@group(1) @binding(2) var<storage, read_write> output: array<vec4f>;
/** What the bank drew as a transition began, as `output` holds it; a vec4 alone without one. */
@group(1) @binding(3) var<storage, read> previous: array<vec4f>;
@group(1) @binding(4) var<uniform> markerPage: MarkerPage;
@group(1) @binding(5) var<uniform> marked: MarkedBank;

/** How much of `previous` this frame mixes in: none at rest, or for a bank without it. */
fn easing() -> f32 {
  return select(0.0, u.ease, u.ease > 0.0 && arrayLength(&previous) == arrayLength(&output));
}
/**
 * Position, then ground and color, size, shade, row, and opacity, and where it is in the world. A
 * transition mixes position, color, size, and opacity from what the bank drew as it began.
 */
fn vertex(row: u32) {
  let out = (vertexPage.first + row) * 5u;
  let x = channelNumber(vertexPage.x, row, 0u);
  let y = channelNumber(vertexPage.y, row, 0u);
  let placed = finiteValue(x) && finiteValue(y);
  var local = vec2f(x, y);
  var origin = vertexPage.origin;
  var z = channelNumber(vertexPage.z, row, 0u);
  var size = channelNumber(vertexPage.size, row, 0u);
  var opacity = select(0.0, 1.0, channelOn(vertexPage.visible, row, 0u));
  let remain = easing();
  if (remain > 0.0) {
    let before = previous[out + 1u];
    if (before.w > 0.5 && placed) {
      local = mix(local + origin, before.xy + u.easeShift, remain);
      origin = vec2f(0.0);
      z = mix(z, before.z, remain);
    }
    let was = previous[out + 3u];
    size = mix(size, was.x, remain);
    opacity = mix(opacity, select(0.0, was.w, before.w > 0.5), remain);
  }
  let height = z * u.geo.z;
  var world = vec3f(local + origin, height);
  var normal = vec3f(0.0, 0.0, 1.0);
  var facing = true;
  if (u.view.w > 1.5) {
    // Angles from the page origin, turned by the origin's own from the camera center.
    let lon0 = origin.x * 0.017453292519943295;
    let dlat0 = origin.y * 0.017453292519943295;
    let sinLat0 = u.geo.x * cos(dlat0) + u.geo.y * sin(dlat0);
    let cosLat0 = u.geo.y * cos(dlat0) - u.geo.x * sin(dlat0);
    let dl = local.x * 0.017453292519943295;
    let lat = local.y * 0.017453292519943295;
    let sl = sin(dl) * cos(lon0) + cos(dl) * sin(lon0);
    let cl = cos(dl) * cos(lon0) - sin(dl) * sin(lon0);
    let sa = sin(lat) * cosLat0 + cos(lat) * sinLat0;
    let ca = cos(lat) * cosLat0 - sin(lat) * sinLat0;
    let nx = ca * sl;
    let ny = sa * u.geo.y - ca * cl * u.geo.x;
    let nz = sa * u.geo.x + ca * cl * u.geo.y;
    world = vec3f(nx, ny, nz) * (1.0 + height) - vec3f(0.0, 0.0, 1.0);
    let cy = -u.rotation.w * u.pose.y;
    let cz = 1.0 + u.rotation.z * u.pose.y;
    facing = dot(vec3f(nx, ny, nz), vec3f(-u.rotation.y * cy, u.rotation.x * cy, cz)) > 1.0;
    let absSl = sl * u.center.w + cl * u.center.z;
    let absCl = cl * u.center.w - sl * u.center.z;
    normal = vec3f(ca * absCl, sa, -ca * absSl);
  } else if (u.geo.w > 0.5) {
    let lon = (local.x + origin.x + u.center.x) * 0.017453292519943295;
    let lat = (local.y + origin.y + u.center.y) * 0.017453292519943295;
    normal = vec3f(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
  }
  var c = channelColor(vertexPage.tint, row, 0u, vertexPage.color);
  c = vec4f(c.rgb * daylight(normal, u), c.a);
  if (remain > 0.0) { c = mix(c, previous[out + 2u], remain); }
  let shown = placed && facing && opacity > 0.001;
  output[out] = project_world(world, u);
  output[out + 1u] = vec4f(local + origin, z, select(0.0, 1.0, placed));
  output[out + 2u] = c;
  output[out + 3u] = vec4f(size, channelNumber(vertexPage.shade, row, 0u), bitcast<f32>(fieldRow(row)), select(0.0, opacity, shown));
  output[out + 4u] = vec4f(world, select(0.0, 1.0, placed));
}
@compute @workgroup_size(64)
fn vertices(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < vertexPage.rows) { vertex(id.x); }
}
/** A marked bank's vertices, and their inputs after its records: eased, unless they step. */
@compute @workgroup_size(64)
fn marked_vertices(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= vertexPage.rows) { return; }
  vertex(row);
  let at = marked.rows * 5u + (vertexPage.first + row) * 2u;
  let remain = easing();
  var v: array<f32, 8>;
  for (var i = 0u; i < 8u; i++) {
    v[i] = channelNumber(markerPage.inputs[i], row, 0u);
    if (remain > 0.0 && (marked.steps & (1u << i)) == 0u) {
      v[i] = mix(v[i], previous[at + i / 4u][i % 4u], remain);
    }
  }
  output[at] = vec4f(v[0], v[1], v[2], v[3]);
  output[at + 1u] = vec4f(v[4], v[5], v[6], v[7]);
}
/**
 * Color; half its width, its shade, its row, and whether dashed; then its lane, its flow speed, how
 * far its flow has moved, and its opacity. Flow moves by its speed each second, so a new speed
 * carries on from where the flow is.
 */
@compute @workgroup_size(64)
fn edges(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= linePage.rows) { return; }
  let out = (linePage.first + row) * 3u;
  var color = channelColor(linePage.tint, row, 0u, linePage.color);
  var half = channelNumber(linePage.width, row, 0u) * 0.5;
  var flow = channelNumber(linePage.flow, row, 0u);
  var opacity = select(0.0, 1.0, channelOn(linePage.visible, row, 0u));
  let remain = easing();
  if (remain > 0.0) {
    let was = previous[out];
    // A line colored by its ends mixes only with another.
    if ((was.a < 0.0) == (color.a < 0.0)) { color = mix(color, was, remain); }
    half = mix(half, previous[out + 1u].x, remain);
    let motion = previous[out + 2u];
    flow = mix(flow, motion.y, remain);
    opacity = mix(opacity, motion.w, remain);
  }
  let spacing = max(u.flowSpacingPx, 1.0);
  let moved = output[out + 2u].z + flow * u.dt;
  output[out] = color;
  output[out + 1u] = vec4f(half, channelNumber(linePage.shade, row, 0u), bitcast<f32>(fieldRow(row)), select(0.0, 1.0, channelOn(linePage.dash, row, 0u)));
  output[out + 2u] = vec4f(channelNumber(linePage.lane, row, 0u), flow, moved - spacing * floor(moved / spacing), opacity);
}
