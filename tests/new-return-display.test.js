const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page-runtime');
const { render, nodes, available } = require('./helpers/wxml-runtime');
const util = require('../utils/util');
const receipt = require('../utils/receipt');
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : (tree && tree.children || []).map(text).join('');
const fixture = (status = 'returned') => ({
  _id:'returned-1',type:'sale',status,orderNo:'XS-RETURN-1',createdAt:'2026-09-13T04:00:00.000Z',returnedAt:'2026-09-13T05:00:00.000Z',
  subtotal:99.9,amountDue:99.9,received:70,debt:29.9,change:0,paymentMethod:'credit',discountPct:100,
  lines:[{name:'测试衬衫',qty:1,price:99.9,amount:99.9,color:'白',size:'M',cost:35}],
  settleHistory:[{amount:10,paymentMethod:'cash'}]
});
function draw(order) {
  const items=[];
  const ctx={canvas:{height:1800},font:'20px sans-serif',fillText:(value,x,y)=>items.push({value:String(value),x,y}),
    measureText(text){return{width:String(text).length*(parseInt(this.font.replace('bold ',''),10)||20)};},
    fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},strokeRect(){},setLineDash(){}};
  receipt.drawReceipt(ctx,384,order,{storeName:'丹姐女装童装'},{});return items;
}

test('退货流水把29.90明确标为已取消历史欠款，保留99.90原交易金额', {skip:!available},()=>{
  const order=fixture(),snapshot=JSON.stringify(order),page=loadPage('orders');
  page.setData({list:[page.toRow(order)],loading:false});
  const rendered=text(render('orders',page.data));
  assert.match(rendered,/原交易/);assert.match(rendered,/99\.90/);assert.match(rendered,/退货前欠款/);assert.match(rendered,/29\.90/);assert.match(rendered,/已取消/);
  assert.doesNotMatch(rendered,/ · 欠 ¥29\.90/);
  assert.equal(JSON.stringify(order),snapshot);
});

test('退货详情各金额明确属于原交易且不展示仍需支付的欠款', {skip:!available},async()=>{
  const order=fixture(),snapshot=JSON.stringify(order);
  const page=loadPage('order-detail',{wx:{showToast(){}},modules:{'../../utils/util.js':{...util,ensureOpenid:async()=> 'owner',getDocById:async()=>order}}});
  await page.loadDoc();const tree=render('order-detail',page.data);
  const rows=nodes(tree).filter(n=>n.attr&&String(n.attr.class).split(' ').includes('info-row')).map(text);
  assert.ok(rows.some(t=>/原交易应收/.test(t)&&/99\.90/.test(t)));
  assert.ok(rows.some(t=>/退货前实收/.test(t)&&/70\.00/.test(t)));
  assert.ok(rows.some(t=>/退货前欠款/.test(t)&&/29\.90/.test(t)&&/已取消/.test(t)));
  assert.ok(!rows.some(t=>/^欠款/.test(t)));
  assert.equal(JSON.stringify(order),snapshot);
});

test('退货小票将欠款标记已取消，原金额保留且不宣称完成退款',()=>{
  const order=fixture(),snapshot=JSON.stringify(order),drawn=draw(order);
  const labels=drawn.map(v=>v.value);
  assert.ok(labels.includes('原交易应收'));
  assert.ok(labels.includes('退货前实收'));
  const debtLabel=drawn.find(v=>v.value==='退货前欠款');assert.ok(debtLabel);
  assert.ok(drawn.some(v=>v.y===debtLabel.y&&v.value==='29.90'));
  assert.ok(labels.some(t=>/已取消/.test(t)));
  assert.ok(!labels.includes('欠款(记账)'));
  assert.ok(!labels.some(t=>/已退款|退款成功/.test(t)));
  assert.equal(JSON.stringify(order),snapshot);
});

test('正常未结清销售仍展示实收与待收欠款，不能错误标为已取消', {skip:!available},async()=>{
  const order=fixture('completed'),listPage=loadPage('orders');listPage.setData({list:[listPage.toRow(order)],loading:false});
  const listText=text(render('orders',listPage.data));assert.match(listText,/欠 ¥29\.90/);assert.doesNotMatch(listText,/已取消|退货前/);
  const receiptLabels=draw(order).map(v=>v.value);assert.ok(receiptLabels.includes('欠款(记账)'));assert.ok(receiptLabels.includes('累计实收'));assert.ok(!receiptLabels.some(v=>/退货前|已取消/.test(v)));
});
