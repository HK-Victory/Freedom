/**
 * api/index.js — Vercel Serverless Function 入口
 *
 * 为什么不使用 serverless-http？
 *   serverless-http 默认面向 AWS Lambda 的 (event, context) 接口。
 *   而 Vercel 的 Node.js Runtime 直接用标准 (req, res) 接口调用函数，
 *   Express 的 app 本身就是一个 (req, res) 处理器，因此直接 app(req, res) 即可，
 *   无需任何适配层。之前使用 serverless-http 会导致请求在 Vercel 上挂起、无响应
 *   （CLI 报 500 是因为那时数据库初始化就失败了；初始化修好后请求卡在 serverless-http）。
 *
 * 初始化：
 *   sql.js / 数据库初始化做成幂等单例（ensureReady），在首个请求前 await 完成，
 *   之后请求直接复用，避免每次冷启动重复加载 wasm。
 */
const { app, ensureReady } = require('../server');

const INIT_TIMEOUT_MS = 15000;
let readyPromise = null;

module.exports = async (req, res) => {
  try {
    if (!readyPromise) readyPromise = ensureReady();
    await readyPromise;

    // 等待响应结束：保证带 await 的异步路由（邮件测试 / 提醒触发等）也能正确返回。
    // 同时加一个硬超时，避免极端情况下函数挂起导致客户端“无响应”。
    await new Promise((resolve, reject) => {
      let settled = false;
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (!res.headersSent) res.status(503).json({ error: '请求处理超时，请稍后重试' });
        resolve();
      }, INIT_TIMEOUT_MS);

      const onFinish = () => { if (!settled) { settled = true; clearTimeout(guard); resolve(); } };
      const onError = (e) => { if (!settled) { settled = true; clearTimeout(guard); reject(e); } };

      res.on('finish', onFinish);
      res.on('error', onError);

      try {
        app(req, res);
      } catch (e) {
        onError(e);
      }
    });
  } catch (err) {
    console.error('[api] 请求处理失败:', (err && (err.stack || err.message)) || err);
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器内部错误: ' + ((err && err.message) || 'unknown') });
    }
  }
};
