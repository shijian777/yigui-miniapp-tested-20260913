const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, deferred, flush } = require('./helpers/page-runtime');
const baseUtil = require('../utils/util');
function runtime(name, overrides = {}, wxOverrides = {}) {
  const effects = { toasts: [], routes: [], backs: 0, writes: [], removes: [] };
  const wx = { showToast: v => effects.toasts.push(v), showModal: v => v.success && v.success({confirm:true}),
    showActionSheet: v => v.success({tapIndex:0}), navigateBack: () => effects.backs++,
    navigateTo: v => effects.routes.push(v), setNavigationBarTitle() {},
    cloud: { database: () => ({RegExp: x => x, command: {}}) }, ...wxOverrides };
  const util = { ...baseUtil, db: () => wx.cloud.database(), ensureOpenid: async () => 'owner',
    cmd: () => ({ gte: value => ({ and: other => ({ value, other }) }), lt: value => ({ value }) }),
    listColl: async () => [], listCollAll: async () => [],
    addDoc: async (c,d) => {effects.writes.push({c,d}); return 'new';},
    updateDocById: async (c,id,d) => {effects.writes.push({c,id,d}); return 1;},
    removeDocById: async (c,id) => {effects.removes.push({c,id}); return 1;}, ...overrides };
  return {page:loadPage(name,{wx, app:{globalData:{openid:'owner'}}, modules:{'../../utils/util.js':util}}),effects,util};
}
const dates = {startDate:'2026-09-01',endDate:'2026-09-13'};
const change = value => ({detail:{value}});
const dataset = d => ({currentTarget:{dataset:d}});

