import { integer } from '../error.js';
import { BANKS, FIELD_KIND } from './pages.js';
import { channelShader, channelColorShader } from '../style/channel.js';
import { colormapShader } from '../colors/shader.js';

const banks = Array.from({ length: BANKS }, (_, bank) => bank);
const kinds = Object.entries(FIELD_KIND)
  .map(([name, value]) => `const FIELD_${name.toUpperCase()}: u32 = ${value}u;`)
  .join('\n');
/** Reads a word of one value bank; the last bank is the fallthrough. */
const word = banks
  .slice(0, -1)
  .map((bank) => `  if (bank == ${bank}u) { return latkitValues${bank}[offset]; }`)
  .join('\n');

/**
 * One layout for native columns, field bindings and sampled observations, with the channels that
 * read them; with `colormap`, that colormap group too, and `channelColor`.
 */
export function fieldShader(options: {
  readonly group: number;
  readonly colormap?: number;
}): string {
  const group = integer(options.group, 'field bind group', 0, 3);
  const values = banks
    .map(
      (bank) =>
        `@group(${group}) @binding(${bank + 1}) var<storage, read> latkitValues${bank}: array<u32>;`,
    )
    .join('\n');
  return /* wgsl */ `
${kinds}
struct LatkitField {
  bank: u32, offset: u32, rowStride: u32, frameStride: u32,
  kind: u32, components: u32, validBank: u32, validOffset: u32,
  validRowStride: u32, validFrameStride: u32, presentBank: u32, presentOffset: u32,
  presentRowStride: u32, presentFrameStride: u32, items: u32, itemBase: u32,
}
struct LatkitFields {
  rows: u32, frames: u32, count: u32, rowKind: u32,
  rowBase: u32, rowBank: u32, rowOffset: u32,
  fields: array<LatkitField>,
}
@group(${group}) @binding(0) var<storage, read> latkitFields: LatkitFields;
${values}
fn latkitWord(bank: u32, offset: u32) -> u32 {
${word}
  return latkitValues${BANKS - 1}[offset];
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
  if (f.kind == FIELD_INT32) { return f32(bitcast<i32>(word)); }
  if (f.kind == FIELD_UINT32) { return f32(word); }
  return bitcast<f32>(word);
}
fn fieldBool(slot: u32, row: u32, frame: u32) -> bool {
  let f = latkitFields.fields[slot];
  return latkitBit(f.bank, f.offset + row * f.rowStride + frame * f.frameStride);
}
fn fieldListLength(slot:u32,row:u32)->u32 {
  if (!fieldValid(slot,row,0u)) { return 0u; }
  return fieldUint(slot,row+1u,0u,0u)-fieldUint(slot,row,0u,0u);
}
fn fieldListFloat(slot:u32,row:u32,item:u32,lane:u32)->f32 {
  let list=latkitFields.fields[slot];
  let first=fieldUint(slot,row,0u,0u)-list.itemBase;
  return fieldFloat(list.items,first+item,0u,lane);
}
fn fieldListVec2f(slot:u32,row:u32,item:u32)->vec2f {
  return vec2f(fieldListFloat(slot,row,item,0u),fieldListFloat(slot,row,item,1u));
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
${channelShader}
${options.colormap === undefined ? '' : colormapShader({ group: options.colormap }) + channelColorShader}`;
}
