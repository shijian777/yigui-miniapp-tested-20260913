// 今日概览：销售额/订单数 走 stats 云函数（服务端聚合）；低库存/最近订单客户端分页查询。
const util = require('../../utils/util.js');

Page({
  onLoad() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
      if (app._applyNativeTheme) app._applyNativeTheme(app._resolveTheme(app.globalData.theme));
    } catch (e) {}
  },
  data: {
    dateText: '',
    greetText: '',
    loading: true,
    lowLimit: 5,
    distTab: 'cat',
    stat: { salesCount: 0, soldQty: 0, salesAmount: '0.00', grossProfitText: '0.00', grossProfit: 0, returnedCount: 0 },
    debt: { totalDebt: 0, totalDebtText: '0.00', totalCount: 0, totalAmountDueText: '0.00', totalReceivedText: '0.00' },
    // 本月累计（销售件数/进货件数/销售额/毛利/进货额）
    mstat: { salesCount: 0, soldQty: 0, salesAmount: '0.00', purchaseQty: 0, purchaseCount: 0,
      purchaseAmount: '0.00', grossProfit: '0.00', profitRate: '0.0' },
    // 库存现状（总件数 + 按成本价总值）
    inv: { skuCount: 0, totalQty: 0, totalQtyText: '0', totalCost: '0.00', totalRetail: '0.00', expectedProfit: '0.00', lowSkuCount: 0 },
    lowGoods: [],
    recent: [],
    // 近 7 天销售趋势（柱状图）
    trend: { days: [], maxV: 1 }
  },

  onShow() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
      if (app._applyNativeTheme) app._applyNativeTheme(app._resolveTheme(app.globalData.theme));
    } catch (e) {}

    this.refresh();
  },
  onPullDownRefresh() {
    this.refresh().then(() => {
      wx.stopPullDownRefresh();
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  async refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    const now = new Date();
    const hour = now.getHours();
    const greet = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    this.setData({
      dateText: util.fmtDate(now) + ' ' + util.pad2(now.getHours()) + ':' + util.pad2(now.getMinutes()),
      greetText: greet + '，老板 👋',
      loading: true
    });
    try {
      await util.ensureOpenid();
      const today = util.todayStr();
      const range = util.rangeMs(today, today);

      // 相同日期范围共用请求，避免今日统计重复和七天趋势串行等待。
      const statRequests = new Map();
      const fetchStats = (r) => {
        const key = r.startMs + ':' + r.endMs;
        if (!statRequests.has(key)) statRequests.set(key, util.fetchStats(r));
        return statRequests.get(key);
      };

      // 0) 近 7 天销售趋势（逐日统计）
      let trend = { days: [], maxV: 1 };
      try {
        const daysArr = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
          const i = 6 - index;
          const d = util.addDays(today, -i);
          const dayRes = await fetchStats(util.rangeMs(d, d));
          const dd = dayRes.data || {};
          return {
            label: d.slice(5).replace('-', '/'),
            amount: Number(dd.salesAmount) || 0,
            qty: Number(dd.soldQty) || 0,
            isToday: i === 0
          };
        }));
        const maxV = Math.max(1, Math.max.apply(null, daysArr.map((x) => x.amount || 0)));
        trend = { days: daysArr, maxV: maxV };
      } catch (e) {
        console.warn('趋势统计失败:', e.message);
      }

      // 1) 今日 + 本月汇总（stats 云函数，调两次）
      const nowDate = new Date();
      const monthStart = util.fmtDate(new Date(nowDate.getFullYear(), nowDate.getMonth(), 1));
      const monthEnd = today;
      const monthRange = util.rangeMs(monthStart, monthEnd);
      let stat = { salesCount: 0, soldQty: 0, salesAmount: '0.00', grossProfitText: '0.00',
        grossProfit: 0, returnedCount: 0, purchaseAmount: 0 };
      let mstat = { salesCount: 0, soldQty: 0, salesAmount: '0.00', purchaseQty: 0,
        purchaseCount: 0, purchaseAmount: '0.00', grossProfit: '0.00', profitRate: '0.0' };
      try {
        const [todayRes, monthRes] = await Promise.all([
          fetchStats(range),
          fetchStats(monthRange)
        ]);
        const td = todayRes.data || {};
        stat = {
          salesCount: td.salesCount || 0,
          soldQty: td.soldQty || 0,
          salesAmount: util.fmtMoney(td.salesAmount),
          grossProfit: Number(td.grossProfit) || 0,
          grossProfitText: util.fmtMoney(td.grossProfit),
          returnedCount: td.returnedCount || 0,
          purchaseAmount: td.purchaseAmount || 0
        };
        const md = monthRes.data || {};
        const monthProfit = Number(md.grossProfit) || 0;
        const monthSales = Number(md.salesAmount) || 0;
        mstat = {
          salesCount: md.salesCount || 0,
          soldQty: md.soldQty || 0,
          salesAmount: util.fmtMoney(monthSales),
          purchaseQty: md.purchaseQty || 0,
          purchaseCount: md.purchaseCount || 0,
          purchaseAmount: util.fmtMoney(md.purchaseAmount),
          grossProfit: util.fmtMoney(monthProfit),
          profitRate: monthSales > 0 ? ((monthProfit / monthSales) * 100).toFixed(1) : '0.0'
        };
      } catch (e) {
        console.warn('今日/本月统计失败(可能集合未初始化):', e.message);
      }

      // 1.5) 全期欠款汇总（用宽区间近似全期，避免拉全表）
      let debt = { totalDebt: 0, totalDebtText: '0.00', totalCount: 0, totalAmountDueText: '0.00', totalReceivedText: '0.00' };
      try {
        // 用一个很宽的区间（比如过去 1 年 ~ 今天+1 天），保证覆盖到全部欠款
        const farRange = util.rangeMs(util.addDays(util.todayStr(), -365), util.todayStr());
        const dr = await util.fetchDebts({ startMs: farRange.startMs, endMs: farRange.endMs });
        const dd = dr.data || {};
        debt = {
          totalDebt: dd.totalDebt || 0,
          totalDebtText: util.fmtMoney(dd.totalDebt),
          totalCount: dd.totalCount || 0,
          totalAmountDueText: util.fmtMoney(dd.totalAmountDue),
          totalReceivedText: util.fmtMoney(dd.totalReceived)
        };
      } catch (e) {
        console.warn('欠款统计失败(可能集合未初始化):', e.message);
      }

      // 2) 低库存预警
      const settings = await util.fetchSettings();
      const threshold = Math.max(0, Math.floor(util.toNum(settings.lowStockThreshold, 5)));
      let lowGoods = [];

      // 2.5) 库存现状：兼容 SKU 与旧单一库存；按 售价/成本 各自计算总值
      let inv = {
        skuCount: 0, totalQty: 0, totalQtyText: '0',
        totalCost: '0.00', totalRetail: '0.00',
        expectedProfit: '0.00', lowSkuCount: 0,
        byCategory: [], byColor: []
      };
      try {
        const allGoods = await util.listCollAll('goods', { orderBy: 'createdAt', order: 'desc' });
        let totalQty = 0;
        let totalCost = 0;
        let totalRetail = 0;
        let lowCount = 0;
        const catMap = new Map(); // 分类 → 件数
        const colorMap = new Map(); // 颜色 → 件数
        const PALETTE = ['#07c160', '#1989fa', '#ff9900', '#e64340', '#9b59b6', '#1abc9c', '#f39c12', '#34495e'];
        allGoods.forEach((g) => {
          const cat = (g.category || '未分类').trim() || '未分类';
          const skus = Array.isArray(g.skus) && g.skus.length ? g.skus : null;
          if (skus) {
            skus.forEach((sku) => {
              const s = util.toNum(sku.stock, 0);
              const c = util.toNum(sku.costPrice, 0);
              const p = util.toNum(sku.price, 0);
              const col = (sku.color || '默认').trim() || '默认';
              totalQty += s;
              totalCost += s * c;
              totalRetail += s * p;
              catMap.set(cat, (catMap.get(cat) || 0) + s);
              colorMap.set(col, (colorMap.get(col) || 0) + s);
              if (g.status === 'on' && s <= threshold) {
                lowCount += 1;
                lowGoods.push({ _id: g._id, rowKey: g._id + '|' + sku.key,
                  skuKey: sku.key, name: g.name, category: g.category,
                  unit: g.unit || '件', stock: s, costPrice: util.fmtMoney(c),
                  specText: [sku.color, sku.size].filter(Boolean).join(' · ') || '默认规格' });
              }
            });
          } else {
            const s = util.toNum(g.stock, 0);
            const c = util.toNum(g.costPrice, 0);
            const p = util.toNum(g.price, 0);
            totalQty += s;
            totalCost += s * c;
            totalRetail += s * p;
            catMap.set(cat, (catMap.get(cat) || 0) + s);
            if (g.status === 'on' && s <= threshold) {
              lowCount += 1;
              lowGoods.push({ _id: g._id, rowKey: g._id, name: g.name,
                category: g.category, unit: g.unit || '件', stock: s,
                costPrice: util.fmtMoney(c), specText: '默认规格' });
            }
          }
        });
        lowGoods.sort((a, b) => a.stock - b.stock);
        lowGoods = lowGoods.slice(0, 20);
        // 分类排行（按数量降序，取 Top 6，剩余合并为「其他」）
        const sortedCat = Array.from(catMap.entries()).sort((a, b) => b[1] - a[1]);
        const topCat = sortedCat.slice(0, 6);
        const restCat = sortedCat.slice(6).reduce((s, e) => s + e[1], 0);
        const byCategory = topCat.map((entry, i) => ({
          cat: entry[0], qty: entry[1], pct: totalQty > 0 ? ((entry[1] / totalQty) * 100).toFixed(1) : '0',
          color: PALETTE[i % PALETTE.length]
        }));
        if (restCat > 0) {
          byCategory.push({ cat: '其他', qty: restCat, pct: ((restCat / totalQty) * 100).toFixed(1), color: '#bfbfbf' });
        }
        // 颜色排行（Top 6）
        const sortedColor = Array.from(colorMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const byColor = sortedColor.map((entry, i) => ({
          colorName: entry[0], qty: entry[1], pct: totalQty > 0 ? ((entry[1] / totalQty) * 100).toFixed(1) : '0',
          fill: PALETTE[i % PALETTE.length]
        }));
        // 计算 conic-gradient 字符串（每个分类/颜色按占比切分）
        const buildGradient = (arr) => {
          if (!arr.length || totalQty === 0) return '#e0e0e0 0% 100%';
          let cursor = 0;
          const stops = [];
          arr.forEach((it) => {
            const start = (cursor / totalQty * 100);
            cursor += it.qty;
            const end = (cursor / totalQty * 100);
            stops.push(`${it.color || it.fill} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
          });
          return stops.join(', ');
        };
        inv = {
          skuCount: allGoods.length,
          totalQty: totalQty,
          totalQtyText: totalQty >= 1000 ? (Math.round(totalQty / 100) / 10) + 'k' : '' + totalQty,
          totalCost: util.fmtMoney(totalCost),
          totalRetail: util.fmtMoney(totalRetail),
          expectedProfit: util.fmtMoney(Math.max(0, totalRetail - totalCost)),
          lowSkuCount: lowCount,
          byCategory: byCategory,
          byColor: byColor,
          pieGradient: buildGradient(byCategory),
          pieGradientColor: buildGradient(byColor)
        };
      } catch (e) {
        console.warn('库存聚合失败:', e.message);
      }

      // 3) 最近订单（销售+进货各取最新，合并取前 8）
      let recent = [];
      try {
        const [sales, purchases] = await Promise.all([
          util.listColl('sales_orders', { limit: 8, orderBy: 'createdAt', order: 'desc' }),
          util.listColl('purchase_orders', { limit: 8, orderBy: 'createdAt', order: 'desc' })
        ]);
        const merged = [];
        sales.forEach((o) => {
          merged.push({
            rowKey: 'sale_' + o._id,
            _id: o._id,
            type: 'sale',
            typeText: '销售',
            orderNo: o.orderNo || '',
            amountText: '¥' + util.fmtMoney(o.amountDue),
            itemsText: (Array.isArray(o.lines) ? o.lines : []).map((l) => (l.name || '(商品)') + '×' + l.qty).join('，'),
            timeText: util.fmtDateTime(o.createdAt),
            createdAt: o.createdAt,
            returned: o.status === 'returned'
          });
        });
        purchases.forEach((o) => {
          merged.push({
            rowKey: 'purchase_' + o._id,
            _id: o._id,
            type: 'purchase',
            typeText: '进货',
            orderNo: o.orderNo || '',
            amountText: '¥' + util.fmtMoney(o.totalAmount),
            itemsText: (Array.isArray(o.lines) ? o.lines : []).map((l) => (l.name || '(商品)') + '×' + l.qty).join('，'),
            timeText: util.fmtDateTime(o.createdAt),
            createdAt: o.createdAt,
            returned: false
          });
        });
        merged.sort((a, b) => {
          const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime();
          const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime();
          return (tb || 0) - (ta || 0);
        });
        recent = merged.slice(0, 8);
      } catch (e) {
        console.warn('最近订单查询失败:', e.message);
      }

      this.setData({ stat: stat, mstat: mstat, inv: inv, debt: debt,
        lowGoods: lowGoods, lowLimit: threshold, recent: recent, trend: trend, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败，请检查云环境配置', icon: 'none' });
    } finally {
      this._refreshing = false;
    }
  },

  // ---------- 跳转 ----------
  goSale() { wx.switchTab({ url: '/pages/sale/sale' }); },
  goPurchase() { wx.navigateTo({ url: '/pages/purchase/purchase' }); },
  goGoods() { wx.navigateTo({ url: '/pages/goods/goods' }); },
  goSuppliers() { wx.navigateTo({ url: '/pages/suppliers/suppliers' }); },
  goStats() { wx.switchTab({ url: '/pages/stats/stats' }); },
  goDebts() { wx.navigateTo({ url: '/pages/debts/debts' }); },
  goCustomers() { wx.navigateTo({ url: '/pages/customers/customers' }); },
  goSlowMover() { wx.navigateTo({ url: '/pages/slow-mover/slow-mover' }); },
  goStatement() { wx.navigateTo({ url: '/pages/statement/statement' }); },
  switchDistTab(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ distTab: t });
  },
  goDetail(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + d.id + '&type=' + d.type });
  },
  // 带入所点商品，进货页继续选择需要补齐的规格。
  restock(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/purchase/purchase?goodsId=' + encodeURIComponent(id) });
  }
});
