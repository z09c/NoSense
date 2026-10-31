/* 生成 build/icon.ico：纯 Node 手写 PNG + ICO 容器，不依赖图像库 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var SIZE = 256;

function crcTable() {
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
var CRC = crcTable();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  var raw = Buffer.alloc((width * 4 + 1) * height);
  var p = 0;
  for (var y = 0; y < height; y++) {
    raw[p++] = 0;                                  // filter: none
    for (var x = 0; x < width; x++) {
      var i = (y * width + x) * 4;
      raw[p++] = rgba[i]; raw[p++] = rgba[i + 1]; raw[p++] = rgba[i + 2]; raw[p++] = rgba[i + 3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- 圆角矩形覆盖度（4x4 超采样抗锯齿） ---- */
function insideRR(x, y, r) {
  var dx = Math.max(Math.abs(x - r.cx) - (r.w / 2 - r.rad), 0);
  var dy = Math.max(Math.abs(y - r.cy) - (r.h / 2 - r.rad), 0);
  return dx * dx + dy * dy <= r.rad * r.rad;
}

function coverage(x, y, r) {
  var hits = 0;
  var step = 0.25;
  for (var sy = 0; sy < 1; sy += step) {
    for (var sx = 0; sx < 1; sx += step) {
      if (insideRR(x + sx, y + sy, r)) hits++;
    }
  }
  return hits / 16;
}

var BAR = { cx: 128, cy: 128, w: 46, h: 176, rad: 22 };
var CARD = { cx: 128, cy: 128, w: 196, h: 196, rad: 40 };

var rgba = Buffer.alloc(SIZE * SIZE * 4);
for (var y = 0; y < SIZE; y++) {
  for (var x = 0; x < SIZE; x++) {
    var i = (y * SIZE + x) * 4;
    var card = coverage(x, y, CARD);
    var bar = coverage(x, y, BAR);
    // 背景圆角卡片：深色玻璃
    var bg = [24, 28, 36];
    // 竖条：蓝 -> 青 渐变
    var t = (y - (BAR.cy - BAR.h / 2)) / BAR.h;
    var top = [47, 111, 237];
    var bottom = [22, 178, 163];
    var col = [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t)
    ];
    var r = Math.round(bg[0] * (1 - bar) + col[0] * bar);
    var g = Math.round(bg[1] * (1 - bar) + col[1] * bar);
    var b = Math.round(bg[2] * (1 - bar) + col[2] * bar);
    var a = Math.max(card * 235, bar * 255);
    if (bar > 0) a = 255 * Math.max(card, bar);
    rgba[i] = card > 0 || bar > 0 ? r : 0;
    rgba[i + 1] = card > 0 || bar > 0 ? g : 0;
    rgba[i + 2] = card > 0 || bar > 0 ? b : 0;
    rgba[i + 3] = Math.round(Math.min(255, a));
  }
}

var image = png(SIZE, SIZE, rgba);
var header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);        // type: icon
header.writeUInt16LE(1, 4);        // one image
var entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0;        // 0 == 256
entry.writeUInt16LE(1, 2);         // planes
entry.writeUInt16LE(32, 4);        // bit depth
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(22, 12);       // pixel data offset
var ico = Buffer.concat([header, entry, image]);

var out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image);
console.log('wrote', out, ico.length, 'bytes');
