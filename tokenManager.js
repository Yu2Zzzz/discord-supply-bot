// tokenManager.js
const axios = require('axios');

// ⚠️ 临时硬编码配置 —— 确认没问题后再挪回 .env
const LOGIN_URL = 'https://supply-backend-production.up.railway.app/api/auth/login';
const BOT_USERNAME = 'discord_bot';
const BOT_PASSWORD = 'CYmN9m2NkWv7hf8'; // 建议测试通了后改掉密码

let accessToken = null;
let tokenExpiresAt = 0; // 毫秒时间戳

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT token');

  const payload = parts[1];
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');

  const json = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function login() {
  console.log('[tokenManager] login() 使用的 loginUrl / username：', LOGIN_URL, BOT_USERNAME);

  if (!LOGIN_URL || !BOT_USERNAME || !BOT_PASSWORD) {
    throw new Error('LOGIN_URL / BOT_USERNAME / BOT_PASSWORD 配置为空（硬编码版本仍然失败）');
  }

  console.log('[BOT] 正在向后端登录获取新的 token …');

  const res = await axios.post(LOGIN_URL, {
    username: BOT_USERNAME,
    password: BOT_PASSWORD,
  });

  // 👇 根据你的后端实际返回调整字段名：
  // 先假设返回 { token: "JWT" } 或 { accessToken: "JWT" }
  const token = res.data && (res.data.token || res.data.accessToken);

  if (!token) {
    console.error('登录响应：', res.data);
    throw new Error('登录成功但未在响应中找到 token 字段（token / accessToken）');
  }

  accessToken = token;

  try {
    const payload = decodeJwtPayload(accessToken);
    if (payload.exp) {
      tokenExpiresAt = payload.exp * 1000; // exp 是秒
    } else {
      tokenExpiresAt = Date.now() + 50 * 60 * 1000; // 没 exp 默认 50 分钟
    }

    console.log(
      '[BOT] 登录成功，token 将在',
      new Date(tokenExpiresAt).toISOString(),
      '过期'
    );
  } catch (e) {
    console.warn('[BOT] 解析 JWT 失败，使用默认 50 分钟有效期', e.message);
    tokenExpiresAt = Date.now() + 50 * 60 * 1000;
  }
}

async function ensureToken() {
  const now = Date.now();
  if (!accessToken || now > tokenExpiresAt - 60 * 1000) {
    await login();
  }
}

async function getAuthHeader() {
  await ensureToken();
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

function resetToken() {
  accessToken = null;
  tokenExpiresAt = 0;
}

module.exports = {
  getAuthHeader,
  resetToken,
};
