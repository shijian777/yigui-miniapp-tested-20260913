// 云函数 slowMover：滞销分析
// 输入：thresholdDays（默认 90）；0 表示全部
// 输出：所有 SKU 按"最近一次售出时间"倒序，>= thresholdDays 没卖过 = 滞销
// 兼容新旧 goods：有 skus 按 SKU 维度统计；否则按商品级统计
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function numOr(v, dflt) { const n = Number(v); return isFinite(n) ? n : dflt; }

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  const thresholdDays = numOr(event.thresholdDays, 90);
  const limit = Math.min(500, Math.max(1, numOr(event.limit, 200)));

  try {
    // 1) 拉所有 goods
    const goodsRes = await db.collection('goods').where({ openid: OPENID }).limit(500).get();
    const goods = goodsRes.data || [];

    // 2) 拉所有 sales_orders lines 的 goodsId + createdAt（最近一次售出时间）
    const salesRes = await db.collection('sales_orders').where({ openid: OPENID }).limit(1000).get();
    const lastSaleBySku = {}; // skuKey -> Date
    const lastSaleByGoods = {}; // goodsId -> Date

    (salesRes.data || []).forEach((o) => {
      if (o.status === 'returned') return;
      const t = (o.createdAt instanceof Date) ? o.createdAt : new Date(o.createdAt);
      const ts = t.getTime();
      const tsPrev = lastSaleByGoods['' + '__NONE__']; // unused, dummy
      lastSaleByGoods.__skip = true;
      (o.lines || []).forEach((l) => {
        const gk = String(l.goodsId || '');
        if (gk) {
          const prev = lastSaleByGoods[gk];
          if (!prev || prev.getTime() < ts) lastSaleByGoods[gk] = new Date(ts);
        }
        const sk = String(l.skuKey || '');
        if (sk) {
          const fullKey = gk + '|' + sk;
          const prev = lastSaleBySku[fullKey];
          if (!prev || prev.getTime() < ts) lastSaleBySku[fullKey] = new Date(ts);
        }
      });
    });
    delete lastSaleByGoods.__skip;

    const now = Date.now();
    const items = [];

    goods.forEach((g) => {
      const skus = Array.isArray(g.skus) && g.skus.length ? g.skus : null;
      if (skus) {
        skus.forEach((sku) => {
          if (Number(sku.stock) <= 0) return; // 没库存不算
          const fullKey = g._id + '|' + String(sku.key || '');
          const lastDate = lastSaleBySku[fullKey];
          const daysSince = lastDate ? Math.floor((now - new Date(lastDate).getTime()) / 86400000) : null;
          if (daysSince === null || daysSince >= thresholdDays) {
            items.push({
              goodsId: g._id,
              goodsName: g.name,
              unit: g.unit || '件',
              skuKey: sku.key,
              color: sku.color,
              size: sku.size,
              stock: Number(sku.stock) || 0,
              costPrice: Number(sku.costPrice) || 0,
              price: Number(sku.price) || 0,
              stockValue: round2((Number(sku.stock) || 0) * (Number(sku.costPrice) || 0)),
              lastSaleAt: lastDate || null,
              daysSince: daysSince,
              isNeverSold: !lastDate
            });
          }
        });
      } else {
        const stock = Number(g.stock) || 0;
        if (stock <= 0) return;
        const lastDate = lastSaleByGoods[g._id];
        const daysSince = lastDate ? Math.floor((now - new Date(lastDate).getTime()) / 86400000) : null;
        if (daysSince === null || daysSince >= thresholdDays) {
          items.push({
            goodsId: g._id,
            goodsName: g.name,
            unit: g.unit || '件',
            skuKey: '',
            color: '',
            size: '',
            stock: stock,
            costPrice: Number(g.costPrice) || 0,
            price: Number(g.price) || 0,
            stockValue: round2(stock * (Number(g.costPrice) || 0)),
            lastSaleAt: lastDate || null,
            daysSince: daysSince,
            isNeverSold: !lastDate
          });
        }
      }
    });

    // 按占用资金倒序
    items.sort((a, b) => b.stockValue - a.stockValue);
    const sliced = items.slice(0, limit);
    const totalStockValue = round2(items.reduce((s, x) => s + x.stockValue, 0));
    const totalStockQty = items.reduce((s, x) => s + x.stock, 0);

    return {
      success: true,
      data: {
        thresholdDays: thresholdDays,
        totalStockValue: totalStockValue,
        totalStockQty: totalStockQty,
        count: items.length,
        list: sliced
      }
    };
  } catch (e) {
    console.error('[slowMover]', e);
    return { success: false, message: e.message || '分析失败' };
  }
};
