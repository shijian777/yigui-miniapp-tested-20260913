// 云函数 migrateSku：把旧商品（有 stock 字段，无 skus 字段）迁移到 SKU 模型。
// 幂等：已经迁移过的（g.skus 存在）跳过。
// 用法：客户端调 util.migrateSku() 一次；返回 { scanned, migrated, skipped, errors }。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  const dryRun = !!event.dryRun;
  const limit = Math.min(1000, Math.max(1, Number(event.limit) || 500));
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  const errors = [];

  try {
    const res = await db.collection('goods').where({ openid: OPENID }).limit(limit).get();
    const items = res.data || [];
    scanned = items.length;

    for (let i = 0; i < items.length; i++) {
      const g = items[i];
      if (Array.isArray(g.skus) && g.skus.length) {
        skipped++;
        continue;
      }
      const oldStock = Number(g.stock) || 0;
      const oldCost = Number(g.costPrice) || 0;
      const oldPrice = Number(g.price) || 0;
      const skuKey = '默认·默认';
      const sku = {
        key: skuKey,
        color: '默认',
        size: '默认',
        stock: oldStock,
        costPrice: oldCost,
        price: oldPrice
      };
      const updateData = {
        skus: [sku],
        colors: ['默认'],
        sizes: ['默认'],
        totalStock: oldStock,
        migratedAt: new Date()
      };
      // 保留旧的 stock 字段作为 fallback（防止迁移后某条云函数路径漏读 skus）
      // 同时保留 costPrice / price 商品级汇总
      if (dryRun) {
        skipped++;
        continue;
      }
      try {
        await db.collection('goods').doc(g._id).update({ data: updateData });
        migrated++;
      } catch (e) {
        errors.push({ _id: g._id, name: g.name, message: e.message });
      }
    }

    return {
      success: true,
      dryRun: dryRun,
      scanned: scanned,
      migrated: migrated,
      skipped: skipped,
      errors: errors,
      remaining: await db.collection('goods').where({ openid: OPENID, skus: db.command.exists(false) }).count().then(r => r.total).catch(() => 0)
    };
  } catch (e) {
    console.error('[migrateSku]', e);
    return { success: false, message: e.message || '迁移失败', scanned: scanned, migrated: migrated };
  }
};
