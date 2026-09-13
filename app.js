// 衣柜小程序。当前为本地模式，库存、订单与流水统一提交。
// Google服务器连接尚未启用；本轮修复不代表旧CloudBase云函数已经同步更新。
const CONFIG = {
  // ⚠️ 当前 useLocal=true 时此字段被忽略（数据走本地模拟层）。
  // 此修复版保持本地模式。切换其他后端需要对应接口适配和回归测试。
  // 注：微信 AppID ≠ 云开发 envId。下面这个值是用户的 AppID 占位，切真实云前一定要改。
  envId: '',
  // 本地模式：当前 AppID 为测试号（无法开通云开发）。置 true 时用本地模拟层，
  // 统一数据服务落设备本地 storage，无需云开发即可使用；
  // 旧 cloudfunctions 目录仅保留原包内容，尚未适配本轮新增的原子商品保存接口。
  useLocal: true
};

App({
  dataCloud: null,
  dataCloudError: '',
  dataMode: CONFIG.useLocal ? 'local' : 'cloud',
  globalData: {
    openid: '',        // 由 login 云函数返回，所有数据按它隔离
    settings: null,    // 设置文档缓存（店名/电话/小票备注…）
    envId: CONFIG.envId,
    theme: 'auto'      // 主题：'light' / 'dark' / 'auto'
  },

  /**
   * 切换主题：light / dark / auto
   * 通过 page.setData 通知所有页面刷新 theme 变量，WXML 的 class 绑定 theme-{{theme}} 立刻生效
   */
  setTheme(mode) {
    this.globalData.theme = mode;
    try { wx.setStorageSync('__theme__', mode); } catch (e) {}
    const resolved = this._resolveTheme(mode);
    const pages = getCurrentPages();
    pages.forEach(p => {
      if (p && typeof p.setData === 'function') {
        p.setData({ theme: resolved, themeRaw: mode });
      }
    });
  },

  /**
   * 把 'auto' 解析为 'light' / 'dark'（读系统主题 wx.getSystemInfoSync.theme）
   */
  _resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      const sys = wx.getSystemInfoSync();
      return sys && sys.theme === 'dark' ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  },

  onLaunch() {
    // 恢复主题偏好
    try {
      const saved = wx.getStorageSync('__theme__');
      if (saved === 'light' || saved === 'dark' || saved === 'auto') {
        this.globalData.theme = saved;
      }
    } catch (e) {}

    // wx.cloud 在部分微信环境是只读原生接口，应用显式持有自己的数据服务。
    this.dataCloud = null;
    this.dataCloudError = '';
    try {
      const provider = CONFIG.useLocal
        ? require('./utils/localcloud.js').createLocalCloud()
        : wx.cloud;
      if (!provider || typeof provider.database !== 'function' || typeof provider.callFunction !== 'function') {
        throw new Error(CONFIG.useLocal ? '本地账本初始化失败' : '当前环境不支持云开发，请检查基础库版本');
      }
      const opt = { traceUser: true };
      if (CONFIG.envId && CONFIG.envId.indexOf('REPLACE') < 0) opt.env = CONFIG.envId;
      provider.init(opt);
      this.dataCloud = provider;
      console.log('[app] 数据服务已就绪：' + (CONFIG.useLocal ? '本地账本' : '云开发'));
    } catch (e) {
      this.dataCloudError = (e && e.message) || '数据服务初始化失败，请重新打开小程序';
      console.error('[app] 数据服务不可用：', this.dataCloudError);
    }
  }
});
