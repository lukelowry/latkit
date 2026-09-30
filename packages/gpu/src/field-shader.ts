import { integer } from './error.js';

/** One layout for native columns, field bindings and sampled observations. */
export function fieldShader(options: { readonly group: number }): string {
  const group = integer(options.group, 'field bind group', 0, 3);
  return /* wgsl */ `
struct LatkitField {
  bank: u32, offset: u32, rowStride: u32, frameStride: u32,
  kind: u32, components: u32, validBank: u32, validOffset: u32,
  validRowStride: u32, validFrameStride: u32, presentBank: u32, presentOffset: u32,
  presentRowStride: u32, presentFrameStride: u32, reserved0: u32, reserved1: u32,
}
struct LatkitFields {
  rows: u32, frames: u32, count: u32, rowKind: u32,
  rowBase: u32, rowBank: u32, rowOffset: u32, reserved: u32,
  fields: array<LatkitField>,
}
@group(${group}) @binding(0) var<storage, read> latkitFields: LatkitFields;
@group(${group}) @binding(1) var<storage, read> latkitValues0: array<u32>;
@group(${group}) @binding(2) var<storage, read> latkitValues1: array<u32>;
fn latkitWord(bank: u32, offset: u32) -> u32 {
  if (bank == 0u) { return latkitValues0[offset]; }
  return latkitValues1[offset];
}
fn latkitBit(bank: u32, bit: u32) -> bool {
  return (latkitWord(bank, bit / 32u) & (1u << (bit & 31u))) != 0u;
}
fn fieldRow(row: u32) -> u32 {
  if (latkitFields.rowKind == 0u) { return latkitFields.rowBase + row; }
  return latkitWord(latkitFields.rowBank, latkitFields.rowOffset + row);
}
fn fieldPresent(slot: u32, row: u32, frame: u32) -> bool {
  if (slot >= latkitFields.count || row >= latkitFields.rows || frame >= latkitFields.frames) { return false; }
  let f = latkitFields.fields[slot];
  if (f.presentBank == 0xffffffffu) { return true; }
  return latkitBit(f.presentBank, f.presentOffset + row * f.presentRowStride + frame * f.presentFrameStride);
}
fn fieldValid(slot: u32, row: u32, frame: u32) -> bool {
  if (!fieldPresent(slot, row, frame)) { return false; }
  let f = latkitFields.fields[slot];
  if (f.validBank == 0xffffffffu) { return true; }
  return latkitBit(f.validBank, f.validOffset + row * f.validRowStride + frame * f.validFrameStride);
}
fn fieldUint(slot: u32, row: u32, frame: u32, component: u32) -> u32 {
  let f = latkitFields.fields[slot];
  return latkitWord(f.bank, f.offset + row * f.rowStride + frame * f.frameStride + component);
}
fn fieldInt(slot: u32, row: u32, frame: u32, component: u32) -> i32 {
  return bitcast<i32>(fieldUint(slot, row, frame, component));
}
fn fieldFloat(slot: u32, row: u32, frame: u32, component: u32) -> f32 {
  let f = latkitFields.fields[slot];
  let word = fieldUint(slot, row, frame, component);
  if (f.kind == 1u) { return f32(bitcast<i32>(word)); }
  if (f.kind == 2u) { return f32(word); }
  return bitcast<f32>(word);
}
fn fieldBool(slot: u32, row: u32, frame: u32) -> bool {
  let f = latkitFields.fields[slot];
  return latkitBit(f.bank, f.offset + row * f.rowStride + frame * f.frameStride);
}
fn fieldVec2f(slot: u32, row: u32, frame: u32) -> vec2f {
  return vec2f(fieldFloat(slot, row, frame, 0u), fieldFloat(slot, row, frame, 1u));
}
fn fieldVec3f(slot: u32, row: u32, frame: u32) -> vec3f {
  return vec3f(fieldFloat(slot, row, frame, 0u), fieldFloat(slot, row, frame, 1u), fieldFloat(slot, row, frame, 2u));
}
fn fieldVec4f(slot: u32, row: u32, frame: u32) -> vec4f {
  return vec4f(fieldFloat(slot, row, frame, 0u), fieldFloat(slot, row, frame, 1u), fieldFloat(slot, row, frame, 2u), fieldFloat(slot, row, frame, 3u));
}
`;
}
