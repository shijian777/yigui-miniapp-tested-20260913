// utils/receipt.js —— 用 canvas 2d 把小票画出来（电子小票预览 / 保存 / 蓝牙位图打印共用）
//
// 关键约定：画布逻辑宽度固定 W = 384px。
//  - 屏幕预览：canvas.width 设为 384（与 58mm@203dpi 打印宽度一致，所见即所得）
//  - 保存到相册：canvasToTempFilePath 时 destWidth 放大到 768 更清晰
//  - 蓝牙打印：直接对 384px 宽画布 getImageData，每个像素 = 1 个打印点
//
// drawReceipt(ctx, W, order, settings, {dryRun}) 会做两遍：
//  第一遍 dryRun=true 只测量高度（measureText 与画布尺寸无关，可以先量后设高）
//  第二遍正常绘制。返回实际使用高度。

const M = 14;        // 左右边距
const W_CONTENT = 384 - M * 2;

const C_BLACK = '#000';
const C_GRAY = '#666';
const C_LIGHT = '#999';
const C_RED = '#e64340';
const PAY_TEXT = { cash: '现金', wechat: '微信', alipay: '支付宝', credit: '记账欠款' };

function setFont(ctx, size, bold) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px sans-serif';
}
function textW(ctx, s) { return ctx.measureText(s).width; }

// 文本换行（按字符贪心切分，兼容中英文混排）
function wrapText(ctx, text, maxW) {
  const lines = [];
  let line = '';
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    if (line && textW(ctx, line + ch) > maxW) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push('');
  return lines;
}

function dashedLine(ctx, x1, y, x2, color) {
  ctx.strokeStyle = color || '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const seg = 4;
  let x = x1;
  ctx.moveTo(x1, y);
  while (x < x2) {
    ctx.lineTo(Math.min(x + seg, x2), y);
    x += seg * 2;
    ctx.moveTo(Math.min(x, x2), y);
  }
  ctx.stroke();
}

// ---------- 各区块 ----------

