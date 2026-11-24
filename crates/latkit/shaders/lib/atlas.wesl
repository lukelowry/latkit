@group(2) @binding(11) var screen_records: texture_2d_array<u32>;

fn record_word(i: u32, offset: u32, stride: u32) -> vec4u {
    let size = textureDimensions(screen_records);
    let texel = i * stride + offset;
    let per = size.x * size.y;
    let at = texel % per;
    return textureLoad(screen_records, vec2i(i32(at % size.x), i32(at / size.x)), i32(texel / per), 0);
}
