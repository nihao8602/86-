// ==UserScript==
// @name         漫画翻译引擎
// @namespace    https://github.com/nihao8602/86-
// @version      7.33.0
// @description  提速版：全局并发池+OCR限速器 · 分块OCR并行 · 下载/OCR/翻译流水线 · 快重试+超时 · 纯白底气泡完全遮盖原文 · 气泡按像素紧贴原文框不再放大 · 去掉气泡描边 · 翻译引擎预设（混元/硅基流动/智谱GLM） · 拟声词跳过不翻 · 详细日志 · 合并更保守 · 英文强制重翻 · 处理顺序可选 · 手机极速模式 · 设备选择(自动/电脑/手机) · 手机直发原图 · 气泡底缩放 · 翻译回退可用版 · DeepSeek 全系关闭思考 · 面板默认最小化 · 分组默认全折叠 · 面板支持触屏拖动 · 气泡级分组(一句一框) · 网址水印过滤 · 拒答文案不落板 · 思考模式开关 · 擦除原文(克隆底)开关 · 术语表+上下文记忆
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
        aiKeys: savedConfig.aiKeys || {},   // 按接口地址分别保存密钥，切换服务商不用重输
        aiModel: savedConfig.aiModel || 'deepseek-chat',
        sourceLang: savedConfig.sourceLang || 'kor',
        fontSize: savedConfig.fontSize || '14',
        thinkingEnabled: savedConfig.thinkingEnabled === undefined ? false : !!savedConfig.thinkingEnabled,   // #3 思考模式总开关（默认关，保持旧行为）
        eraseOriginal: savedConfig.eraseOriginal === undefined ? false : !!savedConfig.eraseOriginal,         // #4 擦除原文再打译文（默认关）
        glossary: savedConfig.glossary || '',                                                                 // #5 手工术语表（每行 原文=译名）
        contextPages: savedConfig.contextPages === undefined ? 1 : parseInt(savedConfig.contextPages, 10) || 0, // #5 上下文页数 0~3
        autoGlossary: savedConfig.autoGlossary === undefined ? false : !!savedConfig.autoGlossary,            // #5 自动记人名译名（可选）
        ctxMemory: savedConfig.ctxMemory || {},                                                              // #5 滑动上下文记忆（按漫画系列分桶）
        autoGlossaryStore: savedConfig.autoGlossaryStore || {},                                               // #5 自动累积的 原文→译名
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
        localOcrToken: savedConfig.localOcrToken || '',   // 服务端设了 OCR_TOKEN 才需要填，留空=不带令牌
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
    let usedFallbackImages = false; // 本次是否走了「页面上所有大图」兜底选图

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

    // 明确的英文拟声/特效词表：只有命中这里才按拟声跳过。
    // 旧规则「全大写 2~5 字母一律当拟声」会把 OK / NO / GO / YES / AND / THE / WHY / HOW 这些真台词
    // 静默吃掉（不翻、不盖），英文漫画的短对白整句消失。改为白名单制：宁可多翻一句，不可错杀一句。
    const SFX_WORDS = new Set(['BANG', 'POW', 'BOOM', 'BAM', 'WHAM', 'SLAM', 'CRASH', 'CLANG', 'KLANG', 'THUD', 'FWIP', 'KRAK', 'KABOOM', 'ZAP', 'RUMBLE', 'BZZ', 'SNAP']);

    // 判断是否拟声词（重复字符型特效字）：ドドド / 쿵쿵 / ㅋㅋ / ゴゴゴ / 두근두근
    function isSfx(text) {
        if (!text) return false;
        const t = text.replace(/\s+/g, '');
        if (t.length < 2) return false;
        const chars = new Set(t);
        if (chars.size === 1 && t.length >= 2) return true;
        if (chars.size === 2 && t.length >= 4 && t.slice(0, 2) === t.slice(2, 4)) {
            // 纯英文的重复词（OKOK / HAHA）多半是对话，不跳过
            if (/^[A-Z]+$/.test(t)) return false;
            return true;
        }
        // 全大写英文：只有明确在特效词表里时才跳过
        if (/^[A-Z]{2,6}$/.test(t)) return SFX_WORDS.has(t);
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

    // 受控并发映射：用于「补翻」这类不能走 pools.ll 的场合（会自锁），
    // 单独开一个小窗口，既限制并发又不占用全局 LLM 池的槽位。
    async function mapLimit(items, limit, fn) {
        const out = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
            while (cursor < items.length) {
                const i = cursor++;
                out[i] = await fn(items[i], i);
            }
        });
        await Promise.all(workers);
        return out;
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
                <span style="font-weight:700;color:#FF69B4;">漫画翻译引擎</span>
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
                <textarea id="mt-glossary" rows="3" placeholder="术语表（可选）：每行一条「原文=译名」，如 Elena=艾琳娜" style="width:100%;padding:6px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;resize:vertical;font-family:inherit;"></textarea>
                <div style="display:flex;gap:6px;align-items:center;">
                    <span style="font-size:12px;white-space:nowrap;">上下文页数</span>
                    <input id="mt-context-pages" type="number" min="0" max="3" step="1" value="1" style="width:56px;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
                    <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#aaa;flex:1;cursor:pointer;white-space:nowrap;">
                        <input id="mt-auto-glossary" type="checkbox" style="accent-color:#FF69B4;">自动记人名
                    </label>
                </div>
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
                        <input id="mt-local-token" type="password" placeholder="访问令牌（服务端设了 OCR_TOKEN 才填）" style="width:100%;padding:5px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;box-sizing:border-box;font-size:12px;outline:none;">
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
                        <span style="font-size:10px;color:#777;flex:1;">次/秒（0=关闭限速器、改用 4 并发；百度免费约 2）</span>
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
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;padding:2px 0;cursor:pointer;">
                    <input id="mt-thinking" type="checkbox" style="accent-color:#FF69B4;">
                    思考模式（更慢更贵；仅对 DeepSeek 官方域生效）
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;padding:2px 0;cursor:pointer;">
                    <input id="mt-erase" type="checkbox" style="accent-color:#FF69B4;">
                    擦除原文再打译文（渐变气泡克隆底，失败自动回退白底）
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
                <button id="mt-clear-bubbles" style="flex:1;padding:8px;background:#8E8E93;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;">清气泡</button>
            </div>

            <button id="mt-toggle" style="padding:12px;background:#FF69B4;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(255,105,180,0.5);">开启自动识别</button>
            <div id="mt-log" style="font-size:11px;color:#ffeb3b;word-break:break-word;text-align:center;min-height:15px;">填好配置后点“开启自动识别”</div>
        `;
        document.body.appendChild(panel);

        // 折叠分区
        function collapseAllSections() {
            document.querySelectorAll('.mt-sec-b').forEach(b => { b.style.display = 'none'; });
            document.querySelectorAll('.mt-sec-h .mt-arrow').forEach(a => { a.textContent = '▸'; });
        }
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
        // 默认全部折叠：只显示分组标题，需要哪个点哪个展开
        collapseAllSections();

        $('mt-ai-url').value = apiConfig.aiUrl;
        $('mt-ai-model').value = apiConfig.aiModel;
        $('mt-ai-key').value = keyForUrl(apiConfig.aiUrl) || apiConfig.aiKey;
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
        $('mt-thinking').checked = !!apiConfig.thinkingEnabled;
        $('mt-erase').checked = !!apiConfig.eraseOriginal;
        $('mt-glossary').value = apiConfig.glossary || '';
        $('mt-context-pages').value = apiConfig.contextPages;
        $('mt-auto-glossary').checked = !!apiConfig.autoGlossary;
        $('mt-device-mode').value = apiConfig.deviceMode || 'auto';
        $('mt-wave-size').value = apiConfig.waveSize;
        $('mt-ocr-rps').value = apiConfig.ocrRps;
        $('mt-local-url').value = apiConfig.localOcrUrl;
        $('mt-local-token').value = apiConfig.localOcrToken || '';

        // 每个接口地址各自存一份密钥：切换服务商自动回填，不用重输
        function keyForUrl(url) {
            const k = String(url || '').trim().toLowerCase();
            return (apiConfig.aiKeys && apiConfig.aiKeys[k]) || '';
        }
        // 翻译引擎预设：选好后自动填接口地址+模型，并回填该服务商保存的密钥
        const translatorSel = $('mt-translator');
        translatorSel.addEventListener('change', () => {
            const t = TRANSLATORS[translatorSel.value];
            if (t && t.url) {
                $('mt-ai-url').value = t.url;
                $('mt-ai-model').value = t.model;
                $('mt-ai-key').value = keyForUrl(t.url);
            }
        });
        // 手动改接口地址时，也回填该地址保存过的密钥
        $('mt-ai-url').addEventListener('change', () => {
            $('mt-ai-key').value = keyForUrl($('mt-ai-url').value);
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
            collapseAllSections();   // 每次点开都回到"全折叠"状态
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

        $('mt-clear-bubbles').addEventListener('click', () => {
            clearBubbles();
            log('已清除全部气泡');
        });

        $('mt-toggle').addEventListener('click', () => {
            syncConfig();
            if (running) stopAuto();
            else startAuto();
        });

        // 默认最小化：收起大面板，只显示悬浮球，需要时点开
        (function initMinimized() {
            const rr = panel.getBoundingClientRect();
            panel._vw = rr.width; panel._vh = rr.height;   // 先量好尺寸（隐藏后量不到）
            panel.style.display = 'none';
            mini.style.display = 'flex';
        })();
    }

    function syncConfig() {
        apiConfig.aiUrl = $('mt-ai-url').value.trim() || 'https://api.deepseek.com/chat/completions';
        apiConfig.aiModel = $('mt-ai-model').value.trim() || 'deepseek-chat';
        apiConfig.aiKey = $('mt-ai-key').value.trim();
        // 按接口地址分别存一份密钥，方便切换服务商
        if (!apiConfig.aiKeys) apiConfig.aiKeys = {};
        const _keyUrl = (apiConfig.aiUrl || '').trim().toLowerCase();
        if (_keyUrl && apiConfig.aiKey) apiConfig.aiKeys[_keyUrl] = apiConfig.aiKey;
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
        apiConfig.localOcrToken = $('mt-local-token').value.trim();
        apiConfig.panelZoom = $('mt-panel-zoom').value || '100';
        apiConfig.fastMode = !!$('mt-fast-mode').checked;
        apiConfig.thinkingEnabled = !!$('mt-thinking').checked;
        apiConfig.eraseOriginal = !!$('mt-erase').checked;
        apiConfig.glossary = $('mt-glossary').value || '';
        apiConfig.contextPages = Math.max(0, Math.min(3, parseInt($('mt-context-pages').value, 10) || 0));
        apiConfig.autoGlossary = !!$('mt-auto-glossary').checked;
        apiConfig.deviceMode = $('mt-device-mode').value || 'auto';
        apiConfig.bubbleScale = $('mt-bubble-scale').value || '100';
    }

    function makeDraggable(panel) {
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0, vw = 0, vh = 0;
        const pz = () => parseFloat(panel.style.zoom) || 1;
        function dragStart(cx, cy, target) {
            if (target && target.closest && target.closest('input,select,button,textarea')) return;
            dragging = true; sx = cx; sy = cy;
            const r = panel.getBoundingClientRect();
            sl = r.left; st = r.top; vw = r.width; vh = r.height;
        }
        function dragMove(cx, cy) {
            if (!dragging) return;
            const z = pz();
            let lv = Math.max(0, Math.min(sl + (cx - sx), innerWidth - vw));
            let tv = Math.max(0, Math.min(st + (cy - sy), innerHeight - vh));
            panel.style.left = (lv / z) + 'px'; panel.style.top = (tv / z) + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
        }
        // 鼠标拖动
        panel.addEventListener('mousedown', e => {
            dragStart(e.clientX, e.clientY, e.target);
            if (dragging) e.preventDefault();
        });
        document.addEventListener('mousemove', e => dragMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', () => dragging = false);
        // 触屏拖动（手机）：面板也要能拖，别只有悬浮球能拖
        panel.addEventListener('touchstart', e => {
            if (e.touches && e.touches[0]) dragStart(e.touches[0].clientX, e.touches[0].clientY, e.target);
        }, { passive: true });
        document.addEventListener('touchmove', e => {
            if (!dragging || !e.touches || !e.touches[0]) return;
            e.preventDefault();
            dragMove(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
        document.addEventListener('touchend', () => dragging = false);
        document.addEventListener('touchcancel', () => dragging = false);
    }

    /* ---------------- 主流程：流水线（下载→OCR→翻译 重叠进行） ---------------- */

    async function startAuto() {
        running = true;
        stopRequested = false;
        processed.clear();
        usedFallbackImages = false;
        clearBubbles();   // 先清掉上一次的气泡：否则重复点开始会新气泡压旧气泡，付费接口二次计费
        totalCount = 0; doneCount = 0;
        dlDone = 0; ocrDone = 0; transDone = 0; transTotal = 0;
        $('mt-toggle').innerText = '停止';
        $('mt-toggle').style.background = '#FF3B30';

        try {
            // 重建并发池（读取当前配置）
            const rps = parseInt(apiConfig.ocrRps, 10) || 0;
            pools = {
                dl: createPool(10),
                ocr: rps > 0 ? createRateLimiter(rps) : createPool(4),
                ll: createPool(5)
            };

            const targets = findChapterImages();
            totalCount = targets.length;
            if (!totalCount) { log('没有找到漫画图'); return; }
            // 兜底选图（没认出漫画结构，抓了页面上所有大图）：先确认，避免在新闻/购物站误点就批量打付费接口
            if (usedFallbackImages && totalCount > 3) {
                const ok = confirm('未识别到漫画页面结构，检测到页面上有 ' + totalCount + ' 张大图。\n继续会把它们全部发给 OCR / 翻译接口，可能产生费用。\n\n要继续吗？');
                if (!ok) { log('已取消（兜底选图未确认）'); return; }
            }
            addLog('流程', '开始 · ' + totalCount + ' 张 · OCR=' + apiConfig.ocrMode + ' · 模型=' + apiConfig.aiModel);

            if (apiConfig.processMode === 'all') {
                await processAll(targets);
            } else {
                await processWaves(targets);
            }

            if (stopRequested) log('⏹ 已停止：' + doneCount + '/' + totalCount + ' 张');
            else log('✅ 全部完成：' + doneCount + '/' + totalCount + ' 张');
        } catch (e) {
            // 旧实现没有 try/finally：内部一抛错 running 就永远卡在 true，按钮停在「停止」，只能刷新页面
            addLog('流程', '异常终止：' + (e && e.message || e), 'error');
            log('❌ 异常终止：' + (e && e.message || e));
        } finally {
            stopAuto();
        }
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
        // 第三级兜底：页面上所有 ≥120×120 的图都算漫画页。找不到结构时才会走到这里，
        // 所以打标记让 startAuto 先弹确认，避免在普通网页上误触就把大图全外发。
        usedFallbackImages = true;
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
                // 有的 CDN（例如加了 Cloudflare 防护的图床）只放行浏览器主进程发出的图片请求。
                // Tampermonkey 后台请求头不全时会被判成机器人，拿回的是验证网页 HTML 而不是图片，
                // 错误会推迟到解码阶段才出现（"The source image could not be decoded"）。
                // 这里补齐常用头，并在响应是 HTML/JSON 时立刻报出可读原因。
                headers: {
                    'Referer': location.href,
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                    'Accept-Language': navigator.language || 'zh-CN'
                },
                userAgent: navigator.userAgent,
                anonymous: false,
                timeout: TIMEOUT_IMG,
                onload: r => {
                    const ct = (r.response && r.response.type) || '';
                    if (r.status && (r.status < 200 || r.status >= 300)) {
                        return reject(new Error('图片请求失败 HTTP ' + r.status + '（可能被站点拦截或需登录）'));
                    }
                    if (/html|json|text/i.test(ct)) {
                        return reject(new Error('返回的不是图片（' + ct + '），多半被 Cloudflare/防盗链拦截'));
                    }
                    if (r.response && r.response.size) resolve(r.response);
                    else reject(new Error('图片为空'));
                },
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
            // #4 补丁必须在 bitmap 释放前生成（之后拿不到像素）
            buildErasePatches(item.bitmap, blocks);
            addLog('OCR', '完成 ' + blocks.length + ' 段 · ' + (Date.now() - t0) + 'ms');
        } catch (e) {
            addLog('OCR', '失败 ' + (e && e.message || e), 'error');
            item.blocks = [];
        }
        if (item.bitmap && item.bitmap.close) item.bitmap.close();
        item.bitmap = null;
        item.blob = null;   // 原图字节一起释放：手机极速模式每张原图可达数 MB，不释放会整章驻留内存
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
                    return finalizeBlocks(blocks, W, H, bitmap);
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
        return finalizeBlocks(blocks, W, H);
    }

    /* ---------------- 文本判定（#1 噪声/拒答、#2 网址水印） ---------------- */

    // 允许保留的极短英文词：避免把 "nt" 这类切图碎片送审，又不误杀真台词里的 I / OK / NO
    const SHORT_KEEP = new Set(['I', 'A', 'OK', 'NO', 'GO', 'YES', 'HE', 'ME', 'WE', 'US', 'AM', 'PM', 'TV', 'AH', 'OH', 'UH', 'HM', 'HA', 'TO', 'IN', 'ON', 'IT', 'IS', 'AS', 'AT', 'BY', 'DO', 'SO', 'UP', 'AN', 'OR', 'IF', 'OF', 'MY', 'BE', 'HI', 'EH', 'HO', 'HU', 'AY', 'YA', 'YO', 'WHY', 'HOW', 'ALL', 'AND', 'THE', 'NOT', 'YOU', 'ARE', 'WAS', 'OUR', 'HER', 'HIS', 'ITS', 'GET', 'GOT', 'NOW', 'WAY', 'DAY', 'OUT', 'SEE', 'SAY', 'WHO', 'TOO', 'USE', 'MAN', 'OLD', 'ONE', 'TWO', 'SIR', 'MOM', 'DAD', 'CAN', 'MAY', 'LET', 'PUT', 'RUN', 'SAT', 'SET', 'SIT', 'TELL', 'WELL', 'WILL', 'WITH', 'YOUR', 'THIS', 'THAT', 'WHAT', 'WHEN', 'THERE', 'THEIR', 'FROM', 'HAVE', 'HERE', 'THEM', 'THEN', 'THEY', 'WERE', 'BEEN', 'BOTH', 'JUST', 'LIKE', 'MADE', 'MAKE', 'MANY', 'MUCH', 'MUST', 'ONLY', 'OVER', 'SAME', 'SOME', 'TAKE', 'THAN', 'UPON', 'VERY']);

    function isNoiseText(text) {
        const t = String(text || '').trim();
        if (!t) return true;
        const compact = t.replace(/\s+/g, '');
        // 纯符号 / 纯标点：OCR 把噪点当字
        if (!/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/.test(compact)) return true;
        // 先剥掉首尾标点再判短词：`nt.` / `?!` / `–no` 这种带标点的碎片也要拦（反重力评审指出）
        const core = compact.replace(/^[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+|[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/g, '');
        // 1~2 个英文字母的碎片：只有白名单里的常用短词保留（先于"单字符"规则，否则 I / A 会被误杀）
        // 注意：纯数字不丢 —— "10 YEARS" 被切成 "10" + "YEARS" 时，丢数字会让译文变成"岁"。
        if (/^[A-Za-z]{1,2}$/.test(core)) return !SHORT_KEEP.has(core.toUpperCase());
        // 孤立的日文小假名/长音符（促音、拗音）与韩文兼容字母：不是独立台词
        if (/^[\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308e\u30a1\u30a3\u30a5\u30a7\u30a9\u30c3\u30e3\u30e5\u30e7\u30fc\u3131-\u318e]{1,2}$/.test(core)) return true;
        return false;
    }

    // 站点水印/网址：命中即丢弃，不翻、不画（#2）
    const URL_TLD = 'com|net|org|cn|tw|jp|kr|co|cc|xyz|info|top|vip|site|club|app|dev|page|blog|shop|online|manga|biz|us|uk|de|fr|ru|es|nl|br|au|tv|edu|gov|store|live|link|fun|space|website';
    function isUrlLike(text) {
        let t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
        if (!t) return false;
        // OCR 常见误识别修正：域名里的 0/o、1/l、3/e 混淆 + .corn/.c0m/.con → .com（仅用于判定，不改原文）
        const variants = [t, t.replace(/0/g, 'o'), t.replace(/1/g, 'l'), t.replace(/3/g, 'e')]
            .map(v => v.replace(/\.corn\b/g, '.com').replace(/\.c0m\b/g, '.com').replace(/\.con\b/g, '.com'));
        const reBare = new RegExp('(^|[^a-z0-9])([a-z0-9-]{2,}\\.)+(' + URL_TLD + ')(\\.[a-z]{2,})?(\\/|$|[^a-z0-9])');
        for (const v of variants) {
            if (/^(https?:\/\/|www\.)/.test(v)) return true;
            if (reBare.test(v)) return true;
            if (/^[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}(\/|$)/.test(v)) return true;   // 带端口
        }
        return false;
    }

    // AI 拒答/解释文案：不能当译文落板（#1）
    const REFUSAL_RE = /无法(可靠|准确|正确)?(地)?翻译|不能(可靠|准确)?翻译|不是一句完整的话|不是完整的?(英文)?句子|请提供完整的?(英文|原文|句子)|无法理解|无法识别(的)?(文字|内容)|作为一个?(AI|人工智能)|我不能(回答|处理|翻译)|cannot (translate|understand)|can'?t (translate|understand)|not a complete sentence|unable to translate|无法处理这段文字/;
    function isRefusal(text) {
        if (!text) return false;
        return REFUSAL_RE.test(String(text));
    }

    /* ---------------- #6 气泡级分组：白色连通域定位气泡 ---------------- */

    function rectContains(r, b) {
        return b.x >= r.x - 1 && b.y >= r.y - 1 && b.x + b.w <= r.x + r.w + 1 && b.y + b.h <= r.y + r.h + 1;
    }

    // 缩到最长边 480px 做阈值化 + BFS 连通域，返回候选气泡矩形（bitmap 像素坐标系）
    function detectBubbles(bitmap, W, H) {
        const scale = Math.min(1, 480 / Math.max(W, H));
        const cw = Math.max(1, Math.round(W * scale));
        const ch = Math.max(1, Math.round(H * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, cw, ch);
        const data = ctx.getImageData(0, 0, cw, ch).data;
        const n = cw * ch;
        const mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            const r = data[o], g = data[o + 1], b = data[o + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            // 近白/浅色且低饱和：白气泡（255,255,255）和浅粉/浅黄气泡都算；
            // 彩色背景（蓝窗、肤色渐变）因饱和度差 > 40 被排除（反重力评审提出的彩色气泡边界）
            mask[i] = ((r + g + b) / 3 > 205 && mx - mn < 40) ? 1 : 0;
        }
        const seen = new Uint8Array(n);
        const queue = new Int32Array(n);
        const out = [];
        const minArea = n * 0.002, maxArea = n * 0.6;
        for (let i = 0; i < n; i++) {
            if (!mask[i] || seen[i]) continue;
            let head = 0, tail = 0;
            queue[tail++] = i; seen[i] = 1;
            let minX = cw, minY = ch, maxX = 0, maxY = 0, area = 0;
            while (head < tail) {
                const p = queue[head++];
                const x = p % cw, y = (p / cw) | 0;
                area++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (x > 0) { const q = p - 1; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
                if (x < cw - 1) { const q = p + 1; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
                if (y > 0) { const q = p - cw; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
                if (y < ch - 1) { const q = p + cw; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
            }
            if (area < minArea || area > maxArea) continue;
            const bw = maxX - minX + 1, bh = maxY - minY + 1;
            if (bw < 16 || bh < 16) continue;
            if (area / (bw * bh) < 0.5) continue;             // 太散：背景白边/白衣服
            if (bw / bh > 6 || bh / bw > 6) continue;          // 极端长条不是气泡
            out.push({ x: minX / cw * W, y: minY / ch * H, w: bw / cw * W, h: bh / ch * H });
        }
        // 只保留最内层：白底页会整页连通，大矩形会被内部小矩形过滤
        out.sort((a, b) => a.w * a.h - b.w * b.h);
        const keep = [];
        for (const r of out) {
            if (keep.some(k => rectContains(k, r))) continue;
            keep.push(r);
        }
        return keep;
    }

    // 块与气泡的归属判定：整块在内 / 中心在内 / 重叠面积占比 ≥ 0.4
    function blockInBubble(b, r) {
        if (rectContains(r, b)) return 1;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return 1;
        const ix = Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x);
        const iy = Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y);
        if (ix <= 0 || iy <= 0) return 0;
        return (ix * iy) / Math.max(1, b.w * b.h);
    }

    // 同一白色连通域里可能黏着多个气泡（两个椭圆贴边/相交）：按垂直间隔切分，
    // 每簇一个翻译单元。垂直间隔超过 max(30px, 行高*1.4) 就断开（不同气泡），否则并入。
    // 水平位置不参与判断：气泡内文字本就居中，碎块左右参差（实测会让"三"单独成簇、译文碎裂）。
    function clusterBlocks(members) {
        const sorted = members.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
        const clusters = [];
        for (const b of sorted) {
            const cur = clusters[clusters.length - 1];
            if (cur) {
                const gap = b.y - cur.y2;
                const limit = Math.max(30, Math.max(cur.maxH, b.h) * 1.4);
                if (gap <= limit && gap >= -limit * 2) {
                    cur.members.push(b);
                    cur.maxH = Math.max(cur.maxH, b.h);
                    cur.x = Math.min(cur.x, b.x);
                    cur.y = Math.min(cur.y, b.y);
                    cur.x2 = Math.max(cur.x2, b.x + b.w);
                    cur.y2 = Math.max(cur.y2, b.y + b.h);
                    continue;
                }
            }
            clusters.push({ members: [b], x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h, maxH: b.h });
        }
        return clusters;
    }

    // 同一气泡里的所有行合并成一个翻译单元；不属于任何气泡的块原样返回。
    // 返回 null 表示整页没有可靠气泡（白底页等），由调用方降级到 mergeBlocks。
    function groupByBubbles(blocks, bitmap, W, H) {
        let bubbles = [];
        try { bubbles = detectBubbles(bitmap, W, H); } catch (e) { bubbles = []; }
        if (!bubbles.length) return null;
        const used = new Array(blocks.length).fill(false);
        const units = [];
        for (const bb of bubbles) {
            const idxs = [];
            blocks.forEach((b, i) => {
                if (!used[i] && blockInBubble(b, bb) >= 0.4) idxs.push(i);
            });
            if (!idxs.length) continue;
            idxs.forEach(i => { used[i] = true; });
            const clusters = clusterBlocks(idxs.map(i => blocks[i]));
            for (const g of clusters) {
                units.push({
                    originalText: joinLines(g.members.map(m => m.originalText)),
                    x: g.x, y: g.y, w: g.x2 - g.x, h: g.y2 - g.y,
                    bubbleUnit: true
                });
            }
        }
        blocks.forEach((b, i) => { if (!used[i]) units.push(Object.assign({}, b, { _orphan: true })); });
        return units;
    }

    /* ---------------- #4 擦除原文：克隆底 + 白色膨胀去字 + 轻模糊 ---------------- */

    // 对会落译文的块生成补丁（bitmap 像素空间）。失败返回 null，渲染层自动回退纯白底。
    function makeErasePatch(bitmap, b) {
        const pad = Math.max(2, Math.round(Math.min(b.w, b.h) * 0.08));
        const x = Math.max(0, Math.floor(b.x - pad));
        const y = Math.max(0, Math.floor(b.y - pad));
        const x2 = Math.min(bitmap.width, Math.ceil(b.x + b.w + pad));
        const y2 = Math.min(bitmap.height, Math.ceil(b.y + b.h + pad));
        const w = x2 - x, h = y2 - y;
        if (w < 4 || h < 4 || w * h > 400000) return null;    // 异常大块直接放弃
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        const src = new Uint8ClampedArray(d);
        // 白色膨胀 4 轮（等效 9x9 邻域）：漫画字笔画一般 2~5px，4 轮连较粗的描边也能覆盖到。
        // 只做 9 次取最大、不排序，比中值滤波快，且对渐变底不会产生脏点。
        let cur = new Uint8ClampedArray(src);
        for (let pass = 0; pass < 4; pass++) {
            const next = new Uint8ClampedArray(cur.length);
            for (let yy = 0; yy < h; yy++) {
                for (let xx = 0; xx < w; xx++) {
                    const o = (yy * w + xx) * 4;
                    for (let c = 0; c < 3; c++) {
                        let m = 0;
                        for (let dy = -1; dy <= 1; dy++) {
                            const Y = yy + dy < 0 ? 0 : (yy + dy >= h ? h - 1 : yy + dy);
                            for (let dx = -1; dx <= 1; dx++) {
                                const X = xx + dx < 0 ? 0 : (xx + dx >= w ? w - 1 : xx + dx);
                                const v = cur[(Y * w + X) * 4 + c];
                                if (v > m) m = v;
                            }
                        }
                        next[o + c] = m;
                    }
                    next[o + 3] = 255;
                }
            }
            cur = next;
        }
        // 估计块内背景亮度（白底≈255，浅色渐变≈220~250）：从亮端累计 20% 像素得到的亮度。
        // 不能用固定中位数分位：裁剪框紧贴粗字时黑像素可能过半，40/60 分位会估成黑色、导致不擦除。
        // 从 255 往下累计，达到 20% 就停 —— 白底/浅底时一定停在 255 或接近 255。
        const hist = new Int32Array(256);
        for (let i = 0; i < src.length; i += 4) {
            hist[Math.min(255, Math.round((src[i] + src[i + 1] + src[i + 2]) / 3))]++;
        }
        let acc = 0, bg = 255;
        const target = (src.length / 4) * 0.2;
        for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= target) { bg = v; break; } }
        // 只有近白底（bg≥240）才用"直接并入背景"覆盖粗字中心：
        // 渐变/彩色底时保留原来的"膨胀+抬升"，否则整块渐变会被刷成一块白（用户明确否过单色填充）。
        const bgStrong = bg >= 240;
        for (let i = 0; i < d.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                let v = cur[i + c];
                if (bgStrong && v < bg - 10) v = bg;                        // 白底粗字残块 → 直接并入背景
                else if (v < 210) v = Math.min(255, v + (210 - v) * 0.75);   // 渐变底：只抬升暗部
                d[i + c] = v;
            }
        }
        // 3x3 均值轻模糊，消除膨胀后的硬边
        const tmp = new Uint8ClampedArray(d);
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const o = (yy * w + xx) * 4;
                for (let c = 0; c < 3; c++) {
                    let sum = 0, cnt = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        const Y = yy + dy < 0 ? 0 : (yy + dy >= h ? h - 1 : yy + dy);
                        for (let dx = -1; dx <= 1; dx++) {
                            const X = xx + dx < 0 ? 0 : (xx + dx >= w ? w - 1 : xx + dx);
                            sum += tmp[(Y * w + X) * 4 + c]; cnt++;
                        }
                    }
                    d[o + c] = sum / cnt;
                }
            }
        }
        // 边缘羽化：补丁是矩形，硬边会盖出"方角"（用户截图里的方块痕迹）。
        // 中心不透明，最外 feather px 线性过渡到透明；渲染时去掉白底，让补丁与气泡底色自然融合。
        const feather = Math.max(2, Math.min(6, Math.floor(pad * 0.9)));
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const dd = Math.min(xx, yy, w - 1 - xx, h - 1 - yy);
                const a = dd >= feather ? 255 : Math.round(255 * (dd + 1) / (feather + 1));
                d[(yy * w + xx) * 4 + 3] = a;
            }
        }
        ctx.putImageData(img, 0, 0);
        return { url: canvas.toDataURL('image/png'), box: { x: x, y: y, w: w, h: h } };
    }

    // 在 ocrOne 释放 bitmap 之前调用：只给「会落译文」的块做补丁（拟声词/噪声/网址不擦）
    function buildErasePatches(bitmap, blocks) {
        if (!apiConfig.eraseOriginal || !bitmap || !blocks || !blocks.length) return;
        for (const b of blocks) {
            if (b.patch) continue;
            if (isSfx(b.originalText) || isNoiseText(b.originalText) || isUrlLike(b.originalText)) continue;
            if (!(b.w > 2 && b.h > 2)) continue;
            try {
                const r = makeErasePatch(bitmap, b);
                if (r) { b.patch = r.url; b.patchBox = r.box; }
            } catch (e) { /* 跨域污染/内存不足：静默降级回白底 */ }
        }
    }

    // OCR 乱读：源语言是英文时，台词里出现中日韩文字基本必是误读（气泡颈部曲线、装饰线、水印）。
    // 注意：不能对日文源用"汉字+假名混杂"规则 —— 日文本身就是汉字+假名，会把正常台词全丢掉。
    function isCjkForSource(text) {
        if (apiConfig.sourceLang !== 'eng') return false;
        return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(text || ''));
    }

    // 孤立小块：气泡颈部/边缘线被误识别的典型形态（框很小 + 文本很短）；白名单短词不误杀。
    function isTinyFragment(b) {
        const t = String(b.originalText || '').replace(/\s+/g, '');
        if (!t) return true;
        if (t.length > 6) return false;
        if (SHORT_KEEP.has(t.toUpperCase())) return false;
        return (b.w < 40 || b.h < 26);
    }

    function finalizeBlocks(blocks, W, H, bitmap) {
        if (!blocks || !blocks.length) return { blocks: [], width: W, height: H };
        // #6 先按「气泡」分组：同一气泡里的多行合成为一个翻译单元；无气泡页返回 null
        let grouped = null;
        if (bitmap) {
            try { grouped = groupByBubbles(blocks, bitmap, W, H); }
            catch (e) { addLog('气泡', '气泡检测失败，回退行合并: ' + (e && e.message || e), 'warn'); }
        }
        // 不在任何气泡内的孤立小块：多半是气泡颈部/装饰线误识别，合并前先剔掉（7.42）
        if (grouped) {
            grouped = grouped.filter(b => {
                if (b._orphan && isTinyFragment(b)) {
                    addLog('过滤', '丢弃气泡外小块: ' + String(b.originalText).slice(0, 20));
                    return false;
                }
                return true;
            });
        }
        // 未归属块再由 mergeBlocks 兜底；气泡单元带 bubbleUnit 标记，不会被拆开/吞并
        const merged = mergeBlocks(grouped || blocks, true);
        const kept = [];
        for (const b of merged) {
            if (isSfx(b.originalText)) continue;
            if (isNoiseText(b.originalText)) { addLog('过滤', '丢弃疑似噪声碎片: ' + String(b.originalText).slice(0, 24)); continue; }
            // 英文源却出现中日韩文字：气泡曲线/装饰被 OCR 读成字（7.42）
            if (isCjkForSource(b.originalText)) { addLog('过滤', '丢弃乱读文字: ' + String(b.originalText).slice(0, 24)); continue; }
            // 小块 + 短文本：气泡颈部误读（7.42）
            if (isTinyFragment(b)) { addLog('过滤', '丢弃微小碎片: ' + String(b.originalText).slice(0, 20) + ' ' + Math.round(b.w) + 'x' + Math.round(b.h)); continue; }
            if (isUrlLike(b.originalText)) { addLog('过滤', '丢弃网址水印: ' + String(b.originalText).slice(0, 40)); continue; }
            kept.push(b);
        }
        return { blocks: kept, width: W, height: H };
    }

    function mergeBlocks(blocks, relax) {
        if (!blocks || blocks.length < 2) return blocks;
        const sorted = blocks.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
        const groups = [];
        for (const b of sorted) {
            const lineH = Math.max(b.h, 1);
            // 气泡单元是「一句一框」的成品，直接独立成组，不参与合并（#6）
            if (b.bubbleUnit) {
                groups.push({ texts: [b.originalText], x: b.x, y: b.y, w: b.w, h: b.h, avgH: b.h, bubbleUnit: true });
                continue;
            }
            let target = null;
            for (const g of groups) {
                if (g.bubbleUnit) continue;
                // 高度差异太大（如大字拟声词 vs 正文小字）不合并，避免拟声词把长句吞掉
                const hRatio = Math.max(b.h, g.avgH) / Math.max(1, Math.min(b.h, g.avgH));
                if (hRatio > 1.8) continue;
                // ① 同一行被切成左右两块：垂直高度重叠 + 水平间隙小 → 合并。
                // 旧版只按 y-gap 判断，行内碎片 gap ≈ -行高 会被 -maxGap 直接拒掉，永远合不上。
                const overlapY = Math.min(b.y + b.h, g.y + g.h) - Math.max(b.y, g.y);
                if (overlapY > Math.min(lineH, g.avgH) * 0.5) {
                    const hGap = Math.max(0, Math.max(b.x, g.x) - Math.min(b.x + b.w, g.x + g.w));
                    if (hGap < Math.max(lineH, g.avgH) * 1.5) { target = g; break; }
                }
                // ② 上下相邻行：行距放宽到 max(10, 行高*1.2)，否则大行距/斜体字永远合并不上
                const gap = b.y - (g.y + g.h);
                const maxGap = relax ? Math.max(10, Math.max(lineH, g.avgH) * 1.2) : Math.max(6, lineH * 0.6);
                if (gap > maxGap || gap < -maxGap) continue;
                const overlapX = Math.min(b.x + b.w, g.x + g.w) - Math.max(b.x, g.x);
                const minW = Math.min(b.w, g.w);
                if (overlapX > Math.min(minW * 0.5, 40)) { target = g; break; }
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
            x: g.x, y: g.y, w: g.w, h: g.h,
            bubbleUnit: !!g.bubbleUnit
        }));
    }

    function joinLines(texts) {
        const sep = apiConfig.sourceLang === 'jpn' ? '' : ' ';
        return texts.join(sep);
    }

    // detectStyle（逐块采样字色/底色）已删除：overlayBubbles 只用纯白底黑字，那两个字段从未被读取，
    // 白付每块一次 canvas 创建 + getImageData 的同步光栅化代价。将来要做「按原图风格上色」时再实现。

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
                headers: apiConfig.localOcrToken
                    ? { 'Content-Type': 'application/json', 'X-OCR-Token': apiConfig.localOcrToken }
                    : { 'Content-Type': 'application/json' },
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
            const done = batch.filter(b => b.chineseText).length;
            transDone += done;
            if (done < batch.length) {
                addLog('翻译', '⚠️ 本批 ' + (batch.length - done) + '/' + batch.length + ' 段未译出（进度按已译出计）', 'error');
            }
            updateProgress();
        }).catch(e => {
            console.warn('[manga] 翻译失败', e);
            // 整批失败时不再把 batch.length 计入 transDone：旧实现会让进度条假装走到 100%，
            // 屏幕上却是一整批空白气泡，用户没有任何可感知的报错。
            addLog('翻译', '❌ 批次失败（' + batch.length + ' 段）: ' + (e && e.message || e), 'error');
            updateProgress();
        })));
    }

    // 只有官方 DeepSeek 接口才关思考：第三方平台托管的 deepseek 模型不认 thinking 字段，
    // 硬塞 { thinking: {type:'disabled'} } 可能直接被拒（400）。旧实现只看模型名，会误伤这些平台。
    function isThinkingModel(model) {
        if (!/deepseek/i.test(model || '')) return false;
        try {
            return /(^|\.)deepseek\.com$/i.test(new URL(apiConfig.aiUrl).hostname);
        } catch (e) {
            return false;
        }
    }

    function callLLM(content, key) {
        return new Promise((resolve, reject) => {
            const body = { model: apiConfig.aiModel, temperature: 0.2, stream: false, messages: [{ role: 'user', content: content }] };
            // 思考开关（#3，默认关）：只对 DeepSeek 官方域下发 thinking 字段，避免其他厂商接口收到未知字段报错。
            // 关闭时保持原来的 disabled 行为，绝不改成默认 enabled（会白烧推理 token / 超时 / finish_reason=length）。
            if (isThinkingModel(apiConfig.aiModel)) {
                body.thinking = { type: apiConfig.thinkingEnabled ? 'enabled' : 'disabled' };
            }
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

    // 解析「每行以 #[n] 开头」的批量译文，返回 序号 → 译文 的 Map。
    // 两轮：先认带 # 的严格格式；一条都没认到时，才退回 "3. 译文" 这种模型漏写 # 的写法。
    // 不能一上来就吃纯数字行 —— 原文 "3 days later" 翻译成 "3 天后" 会被误认为第 3 条，污染对齐。
    function parseNumberedLines(text) {
        const raw = String(text || '').replace(/```[a-z]*/gi, '').split(/\r?\n/);
        const strict = new Map(), loose = new Map();
        for (const line of raw) {
            const l = line.trim();
            if (!l) continue;
            let m = l.match(/^#\s*\[?(\d{1,4})\]?\s*[.、:：)）]?\s*(.+)$/);
            if (m) {
                const n = parseInt(m[1], 10), t = m[2].trim();
                if (n > 0 && t && !strict.has(n)) strict.set(n, t);
                continue;
            }
            m = l.match(/^(\d{1,4})\s*[.、:：)）]\s*(.+)$/);
            if (m) {
                const n = parseInt(m[1], 10), t = m[2].trim();
                if (n > 0 && t && !loose.has(n)) loose.set(n, t);
            }
        }
        if (strict.size) return strict;
        return loose.size ? loose : null;
    }

    /* ---------------- #5 跨图上下文：术语表 + 滑动窗口 + 自动词条 ---------------- */

    // 漫画系列 key：同站同路径前两段视为同一部漫画（章节翻页通常只变后面几段）
    function seriesKey() {
        try {
            const parts = location.pathname.split('/').filter(Boolean);
            return location.hostname + '/' + parts.slice(0, 2).join('/');
        } catch (e) { return location.hostname || 'unknown'; }
    }

    function saveCtxMemory() {
        try {
            const saved = GM_getValue('ai_api_config', {}) || {};
            saved.ctxMemory = apiConfig.ctxMemory || {};
            saved.autoGlossaryStore = apiConfig.autoGlossaryStore || {};
            GM_setValue('ai_api_config', saved);
        } catch (e) { }
    }

    function pushCtxMemory(text, cn) {
        if (!text || !cn) return;
        if (!apiConfig.ctxMemory) apiConfig.ctxMemory = {};
        const k = seriesKey();
        const bucket = apiConfig.ctxMemory[k] || (apiConfig.ctxMemory[k] = []);
        bucket.push({ text: String(text).slice(0, 1500), cn: String(cn).slice(0, 1500) });
        while (bucket.length > 6) bucket.shift();   // 只留最近 6 批，够滑动窗口用
        saveCtxMemory();
    }

    // 手工术语表 + 自动记忆：拼成一段注入 prompt
    function buildGlossarySnippet() {
        const lines = [];
        String(apiConfig.glossary || '').split(/\r?\n/).forEach(l => {
            const m = l.trim().match(/^(.{1,80}?)\s*[=＝:：]\s*(.{1,80})$/);
            if (m) lines.push(m[1].trim() + ' → ' + m[2].trim());
        });
        if (apiConfig.autoGlossary) {
            const store = apiConfig.autoGlossaryStore || {};
            Object.keys(store).slice(-60).forEach(k => lines.push(k + ' → ' + store[k]));
        }
        if (!lines.length) return '';
        return '【术语表】以下专有名词必须沿用给定译名，不要另起译法：\n' + lines.slice(0, 80).join('\n') + '\n';
    }

    // 最近 N 页的原文+译文，帮助模型保持人名/称呼/语气一致
    function buildContextSnippet() {
        const n = Math.max(0, Math.min(3, parseInt(apiConfig.contextPages, 10) || 0));
        if (!n) return '';
        const bucket = (apiConfig.ctxMemory || {})[seriesKey()];
        if (!bucket || !bucket.length) return '';
        const recent = bucket.slice(-n);
        return '【参考上下文】以下是同一部漫画前几页的原文与译文，仅用于保持人名、称呼、语气一致；'
            + '不要翻译它们、不要复述输出它们：\n'
            + recent.map(x => '原文：' + String(x.text || '').slice(0, 400) + '\n译文：' + String(x.cn || '').slice(0, 400)).join('\n') + '\n';
    }

    // 自动词条（可选）：翻完一批后异步提取「人名=译名」，独立请求窗口，不走 pools.ll（会自锁）
    let glossInflight = false;
    let glossLastTs = 0;
    function maybeExtractGlossary(srcText, cnText) {
        if (!apiConfig.autoGlossary || glossInflight) return;
        if (Date.now() - glossLastTs < 30000) return;   // 节流：最多 30s 一次，避免拖慢主流程
        if (!srcText || !cnText || cnText.length < 2) return;
        glossInflight = true;
        glossLastTs = Date.now();
        callLLM('从下面原文与译文中提取人名、称号、专有名词及其对应的中文译名，每行一条「原文=译名」，'
            + '只输出这些行，没有就输出 NONE。不要解释。\n原文：' + String(srcText).slice(0, 1200)
            + '\n译文：' + String(cnText).slice(0, 1200), apiConfig.aiKey)
            .then(reply => {
                const store = apiConfig.autoGlossaryStore || (apiConfig.autoGlossaryStore = {});
                let added = 0;
                String(reply || '').split(/\r?\n/).forEach(l => {
                    const m = l.trim().match(/^(.{1,60}?)\s*[=＝:：]\s*(.{1,40})$/);
                    if (!m) return;
                    const k = m[1].trim(), v = m[2].trim();
                    if (!/[\u4e00-\u9fff]/.test(v)) return;   // 译名必须是中文
                    if (store[k] === v) return;
                    store[k] = v; added++;
                });
                const keys = Object.keys(store);
                if (keys.length > 120) keys.slice(0, keys.length - 120).forEach(k => delete store[k]);
                if (added) { saveCtxMemory(); addLog('术语', '自动记住 ' + added + ' 个译名'); }
            })
            .catch(() => { })
            .finally(() => { glossInflight = false; });
    }

    async function translateBlocks(blocks) {
        const t0 = Date.now();
        addLog('翻译', '开始 ' + blocks.length + ' 段');
        const langName = sourceMap[apiConfig.sourceLang].name;

        // 结构化对齐：每段带 #[n] 序号，回来按序号回填。
        // 旧方案是「|| 拼接 → 按顺序填空」：模型只要少返/多返一句，丢失点之后所有译文整体错位一格，
        // 每句都翻对了却贴进错误的气泡，比翻错更难察觉；台词本身含 || 时对齐必然崩。
        const numbered = blocks.map((b, i) => '#' + (i + 1) + ' ' + b.originalText).join('\n');
        const glossary = buildGlossarySnippet();
        const context = buildContextSnippet();
        // #5 上下文注入位置：规则之后、输出格式之前（输出格式必须紧邻台词，编号对齐才稳）
        const prompt = '你是漫画翻译引擎。下面每一行台词都以 #[序号] 开头，把每一行翻译成中文。'
            + '规则：无论原文是' + langName + '、日文还是英文，都必须翻译成中文（例如 Thank you → 谢谢，绝对不要输出英文或原文）。'
            + (glossary ? glossary : '')
            + (context ? context : '')
            + '输出格式：一行一条，每行以同样的 #[序号] 开头，后跟中文译文；序号必须与输入一一对应，'
            + '不要合并、不要遗漏、不要加解释、不要复述原文：\n' + numbered;

        let miss = 0;
        let sawRefusal = false;
        try {
            const reply = await callLLM(prompt, apiConfig.aiKey);
            const map = parseNumberedLines(reply);
            if (map) {
                blocks.forEach((b, i) => {
                    const t = map.get(i + 1);
                    // 只接受真正的中文：模型把英文原样吐回来时宁可当缺失，交给逐条补翻。
                    // #1 拒答/解释文案（"不是一句完整的话…"）不能当译文，识别出来直接判失败。
                    if (t && isRefusal(t)) { b.chineseText = ''; b.failed = true; sawRefusal = true; return; }
                    b.chineseText = (t && /[\u4e00-\u9fff]/.test(t)) ? t : '';
                });
                const filled = blocks.filter(b => b.chineseText).length;
                if (filled < blocks.length) addLog('翻译', '编号回填 ' + filled + '/' + blocks.length, 'warn');
            } else {
                blocks.forEach(b => { b.chineseText = ''; });
                addLog('翻译', '编号格式解析失败，改为逐条补翻', 'warn');
            }
        } catch (e) {
            blocks.forEach(b => { b.chineseText = ''; });
            addLog('翻译', '批量翻译失败，改为逐条补翻: ' + (e && e.message || e), 'warn');
        }
        if (sawRefusal) addLog('翻译', '识别到拒答文案，已排除（不落板）', 'warn');

        // 缺的逐条补翻，最多两轮。这里不能走 pools.ll：translateBlocks 本身已经占着 ll 池的槽位，
        // 再向同一个池申请会自锁。改用独立的小并发窗口（mapLimit）。
        miss = blocks.filter(b => !b.chineseText).length;
        for (let round = 0; round < 2 && miss > 0; round++) {
            // 已被判为拒答（b.failed）的块不再重试：再问一次大概率还是拒答，白费 1~2 次 API 往返
            const todo = blocks.filter(b => !b.chineseText && !b.failed);
            const got = await mapLimit(todo, 3, async b => {
                try {
                    const r = await callLLM('把这句话翻译成中文，只返回中文译文，不要解释、不要输出英文：' + b.originalText, apiConfig.aiKey);
                    const t = (r || '').trim();
                    if (t && isRefusal(t)) { b.failed = true; return 0; }   // #1 拒答文案不落板
                    if (t && /[\u4e00-\u9fff]/.test(t)) { b.chineseText = t; return 1; }
                } catch (e) { }
                return 0;
            });
            const fixed = got.reduce((a, b) => a + b, 0);
            miss = blocks.filter(b => !b.chineseText).length;
            if (fixed) addLog('翻译', '补翻 ' + fixed + ' 条（第 ' + (round + 1) + ' 轮）');
            if (!fixed) break;
        }
        if (miss) addLog('翻译', '仍有 ' + miss + '/' + blocks.length + ' 段未译出，将显示为空', 'error');

        // #5 记下本批「原文 / 译文」作为后续页的参考上下文；异步提取词条（不阻塞出图）
        const okBlocks = blocks.filter(b => b.originalText && b.chineseText);
        if (okBlocks.length) {
            pushCtxMemory(okBlocks.map(b => b.originalText).join(' / '), okBlocks.map(b => b.chineseText).join(' / '));
            const srcAll = okBlocks.map(b => b.originalText).join('\n');
            maybeExtractGlossary(srcAll, okBlocks[0].chineseText);
        }
        addLog('翻译', '完成 ' + (Date.now() - t0) + 'ms');
        return blocks;
    }

    /* ---------------- 气泡覆盖 ---------------- */

    // 清掉页面上所有气泡，并把图片从 .mt-shell 外壳里挪回原位（避免外壳残留影响页面布局）
    function clearBubbles() {
        document.querySelectorAll('.mt-bubble').forEach(b => b.remove());
        document.querySelectorAll('.mt-shell').forEach(w => {
            const parent = w.parentNode;
            if (!parent) return;
            while (w.firstChild) parent.insertBefore(w.firstChild, w);
            w.remove();
        });
    }

    function overlayBubbles(img, blocks, refW, refH) {
        // 先用图片【实际渲染尺寸】做像素换算：比百分比更稳，杜绝气泡被放大好几倍的问题。
        // 图还没渲染（宽高为 0，例如 display:none / 尚未插入文档）时不能拿 refW 兜底：
        // 那会让 sx=1，气泡按 OCR 原始像素画在已缩放的图上，整页系统性偏移。
        // 宁可这次不画（提示稍后重跑），也不要画错位、更不要先给 img 套一层空壳。
        let rect = null;
        try { rect = img.getBoundingClientRect(); } catch (e) { }
        const dispW = rect ? rect.width : 0;
        const dispH = rect ? rect.height : 0;
        if (!dispW || !dispH || !refW || !refH) {
            addLog('气泡', '图片尚未渲染，跳过覆盖（图片可见后重跑即可）', 'warn');
            return;
        }
        const sx = dispW / refW;
        const sy = dispH / refH;

        const parent = img.parentNode;
        let wrapper = parent;
        if (!wrapper.classList.contains('mt-shell')) {
            wrapper = document.createElement('div');
            wrapper.className = 'mt-shell';
            wrapper.style.cssText = 'position:relative;display:inline-block;max-width:100%;vertical-align:top;line-height:0;';
            parent.insertBefore(wrapper, img);
            wrapper.appendChild(img);
        }

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
            // #4 擦除模式：用 ocrOne 生成的「克隆底」补丁做背景，位置/尺寸严格对齐补丁裁剪框，
            // 不参与气泡缩放（补丁是原图像素，缩放会错位）。生成失败时这里自动走下面的纯白底。
            const usePatch = !!(apiConfig.eraseOriginal && b.patch && b.patchBox);
            let L, T, W, minH, maxH, bgCss;
            if (usePatch) {
                const pb = b.patchBox;
                L = Math.max(0, Math.round(pb.x * sx));
                T = Math.max(0, Math.round(pb.y * sy));
                W = Math.max(1, Math.round(pb.w * sx));
                minH = Math.max(1, Math.round(pb.h * sy));
                maxH = Math.max(minH, Math.round(pb.h * sy * 2.2));
                bgCss = 'background:transparent url("' + b.patch + '") center/100% 100% no-repeat;';
            } else {
                const cx = (b.x + b.w / 2) * sx;
                const cy = (b.y + b.h / 2) * sy;
                W = Math.round((b.w * sx + PAD * 2) * bscale);
                minH = Math.round((b.h * sy + PAD * 2) * bscale);
                // 译文最长允许到原文框约 2.2 倍高，超了自动缩字号，避免白框盖住画面
                maxH = Math.max(minH, Math.round((b.h * sy * 2.2 + PAD * 2) * bscale));
                L = Math.max(0, Math.round(cx - W / 2));
                T = Math.max(0, Math.round(cy - minH / 2));
                W = Math.max(1, Math.min(W, dispW - L));
                bgCss = 'background:#ffffff;';
            }
            // 纯白底/克隆底 + 居中译文：框体紧贴原文框，彻底遮住原文
            div.style.cssText = 'position:absolute;left:' + L + 'px;top:' + T + 'px;width:' + W + 'px;min-height:' + minH + 'px;max-height:' + maxH + 'px;'
                + bgCss + 'color:#000;'
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
