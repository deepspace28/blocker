// One-off generator for placeholder app/tray icons (no external deps).
// Draws a simple padlock glyph on a flat background, encoded as raw PNGs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, pixels /* RGBA Buffer, width*height*4 */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const bg = [0x14, 0x1a, 0x21, 255]; // dark slate background
  const accent = [0x4f, 0x8a, 0xff, 255]; // blue
  const shackle = [0xe8, 0xee, 0xf7, 255]; // near-white

  const cx = size / 2;
  const cy = size / 2;
  const cornerR = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // rounded-rect background
      let inside = true;
      const nx = x < cornerR ? cornerR - x : x > size - cornerR ? x - (size - cornerR) : 0;
      const ny = y < cornerR ? cornerR - y : y > size - cornerR ? y - (size - cornerR) : 0;
      if (nx > 0 && ny > 0 && nx * nx + ny * ny > cornerR * cornerR) inside = false;
      let color = inside ? bg : [0, 0, 0, 0];

      // padlock shackle (arc) - upper portion
      const shackleOuterR = size * 0.20;
      const shackleInnerR = size * 0.12;
      const shackleCy = size * 0.36;
      const dx = x - cx;
      const dy = y - shackleCy;
      if (dy <= 0) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= shackleOuterR && dist >= shackleInnerR) color = shackle;
      }

      // padlock body (rounded rect) - lower portion
      const bodyLeft = size * 0.28;
      const bodyRight = size * 0.72;
      const bodyTop = size * 0.42;
      const bodyBottom = size * 0.82;
      if (x >= bodyLeft && x <= bodyRight && y >= bodyTop && y <= bodyBottom) {
        color = accent;
        // keyhole
        const kdx = x - cx;
        const kdy = y - (bodyTop + (bodyBottom - bodyTop) * 0.38);
        const holeR = size * 0.045;
        if (kdx * kdx + kdy * kdy <= holeR * holeR) color = bg;
        if (Math.abs(kdx) <= size * 0.02 && y >= bodyTop + (bodyBottom - bodyTop) * 0.38 && y <= bodyTop + (bodyBottom - bodyTop) * 0.7) {
          color = bg;
        }
      }

      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = color[3];
    }
  }
  return pixels;
}

const outDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const size of [256, 32, 16]) {
  const pixels = drawIcon(size);
  const png = encodePNG(size, size, pixels);
  const name = size === 256 ? 'icon.png' : `tray${size}.png`;
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('wrote', name);
}

const extIconsDir = path.join(__dirname, '..', 'extension', 'icons');
if (!fs.existsSync(extIconsDir)) fs.mkdirSync(extIconsDir, { recursive: true });

for (const size of [128, 48, 16]) {
  const pixels = drawIcon(size);
  const png = encodePNG(size, size, pixels);
  const name = `icon${size}.png`;
  fs.writeFileSync(path.join(extIconsDir, name), png);
  console.log('wrote extension/icons/' + name);
}
