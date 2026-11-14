import { writeFile } from 'node:fs/promises';

/**
 * Minimal *linear* DNG writer for tests: 16-bit RGB, uncompressed, one strip, camera colour space =
 * linear sRGB (so ColorMatrix1 is XYZ→sRGB). Enough for rawspeed/darktable to develop it.
 */
type Entry = { tag: number; type: number; count: number; value: Buffer };

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const SRATIONAL = 10;
const ASCII = 2;
const BYTE = 1;

function u16(...v: number[]): Buffer {
  const b = Buffer.alloc(v.length * 2);
  v.forEach((x, i) => b.writeUInt16LE(x, i * 2));
  return b;
}
function u32(...v: number[]): Buffer {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4));
  return b;
}
function ascii(s: string): Buffer {
  return Buffer.from(`${s}\0`, 'latin1');
}
function rationals(vals: number[], signed: boolean, denom = 10000): Buffer {
  const b = Buffer.alloc(vals.length * 8);
  vals.forEach((v, i) => {
    const num = Math.round(v * denom);
    if (signed) {
      b.writeInt32LE(num, i * 8);
      b.writeInt32LE(denom, i * 8 + 4);
    } else {
      b.writeUInt32LE(num >>> 0, i * 8);
      b.writeUInt32LE(denom, i * 8 + 4);
    }
  });
  return b;
}

/**
 * pixels: Float32/number array of linear RGB in [0,1], length = w*h*3.
 */
export async function writeLinearDng(file: string, width: number, height: number, pixels: ArrayLike<number>): Promise<void> {
  const data = Buffer.alloc(width * height * 3 * 2);
  for (let i = 0; i < width * height * 3; i++) {
    const v = Math.max(0, Math.min(1, Number(pixels[i]) || 0));
    data.writeUInt16LE(Math.round(v * 65535), i * 2);
  }
  await writeDng(file, width, height, data, 'linear');
}

/**
 * Bayer (RGGB) mosaic DNG from the same linear RGB input: each sensel keeps the channel of its CFA position.
 * Exercises the real demosaic path of a RAW engine.
 */
export async function writeBayerDng(file: string, width: number, height: number, pixels: ArrayLike<number>): Promise<void> {
  const data = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : x % 2 === 0 ? 1 : 2; // R G / G B
      const v = Math.max(0, Math.min(1, Number(pixels[(y * width + x) * 3 + ch]) || 0));
      data.writeUInt16LE(Math.round(v * 65535), (y * width + x) * 2);
    }
  }
  await writeDng(file, width, height, data, 'bayer');
}

async function writeDng(file: string, width: number, height: number, data: Buffer, layout: 'linear' | 'bayer'): Promise<void> {
  const spp = layout === 'linear' ? 3 : 1;
  // XYZ (D65) → linear sRGB
  const xyzToSrgb = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
  const entries: Entry[] = [
    { tag: 254, type: LONG, count: 1, value: u32(0) },
    { tag: 256, type: LONG, count: 1, value: u32(width) },
    { tag: 257, type: LONG, count: 1, value: u32(height) },
    { tag: 258, type: SHORT, count: spp, value: spp === 3 ? u16(16, 16, 16) : u16(16) },
    { tag: 259, type: SHORT, count: 1, value: u16(1) },
    { tag: 262, type: SHORT, count: 1, value: u16(layout === 'linear' ? 34892 : 32803) }, // LinearRaw | CFA
    { tag: 271, type: ASCII, count: 0, value: ascii('TestCam') },
    { tag: 272, type: ASCII, count: 0, value: ascii('Synth') },
    { tag: 273, type: LONG, count: 1, value: u32(0) }, // StripOffsets, patched below
    { tag: 274, type: SHORT, count: 1, value: u16(1) },
    { tag: 277, type: SHORT, count: 1, value: u16(spp) },
    { tag: 278, type: LONG, count: 1, value: u32(height) },
    { tag: 279, type: LONG, count: 1, value: u32(data.length) },
    { tag: 284, type: SHORT, count: 1, value: u16(1) },
    ...(layout === 'bayer'
      ? ([
          { tag: 33421, type: SHORT, count: 2, value: u16(2, 2) }, // CFARepeatPatternDim
          { tag: 33422, type: BYTE, count: 4, value: Buffer.from([0, 1, 1, 2]) }, // CFAPattern RGGB
          { tag: 50710, type: BYTE, count: 3, value: Buffer.from([0, 1, 2]) }, // CFAPlaneColor
          { tag: 50711, type: SHORT, count: 1, value: u16(1) }, // CFALayout
        ] as Entry[])
      : []),
    { tag: 50706, type: BYTE, count: 4, value: Buffer.from([1, 4, 0, 0]) },
    { tag: 50707, type: BYTE, count: 4, value: Buffer.from([1, 1, 0, 0]) },
    { tag: 50708, type: ASCII, count: 0, value: ascii('TestCam Synth') },
    { tag: 50714, type: LONG, count: spp, value: spp === 3 ? u32(0, 0, 0) : u32(0) },
    { tag: 50717, type: LONG, count: spp, value: spp === 3 ? u32(65535, 65535, 65535) : u32(65535) },
    { tag: 50721, type: SRATIONAL, count: 9, value: rationals(xyzToSrgb, true) },
    { tag: 50728, type: RATIONAL, count: 3, value: rationals([1, 1, 1], false) },
    { tag: 50778, type: SHORT, count: 1, value: u16(21) },
  ];
  entries.sort((a, b) => a.tag - b.tag);
  for (const e of entries) if (e.type === ASCII) e.count = e.value.length;

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraOffset = ifdOffset + ifdSize;
  const extras: Buffer[] = [];
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  // Layout: header | IFD | extra values | pixel data
  const dataOffset = (() => {
    let off = extraOffset;
    for (const e of entries) if (e.value.length > 4) off += e.value.length + (e.value.length % 2);
    return off;
  })();
  entries.forEach((e, i) => {
    if (e.tag === 273) e.value = u32(dataOffset);
    const at = 2 + i * 12;
    ifd.writeUInt16LE(e.tag, at);
    ifd.writeUInt16LE(e.type, at + 2);
    ifd.writeUInt32LE(e.count, at + 4);
    if (e.value.length <= 4) {
      e.value.copy(ifd, at + 8);
    } else {
      ifd.writeUInt32LE(extraOffset, at + 8);
      extras.push(e.value);
      extraOffset += e.value.length;
      if (e.value.length % 2) {
        extras.push(Buffer.alloc(1));
        extraOffset += 1;
      }
    }
  });
  ifd.writeUInt32LE(0, ifdSize - 4);
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  await writeFile(file, Buffer.concat([header, ifd, ...extras, data]));
}