test('统计昨天只查询昨天，不包含今天', async () => {
  const {page}=runtime('stats',{todayStr:()=> '2026-09-13',fetchStats:async()=>({data:{}})});
  page.setQuick(dataset({q:'yesterday'})); await flush();
  assert.equal(page.data.startDate,'2026-09-12'); assert.equal(page.data.endDate,'2026-09-12');
});
test('统计切换日期后慢查询不能覆盖新金额', async () => {
  const a=deferred(),b=deferred(); let n=0;
  const {page}=runtime('stats',{fetchStats:()=>++n===1?a.promise:b.promise}); page.setData(dates);
  const first=page.load(); page.setData({startDate:'2026-09-12'}); const second=page.load();
  b.resolve({data:{salesAmount:12.34}}); await second; a.resolve({data:{salesAmount:99}}); await first;
  assert.equal(page.data.stat.salesAmount,'12.34');
});
test('清空客户立即结束对账加载并阻止迟到结果回填', async () => {
  const a=deferred(); const {page}=runtime('statement',{callFn:()=>a.promise});
  page.setData({...dates,customerId:'c1'}); const pending=page.reload(); page.clearCustomer();
  a.resolve({data:{summary:{debt:20},list:[{_id:'o1',amount:20}]}}); await pending;
  assert.equal(page.data.loading,false); assert.equal(page.data.summary,null); assert.equal(page.data.list.length,0);
});
test('欠款的迟到客户聚合失败不能覆盖新查询', async () => {
  const a=deferred(); let n=0;
  const {page}=runtime('debts',{fetchDebts:async()=>({data:{totalDebt:++n===1?99:12}}),fetchDebtCustomers:()=>n===1?a.promise:Promise.resolve({data:{list:[]}})});
  page.setData(dates); const first=page.reload(); await flush(); const second=page.reload(); await second;
  a.reject(new Error('旧网络失败')); await first; assert.equal(page.data.summary.totalDebt,'12.00');
});
test('滞销阈值切换保留最新查询且多规格拥有独立行', async()=>{
  const a=deferred(),b=deferred();let n=0;
  const {page}=runtime('slow-mover',{callFn:()=>++n===1?a.promise:b.promise});
  const first=page.reload();page.setData({threshold:30});const second=page.reload();
  b.resolve({data:{list:[{goodsId:'g1',skuKey:'白-S'},{goodsId:'g1',skuKey:'白-M'}]}});await second;
  a.resolve({data:{list:[]}});await first;
  assert.equal(page.data.list.length,2);assert.ok(page.data.list[0].rowKey);assert.notEqual(page.data.list[0].rowKey,page.data.list[1].rowKey);
});
for(const name of ['stats','statement','debts','orders']) test(name+'拒绝倒置日期而不是显示空账',async()=>{
  let reads=0; const {page,effects}=runtime(name,{fetchStats:async()=>{reads++;return{data:{}};},callFn:async()=>{reads++;return{data:{}};},fetchDebts:async()=>{reads++;return{data:{}};},listColl:async()=>{reads++;return[];}});
  page.setData({startDate:'2026-09-13',endDate:'2026-09-01',customerId:'c1'});
  await (page.load? page.load():page.reload()); assert.equal(reads,0); assert.ok(effects.toasts.length||page.data.errText);
});
for(const name of ['goods','customers','suppliers']) test(name+'快速重查不混入旧列表',async()=>{
  const a=deferred(),b=deferred();let n=0;
  const {page}=runtime(name,{listColl:()=>++n===1?a.promise:b.promise,listCollAll:()=>++n===1?a.promise:b.promise});
  const first=name==='suppliers'?page.load():page.reload(); await flush();
  const second=name==='suppliers'?page.load():page.reload(); await flush();
  b.resolve([{_id:'new',name:'新'}]);await second;a.resolve([{_id:'old',name:'旧'}]);await first;
  assert.deepEqual(Array.from(page.data.list,v=>v._id),['new']);
});
for(const name of ['customer-edit','supplier-edit','goods-edit']) test(name+'加载前不能保存空表单覆盖档案',async()=>{
  const a=deferred(); const {page,effects}=runtime(name,{getDocById:()=>a.promise,callFn:async()=>{effects.writes.push('goods');return{goodsId:'g1'};}});
  page.onLoad({id:'record1'}); await flush();page.setData({'form.name':'误触输入'});
  await (name==='customer-edit'?page.save():page.doSave());await flush();
  assert.equal(effects.writes.length,0);a.resolve({_id:'record1',name:'原始档案',skus:[],stock:0});await flush();
});
test('客户连续点击保存只新增一份档案并记录全部输入',async()=>{
  const a=deferred(); const records=[];
  const {page}=runtime('customer-edit',{addDoc:async(c,d)=>{records.push(d);await a.promise;return'c1';}});
  page.onName(change(' 王姐 '));page.onPhone(change('13800138000'));page.onAddress(change('镇上服装街12号'));page.onNote(change('留白色M码'));
  const first=page.save();const second=page.save();await flush();assert.equal(records.length,1);
  assert.equal(records[0].name,'王姐');assert.equal(records[0].note,'留白色M码');a.resolve();await Promise.all([first,second]);page.onUnload&&page.onUnload();
});
for(const name of ['customer-edit','supplier-edit','goods-edit']) test(name+'保存后手动返回不能由旧计时器弹走新页面',async()=>{
  const {page,effects}=runtime(name,{callFn:async()=>({goodsId:'g1'})});
  page.setData({'form.name':'新档案'});
  await(name==='customer-edit'?page.save():page.doSave());await flush();page.onUnload&&page.onUnload();
  await new Promise(r=>setTimeout(r,650));assert.equal(effects.backs,0);
});
test('有历史订单的零欠款客户不能删除',async()=>{
  const {page,effects}=runtime('customers',{listColl:async(c,o)=>c==='sales_orders'&&o.where.customerId==='c1'?[{_id:'returned',status:'returned'}]:[]});
  page.setData({list:[{_id:'c1',name:'王姐',totalSpent:0,totalDebt:0}]});await page.confirmDelete('c1');await flush();assert.equal(effects.removes.length,0);
});
test('有历史进货单的供应商不能删除',async()=>{
  const {page,effects}=runtime('supplier-edit',{getDocById:async()=>({_id:'s1',name:'供应商'}),listColl:async(c,o)=>c==='purchase_orders'&&o.where.supplierId==='s1'?[{_id:'p1'}]:[]});
  page.onLoad({id:'s1'});await flush();await page.doDelete();await flush();assert.equal(effects.removes.length,0);page.onUnload&&page.onUnload();
});
test('停售商品保留零库存商品档案供历史退货',async()=>{
  const {page,effects}=runtime('goods-edit',{getDocById:async()=>({_id:'g1',name:'旧款',stock:0,skus:[]})});
  page.onLoad({id:'g1'});await flush();await page.doDelete();await flush();
  assert.equal(effects.removes.length,0);assert.ok(effects.writes.some(w=>w.c==='goods'&&w.d.status==='off'));page.onUnload&&page.onUnload();
});
test('订单详情补收中不允许同时退货',async()=>{
  const {page,effects}=runtime('order-detail',{returnSale:async()=>{effects.writes.push('return');}});
  page.setData({doc:{_id:'o1',amountDue:50,debt:20},settling:true});page.doReturn();await flush();assert.equal(effects.writes.length,0);
});
test('订单详情连续退货点击只发一笔且通知原页面更新',async()=>{
  const a=deferred();let calls=0,emits=0;const modals=[];
  const {page}=runtime('order-detail',{returnSale:()=>{calls++;return a.promise;},getDocById:async()=>({_id:'o1',status:'returned',lines:[]})},{showModal:v=>modals.push(v)});
  page.getOpenerEventChannel=()=>({emit:name=>{if(name==='orderChanged')emits++;}});
  page.setData({id:'o1',doc:{_id:'o1',status:'normal',amountDue:50}});page.doReturn();page.doReturn();
  for(const modal of modals)modal.success({confirm:true});await flush();assert.equal(calls,1);
  a.resolve();await flush();assert.equal(emits,1);
});
test('订单Tab返回后重新查询已退货状态',async()=>{
  const {page}=runtime('orders');let reads=0;page.reload=async()=>{reads++;};page.onShow();await flush();assert.equal(reads,1);
});
test('客户查看订单入口打开该客户对账单',async()=>{
  const {page,effects}=runtime('customers');page.setData({list:[{_id:'c1',name:'王姐'}]});page.goDetail(dataset({id:'c1'}));
  assert.ok(effects.routes[0]&&effects.routes[0].url.includes('/pages/statement/statement?customerId=c1'));
});

