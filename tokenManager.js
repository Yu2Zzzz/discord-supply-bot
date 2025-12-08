// tokenManager.js （CommonJS 写法）
const axios = require('axios');

let accessToken = null;
let tokenExpiresAt = 0; // 毫秒时间戳

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT token');

  const payload = parts[1];

  // base64url -> base64
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');

  const json = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function login() {
  const loginUrl = process.env.SUPPLY_LOGIN_URL;
  const username = process.env.BOT_USERNAME;
  const password = process.env.BOT_PASSWORD;

  if (!loginUrl || !username || !password) {
    throw new Error('SUPPLY_LOGIN_URL / BOT_USERNAME / BOT_PASSWORD 未配置完整');
  }

  console.log('[BOT] 正在向后端登录获取新的 token …');

  const res = await axios.post(loginUrl, {
    username,
    password,
  });

  // 根据你的后端返回结构来改：
  // 假设返回：{ token: "JWT" }
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
      // 没有 exp 就默认 50 分钟有效
      tokenExpiresAt = Date.now() + 50 * 60 * 1000;
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

// 确保拿到一个未过期的 token（快过期时自动刷新）
async function ensureToken() {
  const now = Date.now();
  // 提前 1 分钟刷新
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

// 遇到 401 时可以手动重置，强制下次重新登录
function resetToken() {
  accessToken = null;
  tokenExpiresAt = 0;
}

module.exports = {
  getAuthHeader,
  resetToken,
};
