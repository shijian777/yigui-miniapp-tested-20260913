const test = require('node:test');
const assert = require('node:assert/strict');
const receipt = require('../utils/receipt');

function draw(overrides = {}) {
  const texts = [], backgrounds = [];
  const ctx = {
    canvas: { height: 1400 }, font: '20px sans-serif',
    measureText(text) { return { width: String(text).length * (parseInt(this.font.replace('bold ', ''), 10) || 20) }; },
    fillText(text, x, y) { texts.push({ text, x, y }); },
    fillRect(x, y, width, height) { backgrounds.push({ color: this.fillStyle, x, y, width, height }); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, setLineDash() {}
  };
  const order = Object.assign({
    orderNo: 'XS202609100001', createdAt: '2026-09-10T03:20:00.000Z', status: 'completed',
    subtotal: 200, amountDue: 200, received: 200, discountPct: 100,
    customerName: '测试顾客', customerPhone: '13800000000', paymentMethod: 'cash',
    lines: [{ name: '秋季连衣裙', color: '米白', size: 'M', price: 100, qty: 2, amount: 200 }]
  }, overrides);
  const height = receipt.drawReceipt(ctx, 384, order, { storeName: '丹姐女装童装' }, {});
  return { texts, backgrounds, height };
}

test('服装小票打印颜色尺码与客户，便于核对拿货和售后', () => {
  const result = draw();
  assert.ok(result.texts.some(item => /米白/.test(item.text) && /M/.test(item.text)));
  assert.ok(result.texts.some(item => /测试顾客/.test(item.text)));
});

test('退货后的原小票明确标注退货，不被误当成有效销售凭证', () => {
  const result = draw({ status: 'returned' });
  assert.ok(result.texts.some(item => /已退货/.test(item.text)));
  assert.ok(result.texts.some(item => /原交易/.test(item.text)));
});

test('全额赠送的0折小票仍显示折扣记录', () => {
  const result = draw({ discountPct: 0, amountDue: 0, discountAmount: 200, received: 0 });
  assert.ok(result.texts.some(item => /折扣 0 折/.test(item.text)));
});

test('小票白底导出且单号与时间分行，避免重叠和透明背景', () => {
  const result = draw();
  assert.ok(result.backgrounds.some(item => item.color === '#fff' && item.width === 384 && item.height === 1400));
  const number = result.texts.find(item => String(item.text).startsWith('单号'));
  const time = result.texts.find(item => /2026-09-10/.test(item.text));
  assert.notEqual(number.y, time.y);
});
