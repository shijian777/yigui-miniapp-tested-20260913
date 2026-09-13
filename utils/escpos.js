// utils/escpos.js —— 58mm 热敏打印机 ESC/POS 指令构造
//
// 中文打印为什么走"位图"路线：
//  ESC/POS 文本模式下中文需要 GBK 编码，而小程序 JS 环境没有内置 GBK 编码器，
//  因此用 canvas 2d 把小票画成图片，再以 ESC/POS raster bit-image（GS v 0）
//  发送。位图内容与屏幕预览一致，规避编码坑。
//
// 编码约定（本实现）：
//  GS v 0 指令: 1D 76 30 m xL xH yL yH data...
//    xL xH = 每行字节数（小端16位）；widthBytes = ceil(宽/8)
//    yL yH = 本指令的 8 点带数，本实现固定 yL=1（每条指令一个 8 点带）
//  图像按行切分成 H 条 GS v 0 指令（逐行打印是 58mm 蓝牙打印机最常见的驱动
//  方式）：每条指令只打 1 行，行与行之间不合并、不丢垂直细节。
//  字节内：一个字节 = 该行 8 个水平点；bitOrder='msb' 时 bit7=最左点（默认，
//  主流机型约定），'lsb' 时 bit0=最左点（个别机型/镜像需要）。
//  reverseRows=true 时从最后一行往前发（上下颠倒修正）。
//  真机若出现左右镜像/上下颠倒/花位：打印设置页的"打印方向"四档切换即可，
//  无需改代码。不同固件对位图"点密度"处理略有差异，如需 1:1 密度修正可调
//  THRESHOLD 或改用打印设置里的方向档。
const THRESHOLD = 160;

function luminance(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function buildRowBytes(imgData, py, widthBytes, bitOrder) {
  const W = imgData.width;
  const data = imgData.data;
  const line = new Uint8Array(widthBytes);
  for (let x = 0; x < W; x++) {
    const idx = (py * W + x) * 4;
    const a = data[idx + 3];
    if (a === 0) continue; // 全透明当白点
    const lum = luminance(data[idx], data[idx + 1], data[idx + 2]);
    if (lum >= THRESHOLD) continue; // 亮=白点
    const bit = bitOrder === 'lsb' ? (x & 7) : (7 - (x & 7));
    line[x >> 3] |= (1 << bit);
  }
  return line;
}

// 把一行打包成一条 GS v 0（yL=1）指令
function rasterRowCommand(rowBytes, widthBytes) {
  const seg = new Uint8Array(8 + widthBytes);
  seg[0] = 0x1D; seg[1] = 0x76; seg[2] = 0x30; seg[3] = 0x00;
  seg[4] = widthBytes & 0xff;        // xL
  seg[5] = (widthBytes >> 8) & 0xff; // xH
  seg[6] = 0x01;                     // yL = 1 个 8 点带
  seg[7] = 0x00;                     // yH
  seg.set(rowBytes, 8);
  return seg;
}

// imgData: { width, height, data: Uint8ClampedArray(RGBA) }
// opts: { bitOrder?: 'msb'|'lsb', reverseRows?: boolean, invert?: boolean }
// 返回: { segments: [Uint8Array,...], rowCount, widthBytes }（逐条指令，便于进度上报）
function buildRasterSegments(imgData, opts) {
  const o = opts || {};
  const bitOrder = o.bitOrder === 'lsb' ? 'lsb' : 'msb';
  const W = imgData.width;
  const H = imgData.height;
  const widthBytes = Math.ceil(W / 8);
  const segments = [];
  const rows = [];
  for (let py = 0; py < H; py++) rows.push(py);
  if (o.reverseRows) rows.reverse();
  for (let i = 0; i < rows.length; i++) {
    segments.push(rasterRowCommand(buildRowBytes(imgData, rows[i], widthBytes, bitOrder), widthBytes));
  }
  return { segments: segments, rowCount: H, widthBytes: widthBytes };
}

// printer.js 主用入口：把整张位图编码成一段连续的 GS v 0 指令流（Uint8Array），
// 由调用方在头部拼 ESC @、尾部拼走纸/切纸后游标分包写入。
// opts 同上。
function buildRasterCommand(imgData, opts) {
  const { segments } = buildRasterSegments(imgData, opts);
  let total = 0;
  for (let i = 0; i < segments.length; i++) total += segments[i].length;
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < segments.length; i++) {
    out.set(segments[i], off);
    off += segments[i].length;
  }
  return out;
}

// 初始化指令：ESC @（复位打印机）
function initCmds() {
  return new Uint8Array([0x1B, 0x40]);
}

// 走纸 4 行 + 切纸（无切刀的机型会自动忽略切纸指令）
function finishCmds() {
  return new Uint8Array([0x1B, 0x64, 0x04, 0x1D, 0x56, 0x41, 0x00]);
}

// 字节数组 -> ArrayBuffer（writeBLECharacteristicValue 需要）
function toArrayBuffer(u8) {
  const buf = u8.buffer;
  if (buf.byteLength === u8.byteLength) return buf;
  return u8.slice().buffer;
}

// 把一个长包切分为 ≤ payloadSize 的小包（返回 ArrayBuffer 列表）
function chunkBuffer(u8, payloadSize) {
  const out = [];
  for (let i = 0; i < u8.length; i += payloadSize) {
    out.push(toArrayBuffer(u8.slice(i, Math.min(i + payloadSize, u8.length))));
  }
  return out;
}

// BLE 特性 properties 位掩码（微信文档：read=0x02 writeWithoutResponse=0x04 write=0x08 notify=0x10 …）
const PROP_WRITE_NO_RESP = 0x04;
const PROP_WRITE = 0x08;

module.exports = {
  THRESHOLD: THRESHOLD,
  buildRasterSegments: buildRasterSegments,
  buildRasterCommand: buildRasterCommand,
  initCmds: initCmds,
  finishCmds: finishCmds,
  chunkBuffer: chunkBuffer,
  toArrayBuffer: toArrayBuffer,
  PROP_WRITE: PROP_WRITE,
  PROP_WRITE_NO_RESP: PROP_WRITE_NO_RESP
};
