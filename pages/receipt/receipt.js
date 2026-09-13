// pages/receipt/receipt.js —— 电子小票
// 画布 384px 宽（= 58mm 热敏纸 @203dpi 打印宽度），所见即所得；
// 保存相册时放大到 2 倍分辨率输出更清晰。
const util = require('../../utils/util.js');
const receipt = require('../../utils/receipt.js');

const DRAW_W = receipt.DRAW_WIDTH; // 384

Page({
  data: {
    id: '',
    order: null,
    loading: true,
    errText: '',
    canvasReady: false,
    canvasHeight: 300,
    imageBusy: false
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
      if (app._applyNativeTheme) app._applyNativeTheme(app._resolveTheme(app.globalData.theme));
    } catch (e) {}

    this.setData({ id: (query && query.id) || '' });
    this.load();
  },

  async load() {
    try {
      await util.ensureOpenid();
      const [order, settings] = await Promise.all([
        util.getDocById('sales_orders', this.data.id),
        util.fetchSettings()
      ]);
      if (!order) {
        this.setData({ loading: false, errText: '订单不存在' });
        return;
      }
      if (order.type !== 'sale') {
        this.setData({ loading: false, errText: '只有销售单有小票' });
        return;
      }
      // 已退货的单保留原始交易金额，小票明确标注退货状态。
      this.order = order;
      this.settings = settings;
      this.setData({ order: order, loading: false }, () => this.scheduleRender());
    } catch (e) {
      this.setData({ loading: false, errText: (e && e.message) || '加载失败' });
    }
  },

  /* ---------- canvas 渲染 ---------- */
  onReady() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#receiptCanvas').fields({ node: true, size: true }).exec((res) => {
      if (res && res[0] && res[0].node) {
        this.canvasNode = res[0].node;
        this.ctx = this.canvasNode.getContext('2d');
        this.canvasNode.width = DRAW_W;
        this.displayWidth = res[0].width || DRAW_W;
        this.scheduleRender();
      } else {
        this.setData({ canvasReady: false, errText: '小票画布初始化失败，请点击重试' });
      }
    });
  },
  scheduleRender() {
    if (!this.order || !this.canvasNode) return;
    // 订单晚于 onReady 加载时，重新测量已显示画布，保持小票长宽比例。
    wx.createSelectorQuery().in(this).select('#receiptCanvas').fields({ size: true }).exec((res) => {
      if (res && res[0] && res[0].width) this.displayWidth = res[0].width;
      this.renderReceipt();
    });
  },
  renderReceipt() {
    const ctx = this.ctx;
    const order = this.order;
    const settings = this.settings || {};
    // 第一遍只测量（measureText 与画布尺寸无关）
    const h = receipt.drawReceipt(ctx, DRAW_W, order, settings, { dryRun: true });
    this.canvasNode.height = Math.max(120, Math.ceil(h));
    // 画布尺寸重置会清空内容，第二遍正式绘制
    receipt.drawReceipt(ctx, DRAW_W, order, settings, {});
    this.tempFilePath = '';
    this.setData({ canvasReady: true, canvasHeight: Math.ceil(this.canvasNode.height * (this.displayWidth || DRAW_W) / DRAW_W) });
  },

  /* ---------- 保存到相册 ---------- */
  canExportImage() {
    if (this.data.imageBusy) return false;
    if (!this.canvasNode || !this.order || !this.data.canvasReady) {
      wx.showToast({ title: '小票还未绘制完成，请稍后或重试', icon: 'none' });
      return false;
    }
    return true;
  },
  async exportImage() {
    if (this.tempFilePath) return this.tempFilePath;
    const res = await util.wxP(wx.canvasToTempFilePath, {
      canvas: this.canvasNode,
      x: 0, y: 0, width: this.canvasNode.width, height: this.canvasNode.height,
      destWidth: this.canvasNode.width * 2, destHeight: this.canvasNode.height * 2,
      fileType: 'png'
    });
    this.tempFilePath = res.tempFilePath;
    return res.tempFilePath;
  },
  async saveImage() {
    if (!this.canExportImage()) return;
    this.setData({ imageBusy: true });
    try {
      await this.ensureAlbumAuth();
      const filePath = await this.exportImage();
      await util.wxP(wx.saveImageToPhotosAlbum, { filePath });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && (e.message || e.errMsg)) || '保存失败，请重试', icon: 'none' });
    } finally { this.setData({ imageBusy: false }); }
  },
  // 相册权限：先查设置，被拒绝则引导去设置页打开
  ensureAlbumAuth() {
    return util.wxP(wx.getSetting).then((res) => {
      const auth = (res.authSetting || {})['scope.writePhotosAlbum'];
      if (auth === true) return;
      if (auth === undefined) return util.wxP(wx.authorize, { scope: 'scope.writePhotosAlbum' });
      return new Promise((resolve, reject) => {
        wx.showModal({
          title: '需要相册权限',
          content: '保存小票图片到相册需要授权，请在设置中打开「添加到相册」。',
          confirmText: '去设置',
          fail: () => reject(new Error('无法打开授权提示，请重试')),
          success: (r) => {
            if (r.confirm) {
              wx.openSetting({
                success: (s) => {
                  if (s.authSetting['scope.writePhotosAlbum']) resolve();
                  else reject(new Error('未授权相册权限'));
                },
                fail: () => reject(new Error('无法打开设置'))
              });
            } else {
              reject(new Error('已取消保存'));
            }
          }
        });
      });
    });
  },

  /* ---------- 转发给顾客 ---------- */
  async shareImage() {
    if (!this.canExportImage()) return;
    if (typeof wx.showShareImageMenu !== 'function') {
      wx.showToast({ title: '当前版本不支持直接转发，请先保存到相册', icon: 'none' });
      return;
    }
    this.setData({ imageBusy: true });
    try {
      const filePath = await this.exportImage();
      await util.wxP(wx.showShareImageMenu, { path: filePath });
    } catch (e) {
      wx.showToast({ title: /cancel/i.test((e && (e.errMsg || e.message)) || '') ? '已取消转发' : '转发未完成，可重试或保存到相册', icon: 'none' });
    } finally { this.setData({ imageBusy: false }); }
  },
  retryCanvas() { this.onReady(); },

  goPrinter() {
    wx.navigateTo({ url: '/pages/printer/printer?id=' + this.data.id });
  },
  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/orders/orders' }) });
  }
});
