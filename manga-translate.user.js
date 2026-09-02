// ==UserScript==
// @name         漫画翻译引擎
// @namespace    https://github.com/nihao8602/86-
// @version      7.27.0
// @description  提速版：全局并发池+OCR限速器 · 分块OCR并行 · 下载/OCR/翻译流水线 · 快重试+超时 · 纯白底气泡完全遮盖原文 · 气泡按像素紧贴原文框不再放大 · 去掉气泡描边 · 翻译引擎预设（混元/硅基流动/智谱GLM） · 拟声词跳过不翻 · 详细日志 · 合并更保守 · 英文强制重翻 · 处理顺序可选 · 手机极速模式 · 设备选择(自动/电脑/手机) · 手机直发原图 · 气泡底缩放 · 折叠面板 · 翻译回退可用版 · V4关闭思考(thinking:disabled) + 错误日志
// @author       百事比可口好喝
// @match        *://*/*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';
    const savedConfig = GM_getValue('ai_api_config', {});
    const apiConfig = {
        aiUrl: savedConfig.aiUrl || 'https://api.deepseek.com/chat/completions',
        aiKey: savedConfig.aiKey || '',
        aiModel: savedConfig.aiModel || 'deepseek-chat',
        sourceLang: savedConfig.sourceLang || 'kor',
        fontSize: savedConfig.fontSize || '14',
        ocrMode: savedConfig.ocrMode || 'baidu',
        ocrspaceKey: savedConfig.ocrspaceKey || '',
        baiduProxyUrl: savedConfig.baiduProxyUrl || '',
        baiduToken: savedConfig.baiduToken || '',
        baiduPrecision: savedConfig.baiduPrecision || 'general',
        processMode: savedConfig.processMode || 'wave',
        processOrder: savedConfig.processOrder || 'fast',
        waveSize: savedConfig.waveSize || 5,
        ocrRps: savedConfig.ocrRps === undefined ? 3 : savedConfig.ocrRps,
        localOcrUrl: savedConfig.localOcrUrl || 'http://127.0.0.1:8000/ocr',
        panelZoom: savedConfig.panelZoom || '100',
        fastMode: savedConfig.fastMode === undefined ? false : !!savedConfig.fastMode,
        deviceMode: savedConfig.deviceMode || 'auto',
        bubbleScale: savedConfig.bubbleScale || '100'
    };
    const OCR_MODES = ['baidu', 'baidu-direct', 'ocrspace', 'local'];
    if (!OCR_MODES.includes(apiConfig.ocrMode)) apiConfig.ocrMode = 'baidu';

    const sourceMap = {
        kor: { name: '韩文', ocrspace: 'kor', baidu: 'KOR' },
        eng: { name: '英文', ocrspace: 'eng', baidu: 'ENG' },
        jpn: { name: '日文', ocrspace: 'jpn', baidu: 'JAP' }
    };

    // 翻译引擎预设（都是 OpenAI 兼容接口，选好后只需填对应平台的 API Key）
    const TRANSLATORS = {
        ollama:      { name: '本地 Ollama（免费·离线）', url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5:3b' },
        deepseek:    { name: 'DeepSeek 官方', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
        hunyuan:     { name: '腾讯混元（免费额度）', url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-lite' },
        siliconflow: { name: '硅基流动（免费额度）', url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct' },
        zhipu:       { name: '智谱 GLM（免费额度）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' }
    };

    const CAP_MAX_DIM = { baidu: 3000, 'baidu-direct': 3000, ocrspace: 1400, local: 3000 };
    const JPEG_QUALITY = 0.87;
    const LLM_BATCH_SIZE = 60;
    const WAVE_SIZE = 5;
    const TIMEOUT_IMG = 20000;   // 取图超时 20s
    const TIMEOUT_OCR = 60000;   // OCR 超时 60s
    const TIMEOUT_LLM = 120000;  // 大模型超时 120s

    let running = false;
    let stopRequested = false;
    let totalCount = 0;
    let doneCount = 0;
    let dlDone = 0;
    let ocrDone = 0;
    let transDone = 0;
    let transTotal = 0;
    const processed = new Set();
    let pools = null; // { dl, ocr, ll } 每次 startAuto 重建

    function $(id) { return document.getElementById(id); }

    function log(text) {
        const el = $('mt-log');
        if (el) el.innerText = text;
    }

    /* ---------------- 详细日志（含时间戳，用于定位卡顿/慢） ---------------- */
    const LOG_MAX = 500;
    const logBuf = [];
    function ts() {
        const d = new Date();
        return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }
    function addLog(tag, msg, level) {
        const e = { t: ts(), tag: tag, msg: msg, level: level || 'info' };
        logBuf.push(e);
        if (logBuf.length > LOG_MAX) logBuf.shift();
        const v = $('mt-log-view');
        if (v && v.style.display !== 'none') renderLog();
        try {
            if (level === 'error') console.error('[manga][' + tag + ']', msg);
            else if (level === 'warn') console.warn('[manga][' + tag + ']', msg);
            else console.log('[manga][' + tag + ']', msg);
        } catch (e2) { }
    }
    function renderLog() {
        const v = $('mt-log-view');
        if (!v) return;
        v.textContent = logBuf.map(x => '[' + x.t + '][' + x.tag + '] ' + x.msg).join('\n');
        v.scrollTop = v.scrollHeight;
    }
    function clearLog() {
        logBuf.length = 0;
        renderLog();
    }

    // 判断是否拟声词（重复字符型特效字）：ドドド / 쿵쿵 / ㅋㅋ / ゴゴゴ / 두근두근
    function isSfx(text) {
        if (!text) return false;
        const t = text.replace(/\s+/g, '');
        if (t.length < 2) return false;
        const chars = new Set(t);
        if (chars.size === 1 && t.length >= 2) return true;
        if (chars.size === 2 && t.length >= 4 && t.slice(0, 2) === t.slice(2, 4)) return true;
        // 全大写短英文特效字：BANG / POW / WOW / BOOM
        if (/^[A-Z]{2,5}$/.test(t)) return true;
        return false;
    }

    /* ---------------- 并发控制：全局池 + 限速器 ---------------- */

    function createPool(limit) {
        let active = 0;
        const queue = [];
        return function run(fn) {
            return new Promise((resolve, reject) => {
                const task = async () => {
                    active++;
                    try {
                        if (stopRequested) { resolve(null); return; }
                        resolve(await fn());
                    } catch (e) {
                        reject(e);
                    } finally {
                        active--;
                        const next = queue.shift();
                        if (next) next();
                    }
                };
                if (active < limit) task();
                else queue.push(task);
            });
        };
    }

    // 令牌桶限速器：每秒最多发起 rate 次请求（防百度/ocr.space 限流风暴）
    function createRateLimiter(rate) {
        let tokens = rate;
        let last = Date.now();
        const queue = [];
        function pump() {
            const now = Date.now();
            tokens = Math.min(rate, tokens + (now - last) / 1000 * rate);
            last = now;
            while (queue.length && tokens >= 1) {
                tokens -= 1;
                const fn = queue.shift();
                fn();
            }
            if (queue.length) {
                const need = (1 - tokens) / rate;
                setTimeout(pump, Math.max(20, need * 1000));
            }
        }
        return function run(fn) {
            return new Promise((resolve, reject) => {
                queue.push(async () => {
                    if (stopRequested) { resolve(null); return; }
                    try { resolve(await fn()); }
                    catch (e) { reject(e); }
                });
                pump();
            });
        };
    }

    function updateProgress() {
        if (!running) return;
        const parts = [];
        if (dlDone) parts.push('取图 ' + dlDone + '/' + totalCount);
        if (ocrDone) parts.push('OCR ' + ocrDone + '/' + totalCount);
        if (transDone) parts.push('翻译 ' + transDone + '/' + transTotal);
        if (parts.length) log(parts.join(' · '));
    }

    /* ---------------- UI（与原版一致，仅加 OCR 限速一项） ---------------- */

    function createUI() {
        if ($('manga-ai-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'manga-ai-panel';
        panel.style.cssText = 'position:fixed;bottom:40px;right:20px;z-index:999999;width:300px;background:rgba(28,28,30,0.96);color:#fff;padding:14px;border-radius:14px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,0.45);display:flex;flex-direction:column;gap:10px;backdrop-filter:blur(6px);';
        panel.innerHTML = `
            <div id="mt-header" style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #444;padding-bottom:6px;cursor:move;user-select:none;">
                <span style="font-weight:700;color:#FF69B4;">漫画翻译引擎 V7（极速）</span>
                <span id="mt-minimize" style="cursor:pointer;color:#aaa;font-size:16px;padding:0 5px;">—</span>
            </div>

            <div class="mt-sec-h" data-target="trans" style="display:flex;justify-content:space-between;align-items:center;background:#2a2a2c;padding:7px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#FF69B4;user-select:none;border:1px solid #444;">翻译引擎 <span class="mt-arrow">▾</span></div>
            <div class="mt-sec-b" id="mt-sec-trans" style="display:flex;flex-direction:column;gap:8px;padding-top:2px;">
                <select id="mt-translator" style="width:100%;padding:6px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                    <option value="custom">翻译引擎：自定义（手动填地址/模型）</option>
                    <option value="ollama">本地 Ollama（免费·离线）</option>
                    <option value="deepseek">DeepSeek 官方</option>
                    <option value="hunyuan">腾讯混元（免费额度）</option>
                    <option value="siliconflow">硅基流动（免费额度）</option>
                    <option value="zhipu">智谱 GLM（免费额度）</option>
                </select>
                <input id="mt-ai-url" type="text" placeholder="大模型接口地址" style="width:100%;padding:6px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                <input id="mt-ai-model" type="text" placeholder="模型名称（如 deepseek-chat）" style="width:100%;padding:6px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                <div style="display:flex;gap:6px;align-items:center;">
                    <select id="mt-source-lang" style="flex:1;padding:6px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                        <option value="kor">韩文</option>
                        <option value="eng">英文</option>
                        <option value="jpn">日文</option>
                    </select>
                    <span style="color:#aaa;font-weight:700;">→</span>
                    <div style="flex:1;padding:6px;background:#222;color:#888;border:1px solid #444;border-radius:6px;text-align:center;">中文</div>
                </div>
                <input id="mt-ai-key" type="password" placeholder="AI API Key（翻译用）" style="width:100%;padding:6px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
            </div>

            <div class="mt-sec-h" data-target="ocr" style="display:flex;justify-content:space-between;align-items:center;background:#2a2a2c;padding:7px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#FF69B4;user-select:none;border:1px solid #444;">识别 (OCR) <span class="mt-arrow">▾</span></div>
            <div class="mt-sec-b" id="mt-sec-ocr" style="display:flex;flex-direction:column;gap:8px;padding-top:2px;">
                <div style="border:1px solid #444;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;">
                    <select id="mt-ocr-mode" style="width:100%;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                        <option value="baidu">百度 OCR（高精度，经代理）</option>
                        <option value="baidu-direct">百度 OCR（直连，填 access_token）</option>
                        <option value="ocrspace">ocr.space 免费云端（无需后端）</option>
                        <option value="local">本地 OCR（PaddleOCR）</option>
                    </select>
                    <div id="mt-local-cfg" style="display:none;flex-direction:column;gap:4px;">
                        <input id="mt-local-url" type="text" placeholder="本地服务地址，如 http://127.0.0.1:8000/ocr" style="width:100%;padding:5px;background:#333;color:#1e90ff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                        <div style="font-size:10px;color:#777;">需本地运行 local-ocr-server.py（PaddleOCR）。支持韩文/日文，首次识别会自动下载模型。</div>
                    </div>
                    <div id="mt-baidu-cfg" style="display:none;flex-direction:column;gap:4px;">
                        <input id="mt-baidu-proxy" type="text" placeholder="百度代理地址，如 https://xxx.workers.dev" style="width:100%;padding:5px;background:#333;color:#1e90ff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                        <div style="font-size:10px;color:#777;">密钥藏在代理里，不暴露在网页中。代理代码见同目录 baidu-ocr-proxy.js</div>
                    </div>
                    <div id="mt-baidu-direct-cfg" style="display:none;flex-direction:column;gap:4px;">
                        <input id="mt-baidu-token" type="password" placeholder="百度 access_token（约 30 天有效）" style="width:100%;padding:5px;background:#333;color:#1e90ff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                        <select id="mt-baidu-precision" style="width:100%;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                            <option value="general">标准（快，精度略低）</option>
                            <option value="accurate">高精度（慢，更准）</option>
                        </select>
                        <div style="font-size:10px;color:#777;">直连不经过 Cloudflare，国内更快。token 在百度控制台获取。</div>
                    </div>
                    <div id="mt-ocrspace-cfg" style="display:none;flex-direction:column;gap:4px;">
                        <input id="mt-ocrspace-key" type="password" placeholder="ocr.space API Key" style="width:100%;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                        <div style="font-size:10px;color:#777;">免费申请：ocr.space/ocrapi/freekey（免费额度有限，适合测试）</div>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <span style="font-size:11px;color:#aaa;white-space:nowrap;">OCR 限速</span>
                        <input id="mt-ocr-rps" type="number" min="0" max="20" step="1" value="3" style="width:58px;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                        <span style="font-size:10px;color:#777;flex:1;">次/秒（0=不限速，百度免费约 2）</span>
                    </div>
                </div>
            </div>

            <div class="mt-sec-h" data-target="proc" style="display:flex;justify-content:space-between;align-items:center;background:#2a2a2c;padding:7px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#FF69B4;user-select:none;border:1px solid #444;">处理 <span class="mt-arrow">▾</span></div>
            <div class="mt-sec-b" id="mt-sec-proc" style="display:flex;flex-direction:column;gap:8px;padding-top:2px;">
                <div style="display:flex;gap:6px;align-items:center;">
                    <span style="font-size:12px;white-space:nowrap;">方式</span>
                    <select id="mt-process-mode" style="flex:1;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                        <option value="wave">分批渐进（边翻边显示）</option>
                        <option value="all">整章一次性（完成后显示）</option>
                    </select>
                    <span id="mt-wave-size-wrap" style="display:flex;gap:4px;align-items:center;">
                        <input id="mt-wave-size" type="number" min="1" max="50" value="5" style="width:54px;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                        <span style="font-size:11px;color:#888;white-space:nowrap;">张/批</span>
                    </span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <span style="font-size:12px;white-space:nowrap;">顺序</span>
                    <select id="mt-process-order" style="flex:1;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                        <option value="fast">尽快（乱序覆盖，最快）</option>
                        <option value="sequential">按顺序（从上到下，稍慢）</option>
                    </select>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <span style="font-size:12px;white-space:nowrap;">设备</span>
                    <select id="mt-device-mode" style="flex:1;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;outline:none;">
                        <option value="auto">自动（推荐）</option>
                        <option value="pc">电脑端</option>
                        <option value="phone">手机端</option>
                    </select>
                </div>
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;padding:2px 0;cursor:pointer;">
                    <input id="mt-fast-mode" type="checkbox" style="accent-color:#FF69B4;">
                    手机极速模式（图更小更快，小字可能漏识别）
                </label>
            </div>

            <div class="mt-sec-h" data-target="disp" style="display:flex;justify-content:space-between;align-items:center;background:#2a2a2c;padding:7px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#FF69B4;user-select:none;border:1px solid #444;">显示 <span class="mt-arrow">▾</span></div>
            <div class="mt-sec-b" id="mt-sec-disp" style="display:flex;flex-direction:column;gap:8px;padding-top:2px;">
                <div style="display:flex;align-items:center;gap:8px;background:#333;padding:6px 8px;border-radius:6px;border:1px solid #555;">
                    <span style="font-size:12px;font-weight:700;white-space:nowrap;">字号 <span id="mt-font-val" style="color:#FF69B4;">14</span></span>
                    <input id="mt-font-size" type="range" min="10" max="28" value="14" style="flex:1;accent-color:#FF69B4;">
                </div>
                <div style="display:flex;align-items:center;gap:8px;background:#333;padding:6px 8px;border-radius:6px;border:1px solid #555;">
                    <span style="font-size:12px;font-weight:700;white-space:nowrap;">气泡缩放 <span id="mt-bubble-scale-val" style="color:#FF69B4;">100%</span></span>
                    <input id="mt-bubble-scale" type="range" min="50" max="150" value="100" style="flex:1;accent-color:#FF69B4;">
                </div>
                <div style="display:flex;align-items:center;gap:8px;background:#333;padding:6px 8px;border-radius:6px;border:1px solid #555;">
                    <span style="font-size:12px;font-weight:700;white-space:nowrap;">面板缩放 <span id="mt-zoom-val" style="color:#FF69B4;">100%</span></span>
                    <input id="mt-panel-zoom" type="range" min="70" max="160" value="100" style="flex:1;accent-color:#FF69B4;">
                </div>
            </div>

            <div class="mt-sec-h" data-target="log" style="display:flex;justify-content:space-between;align-items:center;background:#2a2a2c;padding:7px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#FF69B4;user-select:none;border:1px solid #444;">日志 <span class="mt-arrow">▾</span></div>
            <div class="mt-sec-b" id="mt-sec-log" style="display:flex;flex-direction:column;gap:6px;padding-top:2px;">
                <div style="display:flex;gap:6px;">
                    <button id="mt-log-toggle" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">展开日志</button>
                    <button id="mt-log-clear" style="flex:1;padding:6px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">清空日志</button>
                </div>
                <div id="mt-log-view" style="display:none;height:200px;overflow-y:auto;background:#111;color:#9f9;font-family:Consolas,monospace;font-size:11px;line-height:1.3;white-space:pre-wrap;word-break:break-all;padding:6px;border-radius:6px;text-align:left;"></div>
            </div>

            <div style="display:flex;gap:6px;">
                <button id="mt-save" style="flex:1;padding:8px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;">保存配置</button>
                <button id="mt-test" style="flex:1;padding:8px;background:#34C759;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;">测试通道</button>
            </div>

            <button id="mt-toggle" style="padding:12px;background:#FF69B4;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(255,105,180,0.5);">开启自动识别</button>
            <div id="mt-log" style="font-size:11px;color:#ffeb3b;word-break:break-word;text-align:center;min-height:15px;">填好配置后点“开启自动识别”</div>
        `;
        document.body.appendChild(panel);

        // 折叠分区
        document.querySelectorAll('.mt-sec-h').forEach(h => {
            h.addEventListener('click', () => {
                const b = $('mt-sec-' + h.dataset.target);
                if (!b) return;
                const open = b.style.display === 'none';
                b.style.display = open ? 'flex' : 'none';
                const a = h.querySelector('.mt-arrow');
                if (a) a.textContent = open ? '▾' : '▸';
            });
        });

        $('mt-ai-url').value = apiConfig.aiUrl;
        $('mt-ai-model').value = apiConfig.aiModel;
        $('mt-ai-key').value = apiConfig.aiKey;
        $('mt-source-lang').value = apiConfig.sourceLang;
        $('mt-font-size').value = apiConfig.fontSize;
        $('mt-font-val').innerText = apiConfig.fontSize;
        $('mt-bubble-scale').value = apiConfig.bubbleScale || '100';
        $('mt-bubble-scale-val').innerText = (apiConfig.bubbleScale || '100') + '%';
        $('mt-panel-zoom').value = apiConfig.panelZoom || '100';
        $('mt-zoom-val').innerText = (apiConfig.panelZoom || '100') + '%';
        panel.style.zoom = (parseInt(apiConfig.panelZoom || '100', 10) / 100);
        $('mt-ocr-mode').value = apiConfig.ocrMode;
        $('mt-ocrspace-key').value = apiConfig.ocrspaceKey;
        $('mt-baidu-proxy').value = apiConfig.baiduProxyUrl;
        $('mt-baidu-token').value = apiConfig.baiduToken;
        $('mt-baidu-precision').value = apiConfig.baiduPrecision;
        $('mt-process-mode').value = apiConfig.processMode;
        $('mt-process-order').value = apiConfig.processOrder || 'fast';
        $('mt-fast-mode').checked = !!apiConfig.fastMode;
        $('mt-device-mode').value = apiConfig.deviceMode || 'auto';
        $('mt-wave-size').value = apiConfig.waveSize;
        $('mt-ocr-rps').value = apiConfig.ocrRps;
        $('mt-local-url').value = apiConfig.localOcrUrl;

        // 翻译引擎预设：选好后自动填接口地址+模型，API Key 仍手动填
        const translatorSel = $('mt-translator');
        translatorSel.addEventListener('change', () => {
            const t = TRANSLATORS[translatorSel.value];
            if (t && t.url) {
                $('mt-ai-url').value = t.url;
                $('mt-ai-model').value = t.model;
            }
        });
        (function restoreTranslator() {
            const url = apiConfig.aiUrl;
            for (const k in TRANSLATORS) {
                if (TRANSLATORS[k].url && url === TRANSLATORS[k].url) { translatorSel.value = k; return; }
            }
            translatorSel.value = 'custom';
        })();

        const modeSel = $('mt-ocr-mode');
        function toggleOcrCfg() {
            const m = modeSel.value;
            $('mt-baidu-cfg').style.display = m === 'baidu' ? 'flex' : 'none';
            $('mt-baidu-direct-cfg').style.display = m === 'baidu-direct' ? 'flex' : 'none';
            $('mt-ocrspace-cfg').style.display = m === 'ocrspace' ? 'flex' : 'none';
            $('mt-local-cfg').style.display = m === 'local' ? 'flex' : 'none';
        }
        modeSel.addEventListener('change', toggleOcrCfg);
        toggleOcrCfg();

        const processSel = $('mt-process-mode');
        function toggleProcessCfg() {
            $('mt-wave-size-wrap').style.display = processSel.value === 'wave' ? 'flex' : 'none';
        }
        processSel.addEventListener('change', toggleProcessCfg);
        toggleProcessCfg();

        $('mt-font-size').addEventListener('input', function (e) {
            const v = e.target.value;
            $('mt-font-val').innerText = v;
            apiConfig.fontSize = v;
            document.querySelectorAll('.mt-bubble').forEach(b => b.style.fontSize = v + 'px');
        });

        $('mt-bubble-scale').addEventListener('input', function (e) {
            const v = e.target.value;
            $('mt-bubble-scale-val').innerText = v + '%';
            apiConfig.bubbleScale = v;
        });

        $('mt-panel-zoom').addEventListener('input', function (e) {
            const v = e.target.value;
            $('mt-zoom-val').innerText = v + '%';
            panel.style.zoom = (parseInt(v, 10) / 100);
            apiConfig.panelZoom = v;
        });

        makeDraggable(panel);

        const mini = document.createElement('div');
        mini.id = 'mt-mini';
        mini.style.cssText = 'position:fixed;bottom:40px;right:20px;z-index:999999;width:34px;height:34px;border-radius:50%;background:transparent;color:#FF69B4;font-size:20px;font-weight:900;display:none;align-items:center;justify-content:center;cursor:grab;user-select:none;text-shadow:0 1px 3px rgba(0,0,0,0.4);';
        mini.textContent = '译';
        document.body.appendChild(mini);

        $('mt-minimize').addEventListener('click', () => {
            const r = panel.getBoundingClientRect();
            panel._vw = r.width; panel._vh = r.height;
            mini.style.left = Math.max(8, Math.min(r.left + r.width - 34, innerWidth - 42)) + 'px';
            mini.style.top = Math.max(8, r.top) + 'px';
            mini.style.bottom = 'auto'; mini.style.right = 'auto';
            panel.style.display = 'none'; mini.style.display = 'flex';
        });

        mini.addEventListener('click', () => {
            if (mini.dataset.moved === 'true') { mini.dataset.moved = 'false'; return; }
            const r = mini.getBoundingClientRect();
            const z = parseFloat(panel.style.zoom) || 1;
            const vw = panel._vw || panel.offsetWidth;
            const vh = panel._vh || panel.offsetHeight;
            let lv = Math.max(0, Math.min(r.left + r.width - vw, innerWidth - vw));
            let tv = Math.max(0, Math.min(r.top, innerHeight - vh));
            panel.style.left = (lv / z) + 'px'; panel.style.top = (tv / z) + 'px';
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
            mini.style.display = 'none'; panel.style.display = 'flex';
        });

        let miniDragging = false, mSX = 0, mSY = 0, mSL = 0, mST = 0;
        mini.dataset.moved = 'false';
        function miniDragStart(cx, cy) {
            miniDragging = true; mini.dataset.moved = 'false';
            mSX = cx; mSY = cy;
            const r = mini.getBoundingClientRect(); mSL = r.left; mST = r.top;
        }
        function miniDragMove(cx, cy) {
            if (!miniDragging) return;
            const dx = cx - mSX, dy = cy - mSY;
            let nl = Math.max(0, Math.min(mSL + dx, innerWidth - mini.offsetWidth));
            let nt = Math.max(0, Math.min(mST + dy, innerHeight - mini.offsetHeight));
            mini.style.left = nl + 'px'; mini.style.top = nt + 'px';
            mini.style.bottom = 'auto'; mini.style.right = 'auto';
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) mini.dataset.moved = 'true';
        }
        mini.addEventListener('mousedown', e => { miniDragStart(e.clientX, e.clientY); e.preventDefault(); });
        document.addEventListener('mousemove', e => miniDragMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', () => miniDragging = false);
        mini.addEventListener('touchstart', e => { miniDragStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
        mini.addEventListener('touchmove', e => { e.preventDefault(); miniDragMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
        mini.addEventListener('touchend', () => miniDragging = false);

        $('mt-save').addEventListener('click', () => {
            syncConfig();
            GM_setValue('ai_api_config', apiConfig);
            const b = $('mt-save');
            b.innerText = '已保存';
            b.style.background = '#34C759';
            setTimeout(() => { b.innerText = '保存配置'; b.style.background = '#555'; }, 1400);
        });

        $('mt-test').addEventListener('click', () => { syncConfig(); runTest(); });

        $('mt-log-toggle').addEventListener('click', () => {
            const v = $('mt-log-view');
            const show = v.style.display === 'none';
            v.style.display = show ? 'block' : 'none';
            $('mt-log-toggle').innerText = show ? '收起日志' : '展开日志';
            if (show) renderLog();
        });
        $('mt-log-clear').addEventListener('click', () => { clearLog(); });

        $('mt-toggle').addEventListener('click', () => {
            syncConfig();
            if (running) stopAuto();
            else startAuto();
        });
    }

    function syncConfig() {
        apiConfig.aiUrl = $('mt-ai-url').value.trim() || 'https://api.deepseek.com/chat/completions';
        apiConfig.aiModel = $('mt-ai-model').value.trim() || 'deepseek-chat';
        apiConfig.aiKey = $('mt-ai-key').value.trim();
        apiConfig.sourceLang = $('mt-source-lang').value;
        apiConfig.fontSize = $('mt-font-size').value;
        apiConfig.ocrMode = $('mt-ocr-mode').value;
        if (!OCR_MODES.includes(apiConfig.ocrMode)) apiConfig.ocrMode = 'baidu';
        apiConfig.ocrspaceKey = $('mt-ocrspace-key').value.trim();
        apiConfig.baiduProxyUrl = $('mt-baidu-proxy').value.trim();
        apiConfig.baiduToken = $('mt-baidu-token').value.trim();
        apiConfig.baiduPrecision = $('mt-baidu-precision').value;
        apiConfig.processMode = $('mt-process-mode').value;
        apiConfig.processOrder = $('mt-process-order').value || 'fast';
        apiConfig.waveSize = parseInt($('mt-wave-size').value, 10) || 5;
        apiConfig.ocrRps = parseInt($('mt-ocr-rps').value, 10) || 0;
        apiConfig.localOcrUrl = $('mt-local-url').value.trim() || 'http://127.0.0.1:8000/ocr';
        apiConfig.panelZoom = $('mt-panel-zoom').value || '100';
        apiConfig.fastMode = !!$('mt-fast-mode').checked;
        apiConfig.deviceMode = $('mt-device-mode').value || 'auto';
        apiConfig.bubbleScale = $('mt-bubble-scale').value || '100';
    }

    function makeDraggable(panel) {
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0, vw = 0, vh = 0;
        const pz = () => parseFloat(panel.style.zoom) || 1;
        panel.addEventListener('mousedown', e => {
            if (e.target && e.target.closest && e.target.closest('input,select,button,textarea')) return;
            dragging = true; sx = e.clientX; sy = e.clientY;
            const r = panel.getBoundingClientRect();
            sl = r.left; st = r.top; vw = r.width; vh = r.height;
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const z = pz();
            let lv = Math.max(0, Math.min(sl + (e.clientX - sx), innerWidth - vw));
            let tv = Math.max(0, Math.min(st + (e.clientY - sy), innerHeight - vh));
            panel.style.left = (lv / z) + 'px'; panel.style.top = (tv / z) + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => dragging = false);
    }

    /* ---------------- 主流程：流水线（下载→OCR→翻译 重叠进行） ---------------- */

    async function startAuto() {
        running = true;
        stopRequested = false;
        processed.clear();
        totalCount = 0; doneCount = 0;
        dlDone = 0; ocrDone = 0; transDone = 0; transTotal = 0;
        $('mt-toggle').innerText = '停止';
        $('mt-toggle').style.background = '#FF3B30';

        // 重建并发池（读取当前配置）
        const rps = parseInt(apiConfig.ocrRps, 10) || 0;
        pools = {
            dl: createPool(10),
            ocr: rps > 0 ? createRateLimiter(rps) : createPool(4),
            ll: createPool(5)
        };

        const targets = findChapterImages();
        totalCount = targets.length;
        if (!totalCount) { log('没有找到漫画图'); stopAuto(); return; }
        addLog('流程', '开始 · ' + totalCount + ' 张 · OCR=' + apiConfig.ocrMode + ' · 模型=' + apiConfig.aiModel);

        if (apiConfig.processMode === 'all') {
            await processAll(targets);
        } else {
            await processWaves(targets);
        }

        if (stopRequested) log('⏹ 已停止：' + doneCount + '/' + totalCount + ' 张');
        else log('✅ 全部完成：' + doneCount + '/' + totalCount + ' 张');
        stopAuto();
    }

    // 下载完一张立刻 OCR 一张（受全局池约束），位图用完即释放
    async function streamChapter(targets) {
        const results = await Promise.all(targets.map(img =>
            pools.dl(() => downloadOne(img)).then(it => it ? ocrOne(it) : null)
        ));
        if (stopRequested) return null;
        return results.filter(Boolean);
    }

    async function processAll(targets) {
        log('整章一次性：取图 ' + targets.length + ' 张...');
        const ok = await streamChapter(targets);
        if (stopRequested || !ok) return;
        if (!ok.length) { log('⚠️ 没有取到图'); return; }

        const flatBlocks = [];
        ok.forEach(r => (r.blocks || []).forEach(b => flatBlocks.push(b)));
        if (!flatBlocks.length) { log('⚠️ 未识别到任何文字'); return; }

        log('批量翻译 ' + flatBlocks.length + ' 段...');
        await translateInBatches(flatBlocks);
        if (stopRequested) return;

        ok.forEach(r => overlayBubbles(r.img, r.blocks, r.width, r.height));
        doneCount = ok.length;
    }

    async function processWaves(targets) {
        const ws = Math.max(1, parseInt(apiConfig.waveSize, 10) || WAVE_SIZE);
        const waves = [];
        for (let i = 0; i < targets.length; i += ws) waves.push(targets.slice(i, i + ws));

        const runWave = async (wave, wi) => {
            if (stopRequested) return;
            const items = await streamChapter(wave);
            if (stopRequested || !items || !items.length) return;

            const flatBlocks = [];
            items.forEach(r => (r.blocks || []).forEach(b => flatBlocks.push(b)));
            if (flatBlocks.length) await translateInBatches(flatBlocks);
            if (stopRequested) return;

            items.forEach(r => overlayBubbles(r.img, r.blocks, r.width, r.height));
            doneCount += items.length;
            log('✅ 批次 ' + (wi + 1) + '/' + waves.length + ' 完成（' + doneCount + '/' + totalCount + ' 张）');
        };

        if (apiConfig.processOrder === 'sequential') {
            // 按顺序：一张（批）完全处理完再下一张，气泡从上到下依次出现
            for (let wi = 0; wi < waves.length; wi++) {
                if (stopRequested) break;
                await runWave(waves[wi], wi);
            }
        } else {
            // 尽快：所有批次并行推进（乱序覆盖，最快）
            await Promise.all(waves.map((wave, wi) => runWave(wave, wi)));
        }
    }

    function stopAuto() {
        running = false;
        stopRequested = true;
        $('mt-toggle').innerText = '开启自动识别';
        $('mt-toggle').style.background = '#FF69B4';
    }

    /* ---------------- 取图 ---------------- */

    function getResolvedSrc(img) {
        const lazyAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'data-image', 'data-actualsrc', 'data-original-src'];
        for (const a of lazyAttrs) {
            const v = img.getAttribute(a);
            if (v && /^https?:|^\/\//.test(v.trim()) && v.trim().length > 8) return normalizeUrl(v.trim());
        }
        if (img.currentSrc && /^https?:|^data:|^blob:/.test(img.currentSrc)) return normalizeUrl(img.currentSrc);
        if (img.src && /^https?:|^data:|^blob:/.test(img.src)) return normalizeUrl(img.src);
        if (img.srcset) {
            let best = '', bestW = 0;
            img.srcset.split(',').forEach(part => {
                const p = part.trim().split(/\s+/);
                const w = parseInt((p[1] || '0').replace(/\D/g, ''), 10) || 0;
                if (w >= bestW) { bestW = w; best = p[0]; }
            });
            if (best) return normalizeUrl(best);
        }
        return '';
    }

    function normalizeUrl(u) {
        if (u.startsWith('//')) return location.protocol + u;
        return u;
    }

    function isWorthTranslating(img) {
        const r = img.getBoundingClientRect();
        return r.width >= 120 && r.height >= 120;
    }

    function findChapterImages() {
        let imgs = Array.from(document.querySelectorAll('img.image-chapter'));
        if (imgs.length) return imgs;
        imgs = Array.from(document.querySelectorAll('img')).filter(img => {
            const p = img.parentElement;
            const marker = ((img.className || '') + ' ' + (p ? (p.className || '') : ''));
            return /image_story|imageChap|image-chapter|reading-content|chapter/i.test(marker);
        });
        if (imgs.length) return imgs;
        return Array.from(document.querySelectorAll('img')).filter(isWorthTranslating);
    }

    async function downloadOne(img) {
        if (stopRequested) return null;
        const key = getResolvedSrc(img) || img.src;
        if (!key) return null;
        if (processed.has(key)) return null;
        processed.add(key);
        const t0 = Date.now();
        const shortKey = (key || '').replace(/^https?:\/\//, '').slice(0, 60);
        addLog('取图', '开始 ' + shortKey);
        try {
            // 只有「本地 OCR + 手机端」才下载原始字节（直发原图）；电脑端直接用页面里的图，免重下载
            const wantBlob = apiConfig.ocrMode === 'local' && isPhoneDevice();
            let blob = null;
            let bitmap = null;
            if (wantBlob && /^https?:/.test(key)) {
                try { blob = await gmFetchBlob(key); } catch (e) { blob = null; }
            }
            if (blob) {
                bitmap = await blobToBitmap(blob);
            } else {
                bitmap = await loadBitmap(img, key);
            }
            dlDone++;
            updateProgress();
            addLog('取图', '完成 ' + shortKey + ' · ' + (Date.now() - t0) + 'ms · ' + bitmap.width + 'x' + bitmap.height + (blob ? ' · ' + Math.round((blob.size || 0) / 1024) + 'KB' : ''));
            return { img, bitmap, blob, width: bitmap.width, height: bitmap.height };
        } catch (e) {
            addLog('取图', '失败 ' + shortKey + ' · ' + (e && e.message || e), 'error');
            dlDone++;
            updateProgress();
            return null;
        }
    }

    function gmFetchBlob(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                headers: { 'Referer': location.href },
                timeout: TIMEOUT_IMG,
                onload: r => { if (r.response) resolve(r.response); else reject(new Error('图片为空')); },
                onerror: () => reject(new Error('图片请求失败（可能防盗链/需登录）')),
                ontimeout: () => reject(new Error('图片请求超时'))
            });
        });
    }

    function isPhoneDevice() {
        if (apiConfig.deviceMode === 'phone') return true;
        if (apiConfig.deviceMode === 'pc') return false;
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(new Error('读取图片失败'));
            fr.readAsDataURL(blob);
        });
    }

    function blobToBitmap(blob) {
        return new Promise((resolve, reject) => {
            if (window.createImageBitmap) {
                createImageBitmap(blob).then(resolve, reject);
                return;
            }
            const u = URL.createObjectURL(blob);
            const im = new Image();
            im.onload = () => { URL.revokeObjectURL(u); resolve(im); };
            im.onerror = () => { URL.revokeObjectURL(u); reject(new Error('图片解码失败')); };
            im.src = u;
        });
    }

    async function loadBitmap(img, url) {
        if (/^(data:|blob:)/.test(url) && img.complete && img.naturalWidth) {
            try { if (window.createImageBitmap) return await createImageBitmap(img); } catch (e) { }
            return img;
        }
        if (img.complete && img.naturalWidth) {
            const direct = await canvasBitmapFromSource(img);
            if (direct) return direct;
        }
        const blob = await gmFetchBlob(url);
        return await blobToBitmap(blob);
    }

    async function canvasBitmapFromSource(src) {
        try {
            const w = src.naturalWidth || src.width;
            const h = src.naturalHeight || src.height;
            if (!w || !h) return null;
            const probe = document.createElement('canvas');
            probe.width = 1; probe.height = 1;
            const pctx = probe.getContext('2d', { willReadFrequently: true });
            pctx.drawImage(src, 0, 0, 1, 1);
            pctx.getImageData(0, 0, 1, 1);
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(src, 0, 0);
            if (window.createImageBitmap) return await createImageBitmap(c);
            return c;
        } catch (e) {
            return null;
        }
    }

    /* ---------------- OCR（分块并行，走全局 OCR 池/限速器） ---------------- */

    async function ocrOne(item) {
        if (stopRequested) {
            if (item.bitmap && item.bitmap.close) item.bitmap.close();
            item.bitmap = null; item.blocks = [];
            return item;
        }
        const t0 = Date.now();
        addLog('OCR', '开始 ' + item.bitmap.width + 'x' + item.bitmap.height);
        try {
            const { blocks, width, height } = await doOCR(item.bitmap, item.blob);
            item.blocks = blocks; item.width = width; item.height = height;
            addLog('OCR', '完成 ' + blocks.length + ' 段 · ' + (Date.now() - t0) + 'ms');
        } catch (e) {
            addLog('OCR', '失败 ' + (e && e.message || e), 'error');
            item.blocks = [];
        }
        if (item.bitmap && item.bitmap.close) item.bitmap.close();
        item.bitmap = null;
        ocrDone++;
        updateProgress();
        return item;
    }

    async function doOCR(bitmap, blob) {
        const W = bitmap.width, H = bitmap.height;

        // 手机端 + 本地 OCR + 有原图字节：直发整张原图，手机零压缩零重编码，切图交给服务端
        if (apiConfig.ocrMode === 'local' && isPhoneDevice() && blob) {
            try {
                const dataUrl = await blobToDataUrl(blob);
                const raw = await localOcr(dataUrl);
                if (raw && raw.length) {
                    const blocks = raw.map(b => ({ originalText: b.text, x: b.x, y: b.y, w: b.w, h: b.h }));
                    addLog('OCR', '原图直发识别 ' + blocks.length + ' 段');
                    return finalizeBlocks(bitmap, blocks, W, H);
                }
            } catch (e) {
                addLog('OCR', '原图直发失败，回退分块', 'warn');
            }
        }

        // 分块路径（电脑端、非本地模式、或手机端无原图时）：按宽度缩放 + JPEG 重编码
        const fast = !!apiConfig.fastMode;
        const cap = fast ? 1600 : (CAP_MAX_DIM[apiConfig.ocrMode] || 1400);
        const jpegQ = fast ? 0.6 : JPEG_QUALITY;
        const scale = Math.min(1, cap / W);
        const chunkH = Math.max(1, Math.floor(cap / scale));

        const jobs = [];
        for (let y0 = 0; y0 < H; y0 += chunkH) {
            const sh = Math.min(chunkH, H - y0);
            jobs.push(pools.ocr(() => {
                if (stopRequested) return null;
                const pw = Math.max(1, Math.round(W * scale));
                const ph = Math.max(1, Math.round(sh * scale));
                const canvas = document.createElement('canvas');
                canvas.width = pw; canvas.height = ph;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, y0, W, sh, 0, 0, pw, ph);
                const dataUrl = canvas.toDataURL('image/jpeg', jpegQ);
                return apiConfig.ocrMode === 'baidu' ? baiduOcr(dataUrl)
                    : apiConfig.ocrMode === 'baidu-direct' ? baiduDirectOcr(dataUrl)
                    : apiConfig.ocrMode === 'local' ? localOcr(dataUrl)
                    : ocrSpace(dataUrl);
            }));
        }
        const results = await Promise.all(jobs);
        if (stopRequested) return { blocks: [], width: W, height: H };

        const blocks = [];
        results.forEach((raw, i) => {
            if (!raw || !raw.length) return;
            const y0 = i * chunkH;
            raw.forEach(b => {
                blocks.push({
                    originalText: b.text,
                    x: b.x / scale,
                    y: b.y / scale + y0,
                    w: b.w / scale,
                    h: b.h / scale
                });
            });
        });
        return finalizeBlocks(bitmap, blocks, W, H);
    }

    function finalizeBlocks(bitmap, blocks, W, H) {
        const merged = mergeBlocks(blocks);
        merged.forEach(b => {
            const s = detectStyle(bitmap, b.x, b.y, b.w, b.h);
            if (s) { b.textColor = s.textColor; b.bgColor = s.bgColor; }
        });
        // 跳过拟声词（重复字符型特效字）：识别不准，直接不翻不盖
        const kept = merged.filter(b => !isSfx(b.originalText));
        return { blocks: kept, width: W, height: H };
    }

    function mergeBlocks(blocks) {
        if (!blocks || blocks.length < 2) return blocks;
        const sorted = blocks.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
        const groups = [];
        for (const b of sorted) {
            const lineH = Math.max(b.h, 1);
            let target = null;
            for (const g of groups) {
                // 高度差异太大（如大字拟声词 vs 正文小字）不合并，避免拟声词把长句吞掉
                const hRatio = Math.max(b.h, g.avgH) / Math.max(1, Math.min(b.h, g.avgH));
                if (hRatio > 1.8) continue;
                const gap = b.y - (g.y + g.h);
                const maxGap = Math.max(6, lineH * 0.6);
                if (gap > maxGap || gap < -maxGap) continue;
                const overlapX = Math.min(b.x + b.w, g.x + g.w) - Math.max(b.x, g.x);
                const minW = Math.min(b.w, g.w);
                if (overlapX > minW * 0.5) { target = g; break; }
            }
            if (target) {
                target.texts.push(b.originalText);
                target.avgH = (target.avgH * (target.texts.length - 1) + b.h) / target.texts.length;
                const nx = Math.min(target.x, b.x);
                const ny = Math.min(target.y, b.y);
                const nx2 = Math.max(target.x + target.w, b.x + b.w);
                const ny2 = Math.max(target.y + target.h, b.y + b.h);
                target.x = nx; target.y = ny;
                target.w = nx2 - nx; target.h = ny2 - ny;
            } else {
                groups.push({ texts: [b.originalText], x: b.x, y: b.y, w: b.w, h: b.h, avgH: b.h });
            }
        }
        return groups.map(g => ({
            originalText: joinLines(g.texts),
            x: g.x, y: g.y, w: g.w, h: g.h
        }));
    }

    function joinLines(texts) {
        const sep = apiConfig.sourceLang === 'jpn' ? '' : ' ';
        return texts.join(sep);
    }

    function detectStyle(bitmap, x, y, w, h) {
        try {
            const sx = Math.max(0, Math.floor(x));
            const sy = Math.max(0, Math.floor(y));
            const sw = Math.max(2, Math.min(Math.ceil(w), bitmap.width - sx));
            const sh = Math.max(2, Math.min(Math.ceil(h), bitmap.height - sy));
            if (sw < 2 || sh < 2) return null;

            const cw = Math.min(sw, 192);
            const ch = Math.min(sh, 192);
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, cw, ch);
            const data = ctx.getImageData(0, 0, cw, ch).data;

            const hist = new Map();
            let total = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 32) continue;
                const key = (data[i] >> 5) + ',' + (data[i + 1] >> 5) + ',' + (data[i + 2] >> 5);
                hist.set(key, (hist.get(key) || 0) + 1);
                total++;
            }
            if (!total) return null;
            let bgKey = null, bgN = 0;
            for (const [k, n] of hist) { if (n > bgN) { bgN = n; bgKey = k; } }
            const bgParts = bgKey.split(',').map(Number);
            const bgR = bgParts[0] * 32 + 16, bgG = bgParts[1] * 32 + 16, bgB = bgParts[2] * 32 + 16;

            let r = 0, g = 0, b = 0, n = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 32) continue;
                const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
                if (Math.sqrt(dr * dr + dg * dg + db * db) > 90) {
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
                }
            }
            if (n < 4) return null;
            return {
                textColor: { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) },
                bgColor: { r: bgR, g: bgG, b: bgB }
            };
        } catch (e) {
            return null;
        }
    }

    /* ---------------- OCR 通道：限速感知重试 ---------------- */

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function ocrSpace(dataUrl) {
        const lang = sourceMap[apiConfig.sourceLang].ocrspace || 'kor';
        const key = apiConfig.ocrspaceKey || '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const blocks = await ocrSpaceOnce(dataUrl, lang, key);
            if (blocks) return blocks;
            if (attempt < 1) await sleep(800);
        }
        return null;
    }

    function ocrSpaceOnce(dataUrl, lang, key) {
        return new Promise(resolve => {
            const base64 = (dataUrl.split(',')[1] || dataUrl).trim();
            const body = 'apikey=' + encodeURIComponent(key)
                + '&base64Image=' + encodeURIComponent(base64)
                + '&language=' + lang
                + '&isOverlayRequired=true';
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.ocr.space/parse/image',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: body,
                timeout: TIMEOUT_OCR,
                onload: r => {
                    try {
                        const res = JSON.parse(r.responseText);
                        if (res.IsErroredOnProcessing || !res.ParsedResults || !res.ParsedResults[0]) { console.warn('[ocr.space]', res.ErrorMessage); resolve(null); return; }
                        const ov = res.ParsedResults[0].TextOverlay;
                        if (!ov || !ov.Lines) { resolve(null); return; }
                        const blocks = [];
                        ov.Lines.forEach(line => {
                            const t = (line.LineText || '').replace(/["\\\r\n]/g, '').trim();
                            if (t.length < 1 || !line.Words || !line.Words.length) return;
                            const xs = line.Words.map(w => w.Left);
                            const ys = line.Words.map(w => w.Top);
                            const rs = line.Words.map(w => w.Left + w.Width);
                            const bs = line.Words.map(w => w.Top + w.Height);
                            blocks.push({
                                text: t,
                                x: Math.min(...xs), y: Math.min(...ys),
                                w: Math.max(...rs) - Math.min(...xs),
                                h: Math.max(...bs) - Math.min(...ys)
                            });
                        });
                        resolve(blocks.length ? blocks : null);
                    } catch (e) { console.warn('[ocr.space]', e); resolve(null); }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    async function baiduOcr(dataUrl) {
        if (!apiConfig.baiduProxyUrl) return null;
        let u = apiConfig.baiduProxyUrl.trim().replace(/\/+$/, '');
        if (!/\/ocr$/.test(u)) u += '/ocr';
        const base64 = (dataUrl.split(',')[1] || '').trim();
        const lang = sourceMap[apiConfig.sourceLang].baidu || 'auto_detect';
        let lastQps = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await baiduOcrOnce(u, base64, lang);
            if (res && res.blocks) return res.blocks;
            lastQps = !!(res && res.qps);
            if (attempt < 2) await sleep(lastQps ? 1600 : 600);
        }
        return null;
    }

    function baiduOcrOnce(u, base64, lang) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: u,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ image: base64, language_type: lang }),
                timeout: TIMEOUT_OCR,
                onload: r => {
                    try {
                        const res = JSON.parse(r.responseText);
                        if (res.error_code || !res.words_result) {
                            const qps = res.error_code === 17 || res.error_code === 18;
                            console.warn('[baidu]', res.error_msg || res);
                            resolve({ blocks: null, qps });
                            return;
                        }
                        const blocks = res.words_result.map(it => {
                            const loc = it.location || {};
                            return {
                                text: (it.words || '').replace(/["\\\r\n]/g, '').trim(),
                                x: loc.left || 0, y: loc.top || 0,
                                w: loc.width || 0, h: loc.height || 0
                            };
                        }).filter(b => b.text.length > 0);
                        resolve({ blocks: blocks.length ? blocks : null, qps: false });
                    } catch (e) { console.warn('[baidu]', e); resolve({ blocks: null, qps: false }); }
                },
                onerror: () => resolve({ blocks: null, qps: false }),
                ontimeout: () => resolve({ blocks: null, qps: false })
            });
        });
    }

    async function baiduDirectOcr(dataUrl) {
        if (!apiConfig.baiduToken) return null;
        const base64 = (dataUrl.split(',')[1] || '').trim();
        const lang = sourceMap[apiConfig.sourceLang].baidu || 'auto_detect';
        const prefer = apiConfig.baiduPrecision === 'accurate' ? 'accurate' : 'general';
        const fallback = prefer === 'accurate' ? 'general' : 'accurate';
        for (const api of [prefer, fallback]) {
            for (let attempt = 0; attempt < 2; attempt++) {
                const res = await baiduDirectOnce(api, base64, lang);
                if (res && res.blocks) return res.blocks;
                if (attempt < 1) await sleep(res && res.qps ? 1600 : 700);
            }
        }
        return null;
    }

    function baiduDirectOnce(api, base64, lang) {
        return new Promise(resolve => {
            const url = 'https://aip.baidubce.com/rest/2.0/ocr/v1/' + api
                + '?access_token=' + encodeURIComponent(apiConfig.baiduToken);
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: 'image=' + encodeURIComponent(base64) + '&language_type=' + encodeURIComponent(lang),
                timeout: TIMEOUT_OCR,
                onload: r => {
                    try {
                        const res = JSON.parse(r.responseText);
                        if (res.error_code || !res.words_result) {
                            const qps = res.error_code === 17 || res.error_code === 18;
                            console.warn('[baidu-direct]', res.error_msg || res);
                            resolve({ blocks: null, qps });
                            return;
                        }
                        const blocks = res.words_result.map(it => {
                            const loc = it.location || {};
                            return {
                                text: (it.words || '').replace(/["\\\r\n]/g, '').trim(),
                                x: loc.left || 0, y: loc.top || 0,
                                w: loc.width || 0, h: loc.height || 0
                            };
                        }).filter(b => b.text.length > 0);
                        resolve({ blocks: blocks.length ? blocks : null, qps: false });
                    } catch (e) { console.warn('[baidu-direct]', e); resolve({ blocks: null, qps: false }); }
                },
                onerror: () => resolve({ blocks: null, qps: false }),
                ontimeout: () => resolve({ blocks: null, qps: false })
            });
        });
    }

    async function localOcr(dataUrl) {
        if (!apiConfig.localOcrUrl) return null;
        const base64 = (dataUrl.split(',')[1] || '').trim();
        const lang = sourceMap[apiConfig.sourceLang].baidu || 'auto_detect';
        for (let attempt = 0; attempt < 2; attempt++) {
            const blocks = await localOcrOnce(apiConfig.localOcrUrl, base64, lang);
            if (blocks) return blocks;
            if (attempt < 1) await sleep(500);
        }
        return null;
    }

    function localOcrOnce(u, base64, lang) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: u,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ image: base64, language_type: lang }),
                timeout: TIMEOUT_OCR,
                onload: r => {
                    try {
                        const res = JSON.parse(r.responseText);
                        if (res.error_code || !res.words_result) { console.warn('[local]', res.error_msg || res); resolve(null); return; }
                        const blocks = res.words_result.map(it => {
                            const loc = it.location || {};
                            return {
                                text: (it.words || '').replace(/["\\\r\n]/g, '').trim(),
                                x: loc.left || 0, y: loc.top || 0,
                                w: loc.width || 0, h: loc.height || 0
                            };
                        }).filter(b => b.text.length > 0);
                        resolve(blocks.length ? blocks : null);
                    } catch (e) { console.warn('[local]', e); resolve(null); }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    /* ---------------- 翻译（大批量 + 并发，走全局 LLM 池） ---------------- */

    async function translateInBatches(flatBlocks) {
        transTotal += flatBlocks.length;
        const batches = [];
        for (let i = 0; i < flatBlocks.length; i += LLM_BATCH_SIZE) batches.push(flatBlocks.slice(i, i + LLM_BATCH_SIZE));
        await Promise.all(batches.map(batch => pools.ll(() => translateBlocks(batch)).then(() => {
            transDone += batch.length;
            updateProgress();
        }).catch(e => {
            console.warn('[manga] 翻译失败', e);
            transDone += batch.length;
            updateProgress();
        })));
    }

    function isThinkingModel(model) {
        return /v4|v3\.1|v3\.2/i.test(model || '');
    }

    function callLLM(content, key) {
        return new Promise((resolve, reject) => {
            const body = { model: apiConfig.aiModel, temperature: 0.2, stream: false, messages: [{ role: 'user', content: content }] };
            // V4/V3.1/V3.2 默认开启思考，翻译时显式关掉，避免白烧推理 token / 超时 / finish_reason=length
            if (isThinkingModel(apiConfig.aiModel)) body.thinking = { type: 'disabled' };
            GM_xmlhttpRequest({
                method: 'POST',
                url: apiConfig.aiUrl,
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                data: JSON.stringify(body),
                timeout: TIMEOUT_LLM,
                onload: r => {
                    try { resolve(parseLLMContent(r.responseText)); }
                    catch (e) {
                        try {
                            const j = JSON.parse(r.responseText);
                            addLog('翻译', '接口异常: ' + ((j.error && j.error.message) || (j.choices && j.choices[0] && j.choices[0].finish_reason) || String(r.responseText).slice(0, 200)), 'error');
                        } catch (e2) { addLog('翻译', '返回解析失败: ' + String(r.responseText).slice(0, 200), 'error'); }
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('AI 网络异常')),
                ontimeout: () => reject(new Error('AI 超时'))
            });
        });
    }

    function parseLLMContent(text) {
        if (!text || !text.trim()) throw new Error('AI 返回为空');
        try {
            const j = JSON.parse(text);
            if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
            if (j.choices && j.choices[0]) {
                if (j.choices[0].finish_reason === 'length') addLog('翻译', 'finish_reason=length（输出被截断，可能思考烧完 token）', 'warn');
                if (j.choices[0].message) return j.choices[0].message.content.trim();
            }
        } catch (e) {
            if (e.message && !/Unexpected|JSON|position/.test(e.message)) throw e;
        }
        let out = '';
        const lines = text.split('\n');
        for (let l of lines) {
            l = l.trim();
            if (!l.startsWith('data:')) continue;
            const d = l.slice(5).trim();
            if (!d || d === '[DONE]') continue;
            try {
                const c = JSON.parse(d);
                if (c.choices && c.choices[0]) {
                    const delta = c.choices[0].delta || {};
                    if (delta.content) out += delta.content;
                }
            } catch (e) { }
        }
        if (out) return out.trim();
        throw new Error('无法解析 AI 返回');
    }

    function parseJsonArray(text) {
        let t = String(text).trim();
        t = t.replace(/```json/gi, '').replace(/```/g, '');
        const s = t.indexOf('['), e = t.lastIndexOf(']');
        if (s < 0 || e <= s) return null;
        try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
    }

    async function translateBlocks(blocks) {
        const t0 = Date.now();
        addLog('翻译', '开始 ' + blocks.length + ' 段');
        const texts = blocks.map(b => b.originalText);
        const langName = sourceMap[apiConfig.sourceLang].name;

        // 主路径：|| 分隔，带英文翻译示例，逼小模型也把英文翻成中文
        const flat = texts.join(' || ');
        const prompt = '你是漫画翻译引擎。把下面被 || 分割的每一段台词翻译成中文。'
            + '规则：无论原文是' + langName + '、日文还是英文，都必须翻译成中文。'
            + '例如 Thank you → 谢谢，Sorry → 对不起，绝对不要输出英文或原文。'
            + '用 || 分隔返回，数量一致，不要序号、不要解释：\n' + flat;
        let assigned = 0;
        try {
            const reply = await callLLM(prompt, apiConfig.aiKey);
            const arr = reply.split('||').map(s => s.trim()).filter(s => s.length > 0);
            // 尽量按顺序填空（即使数量不符，也先把能对应的填上）
            blocks.forEach((b, i) => { b.chineseText = arr[i] || ''; });
            assigned = arr.length;
        } catch (e) { addLog('翻译', '|| 失败', 'warn'); }

        const diff = Math.abs(assigned - blocks.length);

        // 差量 ≤3：接受少量缺失，跳过逐条重翻（避免反复检查浪费时间）
        if (diff > 0 && diff <= 3) {
            addLog('翻译', '差量 ' + diff + ' 句（≤3）跳过重翻 · ' + (Date.now() - t0) + 'ms', 'warn');
            return blocks;
        }

        // 差量较大：只对空/纯英文的逐条重翻
        let fixed = 0;
        for (let i = 0; i < blocks.length; i++) {
            const cur = blocks[i].chineseText || '';
            const pureEnglish = /[a-zA-Z]/.test(cur) && !/[\u4e00-\u9fff]/.test(cur);
            if (!cur || pureEnglish) {
                try {
                    const r = await callLLM('把这句话翻译成中文，只返回中文译文，不要解释、不要输出英文：' + blocks[i].originalText, apiConfig.aiKey);
                    const t = (r || '').trim();
                    if (t && /[\u4e00-\u9fff]/.test(t)) { blocks[i].chineseText = t; fixed++; }
                } catch (e) { }
            }
        }
        if (fixed) addLog('翻译', '重翻 ' + fixed + ' 条');
        addLog('翻译', '完成 ' + (Date.now() - t0) + 'ms');
        return blocks;
    }

    /* ---------------- 气泡覆盖 ---------------- */

    function overlayBubbles(img, blocks, refW, refH) {
        const parent = img.parentNode;
        let wrapper = parent;
        if (!wrapper.classList.contains('mt-shell')) {
            wrapper = document.createElement('div');
            wrapper.className = 'mt-shell';
            wrapper.style.cssText = 'position:relative;display:inline-block;max-width:100%;vertical-align:top;line-height:0;';
            parent.insertBefore(wrapper, img);
            wrapper.appendChild(img);
        }

        // 用图片【实际渲染尺寸】做像素换算：比百分比更稳，杜绝气泡被放大好几倍的问题
        let rect = null;
        try { rect = img.getBoundingClientRect(); } catch (e) { }
        const dispW = (rect && rect.width) || refW;
        const dispH = (rect && rect.height) || refH;
        const sx = dispW / refW;
        const sy = dispH / refH;
        // 极小外扩（约 2~6px），只兜底盖住字迹边缘，不再按百分比放大
        const PAD = Math.max(2, Math.round(Math.min(refW, refH) * 0.004));
        // 气泡背景缩放（只缩白底框，不动字号），默认 100%
        const bscale = (parseInt(apiConfig.bubbleScale || '100', 10) / 100) || 1;

        // 正文（长句）气泡画在拟声词（短字）气泡上面：短文本先画、长文本后画
        const ordered = blocks.slice().sort((a, b) => (a.chineseText ? a.chineseText.length : 0) - (b.chineseText ? b.chineseText.length : 0));
        ordered.forEach(b => {
            if (!b.chineseText) return;
            // 丢弃坐标非法或面积过大的异常块，避免画出一整页的白条
            if (!(b.x >= 0) || !(b.y >= 0) || !(b.w > 0) || !(b.h > 0)) return;
            if (b.w * b.h > refW * refH * 0.35) return;
            const div = document.createElement('div');
            div.className = 'mt-bubble';
            const cx = (b.x + b.w / 2) * sx;
            const cy = (b.y + b.h / 2) * sy;
            let W = Math.round((b.w * sx + PAD * 2) * bscale);
            let minH = Math.round((b.h * sy + PAD * 2) * bscale);
            // 译文最长允许到原文框约 2.2 倍高，超了自动缩字号，避免白框盖住画面
            let maxH = Math.max(minH, Math.round((b.h * sy * 2.2 + PAD * 2) * bscale));
            const L = Math.max(0, Math.round(cx - W / 2));
            const T = Math.max(0, Math.round(cy - minH / 2));
            W = Math.max(1, Math.min(W, dispW - L));
            // 纯白底 + 居中译文：框体紧贴原文框，彻底遮住原文
            div.style.cssText = 'position:absolute;left:' + L + 'px;top:' + T + 'px;width:' + W + 'px;min-height:' + minH + 'px;max-height:' + maxH + 'px;'
                + 'background:#ffffff;color:#000;'
                + 'border:none;border-radius:4px;padding:2px 3px;'
                + 'font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei","PingFang SC",sans-serif;'
                + 'font-size:' + apiConfig.fontSize + 'px;font-weight:700;text-align:center;line-height:1.15;'
                + 'z-index:99998;'
                + 'display:flex;align-items:center;justify-content:center;'
                + 'white-space:normal;overflow-wrap:anywhere;word-break:break-word;box-sizing:border-box;overflow:hidden;';
            div.textContent = b.chineseText;
            div.onclick = () => div.remove();
            wrapper.appendChild(div);

            // 自动缩字号：译文太长时缩小，避免把白框撑得过大盖住画面
            let fsize = parseInt(apiConfig.fontSize, 10) || 14;
            while (fsize > 9 && (div.scrollHeight > maxH + 2 || div.scrollWidth > W + 2)) {
                fsize--;
                div.style.fontSize = fsize + 'px';
            }
        });
    }

    /* ---------------- 测试 ---------------- */

    async function runTest() {
        log('测试 AI 通道...');
        try {
            const reply = await callLLM('回复“OK”两个字，不要其他内容。', apiConfig.aiKey);
            if (!reply) throw new Error('AI 无返回');
            log('✅ AI 正常：' + reply);
        } catch (e) {
            log('❌ AI 失败：' + e.message);
            return;
        }

        log('测试 OCR 通道...');
        try {
            const c = document.createElement('canvas');
            c.width = 600; c.height = 160;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 160);
            ctx.fillStyle = '#000'; ctx.font = 'bold 42px sans-serif';
            ctx.fillText('HELLO TEST 12345', 20, 90);
            const dataUrl = c.toDataURL('image/jpeg', 0.92);
            const raw = apiConfig.ocrMode === 'baidu' ? await baiduOcr(dataUrl)
                : apiConfig.ocrMode === 'baidu-direct' ? await baiduDirectOcr(dataUrl)
                : apiConfig.ocrMode === 'local' ? await localOcr(dataUrl)
                : await ocrSpace(dataUrl);
            if (raw && raw.length) log('✅ OCR 正常，识别到：' + raw.map(x => x.text).join(' / '));
            else log('❌ OCR 无结果：检查 Key / 代理地址 / 限速设置');
        } catch (e) {
            log('❌ OCR 异常：' + e.message);
        }
    }

    createUI();
})();
