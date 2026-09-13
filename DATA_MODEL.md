# DATA_MODEL —— 数据模型与索引

云开发环境：一个老板（一个 openid）一个店铺的所有数据。以下 7 个集合均需手动创建，
**权限统一选「仅创建者可读写」**。

隔离规则：每个文档带显式 `openid` 字段。
- 客户端新增（商品/供应商/设置/期初流水）会带上从 `login` 云函数拿到的 openid；
- 云函数（submitSale/submitPurchase/returnSale/stats）一律 `where({openid: OPENID})` 过滤，
  写入时显式带 `openid: OPENID`，不使用/不信任客户端传入的身份；
- 集合权限的 `_openid` 作为第二层兜底（客户端侧查询天然只能看到自己的文档）。

时间约定：
- 所有 `createdAt/updatedAt/returnedAt` 存 **Date 类型**（云函数 `new Date()` 服务端时间）。
- 统计/列表的"按天过滤"由客户端把本地日期换算成毫秒区间 `[startMs, endMs)` 传云函数或
  直接构 Date 查询条件，规避云函数时区与用户时区不一致的问题。

金额约定：
- 金额一律 number（单位：元），计算统一 `round2` = 四舍五入两位小数；
- 订单/流水内的金额在写入时已快照，后续商品改价不影响历史单。

---

## 1) goods 商品（**色码管理** Phase 2）

### 数据模型

| 字段 | 类型 | 说明 |
|---|---|---|
| _id | string | 文档 ID |
| openid | string | 归属老板 |
| name | string | 名称（必填） |
| barcode | string | 主条码（款级），可空 |
| category | string | 分类，自由文本 |
| unit | string | 单位（件/条/双…） |
| **colors** | array\<string\> | 该款的所有颜色，如 `["黑","蓝","灰"]` |
| **sizes** | array\<string\> | 该款的所有尺码，如 `["S","M","L"]` |
| **skus** | array\<object\> | **SKU 列表**（核心），每条：<br>`{key, color, size, stock, costPrice, price}`<br>`key = color + '-' + size` 唯一 |
| stock | number | **派生缓存** = Σ `skus.stock`，列表/首页用 |
| skuCount | number | **派生缓存** = 非空 SKU 数 |
| costPrice | number | 默认成本价（兼容性字段，批量填充用） |
| price | number | 默认售价（兼容性字段，批量填充用） |
| status | string | `on` 在售 / `off` 停售 |
| createdAt / updatedAt | Date | 建档 / 最后修改 |

### SKU 示例

```js
colors: ['黑','蓝'],
sizes: ['S','M','L'],
skus: [
  { key: '黑-S', color: '黑', size: 'S', stock: 5,  costPrice: 60, price: 120 },
  { key: '黑-M', color: '黑', size: 'M', stock: 12, costPrice: 60, price: 120 },
  { key: '黑-L', color: '黑', size: 'L', stock: 8,  costPrice: 60, price: 120 },
  { key: '蓝-S', color: '蓝', size: 'S', stock: 0,  costPrice: 60, price: 120 },
  { key: '蓝-M', color: '蓝', size: 'M', stock: 15, costPrice: 60, price: 120 },
  { key: '蓝-L', color: '蓝', size: 'L', stock: 3,  costPrice: 60, price: 120 }
],
stock: 43, // Σ skus.stock
skuCount: 5 // 非空 SKU 数
```

### 销售/退货/进货 时

- 销售单 `lines[]` 每条加 `skuKey` 字段（如 `'黑-M'`）
- 库存扣减按 `skus[skuKey].stock` 走
- 成本快照按 `skus[skuKey].costPrice` 取，写入 `lines.cost`

### 兼容旧数据
- 旧版 goods 没有 `colors/sizes/skus` → 自动视为 1 个默认 SKU（key=`默认·默认`）
- 旧版 stock 直接映射到默认 SKU 的 stock 字段
- 一次性 `cloudfunctions/migrateSku` 把已有数据预迁好（幂等，可重复执行）
- 商品编辑页加载旧商品时**自动转换**，无需手动迁移

