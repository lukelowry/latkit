// Atomic reductions over `f32`. `ordered` maps an `f32` to `u32` bits that sort in the same
// order, so `atomicMax` of `ordered(x)` keeps the greatest value, and `atomicMax` of `~ordered(x)`
// keeps the least.

fn ordered(x: f32) -> u32 {
    let b = bitcast<u32>(x);
    return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}

fn unordered(u: u32) -> f32 {
    return bitcast<f32>(select(~u, u & 0x7fffffffu, (u & 0x80000000u) != 0u));
}
