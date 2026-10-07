// polyfill ImageData, 让 mdx-m3-viewer 的 BLP 解码器在 node 里工作
class ImageData {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
global.ImageData = ImageData;

const fs = require('fs');
const { parsers } = require('mdx-m3-viewer');
const blpPath = 'extracted/Units/Critters/EasterRabbit/RabbitSkin.blp';
const buf = fs.readFileSync(blpPath);
const blp = new parsers.blp.Image();
blp.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const mip = blp.getMipmap(0);
console.log('解码成功:', mip.width, 'x', mip.height, ' data:', mip.data.length, 'bytes');

// 存 PPM (最简单, 无依赖) + 同时存原始 RGBA
const w = mip.width, h = mip.height;
const d = mip.data;
const ppm = Buffer.from(`P6\n${w} ${h}\n255\n`);
const rgb = Buffer.alloc(w * h * 3);
for (let i = 0; i < w * h; i++) {
  rgb[i*3] = d[i*4]; rgb[i*3+1] = d[i*4+1]; rgb[i*3+2] = d[i*4+2];
}
fs.writeFileSync('demo_assets/RabbitSkin.ppm', Buffer.concat([ppm, rgb]));
fs.writeFileSync('demo_assets/RabbitSkin.rgba', Buffer.from(d.buffer));
console.log('已存 PPM 和 RGBA 原始数据');
