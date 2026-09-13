// 云函数 login：返回当前用户 openid
// 所有集合按 openid 隔离，客户端拿到 openid 后：
//  1) 写 goods/suppliers/settings 等文档时显式带上 openid 字段
//  2) 云函数内部一律用 wxContext.OPENID 显式过滤/写入（不信任客户端传入的身份）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, message: '获取用户身份失败，请重试' };
  }
  return { success: true, openid: OPENID };
};
