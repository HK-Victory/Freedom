/**
 * node-functions/api/[[default]].js — EdgeOne Pages Node Functions 入口
 *
 * EdgeOne 的 Node Functions 基于 /node-functions 目录生成路由：
 *   node-functions/api/[[default]].js  →  处理所有 /api/* 请求
 *
 * 平台会把该目录前缀 /api 从 req.url 中剥离后再交给 Express
 * （例如线上 /api/auth/login 进入本函数时 req.url === '/auth/login'），
 * 而 server.js 里的路由都以 /api 开头，因此这里在转发前把前缀补回，
 * 使本地（直接 node server.js）与 EdgeOne 上的路由行为完全一致。
 *
 * 部署模式采用官方推荐的「框架模式」：直接 export 一个 Express 实例。
 */

const express = require('express');
const { app: apiApp, ensureReady } = require('../../server');

const app = express();

// 1) 冷启动：确保 sql.js(wasm) + 种子数据初始化完成（幂等单例，只跑一次）
app.use(async (req, res, next) => {
  try {
    await ensureReady();
  } catch (err) {
    console.error('[edgeone] 数据库初始化失败:', err && (err.stack || err.message));
    if (!res.headersSent) res.status(500).json({ error: '服务器初始化失败' });
    return;
  }
  next();
});

// 2) EdgeOne 会剥离 /api 目录前缀，这里补回，使 /api/* 路由正确匹配
app.use((req, res, next) => {
  if (!req.url.startsWith('/api')) {
    req.url = '/api' + (req.url === '/' ? '' : req.url);
  }
  next();
});

// 3) 挂载业务 Express 应用（server.js 内路由均为 /api/*）
app.use(apiApp);

module.exports = app;