function drawHeader(ctx, y, order, settings) {
  // 店名（设置里配）
  const name = (settings.storeName || '').trim() || '我的小店';
  setFont(ctx, 34, true);
  ctx.fillStyle = C_BLACK;
  ctx.textAlign = 'center';
  wrapText(ctx, name, W_CONTENT).forEach((line) => {
    ctx.fillText(line, W_CONTENT / 2 + M, y);
    y += 46;
  });
  if (order.status === 'returned') {
    setFont(ctx, 24, true);
    ctx.fillStyle = C_RED;
    ctx.fillText('已退货 · 原交易凭证', W_CONTENT / 2 + M, y);
    y += 36;
  }

  // 电话 / 地址
  ctx.textAlign = 'center';
  if (settings.phone) {
    setFont(ctx, 20, false);
    ctx.fillStyle = C_GRAY;
    ctx.fillText('Tel ' + settings.phone, W_CONTENT / 2 + M, y);
    y += 28;
  }
  if (settings.address) {
    setFont(ctx, 20, false);
    ctx.fillStyle = C_GRAY;
    const addrLines = wrapText(ctx, settings.address, W_CONTENT);
    for (let i = 0; i < addrLines.length; i++) {
      ctx.fillText(addrLines[i], W_CONTENT / 2 + M, y);
      y += 28;
    }
  }
  dashedLine(ctx, M, y, M + W_CONTENT);
  y += 12;

  // 单号 / 时间 / 支付方式（小字）
  setFont(ctx, 20, false);
  ctx.textAlign = 'left';
  ctx.fillStyle = C_GRAY;
  ctx.fillText('单号  ' + (order.orderNo || ''), M, y);
  y += 28;
  const dt = order.createdAt ? new Date(order.createdAt) : null;
  if (dt && Number.isFinite(dt.getTime())) {
    ctx.fillText('时间  ' + utilFmtDateTime(dt), M, y);
    y += 28;
  }
  if (order.customerName || order.customerPhone) {
    const customer = '客户  ' + [order.customerName, order.customerPhone].filter(Boolean).join(' ');
    wrapText(ctx, customer, W_CONTENT).forEach((line) => {
      ctx.fillText(line, M, y);
      y += 28;
    });
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = C_GRAY;
  const pmText = order.paymentMethodText || PAY_TEXT[order.paymentMethod] || '';
  ctx.fillText('支付  ' + pmText, M, y);
  ctx.textAlign = 'right';
  const cnt = (order.lines || []).length;
  ctx.fillText('共 ' + cnt + ' 项', M + W_CONTENT, y);
  y += 20;
  return y;
}

// 通用日期格式化（局部实现，避免依赖 util 循环引用）
function utilFmtDateTime(d) {
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function drawItems(ctx, y, order) {
  const lines = order.lines || [];
  const rightCol = 104; // 右侧金额列宽
  const nameMaxW = W_CONTENT - rightCol - 10;

  for (let i = 0; i < lines.length; i++) {
    const it = lines[i];
    const name = it.name || '(无名称)';
    const amount = Number(it.amount) || 0;
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;

    setFont(ctx, 22, false);
    const nameLines = wrapText(ctx, name, nameMaxW);

    // 第一行：名称 + 金额（顶部对齐）
    setFont(ctx, 22, false);
    ctx.fillStyle = C_BLACK;
    ctx.textAlign = 'left';
    ctx.fillText(nameLines[0], M, y);
    ctx.textAlign = 'right';
    ctx.fillText(amount.toFixed(2), M + W_CONTENT, y);

    // 名称若过长，剩余行继续往下画
    let rowY = y + 30;
    for (let k = 1; k < nameLines.length; k++) {
      setFont(ctx, 22, false);
      ctx.fillStyle = C_BLACK;
      ctx.textAlign = 'left';
      ctx.fillText(nameLines[k], M, rowY);
      rowY += 30;
    }
    y = rowY;

    // 单价 x 数量（灰色小字）
    setFont(ctx, 18, false);
    ctx.fillStyle = C_GRAY;
    ctx.textAlign = 'left';
    const specification = [it.color, it.size].filter(Boolean).join(' / ');
    if (specification) {
      wrapText(ctx, specification, W_CONTENT).forEach((line) => {
        ctx.fillText(line, M, y);
        y += 26;
      });
    }
    ctx.fillText((price ? price.toFixed(2) : '0.00') + ' x ' + qty + (it.unit || '件'), M, y);
    y += 26;
  }
  dashedLine(ctx, M, y, M + W_CONTENT);
  y += 8;
  return y;
}

function drawMoneyRow(ctx, y, label, value, opt) {
  const o = opt || {};
  const size = o.big ? 32 : 22;
  setFont(ctx, size, o.bold);
  ctx.fillStyle = o.color || C_BLACK;
  ctx.textAlign = 'left';
  ctx.fillText(label, M, y);
  ctx.textAlign = 'right';
  ctx.fillText(value, M + W_CONTENT, y);
  return y + (o.big ? 44 : 32);
}

function drawTotals(ctx, y, order) {
  const returned = order.status === 'returned';
  y = drawMoneyRow(ctx, y, returned ? '原交易合计' : '合计', fmt(order.subtotal));
  const pct = order.discountPct !== undefined && Number.isFinite(Number(order.discountPct)) ? Number(order.discountPct) : 100;
  if (pct < 100) {
    const pctText = (pct % 10 === 0 ? pct / 10 : pct / 10);
    y = drawMoneyRow(ctx, y, '折扣 ' + pctText + ' 折', '-' + fmt(order.discountAmount), { color: C_GRAY });
  }
  if (Number(order.eraseAmount) > 0) {
    y = drawMoneyRow(ctx, y, '抹零', '-' + fmt(order.eraseAmount), { color: C_GRAY });
  }
  dashedLine(ctx, M, y - 14, M + W_CONTENT);
  y = drawMoneyRow(ctx, y, returned ? '原交易应收' : '应收', fmt(order.amountDue), { bold: true, big: !returned });
  y = drawMoneyRow(ctx, y, returned ? '退货前实收' : ((order.settleHistory || []).length ? '累计实收' : '实收'), fmt(order.received));
  const change = Number(order.change) || 0;
  const debt = Number(order.debt) || 0;
  if (change > 0) y = drawMoneyRow(ctx, y, returned ? '原找零' : '找零', fmt(change), { color: C_GRAY });
  if (debt > 0) {
    y = drawMoneyRow(ctx, y, returned ? '退货前欠款' : '欠款(记账)', fmt(debt), { color: returned ? C_GRAY : C_RED, bold: true });
    if (returned) {
      setFont(ctx, 18, false);
      ctx.fillStyle = C_GRAY;
      ctx.textAlign = 'left';
      ctx.fillText('欠款已取消，不再计入待收', M, y);
      y += 28;
    }
  }
  return y;
}

function drawFooter(ctx, y, order, settings) {
  if (order.remark) {
    setFont(ctx, 18, false);
    ctx.fillStyle = C_GRAY;
    ctx.textAlign = 'left';
    const lines = wrapText(ctx, '备注: ' + order.remark, W_CONTENT);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], M, y);
      y += 26;
    }
  }
  dashedLine(ctx, M, y, M + W_CONTENT);
  y += 10;

  const note = (settings.receiptNote || '').trim();
  if (note) {
    setFont(ctx, 20, false);
    ctx.fillStyle = C_GRAY;
    ctx.textAlign = 'center';
    const lines = wrapText(ctx, note, W_CONTENT);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], W_CONTENT / 2 + M, y);
      y += 28;
    }
  }

  // 二维码占位（可空）：设置里打开后画一个虚线占位框
  if (settings.showQrPlaceholder) {
    const box = 74;
    const cx = M + W_CONTENT / 2;
    y += 6;
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.setLineDash ? ctx.setLineDash([5, 4]) : null;
    ctx.strokeRect(cx - box / 2, y, box, box);
    if (ctx.setLineDash) ctx.setLineDash([]);
    setFont(ctx, 16, false);
    ctx.fillStyle = C_LIGHT;
    ctx.textAlign = 'center';
    ctx.fillText('二维码', cx, y + 26);
    ctx.fillText('(占位)', cx, y + 44);
    y += box + 8;
  }

  // 底部留白（走纸手感）
  y += 24;
  return y;
}

function fmt(n) {
  const x = Number(n) || 0;
  return (Math.round(x * 100) / 100).toFixed(2);
}

// order: sales_orders 文档（可含 paymentMethodText 预置文案）
// settings: settings 文档
// 返回绘制后总高度（px）
function drawReceipt(ctx, W, order, settings, opt) {
  if (!(opt && opt.dryRun)) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, ctx.canvas ? ctx.canvas.height : 10000);
  }
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = C_BLACK;

  let y = 10;
  y = drawHeader(ctx, y, order, settings);
  y = drawItems(ctx, y, order);
  y = drawTotals(ctx, y, order);
  y = drawFooter(ctx, y, order, settings);
  return y;
}

module.exports = {
  DRAW_WIDTH: 384,
  drawReceipt: drawReceipt,
  wrapText: wrapText
};