### 写入方

- 建档/编辑/上下架/颜色尺码调整 = 客户端 `goods-edit.js`
- 库存变化（仅按 SKU 维度）= `submitPurchase` / `submitSale` / `returnSale` 云函数事务

### 索引建议

- `openid`(升序) + `createdAt`(降序) —— 列表默认排序
- `openid`(升序) + `status`(升序) + `stock`(升序) —— 低库存预警/在售筛选
- 名称/条码正则模糊搜索，小数据量不建索引；量大后再考虑分词方案

## 2) suppliers 供应商

| 字段 | 类型 | 说明 |
|---|---|---|
| _id / openid | | 同上 |
| name | string | 名称（必填） |
| contact | string | 联系人，可空 |
| phone | string | 电话，可空 |
| remark | string | 备注，可空 |
| createdAt / updatedAt | Date | |

删除供应商不影响历史进货单（进货单保存了名称快照）。索引：`openid` 即可。

## 3) sales_orders 销售单

| 字段 | 类型 | 说明 |
|---|---|---|
| _id / openid | | |
| orderNo | string | 单号 XS+时间戳+随机，展示用 |
| type | string | 恒为 `sale` |
| status | string | `completed` 正常 / `returned` 已退货（红冲保留原单） |
| paymentMethod | string | `cash`/`wechat`/`alipay`/`credit` |
| paymentMethodText | string | 冗余中文，小票直接用 |
| subtotal | number | Σ round2(单价×数量) |
| discountPct | number | 折扣% 0~100，100=不打折 |
| discountAmount | number | 折扣省下金额 |
| erase | bool | 是否抹零 |
| eraseAmount | number | 抹零金额（分角） |
| amountDue | number | 应收 = 折后金额（抹零则取整） |
| received | number | 实收 |
| change | number | 找零 = max(0, 实收−应收) |
| debt | number | 欠款 = max(0, 应收−实收)（记账场景） |
| remark | string | 备注（打印在小票上） |
| customerId | string | 客户档案 ID（可选），选了客户档案时写入 |
| customerName / customerPhone | string | 顾客姓名/电话（如选客户档案会随之带出，手填也保留） |
| lines | array | **内嵌明细**，元素：`{goodsId, name, unit, price(成交单价), qty, amount, cost(售出时成本快照), skuKey, color, size}` |
| createdAt | Date | 开单时间 |
| returnedAt / returnReason | Date/string | 退货信息（status=returned 时） |

写入方：仅 `submitSale`（created/扣库存）与 `returnSale`（标记 returned + 回补库存），均事务。
客户端只读（列表/详情/统计数据源之一）。整单退货、明细内嵌，Phase 2 可扩展行级部分退货。

索引建议：
- `openid`(升序) + `createdAt`(降序) —— 流水列表
- `openid`(升序) + `status`(升序) + `createdAt`(降序) —— 统计/剔除退货（stats 云函数 match）
- `openid`(升序) + `customerId`(升序) —— 按客户聚合（debtCustomers 云函数）

## 4) purchase_orders 进货单

| 字段 | 类型 | 说明 |
|---|---|---|
| _id / openid | | |
| orderNo | string | 单号 JH+时间戳+随机 |
| type | string | 恒为 `purchase` |
| supplierId / supplierName | string | 供应商 ID 与名称快照；未选则散货（空） |
| remark | string | |
| totalAmount | number | Σ round2(进价×数量) |
| lines | array | 内嵌明细：`{goodsId, name, unit, qty, unitCost, amount}` |
| createdAt | Date | |

写入方：仅 `submitPurchase` 事务。Phase 1 不做进货退货。
索引：`openid` + `createdAt`(降序)。

## 7) customers 客户档案

