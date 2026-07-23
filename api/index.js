/**
 * api/index.js — Vercel Serverless Function 入口
 *
 * 将 Express 应用包装为 Vercel 的 Serverless Function。
 * 关键点：sql.js 的 wasm 与数据库需要在「首次请求前」异步初始化，
 * 因此这里把初始化做成幂等单例（ensureReady），在第一个请求进来时 await 完成，
 * 之后的请求直接复用，避免每次冷启动重复加载 wasm。
 */
const serverless = require('serverless-http');
const { app, ensureReady } = require('../server');

let ready = null;
let sls = null;

module.exports = async (req, res) => {
  // 确保所有请求都在数据库就绪后才处理
  if (!ready) ready = ensureReady();
  await ready;

  if (!sls) sls = serverless(app);
  return sls(req, res);
};