// Integrate real page code, util queries and LocalCloud against isolated device storage.
function localFixture() {
  const { createLocalCloud } = require('../utils/localcloud');
  const { createAtomicStorage } = require('../utils/atomic-storage');
  const values = new Map();
  const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const raw = { getStorageSync: k => copy(values.get(k)), setStorageSync: (k,v) => values.set(k,copy(v)), removeStorageSync: k => values.delete(k), getStorageInfoSync: () => ({keys:[...values.keys()]}) };
  const atomic=createAtomicStorage(raw);atomic.setStorageSync('cpos_openid','ledger-owner');
  const cloud=createLocalCloud(atomic), app={dataCloud:cloud,globalData:{openid:'ledger-owner'}};
  const wx={...raw,cloud,showToast(){},showModal:o=>o.success&&o.success({confirm:true}),navigateBack(){},setNavigationBarTitle(){}};
  const previousWx=global.wx,previousApp=global.getApp;global.wx=wx;global.getApp=()=>app;
  return {cloud,wx,app,page:name=>loadPage(name,{wx,app}),close:()=>{global.wx=previousWx;global.getApp=previousApp;}};
}
test('100条真实本地销售与进货流水分页无重无漏且时间倒序',async()=>{
  const f=localFixture();try {
    for(let i=0;i<100;i++) await f.cloud.database().collection(i%2?'sales_orders':'purchase_orders').add({data:{
      openid:'ledger-owner',type:i%2?'sale':'purchase',createdAt:new Date(2026,8,13,12,0,i),amountDue:i,totalAmount:i,lines:[]
    }});
    const page=f.page('orders');page.setData({startDate:'2026-09-13',endDate:'2026-09-13'});await page.reload();
    let pages=1;while(page.data.hasMore&&pages<10){await page.loadNext();pages++;}
    assert.equal(page.data.list.length,100);assert.equal(new Set(page.data.list.map(v=>v._id)).size,100);
    assert.deepEqual(Array.from(page.data.list,v=>v.amountText),Array.from({length:100},(_,i)=>(99-i).toFixed(2)));
    page.onUnload();
  } finally {f.close();}
});
test('实际档案输入保存后重新打开仍保留客户地址备注与供应商联系信息',async()=>{
  const f=localFixture();try {
    const customer=f.page('customer-edit');customer.onName(change('测试客户'));customer.onAddress(change('上海市服装路12号3层'));customer.onNote(change('预留米白M码'));
    await customer.save();customer.onUnload();
    const customers=(await f.cloud.database().collection('customers').get()).data;assert.equal(customers.length,1);
    const reopened=f.page('customer-edit');await reopened.load(customers[0]._id);assert.equal(reopened.data.form.address,'上海市服装路12号3层');assert.equal(reopened.data.form.note,'预留米白M码');reopened.onUnload();
    const supplier=f.page('supplier-edit');supplier.onInput({...dataset({f:'name'}),detail:{value:'童装批发'}});supplier.onInput({...dataset({f:'contact'}),detail:{value:'李先生'}});supplier.onInput({...dataset({f:'remark'}),detail:{value:'周二送货'}});
    supplier.doSave();await flush();supplier.onUnload();
    const suppliers=(await f.cloud.database().collection('suppliers').get()).data;assert.equal(suppliers.length,1);
    const again=f.page('supplier-edit');await again.loadDoc(suppliers[0]._id);assert.equal(again.data.form.contact,'李先生');assert.equal(again.data.form.remark,'周二送货');again.onUnload();
  }finally{f.close();}
});
