// BLP 贴图解码 → PNG (验证解包贴图可用)
const fs = require('fs');
const { parsers } = require('mdx-m3-viewer');

const blpPath = 'extracted/Units/Critters/EasterRabbit/RabbitSkin.blp';
const buf = fs.readFileSync(blpPath);

const blp = new parsers.blp.Image();
blp.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const mipmap = blp.getMipmap(0);
console.log('BLP 解码成功, 尺寸:', mipmap.width, 'x', mipmap.height, ' 格式:', mipmap.format);

// 用 PNG 编码库把 RGBA 数据存成 PNG
const width = mipmap.width, height = mipmap.height;
const rgba = mipmap.data; // Uint8Array

// 构造 PNG (用 zlib 手写最简单 PNG 编码)
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// 扫描线: 每行前加 filter byte 0
const raw = Buffer.alloc(height * (1 + width * 4));
for (let y = 0; y < height; y++) {
  raw[y * (1 + width * 4)] = 0;
  for (let x = 0; x < width * 4; x++) {
    raw[y * (1 + width * 4) + 1 + x] = rgba[y * width * 4 + x];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync('demo_assets/RabbitSkin.png', png);
console.log('已保存 demo_assets/RabbitSkin.png,', png.length, '字节');