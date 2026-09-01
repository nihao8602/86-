// baidu-ocr-proxy.js —— Cloudflare Workers 版百度 OCR 代理
// 作用：把百度 API Key / Secret Key 藏在服务端，用户脚本只与本 Worker 通信，不暴露密钥。
//
// 部署步骤：
//   1. https://dash.cloudflare.com → Workers & Pages → 创建 → Workers
//   2. 把本文件内容整个粘贴进 Worker 编辑器
//   3. 设置 → 变量和机密 → 添加两个变量（更安全，别把密钥写死在代码里）：
//        BAIDU_API_KEY     = 百度智能云「文字识别」应用的 API Key
//        BAIDU_SECRET_KEY  = 同一个应用的 Secret Key
//      （也可以在下方 CONFIG 里直接填，但变量方式更安全）
//   4. 部署，得到 https://你的名字.workers.dev
//   5. 用户脚本面板 → OCR 识别引擎选「百度 OCR（经代理）」→ 代理地址填
//      https://你的名字.workers.dev  （脚本会自动拼上 /ocr）
//
// 可选安全加固：把 ACCEPT_KEY 填成一个口令，脚本请求需带 Header  X-Auth: <口令>，
// 防止别人拿到你的 Worker 地址后盗刷百度额度。
// 注：本代理走百度「通用文字识别(标准版)」，高精度请用脚本的「直连」模式填 token。

const ACCEPT_KEY = ''; // 留空 = 不校验来源；填了则校验 Header X-Auth

// access_token 有效期约 30 天，内存缓存避免每张图都换一次 token
let tokenCache = { value: '', expiresAt: 0 };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth'
};

async function getToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const url = 'https://aip.baidubce.com/oauth/2.0/token'
    + '?grant_type=client_credentials'
    + '&client_id=' + encodeURIComponent(env.BAIDU_API_KEY || CONFIG.API_KEY)
    + '&client_secret=' + encodeURIComponent(env.BAIDU_SECRET_KEY || CONFIG.SECRET_KEY);
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('获取 access_token 失败: ' + JSON.stringify(data));
  }
  // 提前 5 分钟过期，避免用到已失效的 token
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

async function runOcr(env, token, image, languageType, precision) {
  const api = precision === 'accurate' ? 'accurate' : 'general';
  const body = new URLSearchParams();
  body.set('image', image);
  body.set('language_type', languageType || 'auto_detect');
  const res = await fetch(
    'https://aip.baidubce.com/rest/2.0/ocr/v1/' + api + '?access_token=' + encodeURIComponent(token),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }
  );
  return await res.json();
}

export default {
  async fetch(request, env) {
    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error_code: -2, error_msg: 'method not allowed' }, 405);
    }
    if (ACCEPT_KEY && request.headers.get('X-Auth') !== ACCEPT_KEY) {
      return json({ error_code: -3, error_msg: 'auth failed' }, 401);
    }
    try {
      const body = await request.json();
      if (!body || !body.image) throw new Error('缺少 image 字段');
      const token = await getToken(env);
      const result = await runOcr(env, token, body.image, body.language_type, body.precision);
      // 透传百度原始响应（含 words_result / error_code），脚本端已按百度格式解析
      return json(result, 200);
    } catch (e) {
      return json({ error_code: -1, error_msg: String((e && e.message) || e) }, 500);
    }
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// 兜底配置：如果不用变量，可以在这里直接填（不推荐，容易泄露到公开仓库）
const CONFIG = {
  API_KEY: '',
  SECRET_KEY: ''
};
