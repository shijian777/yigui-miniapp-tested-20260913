const test = require('node:test');
const assert = require('node:assert/strict');
const { render, nodes, available } = require('./helpers/wxml-runtime');
const hasClass = (node, cls) => String(node.attr && node.attr.class || '').split(/\s+/).includes(cls);
const hasAction = (node, action) => nodes(node).some(child => child.attr && child.attr.bindtap === action);
const fixture = debt => ({ theme: 'light', isSale: true, typeText: '销售', doc: { status: 'completed', debt, orderNo: 'LAYOUT-1' }, money: { debt: debt.toFixed(2) }, lines: [] });

test('欠款单的补收卡位于普通文档流，不能覆盖固定栏的退货和小票入口', {skip: !available}, () => {
  const tree = render('order-detail', fixture(50));
  const all = nodes(tree), fixedBars = all.filter(n => hasClass(n, 'footer-bar'));
  // .footer-bar uses position:fixed; bottom:0 in the shared stylesheet.
  // Two rendered bars at that anchor paint on top of one another, regardless of button presence.
  assert.equal(fixedBars.length, 1, '同一底部锚点只可存在一条操作栏');
  for (const action of ['doReturn', 'goReceipt', 'goPrinter']) assert.ok(hasAction(fixedBars[0], action));
  assert.equal(hasAction(fixedBars[0], 'doSettleDebt'), false, '补收按钮必须脱离固定操作栏');
  const paymentCard = all.find(n => hasClass(n, 'debt-settlement'));
  assert.ok(paymentCard && hasAction(paymentCard, 'doSettleDebt'));
  const spacer = all.find(n => hasClass(n, 'page-footer-space'));
  assert.ok(spacer && all.indexOf(paymentCard) < all.indexOf(spacer), '收款卡后必须留出固定栏的可滚动空间');
});

test('已结清销售单保持一个固定操作栏并移除补收卡', {skip: !available}, () => {
  const tree = render('order-detail', fixture(0)), all = nodes(tree);
  assert.equal(all.filter(n => hasClass(n, 'footer-bar')).length, 1);
  assert.equal(hasAction(tree, 'doSettleDebt'), false);
  assert.ok(hasAction(tree, 'doReturn'));
});

test('已退货单移除收款和再次退货的操作栏', {skip: !available}, () => {
  const data = fixture(50); data.doc.status = 'returned';
  const tree = render('order-detail', data);
  assert.equal(nodes(tree).filter(n => hasClass(n, 'footer-bar')).length, 0);
  assert.equal(hasAction(tree, 'doSettleDebt'), false);
  assert.equal(hasAction(tree, 'doReturn'), false);
});