| 字段 | 类型 | 说明 |
|---|---|---|
| _id / openid | | |
| name | string | 姓名（必填） |
| phone | string | 电话，可空 |
| wechat | string | 微信号，可空 |
| address | string | 地址，可空 |
| tags | array\<string\> | 标签（VIP/回头客/散户/批发/欠款等） |
| note | string | 备注 |
| totalSpent | number | **派生**：累计消费（completed 单 amountDue 之和） |
| totalOrders | number | **派生**：累计单数 |
| totalDebt | number | **派生**：当前未结清欠款总额（debt > 0 的 completed 单 debt 之和） |
| lastOrderAt | Date | **派生**：最近一次开单时间 |
| createdAt / updatedAt | Date | |

派生字段由 `stats.action=syncCustomers` 维护：销售开单成功后客户端异步调一次，全量重算该 openid 所有 customerId 对应客户的聚合值。

删除保护：有 `totalSpent > 0` 或 `totalDebt > 0` 不允许删除（UI 拦截）。

索引：`openid` + `lastOrderAt`(降序) 默认排序；`openid` + `name`(升序) 搜索。

## 5) inventory_logs 库存流水（审计/追溯）

| 字段 | 类型 | 说明 |
|---|---|---|
| _id / openid | | |
| type | string | `purchase` 进货 / `sale` 销售 / `return` 退货 / `initial` 期初建档 |
| action | string | `in` 入 / `out` 出 |
| goodsId / goodsName / unit | | 商品快照（商品删除后仍可追溯） |
| skuKey / color / size | string | **色码维度**（新数据写入） |
| qty | number | 数量（正数） |
| unitPrice | number | 成本口径单价（进货=进价；销售/退货=当时成本快照；期初=建档成本） |
| refType / refId | string | 来源：`purchase`/`sale`/`return`/`initial` + 关联单据 ID |
| createdAt | Date | |

写入方：三个库存云函数事务内逐行写入；期初由 goods-edit 客户端写入（尽力而为）。
索引：`openid` + `goodsId` + `createdAt`(降序)；`openid` + `refId`。

## 6) settings 设置（单文档）

每老板一条（按 openid 查第一条，没有则客户端自动建默认文档）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| storeName | string | 我的服装店 | 小票店名 |
| phone / address | string | '' | 小票头部 |
| receiptNote | string | 谢谢惠顾… | 小票底部备注 |
| defaultPayment | string | cash | 开单默认支付方式 |
| lowStockThreshold | number | 5 | 低库存预警阈值 |
| showQrPlaceholder | bool | false | 小票是否画二维码占位框 |
| updatedAt | Date | | |

索引：`openid` 唯一查询即可（数据量=1）。

---

## 金额/成本关键公式（与代码一一对应）

```
进货后成本价 newCost = round2( (costPrice × stock + unitCost × qty) / (stock + qty) )
销售应收  subtotal = Σ round2(price × qty)
         afterDiscount = round2(subtotal × discountPct / 100)
         amountDue = erase ? floor(afterDiscount) : afterDiscount   （抹零=取整到元）
         change = max(0, received − amountDue) ;  debt = max(0, amountDue − received)
毛利      = Σ amountDue(completed) − Σ(cost × qty)(completed)      （returned 单整单剔除）
```

## 事务范围（wx-server-sdk db.runTransaction）

- submitSale：逐行 doc.get 商品 → 校验库存/归属 → 扣库存(绝对值写) → add 销售单 → add 流水×行
- submitPurchase：逐行 doc.get 商品 → 加库存 + 写新成本价 → add 进货单 → add 流水×行
- returnSale：doc.get 销售单（校验本人 + completed）→ 逐行回补库存 + add 退货流水 →
  update 订单 status=returned / returnedAt / returnReason
- 事务内不支持 where/聚合/部分数据库指令，故全部采用「doc 级读 + 绝对值写」；
  冲突时 SDK 自动重试回调，重试基于最新文档状态。
