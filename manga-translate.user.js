// ==UserScript==
// @name         漫画翻译引擎
// @namespace    https://github.com/nihao8602/86-
// @version      7.42.0
// @description  提速版：全局并发池+OCR限速器 · 分块OCR并行(90px重叠) · 下载/OCR/翻译流水线 · 快重试+超时 · 纯白底气泡完全遮盖原文 · 擦除原文(克隆底+边缘羽化/主色填充/模型擦除)开关 · 气泡按像素紧贴原文框 · 翻译引擎预设(混元/硅基流动/智谱GLM) · 拟声词跳过 · 详细日志 · 合并更保守 · 英文强制重翻 · 处理顺序可选 · 手机极速模式 · 设备选择 · 手机直发原图 · 气泡底缩放 · DeepSeek 全系默认关闭思考 · 思考模式开关 · 面板默认最小化/全折叠 · 气泡级分组(一句一框，按文字块区域检测) · 菱形/四角不被并成一句 · 同行碎片不错误锁定 · 网址水印过滤 · OCR乱读碎片过滤 · 术语表+上下文记忆 · 人名自动音译 · 面板三页签(开始/设置/日志) · 章节进度看板(取图/OCR/翻译) ·【7.52】内置 YOLO+Tesseract 免部署 OCR 引擎(可一键下载模型) · 漫画排版引擎(字号自适应/中英混排断行/避头尾/孤字行合并) · Canvas 整图重绘渲染 · 主色反衬配色
// @author       百事比可口好喝
// @match        *://*/*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
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
        // 迁移优先：旧配置里 ocrEngine==='builtin' 说明用户正在用内置引擎，
        // 这时即使 ocrMode 还留着 'local' 也要切到 builtin，否则合并后他会发现选项变了但行为没变。
        ocrMode: (savedConfig.ocrEngine === 'builtin' ? 'builtin' : null) || savedConfig.ocrMode || 'baidu',
        ocrspaceKey: savedConfig.ocrspaceKey || '',
        baiduProxyUrl: savedConfig.baiduProxyUrl || '',
        baiduToken: savedConfig.baiduToken || '',
        baiduPrecision: savedConfig.baiduPrecision || 'general',
        processMode: savedConfig.processMode || 'wave',
        processOrder: savedConfig.processOrder || 'fast',
        waveSize: savedConfig.waveSize || 5,
        ocrRps: savedConfig.ocrRps === undefined ? 3 : savedConfig.ocrRps,
        ocrChunkHi: savedConfig.ocrChunkHi === undefined ? true : !!savedConfig.ocrChunkHi,   // 高清分块 OCR（local 模式 1000px/块）
        localOcrUrl: savedConfig.localOcrUrl || 'http://127.0.0.1:8000/ocr',
        localOcrToken: savedConfig.localOcrToken || '',   // 服务端设了 OCR_TOKEN 才需要填，留空=不带令牌
        panelZoom: savedConfig.panelZoom || '100',
        fastMode: savedConfig.fastMode === undefined ? false : !!savedConfig.fastMode,
        deviceMode: savedConfig.deviceMode || 'auto',
        bubbleScale: savedConfig.bubbleScale || '100',
        // ── 7.52 新增 ──
        // 旧版把「识别服务」「识别引擎」拆成两个字段，现在合并成一个 ocrMode；
        // 老用户 ocrEngine==='builtin' 自动迁移成 ocrMode==='builtin'。
        builtinLang: savedConfig.builtinLang || 'eng',               // 内置识别语言包（Tesseract）
        // 默认走 jsdelivr：GitHub 仓库托管 base64 模型，免费不限量，不占自己服务器流量。
        // 老配置里如果是自建地址，自动迁移（自建的会烧服务器流量）。
        builtinModelBase: (function () {
            const v = savedConfig.builtinModelBase;
            const GH = 'https://raw.githubusercontent.com/nihao8602/86-/main/models';
            if (!v) return GH;
            // 老配置里的自建地址会烧自己服务器流量，自动迁到 GitHub
            if (v.indexOf('cdn.860286.xyz/userscript/models') >= 0) return GH;
            if (v.indexOf('cdn.jsdelivr.net/gh/nihao8602') >= 0) return GH;
            return v;
        })(),
        eraseMode: savedConfig.eraseMode || 'filter',                // filter = 本地像素滤波（旧）；dominant = 框内主色填充；model = 模型擦除（需外部服务）
        eraseServiceUrl: savedConfig.eraseServiceUrl || '',          // 模型擦除服务地址（POST 图片+mask）
        renderMode: savedConfig.renderMode || 'dom',                 // dom = 现有 DOM 气泡叠加；canvas = 整图 Canvas 重绘
        typesetAutoSize: savedConfig.typesetAutoSize === undefined ? true : !!savedConfig.typesetAutoSize,  // 字号自适应（按框面积算）
        typesetAvoidPunct: savedConfig.typesetAvoidPunct === undefined ? true : !!savedConfig.typesetAvoidPunct, // 避标点行首 + 孤字行合并
        autoContrast: savedConfig.autoContrast === undefined ? true : !!savedConfig.autoContrast,           // 按框内主色自动反衬文字色
        modelsReady: savedConfig.modelsReady || {}                   // 已下载模型记录 { best: true, 'preprocess-yolo': true }
    };
    const OCR_MODES = ['builtin', 'local', 'baidu', 'baidu-direct', 'ocrspace'];
    if (!OCR_MODES.includes(apiConfig.ocrMode)) apiConfig.ocrMode = 'local';

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

    // 本地英文 OCR 的分块上限（关闭「高清分块 OCR」时使用）：PaddleOCR 会把过高的切片内部缩放到 ~960px 高，
    // 字被压小后整行漏识别。实测 720 宽长条图：2400px 切片漏掉 "I SENT YOU THE LINK OVER" 等整句；
    // 1000px 切片全部识别（只会切成更多块，交给 mergeBlocks 合并）。高清开关打开时 local 用 1000。
    const CAP_MAX_DIM = { baidu: 3000, 'baidu-direct': 3000, ocrspace: 1400, local: 2400 };

    // ── 7.52 内置 OCR 引擎（YOLO 检测 + Tesseract 识别，纯前端 WASM，不需要本地部署）──
    // 内置引擎用到的两套运行时：onnxruntime-web（YOLO 推理）+ tesseract.js（文字识别）
    const RUNTIME_CDN = {
        ort: ['https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js',
              'https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.min.js'],
        ortWasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/',
        tess: ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
               'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'],
        tessWorker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
        tessCore: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js',
        tessLang: 'https://tessdata.projectnaptha.com/4.0.0'
    };
    // 检测模型（来自沉浸式翻译公开 CDN，无鉴权）：best = YOLO 文字框检测，preprocess-yolo = letterbox 预处理
    const BUILTIN_MODELS = ['preprocess-yolo', 'best'];
    const YOLO_INPUT = [1, 3, 640, 640];
    // 排障用：想确认 YOLO 到底圈了多大、Tesseract 有没有给出行级坐标，把它改成 true
    const MT_DEBUG_OCR = false;
    const YOLO_CONF = 0.2;
    const YOLO_NMS = 0.45;
    // Tesseract 语言包：漫画常见源语言
    const OCR_MODE_NAMES = {
        builtin: '内置轻量OCR',
        local: '本地PaddleOCR',
        baidu: '百度OCR(代理)',
        'baidu-direct': '百度OCR(直连)',
        ocrspace: 'ocr.space'
    };
    const TESS_LANGS = {
        eng: { name: '英文', code: 'eng' },
        jpn: { name: '日文', code: 'jpn' },
        kor: { name: '韩文', code: 'kor' },
        chi_sim: { name: '中文简体', code: 'chi_sim' },
        chi_tra: { name: '中文繁体', code: 'chi_tra' },
        eng_jpn: { name: '英文+日文', code: 'eng+jpn' }
    };
    if (!TESS_LANGS[apiConfig.builtinLang]) apiConfig.builtinLang = 'eng';
    const ERASE_MODES = ['filter', 'dominant', 'model'];
    if (!ERASE_MODES.includes(apiConfig.eraseMode)) apiConfig.eraseMode = 'filter';
    const RENDER_MODES = ['dom', 'canvas'];
    if (!RENDER_MODES.includes(apiConfig.renderMode)) apiConfig.renderMode = 'dom';

    const JPEG_QUALITY = 0.87;
    const LLM_BATCH_SIZE = 60;
    const LLM_BATCH_CHARS = 7600;
    const LLM_RETRY_BATCH_SIZE = 20;
    const WAVE_SIZE = 5;
    const TIMEOUT_IMG = 20000;   // 取图超时 20s
    const TIMEOUT_OCR = 60000;   // OCR 超时 60s
    const TIMEOUT_LLM = 120000;  // 大模型超时 120s

    let running = false;
    let stopRequested = false;
    // 任务编号：stop 之后立刻再点开始，旧任务还在路上的回调必须能被识别并丢弃，
    // 否则它会继续请求、覆盖新任务的图片，甚至在 finally 里把新任务一起停掉。
    let taskSeq = 0;
    let activeTask = 0;
    function newTask() { activeTask = ++taskSeq; return activeTask; }
    function taskAlive(id) { return id !== 0 && id === activeTask; }
    // 渲染世代：点「清除气泡」时 ++，在途的异步渲染看到世代变了就不再写回图片
    let renderEpoch = 0;
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
        const detail = $('mt-status-detail');
        if (detail) detail.textContent = text;
        refreshPanelUI();
    }

    function refreshPanelUI() {
        const panel = $('manga-ai-panel');
        if (!panel) return;
        const translator = $('mt-translator');
        const language = $('mt-source-lang');
        const ocr = $('mt-ocr-mode');
        if (translator && $('mt-overview-translator')) $('mt-overview-translator').textContent = translator.selectedOptions[0]?.textContent || '自定义';
        if (language && $('mt-overview-language')) $('mt-overview-language').textContent = (sourceMap[language.value]?.name || '原文') + ' → 中文';
        if (ocr && $('mt-overview-ocr')) $('mt-overview-ocr').textContent = ocr.selectedOptions[0]?.textContent || 'OCR';
        const title = $('mt-status-title');
        const pill = $('mt-status-pill');
        if (title) title.textContent = running ? '正在翻译当前章节' : totalCount > 0 && doneCount >= totalCount ? '翻译完成' : totalCount > 0 ? '已停止' : '已就绪';
        if (pill) pill.textContent = running ? '运行中' : totalCount > 0 && doneCount >= totalCount ? '已完成' : totalCount > 0 ? '已停止' : '待启动';
        const progress = $('mt-progress');
        if (progress) progress.hidden = !running && totalCount === 0;
        const count = $('mt-progress-count');
        if (count) count.textContent = doneCount + ' / ' + totalCount + ' 张';
        const fill = $('mt-progress-fill');
        if (fill) fill.style.width = (totalCount ? Math.min(100, Math.round(doneCount / totalCount * 100)) : 0) + '%';
        if ($('mt-stage-download')) $('mt-stage-download').textContent = '取图 ' + dlDone + '/' + totalCount;
        if ($('mt-stage-ocr')) $('mt-stage-ocr').textContent = 'OCR ' + ocrDone + '/' + totalCount;
        if ($('mt-stage-trans')) $('mt-stage-trans').textContent = '翻译 ' + transDone + '/' + transTotal;
        panel.classList.toggle('mt-running', running);
        const mini = $('mt-mini');
        if (mini) mini.classList.toggle('mt-running', running);
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
        refreshPanelUI();
    }

    /* ---------------- UI（与原版一致，仅加 OCR 限速一项） ---------------- */

    // 兜底入口：小窗万一被页面浮层盖住 / 飘出视口，从 TM 菜单也能把面板叫回来
    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        const toggle = () => {
            const p = $('manga-ai-panel'), m = $('mt-mini');
            if (!p) { location.reload(); return; }
            if (p.style.display === 'none') {
                p.style.display = 'flex';
                if (m) m.style.display = 'none';
                try { GM_setValue('mt_minimized', false); } catch (e) { }
            } else {
                p.style.display = 'none';
                if (m) m.style.display = 'flex';
                try { GM_setValue('mt_minimized', true); } catch (e) { }
            }
        };
        try {
            GM_registerMenuCommand('显示 / 隐藏面板', toggle);
            GM_registerMenuCommand('把悬浮球归位到右下角', () => {
                const m = $('mt-mini'), p = $('manga-ai-panel');
                if (!m) return;
                m.style.display = 'flex';
                m.style.left = 'auto'; m.style.top = 'auto';
                m.style.right = '20px'; m.style.bottom = '20px';
                if (p) p.style.display = 'none';
                try { GM_setValue('mt_minimized', true); } catch (e) { }
            });
        } catch (e) { }
    }

    function createUI() {
        if ($('manga-ai-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'manga-ai-panel';
        panel.style.cssText = '';
        if (!$('mt-ui-style')) {
            const uiStyle = document.createElement('style');
            uiStyle.id = 'mt-ui-style';
            uiStyle.textContent = "\n#manga-ai-panel, #manga-ai-panel *, #mt-mini { box-sizing: border-box !important; font-family: system-ui, \"Microsoft YaHei\", \"PingFang SC\", sans-serif !important; }\n#manga-ai-panel { position: fixed !important; right: 18px; bottom: 18px; z-index: 999999; display: flex; flex-direction: column; width: min(380px, calc(100vw - 20px)); height: min(680px, calc(100dvh - 20px)); min-height: 360px; overflow: hidden; background: #fbfaf7; color: #292d32; border: 1px solid #dedbd4; border-radius: 22px; box-shadow: 0 22px 66px rgba(20, 28, 35, .28); font-size: 13px; line-height: 1.45; isolation: isolate; }\n#manga-ai-panel [hidden] { display: none !important; }\n#manga-ai-panel button, #manga-ai-panel input, #manga-ai-panel select, #manga-ai-panel textarea { font: inherit; }\n#manga-ai-panel button { cursor: pointer; }\n#manga-ai-panel #mt-header { display: flex; align-items: center; gap: 11px; flex: none; min-height: 77px; padding: 16px 19px; border-bottom: 1px solid #e3ded7; cursor: move; user-select: none; }\n#manga-ai-panel .mt-brand { width: 39px; height: 39px; flex: none; display: grid; place-items: center; border-radius: 12px; background: #b6534c; color: #fff; font-size: 21px; font-weight: 900; }\n#manga-ai-panel .mt-head-copy { flex: 1; min-width: 0; }\n#manga-ai-panel .mt-title { font-size: 16px; font-weight: 800; line-height: 1.25; }\n#manga-ai-panel .mt-subtitle { color: #777d83; font-size: 10px; margin-top: 4px; }\n#manga-ai-panel #mt-minimize { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border: 1px solid #dedbd4; border-radius: 9px; background: #fff; color: #777d83; font-size: 18px; line-height: 1; cursor: pointer; }\n#manga-ai-panel .mt-main-nav { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; flex: none; margin: 12px 19px 0; padding: 4px; border-radius: 12px; background: #f2f0ea; }\n#manga-ai-panel .mt-nav-btn, #manga-ai-panel .mt-subtab { border: 0; border-radius: 9px; background: transparent; color: #757b83; font-size: 12px; font-weight: 700; min-height: 34px; }\n#manga-ai-panel .mt-nav-btn[aria-selected=\"true\"], #manga-ai-panel .mt-subtab[aria-selected=\"true\"] { background: #fae8e4; color: #a9443e; }\n#manga-ai-panel #mt-content { flex: 1; min-height: 0; overflow: hidden; }\n#manga-ai-panel .mt-page { height: 100%; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #d5ccc3 transparent; padding: 16px 19px 18px; }\n#manga-ai-panel .mt-status-card { display: flex; justify-content: space-between; gap: 10px; padding: 13px 14px; border-radius: 13px; background: #f7ebe6; }\n#manga-ai-panel #mt-status-title { color: #a9443e; font-size: 13px; font-weight: 800; }\n#manga-ai-panel #mt-status-detail { max-width: 260px; margin-top: 4px; color: #777d83; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n#manga-ai-panel #mt-status-pill { align-self: flex-start; flex: none; padding: 4px 8px; border-radius: 99px; border: 1px solid #e4d7d0; background: #fff; color: #a9443e; font-size: 10px; font-weight: 700; }\n#manga-ai-panel .mt-progress { margin-top: 13px; padding: 12px 13px; background: #fff; border: 1px solid #e1ddd6; border-radius: 12px; }\n#manga-ai-panel .mt-progress-head { display: flex; justify-content: space-between; font-weight: 750; font-size: 11px; }\n#manga-ai-panel .mt-progress-track { height: 7px; margin: 10px 0; border-radius: 8px; background: #eee9e4; overflow: hidden; }\n#manga-ai-panel #mt-progress-fill { display: block; width: 0; height: 100%; border-radius: inherit; background: #b6534c; transition: width .25s ease; }\n#manga-ai-panel .mt-progress-stages { color: #777d83; font-size: 10px; line-height: 1.5; }\n#manga-ai-panel .mt-kicker { margin: 16px 2px 9px; color: #777d83; font-size: 11px; font-weight: 800; }\n#manga-ai-panel .mt-quick-card { width: 100%; min-height: 69px; display: flex; align-items: center; gap: 12px; margin-bottom: 9px; padding: 11px 14px; text-align: left; color: #292d32; border: 1px solid #e1ddd6; border-radius: 12px; background: #fff; }\n#manga-ai-panel .mt-quick-card:hover { border-color: #c9918a; background: #fffaf8; }\n#manga-ai-panel .mt-card-copy { flex: 1; min-width: 0; }\n#manga-ai-panel .mt-card-title { display: block; color: #777d83; font-size: 10px; }\n#manga-ai-panel .mt-card-value { display: block; margin-top: 3px; font-size: 14px; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n#manga-ai-panel .mt-card-chevron { color: #757b83; font-size: 19px; }\n#manga-ai-panel .mt-home-hint { margin: 14px 3px 0; color: #777d83; font-size: 10px; line-height: 1.5; }\n#manga-ai-panel .mt-settings-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 13px; }\n#manga-ai-panel .mt-settings-head strong { font-size: 16px; }\n#manga-ai-panel .mt-settings-head span { color: #777d83; font-size: 10px; }\n#manga-ai-panel .mt-subnav { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 15px; padding: 4px; border-radius: 11px; background: #f2f0ea; }\n#manga-ai-panel .mt-subtab { min-height: 32px; font-size: 11px; }\n#manga-ai-panel .mt-setting-page { display: none; flex-direction: column; gap: 9px; padding-bottom: 8px; }\n#manga-ai-panel .mt-setting-page.mt-active { display: flex; }\n#manga-ai-panel .mt-setting-page h3 { margin: 1px 0 4px; font-size: 14px; }\n#manga-ai-panel .mt-field-label { margin-top: 6px; color: #777d83; font-size: 11px; font-weight: 700; }\n#manga-ai-panel .mt-setting-page input:not([type=\"checkbox\"]):not([type=\"range\"]), #manga-ai-panel .mt-setting-page select, #manga-ai-panel .mt-setting-page textarea { width: 100%; min-width: 0; padding: 9px 11px; background: #fff; color: #292d32; border: 1px solid #dcd8d1; border-radius: 9px; outline: none; font-size: 12px; }\n#manga-ai-panel .mt-setting-page input:not([type=\"checkbox\"]):not([type=\"range\"]), #manga-ai-panel .mt-setting-page select { min-height: 38px; }\n#manga-ai-panel .mt-setting-page input:focus, #manga-ai-panel .mt-setting-page select:focus, #manga-ai-panel .mt-setting-page textarea:focus { border-color: #b6534c; box-shadow: 0 0 0 3px rgba(182,83,76,.13); }\n#manga-ai-panel .mt-setting-page textarea { resize: vertical; min-height: 70px; }\n#manga-ai-panel .mt-setting-page > div:not(.mt-field-label) { min-width: 0; }\n#manga-ai-panel #mt-sec-trans > div, #manga-ai-panel #mt-sec-proc > div, #manga-ai-panel #mt-sec-disp > div, #manga-ai-panel #mt-sec-ocr > div > div { display: flex; align-items: center; gap: 8px; }\n#manga-ai-panel #mt-sec-ocr > div { display: flex; flex-direction: column; gap: 9px; padding: 12px; border: 1px solid #e1ddd6; border-radius: 12px; background: #fff; }\n#manga-ai-panel #mt-sec-ocr > div > div[id$=\"-cfg\"] { flex-direction: column; align-items: stretch; }\n#manga-ai-panel #mt-sec-trans > div > select, #manga-ai-panel #mt-sec-trans > div > div, #manga-ai-panel #mt-sec-proc > div > select, #manga-ai-panel #mt-sec-disp > div > input[type=\"range\"] { flex: 1; }\n#manga-ai-panel #mt-sec-trans > div > div { padding: 9px; text-align: center; background: #f2f0ea; border: 1px solid #dcd8d1; border-radius: 9px; color: #777d83; }\n#manga-ai-panel .mt-setting-page label:has(input[type=\"checkbox\"]) { display: flex; align-items: flex-start; gap: 8px; color: #555c64; font-size: 11px; line-height: 1.45; cursor: pointer; }\n#manga-ai-panel input[type=\"checkbox\"], #manga-ai-panel input[type=\"range\"] { accent-color: #b6534c; }\n#manga-ai-panel input[type=\"checkbox\"] { flex: none; margin-top: 2px; }\n#manga-ai-panel #mt-sec-ocr [id$=\"-cfg\"] > div, #manga-ai-panel #mt-sec-ocr > div > div > span:last-child { color: #777d83; font-size: 10px; line-height: 1.4; }\n#manga-ai-panel #mt-wave-size-wrap { flex: none; width: 91px; }\n#manga-ai-panel #mt-wave-size-wrap input, #manga-ai-panel #mt-context-pages, #manga-ai-panel #mt-ocr-rps { width: 58px !important; flex: none; }\n#manga-ai-panel #mt-sec-disp > div { padding: 10px 11px; background: #fff; border: 1px solid #e1ddd6; border-radius: 10px; }\n#manga-ai-panel #mt-sec-disp > div > span { min-width: 106px; font-size: 11px; font-weight: 700; }\n#manga-ai-panel #mt-font-val, #manga-ai-panel #mt-bubble-scale-val, #manga-ai-panel #mt-zoom-val { color: #a9443e; }\n#manga-ai-panel .mt-log-actions { display: flex; gap: 8px; margin-bottom: 12px; }\n#manga-ai-panel .mt-log-actions button { flex: 1; min-height: 35px; border: 1px solid #dedbd4; border-radius: 9px; background: #fff; color: #555c64; font-size: 11px; font-weight: 700; }\n#manga-ai-panel #mt-log-view { display: block; height: min(370px, 52dvh); overflow: auto; padding: 11px; border: 1px solid #dedbd4; border-radius: 10px; background: #272a2e; color: #d8e8db; font-family: Consolas, monospace !important; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }\n#manga-ai-panel .mt-footer { flex: none; padding: 10px 19px 13px; border-top: 1px solid #e3ded7; background: #fbfaf7; }\n#manga-ai-panel .mt-utilities { display: flex; justify-content: space-between; gap: 5px; margin-bottom: 9px; }\n#manga-ai-panel .mt-utilities button { padding: 3px 6px; color: #6d737b; background: transparent; border: 0; border-radius: 7px; font-size: 10px; font-weight: 700; }\n#manga-ai-panel .mt-utilities button:hover { background: #f2f0ea; }\n#manga-ai-panel .mt-utilities #mt-save.mt-saved { color: #218553; }\n#manga-ai-panel #mt-toggle { width: 100%; min-height: 40px; background: #b6534c; color: #fff; border: 0; border-radius: 10px; font-size: 12px; font-weight: 800; box-shadow: 0 5px 14px rgba(182,83,76,.22); }\n#manga-ai-panel.mt-running #mt-toggle { background: #9d4b48; }\n#manga-ai-panel #mt-log { margin-top: 7px; min-height: 14px; color: #777d83; text-align: center; font-size: 10px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n#mt-mini { position: fixed; right: 20px; bottom: 20px; z-index: 999999; display: none; align-items: center; justify-content: center; width: 36px; height: 36px; border: 2px solid #fff; border-radius: 12px; z-index: 2147483647 !important; background: #b6534c; color: #fff; font-size: 16px; font-weight: 900; box-shadow: 0 4px 14px rgba(20,28,35,.3); cursor: grab; user-select: none; }\n#mt-mini.mt-running { background: #9d4b48; }\n#manga-ai-panel button:focus-visible, #mt-mini:focus-visible { outline: 3px solid rgba(182,83,76,.45); outline-offset: 2px; }\n@media (max-width: 450px) { #manga-ai-panel { right: 10px; bottom: 10px; width: calc(100vw - 20px); height: min(680px, calc(100dvh - 20px)); border-radius: 18px; } #manga-ai-panel .mt-page { padding: 12px 14px; } #manga-ai-panel .mt-footer { padding: 8px 14px 12px; } }\n";
            document.head.appendChild(uiStyle);
        }
        panel.innerHTML = "\n            <div id=\"mt-header\">\n                <span class=\"mt-brand\" aria-hidden=\"true\">译</span>\n                <div class=\"mt-head-copy\"><div class=\"mt-title\">漫画翻译引擎</div><div class=\"mt-subtitle\">识别与翻译当前章节</div></div>\n                <button id=\"mt-minimize\" type=\"button\" title=\"收起面板\" aria-label=\"收起面板\">—</button>\n            </div>\n            <nav class=\"mt-main-nav\" aria-label=\"主页面\">\n                <button type=\"button\" class=\"mt-nav-btn\" data-page=\"home\" aria-selected=\"true\">开始</button>\n                <button type=\"button\" class=\"mt-nav-btn\" data-page=\"settings\" aria-selected=\"false\">设置</button>\n                <button type=\"button\" class=\"mt-nav-btn\" data-page=\"log\" aria-selected=\"false\">日志</button>\n            </nav>\n            <div id=\"mt-content\">\n                <section class=\"mt-page\" id=\"mt-page-home\">\n                    <div class=\"mt-status-card\"><div><div id=\"mt-status-title\">已就绪</div><div id=\"mt-status-detail\">填好配置后即可开始识别</div></div><span id=\"mt-status-pill\">待启动</span></div>\n                    <div class=\"mt-progress\" id=\"mt-progress\" hidden><div class=\"mt-progress-head\"><span>当前章节</span><span id=\"mt-progress-count\">0 / 0 张</span></div><div class=\"mt-progress-track\"><span id=\"mt-progress-fill\"></span></div><div class=\"mt-progress-stages\"><span id=\"mt-stage-download\">取图 0/0</span>　·　<span id=\"mt-stage-ocr\">OCR 0/0</span>　·　<span id=\"mt-stage-trans\">翻译 0/0</span></div></div>\n                    <div class=\"mt-kicker\">常用选项</div>\n                    <button type=\"button\" class=\"mt-quick-card\" data-go-setting=\"trans\"><span class=\"mt-card-copy\"><span class=\"mt-card-title\">翻译服务</span><span class=\"mt-card-value\" id=\"mt-overview-translator\">DeepSeek 官方</span></span><span class=\"mt-card-chevron\">›</span></button>\n                    <button type=\"button\" class=\"mt-quick-card\" data-go-setting=\"trans\"><span class=\"mt-card-copy\"><span class=\"mt-card-title\">源语言</span><span class=\"mt-card-value\" id=\"mt-overview-language\">韩文 → 中文</span></span><span class=\"mt-card-chevron\">›</span></button>\n                    <button type=\"button\" class=\"mt-quick-card\" data-go-setting=\"ocr\"><span class=\"mt-card-copy\"><span class=\"mt-card-title\">文字识别</span><span class=\"mt-card-value\" id=\"mt-overview-ocr\">百度 OCR</span></span><span class=\"mt-card-chevron\">›</span></button>\n                    <p class=\"mt-home-hint\">模型、密钥、限速、处理方式和显示选项在设置页调整。</p>\n                </section>\n                <section class=\"mt-page\" id=\"mt-page-settings\" hidden>\n                    <div class=\"mt-settings-head\"><strong>设置</strong><span>按任务分组，一次只看一类</span></div>\n                    <nav class=\"mt-subnav\" aria-label=\"设置分类\">\n                        <button type=\"button\" class=\"mt-subtab\" data-setting=\"trans\" aria-selected=\"true\">翻译</button>\n                        <button type=\"button\" class=\"mt-subtab\" data-setting=\"ocr\" aria-selected=\"false\">OCR</button>\n                        <button type=\"button\" class=\"mt-subtab\" data-setting=\"proc\" aria-selected=\"false\">处理</button>\n                        <button type=\"button\" class=\"mt-subtab\" data-setting=\"disp\" aria-selected=\"false\">显示</button>\n                    </nav>\n                    <div class=\"mt-setting-page\" id=\"mt-sec-trans\">\n                <label class=\"mt-field-label\" for=\"mt-translator\">服务提供方</label><select id=\"mt-translator\">\n                    <option value=\"custom\">翻译引擎：自定义（手动填地址/模型）</option>\n                    <option value=\"ollama\">本地 Ollama（免费·离线）</option>\n                    <option value=\"deepseek\">DeepSeek 官方</option>\n                    <option value=\"hunyuan\">腾讯混元（免费额度）</option>\n                    <option value=\"siliconflow\">硅基流动（免费额度）</option>\n                    <option value=\"zhipu\">智谱 GLM（免费额度）</option>\n                </select>\n                <label class=\"mt-field-label\" for=\"mt-ai-url\">接口地址</label><input id=\"mt-ai-url\" type=\"text\" placeholder=\"大模型接口地址\">\n                <label class=\"mt-field-label\" for=\"mt-ai-model\">模型名称</label><input id=\"mt-ai-model\" type=\"text\" placeholder=\"模型名称（如 deepseek-chat）\">\n                <div>\n                    <select id=\"mt-source-lang\">\n                        <option value=\"kor\">韩文</option>\n                        <option value=\"eng\">英文</option>\n                        <option value=\"jpn\">日文</option>\n                    </select>\n                    <span>→</span>\n                    <div>中文</div>\n                </div>\n                <label class=\"mt-field-label\" for=\"mt-ai-key\">API Key</label><input id=\"mt-ai-key\" type=\"password\" placeholder=\"AI API Key（翻译用）\">\n                <label class=\"mt-field-label\" for=\"mt-glossary\">术语表</label><textarea id=\"mt-glossary\" rows=\"3\" placeholder=\"术语表（可选）：每行一条「原文=译名」，如 Elena=艾琳娜\"></textarea>\n                <div>\n                    <span>上下文页数</span>\n                    <input id=\"mt-context-pages\" type=\"number\" min=\"0\" max=\"3\" step=\"1\" value=\"1\">\n                    <label>\n                        <input id=\"mt-auto-glossary\" type=\"checkbox\">自动记人名\n                    </label>\n                </div>\n            </div>\n                    <div class=\"mt-setting-page\" id=\"mt-sec-ocr\">\n                <div>\n                    <label class=\"mt-field-label\" for=\"mt-ocr-mode\">识别服务</label><select id=\"mt-ocr-mode\">\n                        <option value=\"builtin\">内置轻量 OCR（YOLO+Tesseract，免部署，浏览器内跑）</option>\n                        <option value=\"local\">本地 OCR（PaddleOCR，需部署，中日韩最准）</option>\n                        <option value=\"baidu\">百度 OCR（高精度，经代理）</option>\n                        <option value=\"baidu-direct\">百度 OCR（直连，填 access_token）</option>\n                        <option value=\"ocrspace\">ocr.space 免费云端（无需后端）</option>\n                    </select>\n                    <div id=\"mt-local-cfg\">\n                        <input id=\"mt-local-url\" type=\"text\" placeholder=\"本地服务地址，如 http://127.0.0.1:8000/ocr\">\n                        <input id=\"mt-local-token\" type=\"password\" placeholder=\"访问令牌（服务端设了 OCR_TOKEN 才填）\">\n                        <div>需本地运行 local-ocr-server.py（PaddleOCR）。支持韩文/日文，首次识别会自动下载模型。</div>\n                    </div>\n                    <div id=\"mt-baidu-cfg\">\n                        <input id=\"mt-baidu-proxy\" type=\"text\" placeholder=\"百度代理地址，如 https://xxx.workers.dev\">\n                        <div>密钥藏在代理里，不暴露在网页中。代理代码见同目录 baidu-ocr-proxy.js</div>\n                    </div>\n                    <div id=\"mt-baidu-direct-cfg\">\n                        <input id=\"mt-baidu-token\" type=\"password\" placeholder=\"百度 access_token（约 30 天有效）\">\n                        <select id=\"mt-baidu-precision\">\n                            <option value=\"general\">标准（快，精度略低）</option>\n                            <option value=\"accurate\">高精度（慢，更准）</option>\n                        </select>\n                        <div>直连不经过 Cloudflare，国内更快。token 在百度控制台获取。</div>\n                    </div>\n                    <div id=\"mt-ocrspace-cfg\">\n                        <input id=\"mt-ocrspace-key\" type=\"password\" placeholder=\"ocr.space API Key\">\n                        <div>免费申请：ocr.space/ocrapi/freekey（免费额度有限，适合测试）</div>\n                    </div>\n                    <div>\n                        <span>OCR 限速</span>\n                        <input id=\"mt-ocr-rps\" type=\"number\" min=\"0\" max=\"20\" step=\"1\" value=\"3\">\n                        <span>次/秒（0=关闭限速器、改用 4 并发；百度免费约 2）</span>\n                    </div>\n                    <label>\n                        <input id=\"mt-ocr-hi\" type=\"checkbox\">\n                        高清分块 OCR（更准；单图 OCR 时间约 ×2，长条小字漫画建议开）\n                    </label>\n                    <div id=\"mt-builtin-cfg\">\n                        <div>检测模型 2 个（约 10MB）+ 识别语言包。首次点「下载模型」联网取一次，之后离线可用，不需要任何本地服务。</div>\n                        <select id=\"mt-builtin-lang\">\n                            <option value=\"eng\">英文</option>\n                            <option value=\"jpn\">日文</option>\n                            <option value=\"kor\">韩文</option>\n                            <option value=\"chi_sim\">中文简体</option>\n                            <option value=\"chi_tra\">中文繁体</option>\n                            <option value=\"eng_jpn\">英文+日文</option>\n                        </select>\n                        <input id=\"mt-builtin-base\" type=\"text\" placeholder=\"检测模型地址（可换成镜像）\">\n                        <div style=\"display:flex;gap:6px;align-items:center;flex-wrap:wrap\">\n                            <button type=\"button\" id=\"mt-model-download\">下载 / 准备模型</button>\n                            <button type=\"button\" id=\"mt-model-clear\">清除模型</button>\n                            <span id=\"mt-model-status\">未下载</span>\n                        </div>\n                    </div>\n                </div>\n            </div>\n                    <div class=\"mt-setting-page\" id=\"mt-sec-proc\">\n                <div>\n                    <span>方式</span>\n                    <select id=\"mt-process-mode\">\n                        <option value=\"wave\">分批渐进（边翻边显示）</option>\n                        <option value=\"all\">整章一次性（完成后显示）</option>\n                    </select>\n                    <span id=\"mt-wave-size-wrap\">\n                        <input id=\"mt-wave-size\" type=\"number\" min=\"1\" max=\"50\" value=\"5\">\n                        <span>张/批</span>\n                    </span>\n                </div>\n                <div>\n                    <span>顺序</span>\n                    <select id=\"mt-process-order\">\n                        <option value=\"fast\">尽快（乱序覆盖，最快）</option>\n                        <option value=\"sequential\">按顺序（从上到下，稍慢）</option>\n                    </select>\n                </div>\n                <div>\n                    <span>设备</span>\n                    <select id=\"mt-device-mode\">\n                        <option value=\"auto\">自动（推荐）</option>\n                        <option value=\"pc\">电脑端</option>\n                        <option value=\"phone\">手机端</option>\n                    </select>\n                </div>\n                <label>\n                    <input id=\"mt-fast-mode\" type=\"checkbox\">\n                    手机极速模式（图更小更快，小字可能漏识别）\n                </label>\n                <label>\n                    <input id=\"mt-thinking\" type=\"checkbox\">\n                    思考模式（更慢更贵；仅对 DeepSeek 官方域生效）\n                </label>\n            </div>\n                    <div class=\"mt-setting-page\" id=\"mt-sec-disp\">\n                <div>\n                    <span>字号 <span id=\"mt-font-val\">14</span></span>\n                    <input id=\"mt-font-size\" type=\"range\" min=\"10\" max=\"28\" value=\"14\">\n                </div>\n                <div>\n                    <span>气泡缩放 <span id=\"mt-bubble-scale-val\">100%</span></span>\n                    <input id=\"mt-bubble-scale\" type=\"range\" min=\"50\" max=\"150\" value=\"100\">\n                </div>\n                <div>\n                    <span>面板缩放 <span id=\"mt-zoom-val\">100%</span></span>\n                    <input id=\"mt-panel-zoom\" type=\"range\" min=\"70\" max=\"160\" value=\"100\">\n                </div>\n                <div>\n                    <label class=\"mt-field-label\" for=\"mt-render-mode\">渲染方式</label>\n                    <select id=\"mt-render-mode\">\n                        <option value=\"dom\">DOM 气泡叠加（快，文字可选）</option>\n                        <option value=\"canvas\">Canvas 整图重绘（排版更还原，缩放不错位）</option>\n                    </select>\n                </div>\n                <div>\n                    <label class=\"mt-field-label\" for=\"mt-erase-mode\">擦除方式</label>\n                    <select id=\"mt-erase-mode\">\n                        <option value=\"filter\">本地像素滤波（白色膨胀+暗部抬升）</option>\n                        <option value=\"dominant\">框内主色填充（彩色气泡更贴合）</option>\n                        <option value=\"model\">模型擦除（需外部服务）</option>\n                    </select>\n                    <label style=\"display:block;margin:6px 0\">\n                        <input id=\"mt-erase\" type=\"checkbox\">\n                        启用擦除（先把原文擦掉再打译文；不勾的话下面选什么都不生效）\n                    </label>\n                    <div id=\"mt-erase-url-wrap\">\n                        <input id=\"mt-erase-url\" type=\"text\" placeholder=\"擦除服务地址，如 http://127.0.0.1:8001/inpaint\">\n                        <div>服务端：local-inpaint-server.py，独立进程跑在 <b>8001</b>（8000 是你的 OCR，互不影响）。启动：双击「启动擦除服务.cmd」，或 python local-inpaint-server.py。首次要先下模型（约 198MB）：python local-inpaint-server.py --download-model。地址只在「擦除方式 = 模型擦除」时生效；没配 / 连不上会自动回落本地滤波。</div>\n                    </div>\n                </div>\n                <div>\n                    <span>排版</span>\n                    <label><input id=\"mt-typeset-size\" type=\"checkbox\"> 字号自适应（按气泡面积算）</label>\n                    <label><input id=\"mt-typeset-punct\" type=\"checkbox\"> 避标点行首 / 合孤字行</label>\n                    <label><input id=\"mt-auto-contrast\" type=\"checkbox\"> 按底色自动反衬文字色</label>\n                </div>\n            </div>\n                </section>\n                <section class=\"mt-page\" id=\"mt-page-log\" hidden><div class=\"mt-settings-head\"><strong>运行日志</strong><span>便于检查识别与翻译过程</span></div><div class=\"mt-log-actions\"><button id=\"mt-log-toggle\" type=\"button\">收起日志</button><button id=\"mt-log-clear\" type=\"button\">清空日志</button></div><div id=\"mt-log-view\"></div></section>\n            </div>\n            <div class=\"mt-footer\"><div class=\"mt-utilities\"><button id=\"mt-save\" type=\"button\">保存配置</button><button id=\"mt-test\" type=\"button\">测试通道</button><button id=\"mt-clear-bubbles\" type=\"button\">清除气泡</button></div><button id=\"mt-toggle\" type=\"button\">▶　开启自动识别</button><div id=\"mt-log\">填好配置后点“开启自动识别”</div></div>\n";
        document.body.appendChild(panel);

        let activeSetting = 'trans';
        function showPage(page, setting = activeSetting) {
            activeSetting = setting;
            ['home', 'settings', 'log'].forEach(name => {
                $('mt-page-' + name).hidden = name !== page;
            });
            panel.querySelectorAll('.mt-nav-btn').forEach(button => {
                button.setAttribute('aria-selected', String(button.dataset.page === page));
            });
            ['trans', 'ocr', 'proc', 'disp'].forEach(name => {
                const selected = name === activeSetting;
                $('mt-sec-' + name).classList.toggle('mt-active', selected);
            });
            panel.querySelectorAll('.mt-subtab').forEach(button => {
                button.setAttribute('aria-selected', String(button.dataset.setting === activeSetting));
            });
            if (page === 'log') renderLog();
            const content = $('mt-page-' + page);
            if (content) content.scrollTop = 0;
        }
        panel.querySelectorAll('.mt-nav-btn').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
        panel.querySelectorAll('.mt-subtab').forEach(button => button.addEventListener('click', () => showPage('settings', button.dataset.setting)));
        panel.querySelectorAll('.mt-quick-card').forEach(button => button.addEventListener('click', () => showPage('settings', button.dataset.goSetting)));
        showPage('home');

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
        $('mt-ocr-hi').checked = !!apiConfig.ocrChunkHi;
        $('mt-local-url').value = apiConfig.localOcrUrl;
        $('mt-local-token').value = apiConfig.localOcrToken || '';

        // ── 7.52 新增控件初值 ──
        if ($('mt-builtin-lang')) $('mt-builtin-lang').value = apiConfig.builtinLang;
        if ($('mt-builtin-base')) $('mt-builtin-base').value = apiConfig.builtinModelBase;
        if ($('mt-erase-mode')) $('mt-erase-mode').value = apiConfig.eraseMode;
        if ($('mt-erase-url')) $('mt-erase-url').value = apiConfig.eraseServiceUrl || '';
        if ($('mt-render-mode')) $('mt-render-mode').value = apiConfig.renderMode;
        if ($('mt-typeset-size')) $('mt-typeset-size').checked = !!apiConfig.typesetAutoSize;
        if ($('mt-typeset-punct')) $('mt-typeset-punct').checked = !!apiConfig.typesetAvoidPunct;
        if ($('mt-auto-contrast')) $('mt-auto-contrast').checked = !!apiConfig.autoContrast;
        if ($('mt-model-status')) {
            const allReady = BUILTIN_MODELS.every(function (n) { return apiConfig.modelsReady && apiConfig.modelsReady[n]; });
            $('mt-model-status').textContent = allReady ? '已下载（离线可用）' : '未下载';
        }

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
            const bi = $('mt-builtin-cfg');
            if (bi) bi.style.display = m === 'builtin' ? 'block' : 'none';
        }
        modeSel.addEventListener('change', toggleOcrCfg);
        toggleOcrCfg();

        // ── 7.52：内置模型 / 擦除 / 渲染 ──
        if ($('mt-builtin-lang')) {
            $('mt-builtin-lang').addEventListener('change', () => { apiConfig.builtinLang = $('mt-builtin-lang').value; });
        }
        if ($('mt-model-download')) {
            $('mt-model-download').addEventListener('click', async () => {
                const st = $('mt-model-status'), btn = $('mt-model-download');
                btn.disabled = true;
                try {
                    if (st) st.textContent = '准备中…';
                    await prepareBuiltinOcr(function (msg) { if (st) st.textContent = msg; });
                    for (const n of BUILTIN_MODELS) apiConfig.modelsReady[n] = true;
                    if (st) st.textContent = '已就绪（离线可用）';
                    addLog('OCR', '内置引擎模型已就绪');
                } catch (e) {
                    if (st) st.textContent = '失败：' + (e && e.message || e);
                    addLog('OCR', '模型准备失败：' + (e && e.message || e), 'error');
                } finally {
                    btn.disabled = false;
                }
            });
        }
        if ($('mt-model-clear')) {
            $('mt-model-clear').addEventListener('click', async () => {
                await clearBuiltinModels();
                if ($('mt-model-status')) $('mt-model-status').textContent = '已清除';
                addLog('OCR', '已清除内置引擎模型缓存');
            });
        }
        if ($('mt-erase-mode')) {
            const syncEraseUrl = () => {
                const w = $('mt-erase-url-wrap');
                const on = $('mt-erase-mode').value === 'model';
                // 地址框常显：以前只在选「模型擦除」时才出现，等于把功能藏在两层菜单后面，
                // 用户翻遍面板也找不到「擦除服务地址」在哪。
                if (w) w.style.display = 'block';
                const urlEl = $('mt-erase-url');
                if (urlEl) {
                    urlEl.style.opacity = on ? '1' : '0.45';
                    urlEl.title = on ? '' : '当前擦除方式不是「模型擦除」，这个地址暂不生效';
                }
                // 切到模型擦除且地址还空着 → 自动填本地服务默认地址，省得用户去查端口
                if (on && urlEl && !urlEl.value.trim()) {
                    urlEl.value = 'http://127.0.0.1:8001/inpaint';
                    apiConfig.eraseServiceUrl = urlEl.value;
                }
                // 选了具体擦除方式，说明用户就是要擦除 —— 自动把总开关勾上，
                // 免得又出现「方式选了、开关没勾、一条补丁都没有」这种白跑一趟的情况。
                const chk = $('mt-erase');
                if (chk && !chk.checked && ($('mt-erase-mode').value === 'model' || $('mt-erase-mode').value === 'dominant')) {
                    chk.checked = true;
                    apiConfig.eraseOriginal = true;
                    addLog('擦除', '已自动勾选「启用擦除」', 'warn');
                }
            };
            $('mt-erase-mode').addEventListener('change', syncEraseUrl);
            syncEraseUrl();
        }
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
        mini.style.cssText = '';
        mini.textContent = '译';
        document.body.appendChild(mini);

        $('mt-minimize').addEventListener('click', () => {
            const r = panel.getBoundingClientRect();
            panel._vw = r.width; panel._vh = r.height;
            mini.style.display = 'flex';   // 先显示，否则 offsetWidth 为 0，悬浮球会偏出屏幕右侧
            try { GM_setValue('mt_minimized', true); } catch (e) { }
            const mw = mini.offsetWidth || 36;
            mini.style.left = Math.max(8, Math.min(r.left + r.width - mw, innerWidth - mw - 8)) + 'px';
            mini.style.top = Math.max(8, r.top) + 'px';
            mini.style.bottom = 'auto'; mini.style.right = 'auto';
            panel.style.display = 'none';
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
            showPage('home');
            mini.style.display = 'none'; panel.style.display = 'flex';
            try { GM_setValue('mt_minimized', false); } catch (e) { }
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

        ['mt-translator', 'mt-source-lang', 'mt-ocr-mode'].forEach(id => $(id).addEventListener('change', refreshPanelUI));

        $('mt-save').addEventListener('click', () => {
            syncConfig();
            GM_setValue('ai_api_config', apiConfig);
            const b = $('mt-save');
            b.innerText = '已保存';
            b.classList.add('mt-saved');
            setTimeout(() => { b.innerText = '保存配置'; b.classList.remove('mt-saved'); }, 1400);
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
            else { showPage('home'); startAuto(); }
        });

        // 面板显示状态要记住：第一次装脚本时**必须先把面板露出来**，
        // 否则用户看到的是一个右下角小圆点，一旦它被页面浮层盖住或飘出视口，就彻底没有入口了。
        (function initMinimized() {
            const rr = panel.getBoundingClientRect();
            panel._vw = rr.width; panel._vh = rr.height;   // 先量好尺寸（隐藏后量不到）
            let wantMin = false;
            try { wantMin = GM_getValue('mt_minimized', false) === true; } catch (e) { }
            if (wantMin) {
                panel.style.display = 'none';
                mini.style.display = 'flex';
            } else {
                panel.style.display = 'flex';
                mini.style.display = 'none';
            }
            refreshPanelUI();
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
        apiConfig.ocrChunkHi = !!$('mt-ocr-hi').checked;
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
        // ── 7.52 新增 ──
        if ($('mt-builtin-lang')) apiConfig.builtinLang = $('mt-builtin-lang').value;
        if ($('mt-builtin-base')) apiConfig.builtinModelBase = $('mt-builtin-base').value.trim() || apiConfig.builtinModelBase;
        if ($('mt-erase-mode')) apiConfig.eraseMode = $('mt-erase-mode').value;
        if ($('mt-erase-url')) {
            const nextEraseUrl = $('mt-erase-url').value.trim();
            if (nextEraseUrl !== apiConfig.eraseServiceUrl) eraseServiceAlive = null;
            apiConfig.eraseServiceUrl = nextEraseUrl;
        }
        if ($('mt-render-mode')) apiConfig.renderMode = $('mt-render-mode').value;
        if ($('mt-typeset-size')) apiConfig.typesetAutoSize = !!$('mt-typeset-size').checked;
        if ($('mt-typeset-punct')) apiConfig.typesetAvoidPunct = !!$('mt-typeset-punct').checked;
        if ($('mt-auto-contrast')) apiConfig.autoContrast = !!$('mt-auto-contrast').checked;
    }

    function makeDraggable(panel) {
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0, vw = 0, vh = 0;
        const pz = () => parseFloat(panel.style.zoom) || 1;
        function dragStart(cx, cy, target) {
            if (!target || !target.closest || !target.closest('#mt-header') || target.closest('button')) return;
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
        const myTask = newTask();      // 先占号：之前残留的回调会立刻看到自己已失效
        running = true;
        stopRequested = false;
        processed.clear();
        usedFallbackImages = false;
        clearBubbles();   // 先清掉上一次的气泡：否则重复点开始会新气泡压旧气泡，付费接口二次计费
        totalCount = 0; doneCount = 0;
        dlDone = 0; ocrDone = 0; transDone = 0; transTotal = 0;
        $('mt-toggle').innerText = '■　停止识别';
        refreshPanelUI();

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
            if (!apiConfig.eraseOriginal && apiConfig.eraseMode !== 'filter') {
            addLog('擦除', '当前擦除方式是「' + apiConfig.eraseMode + '」但「启用擦除」没勾，本次不会擦除任何东西', 'warn');
        }
        addLog('流程', '开始 · ' + totalCount + ' 张 · 识别=' + (OCR_MODE_NAMES[apiConfig.ocrMode] || apiConfig.ocrMode) +
                ' · 擦除=' + (apiConfig.eraseOriginal ? (apiConfig.eraseMode === 'model' ? '模型' : apiConfig.eraseMode === 'dominant' ? '主色填充' : '像素滤波') : '关') +
                ' · 渲染=' + (apiConfig.renderMode === 'canvas' ? '整图重绘' : 'DOM叠加') +
                ' · 模型=' + apiConfig.aiModel);

            if (apiConfig.processMode === 'all') {
                await processAll(targets, myTask);
            } else {
                await processWaves(targets, myTask);
            }

            if (stopRequested) log('⏹ 已停止：' + doneCount + '/' + totalCount + ' 张');
            else log('✅ 全部完成：' + doneCount + '/' + totalCount + ' 张');
        } catch (e) {
            // 旧实现没有 try/finally：内部一抛错 running 就永远卡在 true，按钮停在「停止」，只能刷新页面
            addLog('流程', '异常终止：' + (e && e.message || e), 'error');
            log('❌ 异常终止：' + (e && e.message || e));
        } finally {
            // 只有自己还是当前任务才收尾；否则会把后来启动的新任务一起停掉
            if (taskAlive(myTask)) stopAuto();
        }
    }

    // 下载完一张立刻 OCR 一张（受全局池约束），位图用完即释放
    async function streamChapter(targets, taskId) {
        const results = await Promise.all(targets.map(img =>
            pools.dl(() => downloadOne(img)).then(it => it ? ocrOne(it, taskId) : null)
        ));
        if (stopRequested || (taskId !== undefined && !taskAlive(taskId))) return null;
        return results.filter(Boolean);
    }

    async function processAll(targets, taskId) {
        log('整章一次性：取图 ' + targets.length + ' 张...');
        const ok = await streamChapter(targets, taskId);
        if (stopRequested || !ok) return;
        if (!ok.length) { log('⚠️ 没有取到图'); return; }

        const flatBlocks = [];
        ok.forEach(r => (r.blocks || []).forEach(b => flatBlocks.push(b)));
        if (!flatBlocks.length) { log('⚠️ 未识别到任何文字'); return; }

        log('批量翻译 ' + flatBlocks.length + ' 段...');
        await translateInBatches(flatBlocks);
        if (stopRequested || (taskId !== undefined && !taskAlive(taskId))) return;

        // #2：等所有渲染真正结束再报"完成"，否则完成提示会提前出现
        await Promise.all(ok.map(r => overlayBubbles(r.img, r.blocks, r.width, r.height, taskId)));
        doneCount = ok.length;
    }

    async function processWaves(targets, taskId) {
        const ws = Math.max(1, parseInt(apiConfig.waveSize, 10) || WAVE_SIZE);
        const waves = [];
        for (let i = 0; i < targets.length; i += ws) waves.push(targets.slice(i, i + ws));

        const runWave = async (wave, wi) => {
            if (stopRequested || (taskId !== undefined && !taskAlive(taskId))) return;
            const items = await streamChapter(wave, taskId);
            if (stopRequested || !items || !items.length) return;

            const flatBlocks = [];
            items.forEach(r => (r.blocks || []).forEach(b => flatBlocks.push(b)));
            if (flatBlocks.length) await translateInBatches(flatBlocks);
            if (stopRequested || (taskId !== undefined && !taskAlive(taskId))) return;

            await Promise.all(items.map(r => overlayBubbles(r.img, r.blocks, r.width, r.height, taskId)));
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
        activeTask = 0;        // 作废当前任务：所有在途回调看到 taskAlive(id)===false 就不再写回
        $('mt-toggle').innerText = '▶　开启自动识别';
        refreshPanelUI();
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
        if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
        // iPadOS 13+ 的 Safari 默认发桌面 Macintosh UA：按触摸点数识别 iPad（7.45）
        return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
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

    async function ocrOne(item, taskId) {
        const alive = () => (taskId === undefined) || taskAlive(taskId);
        if (stopRequested || !alive()) {
            if (item.bitmap && item.bitmap.close) item.bitmap.close();
            item.bitmap = null; item.blocks = [];
            return item;
        }
        const t0 = Date.now();
        addLog('OCR', '开始 ' + item.bitmap.width + 'x' + item.bitmap.height);
        try {
            const { blocks, width, height } = await doOCR(item.bitmap, item.blob);
            // 识别中途被停止 / 重启：结果不再挂到 item 上，避免污染新一轮
            if (!alive()) {
                if (item.bitmap && item.bitmap.close) item.bitmap.close();
                item.bitmap = null; item.blob = null; item.blocks = [];
                return item;
            }
            item.blocks = blocks; item.width = width; item.height = height;
            // #4 补丁必须在 bitmap 释放前生成（之后拿不到像素）
            buildErasePatches(item.bitmap, blocks);
            await buildModelPatches(item.bitmap, blocks);   // 7.52：模型擦除（异步，失败自动回落本地滤波）
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

        // 7.52：内置 YOLO+Tesseract 引擎（免部署）—— 独立链路，和下面的分块 OCR 完全不共用代码。
        // 失败时不回退到别的 OCR：那会静默切到「本地 PaddleOCR」这种需要起服务的模式，
        // 用户看到的就是"明明选了内置却报 local 连不上"，非常容易误解成配置冲突。
        if (apiConfig.ocrMode === 'builtin') {
            try {
                const { blocks } = await builtinOcr(bitmap);
                return finalizeBlocks(blocks, W, H, bitmap);
            } catch (e) {
                addLog('OCR', '内置引擎失败：' + (e && e.message || e), 'error');
                addLog('OCR', '（内置引擎不再回退到其他识别服务；要换方法请到面板「识别服务」改选）', 'warn');
                return { blocks: [], width: W, height: H };
            }
        }

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

        // 分块路径（电脑端、非本地模式、或手机端无原图时）：按宽度缩放 + JPEG 重编码。
        // 分块之间加 OVERLAP 重叠带：刚好压在切分线上的文字行会被横向切碎、上下两块都识别不出（7.45）。
        const fast = !!apiConfig.fastMode;
        // 高清分块：local + 开关打开 → 1000px 高（更准，OCR 时间约 ×2）；关闭 → 2400px（快，长条小字易漏句）
        const hiChunk = apiConfig.ocrMode === 'local' && apiConfig.ocrChunkHi;
        const cap = fast ? 1600 : (hiChunk ? 1000 : (CAP_MAX_DIM[apiConfig.ocrMode] || 1400));
        // 窄长漫画通常本来就小于极速模式宽度上限，此时继续压到 0.60 没有缩放收益，
        // 只会把白底上的细英文笔画压糊并造成漏字；窄图保留较高质量，大图才使用更强压缩。
        const jpegQ = fast ? (W <= 1200 ? 0.78 : 0.68) : JPEG_QUALITY;
        const scale = Math.min(1, cap / W);
        const chunkH = Math.max(1, Math.floor(cap / scale));
        const OVERLAP = Math.min(90, Math.floor(chunkH * 0.1));
        const stepH = Math.max(1, chunkH - OVERLAP);

        const slices = [];
        for (let y0 = 0; y0 < H; y0 += stepH) {
            const sh = Math.min(chunkH, H - y0);
            slices.push({ y0, sh });
            if (y0 + sh >= H) break;
        }

        const jobs = slices.map(({ y0, sh }) => pools.ocr(() => {
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
        const results = await Promise.all(jobs);
        if (stopRequested) return { blocks: [], width: W, height: H };

        const blocks = [];
        function overlapRatio(a, b) {
            const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ix <= 0 || iy <= 0) return 0;
            const inter = ix * iy;
            return inter / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
        }
        function normalizedOcrText(s) {
            return String(s || '').toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, '');
        }
        function duplicateIndex(nb) {
            const nt = normalizedOcrText(nb.originalText);
            return blocks.findIndex(eb => {
                const cy1 = eb.y + eb.h / 2, cy2 = nb.y + nb.h / 2;
                const cx1 = eb.x + eb.w / 2, cx2 = nb.x + nb.w / 2;
                // 先要求框真正重叠；旧版只比较中心距离，会把同一气泡里相邻两行误删。
                const overlap = overlapRatio(eb, nb);
                if (overlap < 0.45) return false;
                if (Math.abs(cy1 - cy2) > Math.max(eb.h, nb.h) * 0.7 ||
                    Math.abs(cx1 - cx2) > Math.max(eb.w, nb.w) * 0.65) return false;
                const et = normalizedOcrText(eb.originalText);
                return !et || !nt || et === nt || et.includes(nt) || nt.includes(et) || overlap >= 0.78;
            });
        }
        results.forEach((raw, i) => {
            if (!raw || !raw.length) return;
            const y0 = slices[i].y0;
            raw.forEach(b => {
                const nb = {
                    originalText: b.text,
                    x: b.x / scale,
                    y: b.y / scale + y0,
                    w: b.w / scale,
                    h: b.h / scale
                };
                // 重叠带里的同一行保留信息更完整的版本。必须有实际框重叠，不能仅凭中心接近删行。
                const di = duplicateIndex(nb);
                if (di < 0) blocks.push(nb);
                else if (normalizedOcrText(nb.originalText).length > normalizedOcrText(blocks[di].originalText).length) blocks[di] = nb;
            });
        });
        // 分块模式也必须带 bitmap，否则气泡级分组会被跳过
        return finalizeBlocks(blocks, W, H, bitmap);
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
    const URL_TLD = 'com|net|org|cn|tw|jp|kr|cc|xyz|info|top|vip|site|club|app|dev|page|blog|shop|online|manga|biz|uk|de|fr|ru|es|nl|br|au|tv|edu|gov|store|live|link|fun|space|website';
    function isUrlLike(text) {
        const raw = String(text || '').trim().toLowerCase();
        if (!raw) return false;
        // 多词正常句（≥4 个空格分隔词）且没有 http/www/明确域名 → 不当网址。
        // 旧实现先删光整句空格再匹配，会把 "WAIT. US" 拼成 "wait.us" 误杀正常台词（7.45 修正）。
        const words = raw.split(/\s+/).filter(Boolean);
        if (words.length >= 4 && !/(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|cn|tw|jp|kr|cc|xyz|site|club|top|vip|manga)\b)/.test(raw)) return false;
        // OCR 常见误识别修正（仅用于判定，不改原文）：.corn/.c0m/.con → .com；0/o、1/l、3/e 混淆
        const compact = raw.replace(/\s+/g, '');
        const variants = [compact, compact.replace(/0/g, 'o'), compact.replace(/1/g, 'l'), compact.replace(/3/g, 'e')]
            .map(v => v.replace(/\.corn\b/g, '.com').replace(/\.c0m\b/g, '.com').replace(/\.con\b/g, '.com'));
        // 原文带空格边界：只认"点后紧跟 TLD"的形态（避免 "wait. us" 拼成 wait.us）
        const reBareSrc = new RegExp('(^|\\s)([a-z0-9-]{2,}\\.)+(' + URL_TLD + ')(\\.[a-z]{2,})?(\\/|$|\\s)');
        if (reBareSrc.test(raw)) return true;
        for (const v of variants) {
            if (/^(https?:\/\/|www\.)/.test(v)) return true;
            if (new RegExp('(^|[^a-z0-9])([a-z0-9-]{2,}\\.)+(' + URL_TLD + ')(\\.[a-z]{2,})?(\\/|$|[^a-z0-9])').test(v)) return true;
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

    // 不再把“只含一个汉字”当成翻译成功。结合原文长度筛掉明显截断/残缺的回答，交给逐条补翻。
    function isUsableTranslation(source, translated) {
        const src = String(source || '').trim();
        const t = String(translated || '').trim();
        if (!src || !t || isRefusal(t)) return false;
        const cn = (t.match(/[\u3400-\u9fff]/g) || []).length;
        if (!cn) return false;
        if (apiConfig.sourceLang === 'eng') {
            const letters = (src.match(/[A-Za-z]/g) || []).length;
            const words = (src.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
            const minCn = letters >= 20
                ? Math.min(18, Math.max(4, Math.floor(letters * 0.16), Math.floor(words * 0.55)))
                : 1;
            if (cn < minCn) return false;
        } else {
            const sourceChars = (src.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
            if (sourceChars >= 10 && cn < Math.min(14, Math.max(3, Math.floor(sourceChars * 0.24)))) return false;
        }
        return true;
    }

    /* ---------------- #6 气泡级分组：白色连通域定位气泡 ---------------- */

    function rectContains(r, b) {
        return b.x >= r.x - 1 && b.y >= r.y - 1 && b.x + b.w <= r.x + r.w + 1 && b.y + b.h <= r.y + r.h + 1;
    }

    // 只在 OCR 文字附近建立搜索区。相邻行扩展后的区域会自动合并成一个气泡候选区，
    // 但长图中没有文字的大片画面不再进入像素扫描，避免整张 720x15560 图片做千万级 BFS。
    function buildBubbleSearchRegions(blocks, W, H) {
        const regions = [];
        const source = (blocks || []).filter(b => b && b.w > 1 && b.h > 1);
        for (const b of source) {
            const padX = Math.max(36, Math.min(W * 0.14, b.w * 0.75));
            const padY = Math.max(52, Math.min(190, b.h * 3.2));
            let r = {
                x: Math.max(0, b.x - padX),
                y: Math.max(0, b.y - padY),
                x2: Math.min(W, b.x + b.w + padX),
                y2: Math.min(H, b.y + b.h + padY)
            };
            // 合并所有相交搜索区，并从头复查，处理多行文字造成的传递合并。
            for (let i = 0; i < regions.length;) {
                const q = regions[i];
                const overlapX = Math.min(r.x2, q.x2) - Math.max(r.x, q.x);
                const overlapY = Math.min(r.y2, q.y2) - Math.max(r.y, q.y);
                if (overlapX >= 0 && overlapY >= 0) {
                    r = { x: Math.min(r.x, q.x), y: Math.min(r.y, q.y), x2: Math.max(r.x2, q.x2), y2: Math.max(r.y2, q.y2) };
                    regions.splice(i, 1);
                    i = 0;
                } else i++;
            }
            regions.push(r);
        }
        return regions.map(r => ({ x: r.x, y: r.y, w: r.x2 - r.x, h: r.y2 - r.y }));
    }

    function detectBubbles(bitmap, W, H, blocks) {
        const regions = buildBubbleSearchRegions(blocks, W, H);
        const out = [];
        for (const region of regions) {
            const scale = Math.min(1, 420 / Math.max(1, region.w), 900 / Math.max(1, region.h));
            const cw = Math.max(1, Math.round(region.w * scale));
            const ch = Math.max(1, Math.round(region.h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = cw; canvas.height = ch;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, cw, ch);
            const data = ctx.getImageData(0, 0, cw, ch).data;
            const n = cw * ch;
            const mask = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                const o = i * 4;
                const r = data[o], g = data[o + 1], b = data[o + 2];
                const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                mask[i] = ((r + g + b) / 3 > 205 && mx - mn < 40) ? 1 : 0;
            }
            const seen = new Uint8Array(n);
            const queue = new Int32Array(n);
            const minArea = Math.max(36, n * 0.0005), maxArea = n * 0.9;
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
                const fill = area / Math.max(1, bw * bh);
                if (bw < 14 || bh < 14 || fill < 0.48) continue;
                if (bw / bh > 7 || bh / bw > 7) continue;
                const edgeCount = (minX === 0 ? 1 : 0) + (maxX === cw - 1 ? 1 : 0)
                    + (minY === 0 ? 1 : 0) + (maxY === ch - 1 ? 1 : 0);
                // 同时碰到两个以上分片边缘的白区通常是页面留白/栏间空白，不是封闭气泡。
                if (edgeCount >= 2) continue;
                out.push({
                    x: region.x + minX / scale,
                    y: region.y + minY / scale,
                    w: bw / scale,
                    h: bh / scale,
                    fill: fill,
                    clipped: edgeCount > 0
                });
            }
        }
        // 重叠搜索区里的重复框只留更完整的一个；内部文字割裂出的碎白块也不应抢走 OCR 行。
        const valid = out.filter(r => r.w >= W * 0.045 && r.h >= 24);
        valid.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        const keep = [];
        for (const r of valid) {
            const duplicate = keep.some(k => {
                const ix = Math.min(r.x + r.w, k.x + k.w) - Math.max(r.x, k.x);
                const iy = Math.min(r.y + r.h, k.y + k.h) - Math.max(r.y, k.y);
                const inter = ix > 0 && iy > 0 ? ix * iy : 0;
                return rectContains(k, r) || inter / Math.max(1, Math.min(r.w * r.h, k.w * k.h)) > 0.78;
            });
            if (duplicate) continue;
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

    // 同一白色连通域里可能黏着多个气泡、或菱形/属性面板的四角文字：
    // 同一视觉行要求水平间距在"词间距级"，上下行要求垂直间距小且水平重叠/中心对齐。
    // 7.41~7.45 只按垂直距离切分，会把菱形四角的四段英文并成一句（必须在水平方向也约束）。
    function clusterBlocks(members) {
        const sorted = members.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
        const clusters = [];
        for (const b of sorted) {
            let target = null;
            for (const g of clusters) {
                const gW = g.x2 - g.x;
                const lineH = Math.max(g.maxH, b.h, 12);
                // ① 同一视觉行：垂直重叠 + 水平间隙小（词间距）
                const overlapY = Math.min(b.y + b.h, g.y2) - Math.max(b.y, g.y);
                const hGap = Math.max(0, Math.max(b.x, g.x) - Math.min(b.x + b.w, g.x2));
                if (overlapY > Math.min(b.h, g.maxH) * 0.4 && hGap <= Math.max(lineH * 2, 36)) { target = g; break; }
                // ② 上下相邻行：垂直间隙小，且水平重叠或中心对齐
                const vGap = Math.max(b.y - g.y2, g.y - (b.y + b.h));
                if (vGap <= Math.max(24, lineH * 1.4)) {
                    const overlapX = Math.min(b.x + b.w, g.x2) - Math.max(b.x, g.x);
                    const cx1 = g.x + gW / 2, cx2 = b.x + b.w / 2;
                    if (overlapX > Math.min(b.w, gW) * 0.15 || Math.abs(cx1 - cx2) <= Math.max(b.w, gW) * 0.7) { target = g; break; }
                }
            }
            if (target) {
                target.members.push(b);
                target.maxH = Math.max(target.maxH, b.h);
                target.x = Math.min(target.x, b.x);
                target.y = Math.min(target.y, b.y);
                target.x2 = Math.max(target.x2, b.x + b.w);
                target.y2 = Math.max(target.y2, b.y + b.h);
            } else {
                clusters.push({ members: [b], x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h, maxH: b.h });
            }
        }
        return clusters;
    }

    function groupBlocksByBubbleCandidates(blocks, bubbles) {
        // 一个块可能同时落在大背景白区和真正的小气泡里，优先归到面积更小、包裹更紧的候选。
        bubbles = bubbles.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h));
        const owner = new Array(blocks.length).fill(-1);
        blocks.forEach((b, i) => {
            let best = -1, bestArea = Infinity;
            bubbles.forEach((bb, bi) => {
                const hit = blockInBubble(b, bb);
                const area = bb.w * bb.h;
                if (hit >= 0.35 && area < bestArea) { best = bi; bestArea = area; }
            });
            owner[i] = best;
        });
        const units = [];
        bubbles.forEach((bb, bi) => {
            const idxs = [];
            owner.forEach((v, i) => { if (v === bi) idxs.push(i); });
            if (!idxs.length) return;
            // 开放式气泡或相连的白底会把相隔很远的两句归到同一个候选白区。
            // 先按实际文字行的几何邻近性拆开，再逐簇决定是否锁定为一句。
            const indexByBlock = new Map(idxs.map(i => [blocks[i], i]));
            for (const cluster of clusterBlocks(idxs.map(i => blocks[i]))) {
                const members = cluster.members;
                const centers = members.map(b => b.y + b.h / 2).sort((a, b) => a - b);
                const lineH = Math.max(...members.map(b => b.h));
                const oneVisualLine = centers[centers.length - 1] - centers[0] <= lineH * 0.65;
                if (members.length < 2 || oneVisualLine) {
                    members.forEach(b => { owner[indexByBlock.get(b)] = -1; });
                    continue;
                }
                units.push({
                    originalText: joinSortedBlocks(members),
                    x: cluster.x, y: cluster.y, w: cluster.x2 - cluster.x, h: cluster.y2 - cluster.y,
                    avgH: lineH,
                    _members: members,
                    _locked: true
                });
            }
        });
        blocks.forEach((b, i) => {
            if (owner[i] < 0) units.push(Object.assign({}, b, { avgH: b.h, _members: [b], _locked: false }));
        });
        return units;
    }

    // 同一可靠气泡里的多行合并成一个翻译单元；单行伪气泡与未归属块交给后续保守行合并。
    // 返回 null 表示整页没有可靠气泡（白底页等），由调用方降级到 mergeBlocks。
    function groupByBubbles(blocks, bitmap, W, H) {
        let bubbles = [];
        try { bubbles = detectBubbles(bitmap, W, H, blocks); } catch (e) { bubbles = []; }
        if (!bubbles.length) return null;
        return groupBlocksByBubbleCandidates(blocks, bubbles);
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

    // 7.52 新增：框内主色填充补丁（移植自沉浸式翻译客户端的擦除方式）
    // 做法：统计框内像素出现最多的颜色 → 用该色刷满整个框 → 最外几像素羽化，避免方角。
    // 比 makeErasePatch 的"白色膨胀"更贴合彩色气泡/底色，但对网点、渐变会退化成一块死色。
    function makeDominantPatch(bitmap, b) {
        const pad = Math.max(2, Math.round(Math.min(b.w, b.h) * 0.08));
        const x = Math.max(0, Math.floor(b.x - pad));
        const y = Math.max(0, Math.floor(b.y - pad));
        const x2 = Math.min(bitmap.width, Math.ceil(b.x + b.w + pad));
        const y2 = Math.min(bitmap.height, Math.ceil(b.y + b.h + pad));
        const w = x2 - x, h = y2 - y;
        if (w < 4 || h < 4 || w * h > 400000) return null;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        // 16 阶量化直方图取主色（与官方 cB 同一算法）
        const hist = new Map();
        for (let i = 0; i < d.length; i += 4) {
            const key = (Math.round(d[i] / 16) * 16) + ',' + (Math.round(d[i + 1] / 16) * 16) + ',' + (Math.round(d[i + 2] / 16) * 16);
            hist.set(key, (hist.get(key) || 0) + 1);
        }
        if (!hist.size) return null;
        const top = [...hist.entries()].sort((a, b2) => b2[1] - a[1])[0];
        const [r, g, bl] = top[0].split(',').map(Number);
        for (let i = 0; i < d.length; i += 4) {
            d[i] = r; d[i + 1] = g; d[i + 2] = bl; d[i + 3] = 255;
        }
        // 边缘羽化：补丁是矩形，硬边会盖出方角
        const feather = Math.max(2, Math.min(6, Math.floor(pad * 0.9)));
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const dd = Math.min(xx, yy, w - 1 - xx, h - 1 - yy);
                d[(yy * w + xx) * 4 + 3] = dd >= feather ? 255 : Math.round(255 * (dd + 1) / (feather + 1));
            }
        }
        ctx.putImageData(img, 0, 0);
        return { url: canvas.toDataURL('image/png'), box: { x, y, w, h } };
    }

    // 7.52：给擦除模型用的「笔画级」mask。整框填白会让模型凭空补一大片、纹理很假；
    // 只标出笔画再膨胀几像素，模型只需把笔迹融进周围背景，接缝自然得多。
    function buildTextMaskCanvas(srcCanvas, w, h, box, originX, originY, pad) {
        const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
        const img = sctx.getImageData(0, 0, w, h);
        const d = img.data;
        // 估背景亮度：从 255 往下累计 20%（与 makeErasePatch 同一套，白底/浅底一定停在亮端）
        const hist = new Int32Array(256);
        for (let i = 0; i < d.length; i += 4) {
            hist[Math.min(255, Math.round((d[i] + d[i + 1] + d[i + 2]) / 3))]++;
        }
        let acc = 0, bg = 255;
        const target = (w * h) * 0.2;
        for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= target) { bg = v; break; } }
        const darkThr = Math.max(30, bg * 0.62);                 // 亮底：比背景暗多少算字
        const lightThr = Math.min(235, bg + (255 - bg) * 0.45 + 30); // 暗底：比背景亮多少算字
        const m = new Uint8Array(w * h);
        let count = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                const lum = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
                const isText = bg >= 128 ? lum < darkThr : lum > lightThr;
                if (isText) { m[y * w + x] = 255; count++; }
            }
        }
        const ratio = count / Math.max(1, w * h);
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = w; maskCanvas.height = h;
        const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });

        // 抓不到笔画（纯色块 / 阈值失手）→ 回退成整框矩形，宁可多擦也别漏
        if (ratio < 0.05) {
            mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h);
            mctx.fillStyle = '#fff';
            mctx.fillRect(
                Math.max(0, Math.floor(box.x - originX - pad / 2)),
                Math.max(0, Math.floor(box.y - originY - pad / 2)),
                Math.min(w, Math.ceil(box.w + pad)),
                Math.min(h, Math.ceil(box.h + pad))
            );
            return { canvas: maskCanvas, ratio, fallback: true };
        }

        // 膨胀 3 轮 3x3：把笔画外沿一起包进来，给模型留融合余量
        let cur = m;
        for (let pass = 0; pass < 3; pass++) {
            const nxt = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let v = 0;
                    for (let dy = -1; dy <= 1 && !v; dy++) {
                        const yy = y + dy;
                        if (yy < 0 || yy >= h) continue;
                        for (let dx = -1; dx <= 1; dx++) {
                            const xx = x + dx;
                            if (xx < 0 || xx >= w) continue;
                            if (cur[yy * w + xx]) { v = 255; break; }
                        }
                    }
                    nxt[y * w + x] = v;
                }
            }
            cur = nxt;
        }
        const out = mctx.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
            const v = cur[i];
            out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
        }
        mctx.putImageData(out, 0, 0);
        return { canvas: maskCanvas, ratio, fallback: false };
    }

    // 7.52 新增：模型擦除（外部服务）。服务没配 / 失败时返回 null，由调用方回退到本地滤波。
    // 约定接口：POST eraseServiceUrl  { image: dataURL, mask: dataURL }  → { image: dataURL }
    function makeModelPatch(bitmap, b) {
        if (!apiConfig.eraseServiceUrl) return Promise.resolve(null);
        return new Promise((resolve) => {
            let image, mask;
            try {
                const pad = Math.max(3, Math.round(Math.min(b.w, b.h) * 0.1));
                const x = Math.max(0, Math.floor(b.x - pad));
                const y = Math.max(0, Math.floor(b.y - pad));
                const x2 = Math.min(bitmap.width, Math.ceil(b.x + b.w + pad));
                const y2 = Math.min(bitmap.height, Math.ceil(b.y + b.h + pad));
                const w = x2 - x, h = y2 - y;
                if (w < 4 || h < 4 || w * h > 600000) { resolve(null); return; }
                // 原图裁剪
                const c1 = document.createElement('canvas');
                c1.width = w; c1.height = h;
                c1.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, x, y, w, h, 0, 0, w, h);
                image = c1.toDataURL('image/png');
                // mask：优先给「笔画级」精确遮罩（只擦字，模型补纹理自然）；
                // 阈值抓不到笔画时 buildTextMaskCanvas 内部会回退成整框矩形
                const built = buildTextMaskCanvas(c1, w, h, b, x, y, pad);
                mask = built.canvas.toDataURL('image/png');
                const bx = { x, y, w, h };
                // 地址容错：允许只填根地址（http://host:8001），自动补 /inpaint
                let postUrl = String(apiConfig.eraseServiceUrl || '').replace(/\/+$/, '');
                if (!/\/inpaint$/.test(postUrl)) postUrl += '/inpaint';
                GM_xmlhttpRequest({
                    method: 'POST', url: postUrl,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ image, mask }), timeout: 60000,
                    onload: r => {
                        try {
                            const j = JSON.parse(r.responseText);
                            if (j && j.image) resolve({ url: j.image, box: bx });
                            else resolve(null);
                        } catch (e) { resolve(null); }
                    },
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null)
                });
            } catch (e) { resolve(null); }
        });
    }

    // 在 ocrOne 释放 bitmap 之前调用：只给「会落译文」的块做补丁（拟声词/噪声/网址不擦）
    function buildErasePatches(bitmap, blocks) {
        if (!apiConfig.eraseOriginal || !bitmap || !blocks || !blocks.length) return;
        const mode = apiConfig.eraseMode;
        for (const b of blocks) {
            if (b.patch) continue;
            if (isSfx(b.originalText) || isNoiseText(b.originalText) || isUrlLike(b.originalText)) continue;
            if (!(b.w > 2 && b.h > 2)) continue;
            try {
                if (mode === 'dominant') {
                    const r = makeDominantPatch(bitmap, b);
                    if (r) { b.patch = r.url; b.patchBox = r.box; b.patchMode = 'dominant'; }
                } else if (mode === 'model') {
                    // 模型擦除是异步的：这里只打标记，真正的补丁在 afterOcr 阶段补
                    b._needModelPatch = true;
                } else {
                    const r = makeErasePatch(bitmap, b);
                    if (r) { b.patch = r.url; b.patchBox = r.box; b.patchMode = 'filter'; }
                }
            } catch (e) { /* 跨域污染/内存不足：静默降级回白底 */ }
        }
    }

    // 模型擦除在 OCR 之后、bitmap 释放之前补做（异步，逐块串行以免打爆服务）
    // 7.52：擦除服务可达性探测（缓存结果，避免服务没起时每个框都干等 60s 超时）
    let eraseServiceAlive = null;   // null=未探测 true=可用 false=不可用
    function probeEraseService() {
        return new Promise((resolve) => {
            if (eraseServiceAlive !== null) { resolve(eraseServiceAlive); return; }
            if (!apiConfig.eraseServiceUrl) { eraseServiceAlive = false; resolve(false); return; }
            let statusUrl = apiConfig.eraseServiceUrl.replace(/\/+$/, '');
            if (/\/inpaint$/.test(statusUrl)) statusUrl += '/status';
            else if (!/\/inpaint\/status$/.test(statusUrl)) statusUrl += '/inpaint/status';
            GM_xmlhttpRequest({
                method: 'GET', url: statusUrl, timeout: 4000,
                onload: r => {
                    try {
                        const j = JSON.parse(r.responseText);
                        if (j && j.error) {
                            addLog('擦除', '服务在线但模型未就绪：' + j.error, 'warn');
                            eraseServiceAlive = false;
                        } else {
                            eraseServiceAlive = true;
                        }
                    } catch (e) { eraseServiceAlive = true; }
                    resolve(eraseServiceAlive);
                },
                onerror: () => { eraseServiceAlive = false; resolve(false); },
                ontimeout: () => { eraseServiceAlive = false; resolve(false); }
            });
        });
    }

    // 7.52：模型擦除在 OCR 之后、bitmap 释放之前补做。
    // 限流并发（默认 2）而不是串行：CPU 推理一块几百毫秒，一页几十块串行会等到天荒地老；
    // 并发太高又把 CPU 打满反而更慢，2 是稳妥值。
    async function buildModelPatches(bitmap, blocks) {
        if (apiConfig.eraseMode !== 'model' || !bitmap || !blocks) return;
        const targets = blocks.filter(b => b._needModelPatch && !b.patch);
        if (!targets.length) return;

        const alive = await probeEraseService();
        if (!alive) {
            addLog('擦除', '擦除服务不可用，本图全部回退本地滤波（检查地址 / 模型是否下载）', 'warn');
            for (const b of targets) {
                try {
                    const fb = makeErasePatch(bitmap, b);
                    if (fb) { b.patch = fb.url; b.patchBox = fb.box; b.patchMode = 'filter'; }
                } catch (e) { }
            }
            return;
        }

        const CONCURRENCY = 2;
        let idx = 0, okCount = 0, failCount = 0;
        const worker = async () => {
            while (idx < targets.length) {
                if (stopRequested) return;
                const b = targets[idx++];
                const r = await makeModelPatch(bitmap, b);
                if (r) {
                    b.patch = r.url; b.patchBox = r.box; b.patchMode = 'model';
                    okCount++;
                } else {
                    failCount++;
                    try {
                        const fb = makeErasePatch(bitmap, b);
                        if (fb) { b.patch = fb.url; b.patchBox = fb.box; b.patchMode = 'filter'; }
                    } catch (e) { }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
        addLog('擦除', '模型擦除完成：成功 ' + okCount + ' · 回落 ' + failCount);
    }

    // OCR 乱读：源语言是英文时，台词里出现中日韩文字基本必是误读（气泡颈部曲线、装饰线、水印）。
    // 注意：不能对日文源用"汉字+假名混杂"规则 —— 日文本身就是汉字+假名，会把正常台词全丢掉。
    // 英文源清洗：英文句子里混入少量 OCR 误读的中日韩字符（省略号/线条被认成汉字）时，
    // 剔除这些乱码字符、保留英文；只有整块几乎没有有效英文时才丢弃（7.45：不再整句连坐）。
    function cleanOrFilterBySource(b) {
        let t = String(b.originalText || '').trim();
        if (!t) return false;
        if (apiConfig.sourceLang === 'eng') {
            const stripped = t.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ').replace(/\s+/g, ' ').trim();
            const engLetters = (stripped.match(/[A-Za-z]/g) || []).length;
            if (engLetters >= 2 || SHORT_KEEP.has(stripped.toUpperCase())) {
                b.originalText = stripped;
                return true;
            }
            return false;
        }
        return true;
    }

    // 孤立小块：宽高必须【同时】很小（用 &&，避免误杀高度 <26px 的正常单行英文）；
    // 含 3 个以上连续字母 / 2 个以上 CJK 的短词也直接保留（"SURE"/"AREA"/"CHECK" 这类真词不丢）。
    function isTinyFragment(b) {
        const t = String(b.originalText || '').replace(/\s+/g, '');
        if (!t) return true;
        if (/[A-Za-z]{3,}/.test(t) || /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/.test(t)) return false;
        if (SHORT_KEEP.has(t.toUpperCase())) return false;
        return (b.w < 28 && b.h < 18);
    }

    function finalizeBlocks(blocks, W, H, bitmap) {
        if (!blocks || !blocks.length) return { blocks: [], width: W, height: H };
        // 1. 合并前先清洗单块乱码与极小噪点：避免一颗老鼠屎让合并后的整段台词被连坐丢弃
        const pre = [];
        for (const b of blocks) {
            if (!cleanOrFilterBySource(b)) { addLog('过滤', '丢弃纯乱码块: ' + String(b.originalText).slice(0, 24)); continue; }
            if (isTinyFragment(b)) { addLog('过滤', '丢弃微小碎片: ' + String(b.originalText).slice(0, 20) + ' ' + Math.round(b.w) + 'x' + Math.round(b.h)); continue; }
            pre.push(b);
        }
        if (!pre.length) return { blocks: [], width: W, height: H };

        // 2. 气泡分组（无气泡页返回 null，降级到行合并）
        let grouped = null;
        if (bitmap) {
            try { grouped = groupByBubbles(pre, bitmap, W, H); }
            catch (e) { addLog('气泡', '气泡检测失败，回退行合并: ' + (e && e.message || e), 'warn'); }
        }
        // 3. 气泡单元已经是一句，绝不能再与别的区域二次合并；只保守合并未归属气泡的 OCR 行。
        // 旧版在这里对全部结果 mergeBlocks(..., true)，等于把前一步的分区重新拆掉，
        // 属性面板四角文字会沿着中间标签逐步串成覆盖整图的一个大框。
        let merged;
        if (grouped) {
            const locked = grouped.filter(b => b._locked);
            const loose = grouped.filter(b => !b._locked);
            merged = locked.concat(mergeBlocks(loose, false));
            merged.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        } else {
            merged = mergeBlocks(pre, false);
        }

        const kept = [];
        for (const b of merged) {
            if (!cleanOrFilterBySource(b)) { addLog('过滤', '丢弃乱码块: ' + String(b.originalText).slice(0, 24)); continue; }
            if (isSfx(b.originalText)) continue;
            if (isNoiseText(b.originalText)) { addLog('过滤', '丢弃疑似噪声碎片: ' + String(b.originalText).slice(0, 24)); continue; }
            if (isUrlLike(b.originalText)) { addLog('过滤', '丢弃网址水印: ' + String(b.originalText).slice(0, 40)); continue; }
            kept.push(b);
        }
        return { blocks: kept, width: W, height: H };
    }

    // 把多行/多词块拼成通顺句子：先按视觉行分组（中心 y 相近），行内按 x 排序，行间按 y 排序。
    // 旧实现直接按 y 排序后 join，同一行被切成左右两块时右侧块会先入组，语序就颠倒了（7.45）。
    function joinSortedBlocks(members) {
        if (!members || !members.length) return '';
        const byY = members.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
        const lines = [];
        for (const m of byY) {
            const cy = m.y + m.h / 2;
            const last = lines[lines.length - 1];
            // OCR 字框可能把首行高度估得偏大；用较矮行作为阈值，避免相邻两行被当成同一行按 x 重排。
            if (last && Math.abs(cy - last.cy) <= Math.min(last.maxH, m.h) * 0.55) {
                last.items.push(m);
                last.maxH = Math.max(last.maxH, m.h);
                last.cy = (last.cy * (last.items.length - 1) + cy) / last.items.length;
            } else {
                lines.push({ cy, maxH: m.h, items: [m] });
            }
        }
        return joinLines(lines.map(line => {
            line.items.sort((a, b) => a.x - b.x);
            return joinLines(line.items.map(x => x.originalText));
        }));
    }

    // 判断两组是否属于同一段：同行左右相邻，或上下相邻且水平重叠/中心对齐（居中排版）
    function canMergeGroup(g, b, relax) {
        const lineH = Math.max(b.avgH || b.h, g.avgH || g.h, 12);
        const hRatio = Math.max(b.avgH || b.h, g.avgH || g.h) / Math.max(1, Math.min(b.avgH || b.h, g.avgH || g.h));
        if (hRatio > 2.1) return false;
        // ① 同一行被切成左右两块：水平间隙必须是词间距级（收紧，避免菱形左右角被并成一句）
        const overlapY = Math.min(b.y + b.h, g.y + g.h) - Math.max(b.y, g.y);
        if (overlapY > Math.min(b.h, g.h) * 0.35) {
            const hGap = Math.max(0, Math.max(b.x, g.x) - Math.min(b.x + b.w, g.x + g.w));
            if (hGap <= Math.max(lineH * 1.6, 32)) return true;
        }
        // ② 上下相邻行：要求真正的水平重叠，或按较窄行/字号严格居中。
        // 不能按较宽行的 0.7 倍判断，否则图表左右角标签会被中间长标签吸进去，并发生链式大合并。
        const vGap = Math.max(b.y - (g.y + g.h), g.y - (b.y + b.h));
        const maxGap = relax ? Math.max(16, lineH * 1.25) : Math.max(9, lineH * 0.8);
        if (vGap > maxGap) return false;
        const overlapX = Math.min(b.x + b.w, g.x + g.w) - Math.max(b.x, g.x);
        const minW = Math.min(b.w, g.w);
        const cx1 = g.x + g.w / 2, cx2 = b.x + b.w / 2;
        const centerAligned = Math.abs(cx1 - cx2) <= Math.max(lineH * 2.2, minW * 0.35);
        if (!(overlapX > Math.min(minW * 0.28, 24) || centerAligned)) return false;
        const unionW = Math.max(g.x + g.w, b.x + b.w) - Math.min(g.x, b.x);
        const maxW = Math.max(g.w, b.w);
        return unionW <= Math.max(maxW * 1.45, maxW + lineH * 3);
    }

    // 多遍收敛合并：单遍扫描漏合并会导致一句话碎成多块；最多 10 轮防死循环。
    function mergeBlocks(blocks, relax) {
        if (!blocks || blocks.length < 2) return blocks;
        let groups = blocks.map(b => ({
            x: b.x, y: b.y, w: b.w, h: b.h,
            avgH: b.avgH || b.h,
            members: b._members ? b._members.slice() : [{ originalText: b.originalText, x: b.x, y: b.y, w: b.w, h: b.h }]
        }));
        let changed = true, guard = 0;
        while (changed && guard++ < 10) {
            changed = false;
            groups.sort((a, b) => (a.y - b.y) || (a.x - b.x));
            const next = [];
            for (const b of groups) {
                let target = null;
                for (const g of next) { if (canMergeGroup(g, b, relax)) { target = g; break; } }
                if (target) {
                    const total = target.members.length + b.members.length;
                    target.avgH = (target.avgH * target.members.length + b.avgH * b.members.length) / total;
                    target.members.push(...b.members);
                    const nx = Math.min(target.x, b.x);
                    const ny = Math.min(target.y, b.y);
                    const nx2 = Math.max(target.x + target.w, b.x + b.w);
                    const ny2 = Math.max(target.y + target.h, b.y + b.h);
                    target.x = nx; target.y = ny; target.w = nx2 - nx; target.h = ny2 - ny;
                    changed = true;
                } else {
                    next.push(b);
                }
            }
            groups = next;
        }
        return groups.map(g => ({
            originalText: joinSortedBlocks(g.members),
            x: g.x, y: g.y, w: g.w, h: g.h,
            avgH: g.avgH
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

    /* ================================================================
     * 7.52 内置 OCR 引擎：YOLO 检测文字框 + Tesseract 逐框识别
     * 纯浏览器 WASM，不需要本地 Python 服务；模型首次点「下载模型」后存 IndexedDB。
     * ================================================================ */
    let ortLoading = null, tessLoading = null;
    const ortSessions = {};        // { best, 'preprocess-yolo' }
    let builtinBusy = false;

    function injectScript(urls) {
        const list = Array.isArray(urls) ? urls : [urls];
        return new Promise((resolve, reject) => {
            let i = 0;
            const next = () => {
                if (i >= list.length) { reject(new Error('运行时脚本加载失败')); return; }
                const url = list[i++];
                const el = document.createElement('script');
                el.src = url; el.async = true;
                el.onload = () => resolve(url);
                el.onerror = () => { el.remove(); next(); };
                (document.head || document.documentElement).appendChild(el);
            };
            next();
        });
    }

    // 运行时对象可能挂在三个地方：@require 注入的沙箱作用域、沙箱 window、页面真实 window。
    // 漫画站 CSP 普遍很严，往页面里插 <script src> 十有八九被 script-src 挡掉，
    // 所以首选 @require（Tampermonkey 层加载，不受页面 CSP 约束），运行时注入只当兜底。
    function pickGlobal(name) {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow[name]) return unsafeWindow[name];
        } catch (e) { }
        try { if (typeof window !== 'undefined' && window && window[name]) return window[name]; } catch (e) { }
        try {
            // eslint-disable-next-line no-eval
            const v = eval('typeof ' + name + ' !== "undefined" ? ' + name + ' : null');
            if (v) return v;
        } catch (e) { }
        return null;
    }

    function ortEnvReady(ort) {
        try {
            if (ort.env && ort.env.wasm) {
                ort.env.wasm.wasmPaths = RUNTIME_CDN.ortWasm;
                ort.env.wasm.numThreads = 1;   // 用户脚本环境通常没有 COOP/COEP，多线程会直接失败
                ort.env.wasm.simd = true;
            }
            if (ort.env) ort.env.logLevel = 'error';
        } catch (e) { }
        return ort;
    }

    async function ensureOrt() {
        const pre = pickGlobal('ort');
        if (pre && pre.InferenceSession) return ortEnvReady(pre);
        if (!ortLoading) {
            ortLoading = injectScript(RUNTIME_CDN.ort).then(() => {
                const got = pickGlobal('ort');
                if (!got || !got.InferenceSession) {
                    throw new Error('onnxruntime-web 未就绪（CDN 被 CSP 拦或网络不通）');
                }
                return ortEnvReady(got);
            }).catch(e => { ortLoading = null; throw e; });
        }
        return ortLoading;
    }

    async function ensureTesseract() {
        const pre = pickGlobal('Tesseract');
        if (pre && pre.createWorker) return pre;
        if (!tessLoading) {
            tessLoading = injectScript(RUNTIME_CDN.tess).then(() => {
                const got = pickGlobal('Tesseract');
                if (!got || !got.createWorker) {
                    throw new Error('tesseract.js 未就绪（CDN 被 CSP 拦或网络不通）');
                }
                return got;
            }).catch(e => { tessLoading = null; throw e; });
        }
        return tessLoading;
    }

    // ---- 模型缓存：IndexedDB 'mt52-onnx' / store 'models' ----
    function openModelDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('mt52-onnx', 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'key' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
        });
    }
    async function modelGet(key) {
        try {
            const db = await openModelDb();
            return await new Promise(resolve => {
                const r = db.transaction('models', 'readonly').objectStore('models').get(key);
                r.onsuccess = () => {
                    const rec = r.result;
                    if (!rec || !rec.data) { resolve(null); return; }
                    // 旧格式记录（没有 size 字段）没法验证完整性，一律丢弃重下 ——
                    // 用户手机上很可能就躺着上一版留下的半截文件，而它正是
                    // "protobuf parsing failed" 的源头。
                    if (typeof rec.size !== 'number') {
                        addLog('OCR', '缓存里的 ' + key + ' 是旧格式，无法校验，丢弃重下', 'warn');
                        resolve(null);
                        return;
                    }
                    if (rec.data.byteLength !== rec.size) {
                        addLog('OCR', '缓存里的 ' + key + ' 大小不符（' + rec.data.byteLength + '/' + rec.size + '），丢弃重下', 'warn');
                        resolve(null);
                        return;
                    }
                    if (rec.data.byteLength < 1024) { resolve(null); return; }
                    resolve(rec.data);
                };
                r.onerror = () => resolve(null);
            });
        } catch (e) { return null; }
    }
    async function modelPut(key, data) {
        const db = await openModelDb();
        return new Promise((resolve, reject) => {
            const r = db.transaction('models', 'readwrite').objectStore('models')
                .put({ key, data, size: data.byteLength, ts: Date.now() });
            r.onsuccess = () => resolve(true);
            r.onerror = () => reject(r.error);
        });
    }

    // ── base64 文本通道 ──
    // 有的手机版 TM 在把 HTTP 响应交给脚本时，会先按字符串解码一次再还原成字节，
    // 二进制里 >=0x80 的字节全被替换掉（1977 → 2485/2627 字节），信息不可逆丢失。
    // 纯 ASCII 的 base64 文本不会遇到这个问题，所以模型优先走 .b64。
    function decodeB64ToBuffer(text) {
        const clean = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
        const bin = atob(clean);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
        return out.buffer;
    }

    function fetchText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'text', timeout: 180000,
                onload: r => {
                    if (!(r.status >= 200 && r.status < 300)) { reject(new Error('HTTP ' + r.status + ' @ ' + url)); return; }
                    const t = r.responseText;
                    if (!t || t.length < 16) { reject(new Error('文本为空: ' + url)); return; }
                    resolve(t);
                },
                onerror: () => reject(new Error('下载失败（网络）: ' + url)),
                ontimeout: () => reject(new Error('下载超时: ' + url))
            });
        });
    }

    // 模型源候选：raw 直连优先（不消耗任何自建流量），不通再走加速，最后 jsdelivr。
    // 实测 jsdelivr 的 Range 不可靠（返回压缩整块），所以它排在最后只作兜底。
    const MODEL_MIRRORS = [
        'https://raw.githubusercontent.com/nihao8602/86-/main/models',
        'https://gh.860286.xyz/https://raw.githubusercontent.com/nihao8602/86-/main/models',
        'https://cdn.jsdelivr.net/gh/nihao8602/86-@main/models'
    ];

    // 分块 base64：大模型（best 有 10.5MB）单次文本响应会被截断，
    // 长度不是 4 的倍数后 atob 就报 "invalid characters"。切成 1MB 一段分别取。
    // ── Range 分块下载 base64 ──
    // 手机上大响应会被截断（14MB 文本切一半后 atob 直接报 invalid characters）。
    // 用 HTTP Range 每次只取 128KB，服务端必须回 206 + Content-Range，
    // 每片都校验起点/长度/字符集，坏一片就整批作废，不会把脏数据写进缓存。
    async function fetchB64ByRange(base, name, onProgress) {
        const url = base + '/' + name + '.onnx.b64';
        const CHUNK = 128 * 1024;
        const parts = [];
        let offset = 0;
        let total = null;

        addLog('OCR', 'Range 分块下载 ' + name + '.onnx.b64 …');

        while (total === null || offset < total) {
            const start = offset;
            const end = start + CHUNK - 1;

            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url,
                    headers: { Range: 'bytes=' + start + '-' + end },
                    responseType: 'text', timeout: 60000,
                    onload: r => resolve(r),
                    onerror: () => reject(new Error('小块下载失败 @' + start)),
                    ontimeout: () => reject(new Error('小块下载超时 @' + start))
                });
            });

            const hdr = String(res.responseHeaders || '');
            const m = /(?:^|\n)content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(hdr);
            if (res.status !== 206 || !m) {
                throw new Error('未收到有效 Content-Range（HTTP ' + res.status + '）');
            }

            const aStart = Number(m[1]), aEnd = Number(m[2]), size = Number(m[3]);
            const text = res.responseText;

            if (aStart !== start || aEnd < aStart || aEnd > end || size <= aEnd
                || (total !== null && total !== size)
                || typeof text !== 'string'
                || text.length !== aEnd - aStart + 1
                || !/^[A-Za-z0-9+/=]+$/.test(text)) {
                throw new Error('片段不完整或内容无效 @' + start
                    + '（实收 ' + (typeof text === 'string' ? text.length : 'null') + ' 字符）');
            }

            total = size;
            if (total > 100 * 1024 * 1024) throw new Error('文件异常：超过 100MB');

            parts.push(text);
            offset = aEnd + 1;
            if (onProgress) onProgress(offset, total);

            if (parts.length % 16 === 0 || offset === total) {
                addLog('OCR', '  Range ' + Math.round(offset / total * 100) + '%（' + offset + ' / ' + total + '）');
            }
        }

        const b64 = parts.join('');
        if (b64.length % 4 !== 0
            || /[^A-Za-z0-9+/=]/.test(b64)
            || /=/.test(b64.slice(0, -2))
            || /=[^=]/.test(b64)) {
            throw new Error('Base64 拼接后格式错误（长度 ' + b64.length + '）');
        }

        const buf = decodeB64ToBuffer(b64);
        addLog('OCR', '  Range 分块完成，解码后 ' + buf.byteLength + ' 字节');
        return buf;
    }

    async function fetchB64Chunks(base, name, onProgress) {
        const parts = [];
        let total = 0;
        for (let i = 0; i < 64; i++) {
            const idx = (i < 10 ? '0' : '') + i;
            let t = null;
            try {
                t = await fetchText(base + '/' + name + '.onnx.b64.' + idx);
            } catch (e) {
                break;   // 没有更多块了
            }
            if (!t) break;
            parts.push(t);
            total += t.length;
            addLog('OCR', '  分块 ' + idx + ' 已取 · 累计 ' + total + ' 字符');
            if (onProgress) onProgress(total, 0);
        }
        if (!parts.length) throw new Error('没有分块文件');
        return parts.join('');
    }

    // 依次尝试各个模型源，哪个成功用哪个
    async function fetchModelBuffer(base, name, onProgress) {
        const bases = [base].concat(MODEL_MIRRORS.filter(m => m !== base));
        let lastErr = null;
        for (let i = 0; i < bases.length; i++) {
            const b = bases[i];
            try {
                const host = b.replace(/^https?:\/\//, '').split('/')[0];
                addLog('OCR', '模型源[' + (i + 1) + '/' + bases.length + '] ' + host);
                return await fetchModelFromOne(b, name, onProgress);
            } catch (e) {
                lastErr = e;
                addLog('OCR', '  该源失败（' + (e && e.message || e) + '），换下一个', 'warn');
            }
        }
        throw lastErr || new Error('所有模型源都不可用');
    }

    async function fetchModelFromOne(base, name, onProgress) {
        // 已知模型的长度与 SHA-256（改模型文件必须同步更新这三个数）
        const specs = {
            'preprocess-yolo': {
                chars: 2636,
                bytes: 1977,
                sha: '70e9c52222b37c5c7cc172da149da0471ce6fbdc7ace70adfa6b6c79f56ee14b'
            },
            best: {
                chars: 14111256,
                bytes: 10583440,
                sha: 'be1b6534b6311fdcb760c789302e932779775aad70d1ce4a4c6e580033e85e4d'
            }
        };
        const spec = specs[name];
        if (!spec) throw new Error('未知模型：' + name);
        if (!globalThis.crypto || !globalThis.crypto.subtle) {
            throw new Error('无法校验模型，请在 HTTPS 漫画页面运行');
        }

        const parts = [];
        const chunk = 128 * 1024;
        const url = base.replace(/\/+$/, '') + '/' + name + '.onnx.b64';
        addLog('OCR', '小块下载并校验模型：' + name);

        for (let start = 0; start < spec.chars; start += chunk) {
            const end = Math.min(start + chunk, spec.chars) - 1;
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url,
                    headers: { Range: 'bytes=' + start + '-' + end },
                    responseType: 'text', timeout: 60000,
                    onload: resolve,
                    onerror: () => reject(new Error('下载失败，位置 ' + start)),
                    ontimeout: () => reject(new Error('下载超时，位置 ' + start))
                });
            });

            const text = typeof res.responseText === 'string' ? res.responseText : res.response;

            // 诊断信息改到校验失败时输出（见下方 catch 分支）

            // 小模型只有一段，服务器直接返回整文件（200）也接受
            const fullSmallFile = start === 0 && end === spec.chars - 1;
            if (Number(res.status) !== 206 && !(fullSmallFile && Number(res.status) === 200)) {
                throw new Error('范围请求失败：HTTP ' + res.status);
            }

            // 不依赖 Content-Range：每段长度和字符集自己校验
            if (typeof text !== 'string'
                || text.length !== end - start + 1
                || /[^A-Za-z0-9+/=]/.test(text)) {
                // 只在出问题时才输出诊断，平时不刷屏。
                // 已知：iOS 的 Gear 浏览器会把响应重新编码，131072 字节变成 237290 字符；
                // Safari + Userscripts 正常。遇到这种情况建议换 Safari。
                try {
                    addLog('OCR', '【诊断】HTTP ' + res.status
                        + ' · 期望 ' + (end - start + 1)
                        + ' 实收 ' + (typeof text === 'string' ? text.length : '非文本')
                        + ' · responseText=' + Object.prototype.toString.call(res.responseText)
                        + ' · response=' + Object.prototype.toString.call(res.response), 'error');
                    if (typeof text === 'string') {
                        addLog('OCR', '【诊断】开头 ' + JSON.stringify(text.slice(0, 80))
                            + ' · 非Base64字符 ' + (text.match(/[^A-Za-z0-9+/=]/g) || []).length, 'error');
                    }
                    addLog('OCR', '【诊断】响应头 ' + JSON.stringify(res.responseHeaders).slice(0, 300), 'error');
                    addLog('OCR', '【建议】如果你在 iOS 的 Gear 等浏览器里，请改用 Safari + Userscripts，那些浏览器的网络层会破坏二进制数据', 'warn');
                } catch (e3) { }
                throw new Error('模型片段不完整，位置 ' + start
                    + '，应收 ' + (end - start + 1)
                    + '，实收 ' + (typeof text === 'string' ? text.length : '非文本'));
            }

            parts.push(text);
            if (onProgress) onProgress(end + 1, spec.chars);
            if (parts.length % 16 === 0 || end + 1 === spec.chars) {
                addLog('OCR', '  下载进度 ' + Math.round((end + 1) / spec.chars * 100) + '%');
            }
        }

        const buf = decodeB64ToBuffer(parts.join(''));
        if (buf.byteLength !== spec.bytes) {
            throw new Error('模型解码后的长度错误（' + buf.byteLength + ' / ' + spec.bytes + '）');
        }

        // 即使服务器返回错位或重复片段，也会在这里被拦住
        const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
        const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        if (hash !== spec.sha) {
            throw new Error('模型校验失败：下载内容不一致（' + hash.slice(0, 16) + '…），不要使用该缓存');
        }

        addLog('OCR', name + ' 校验通过：' + buf.byteLength + ' 字节');
        return buf;
    }

    // 校验拿到的字节真的是 ONNX。
    // ONNX 是 protobuf：首字节一般是 0x08（field1 = ir_version, varint）。
    // 如果拿到的是网页 / JSON / zip，首字节会是 '<' '{' '[' 'P' 这类可打印字符。
    function assertOnnx(buf, name) {
        if (!buf || typeof buf.byteLength !== 'number') throw new Error(name + ' 不是二进制');
        // preprocess-yolo.onnx 实际只有 ~2KB，别拿 4KB 当门槛误杀正常文件
        if (buf.byteLength < 512) throw new Error(name + ' 太小（' + buf.byteLength + ' 字节）');
        const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
        const printable = head[0] === 0x3C || head[0] === 0x7B || head[0] === 0x5B || head[0] === 0x50 || head[0] === 0xEF || head[0] === 0x22;
        if (printable) {
            // 把开头一小段当文本打出来：能一眼看出是错误页、JSON 报错，还是二进制被编码坏了
            let preview = '';
            try {
                preview = new TextDecoder('utf-8', { fatal: false })
                    .decode(new Uint8Array(buf, 0, Math.min(120, buf.byteLength)))
                    .replace(/[\x00-\x1f]/g, '.');
            } catch (e) { }
            addLog('OCR', '  内容开头：' + preview);
            throw new Error(name + ' 下载到的不是 ONNX（首字节 0x' + head[0].toString(16) + '）');
        }
        return buf;
    }

    function fetchBinary(url, onProgress) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                // 手机上用 responseType:'arraybuffer' 偶发拿到内容损坏的缓冲区
                // （长度对、字节错），存进 IndexedDB 后就是永久的 protobuf parsing failed。
                // 改走 blob：二进制由浏览器自己托管，再 arrayBuffer() 取出来更可靠。
                // 这个 CDN 的响应没有 Content-Type 头，用 blob 时 TM 会按文本处理，
                // 二进制被 UTF-8 解码（0x08→、0x12→?），信息就永久丢了。
                // arraybuffer 拿的是原始字节，不看 Content-Type；再显式覆盖 MIME 双保险。
                responseType: 'arraybuffer',
                overrideMimeType: 'application/octet-stream',
                timeout: 180000,
                onprogress: e => { if (onProgress && e.loaded) onProgress(e.loaded, e.total || 0); },
                onload: r => {
                    if (!(r.status >= 200 && r.status < 300)) {
                        reject(new Error('HTTP ' + r.status + ' @ ' + url));
                        return;
                    }
                    const resp = r.response;
                    const hdr = String(r.responseHeaders || '');
                    const m = /content-length:\s*(\d+)/i.exec(hdr);
                    const expected = m ? parseInt(m[1], 10) : 0;

                    const finish = (buf) => {
                        try {
                            if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength < 1024) {
                                reject(new Error('下载到的不是有效二进制（' + (buf ? buf.byteLength : 'null') + ' 字节）'));
                                return;
                            }
                            // 只判断“明显少了”；gzip 时 Content-Length 是压缩后大小
                            if (expected > 0 && buf.byteLength < expected * 0.98) {
                                reject(new Error('下载不完整：' + buf.byteLength + ' / ' + expected + ' 字节（网络中断？）'));
                                return;
                            }
                            const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
                            addLog('OCR', '  下载完成 ' + buf.byteLength + ' 字节，首字节 '
                                + Array.prototype.map.call(head, b => '0x' + b.toString(16)).join(' '));
                            resolve(buf);
                        } catch (e) { reject(e); }
                    };

                    const kind = Object.prototype.toString.call(resp);
                    addLog('OCR', '  响应类型 ' + kind
                        + '  size=' + (resp && resp.size !== undefined ? resp.size : (resp && resp.byteLength))
                        + ' type=' + (resp && resp.type !== undefined ? (resp.type || '(空)') : '?'));

                    // TM 有的版本会直接给 Uint8Array，别当成不认识丢掉了
                    if (resp && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(resp)) {
                        finish(resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength));
                        return;
                    }
                    if (resp instanceof ArrayBuffer) {
                        finish(resp);
                        return;
                    }
                    if (resp && typeof Blob !== 'undefined' && resp instanceof Blob) {
                        try {
                            const fr = new FileReader();
                            fr.onload = () => finish(fr.result);
                            fr.onerror = () => reject(new Error('FileReader 读取失败'));
                            fr.readAsArrayBuffer(resp);
                        } catch (e) {
                            reject(new Error('读取 blob 失败: ' + (e && e.message || e)));
                        }
                        return;
                    }
                    reject(new Error('拿到的既不是 ArrayBuffer 也不是 Blob，而是 ' + kind));
                },
                onerror: () => reject(new Error('下载失败（网络）: ' + url)),
                ontimeout: () => reject(new Error('下载超时: ' + url))
            });
        });
    }

    // 下载/读取两个检测模型，返回 { best: ArrayBuffer, 'preprocess-yolo': ArrayBuffer }
    async function ensureModelBuffers(onProgress) {
        const base = String(apiConfig.builtinModelBase || '').replace(/\/+$/, '');
        const out = {};
        for (const name of BUILTIN_MODELS) {
            let buf = await modelGet(name);
            if (!buf) {
                buf = await fetchModelBuffer(base, name,
                    (loaded, total) => onProgress && onProgress(name, loaded, total));
                // 存之前先确认是 ONNX，坏数据绝不进缓存（否则下次还会读出来报同一个错）
                assertOnnx(buf, name);
                await modelPut(name, buf);
            }
            out[name] = buf;
            apiConfig.modelsReady[name] = true;
        }
        return out;
    }

    async function ensureOrtSessions() {
        if (ortSessions.best && ortSessions['preprocess-yolo']) return ortSessions;
        await ensureOrt();
        const ort = pickGlobal('ort');
        let bufs = await ensureModelBuffers();
        try {
            if (!ortSessions['preprocess-yolo']) {
                ortSessions['preprocess-yolo'] = await ort.InferenceSession.create(bufs['preprocess-yolo']);
            }
            if (!ortSessions.best) {
                ortSessions.best = await ort.InferenceSession.create(bufs['best']);
            }
        } catch (e) {
            // 模型文件坏了（手机上最常见：下载中断后存进 IndexedDB 的半截数据）。
            // 清掉缓存重新下载一次，只重试这一轮，避免死循环。
            addLog('OCR', '模型加载失败：' + (e && e.message || e), 'warn');
            addLog('OCR', '清除本地模型缓存，重新下载一次…', 'warn');
            await clearBuiltinModels();
            bufs = await ensureModelBuffers();
            ortSessions['preprocess-yolo'] = await ort.InferenceSession.create(bufs['preprocess-yolo']);
            ortSessions.best = await ort.InferenceSession.create(bufs['best']);
            addLog('OCR', '重下后加载成功');
        }
        return ortSessions;
    }

    // ---- YOLO：letterbox 预处理（缩放校准，移植自官方 N3）----
    async function yoloPreprocess(prepSession, srcTensor, padTensor, scaleW, scaleH, depth) {
        depth = depth || 0;
        if (depth > 40) throw new Error('预处理未收敛');
        const ort = pickGlobal('ort');
        const scales = new ort.Tensor('float32', new Float32Array([scaleW, scaleH]));
        const { letterbox } = await prepSession.run({ images: srcTensor, padding: padTensor, scales });
        const side = letterbox.dims[3];
        if (side === 640) return letterbox;
        const adjust = side > 640 ? -5e-4 : 5e-4;
        return yoloPreprocess(prepSession, srcTensor, padTensor, scaleW + adjust, scaleH + adjust, depth + 1);
    }

    function boxIoU(a, b) {
        const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
        const ix = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
        const iy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
        if (ix <= 0 || iy <= 0) return 0;
        const inter = ix * iy;
        const areaA = aw * ah, areaB = bw * bh;
        if (Math.abs(inter / Math.max(1, Math.min(areaA, areaB))) >= 0.9) return 1;  // 完全包含视为同框
        return inter / Math.max(1, areaA + areaB - inter);
    }

    function yoloNms(boxes, thr) {
        boxes.sort((a, b) => b.area - a.area);
        const keep = [];
        const used = new Array(boxes.length).fill(false);
        for (let i = 0; i < boxes.length; i++) {
            if (used[i]) continue;
            keep.push(boxes[i]); used[i] = true;
            for (let j = i + 1; j < boxes.length; j++) {
                if (used[j]) continue;
                if (boxIoU(boxes[i].bounding, boxes[j].bounding) > thr) used[j] = true;
            }
        }
        return keep;
    }

        // 单块检测：把 bitmap 的 [y0, y0+h) 这条送进 YOLO，返回相对该条的框
    async function yoloDetectChunk(ort, sess, bitmap, y0, h) {
        const W = bitmap.width;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = h;
        const sctx = canvas.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(bitmap, 0, y0, W, h, 0, 0, W, h);

        // 手工构造 RGB / NCHW 张量。ort.Tensor.fromImage 对 canvas 的支持在不同版本不一致，
        // 会抛 "Input data provided is not supported - aborted tensor creation"，读像素自己拼最稳。
        const rgba = sctx.getImageData(0, 0, W, h).data;
        const plane = W * h;
        const rgb = new Float32Array(plane * 3);
        for (let i = 0, p = 0; i < rgba.length; i += 4) {
            rgb[p] = rgba[i] / 255;
            rgb[p + plane] = rgba[i + 1] / 255;
            rgb[p + plane * 2] = rgba[i + 2] / 255;
            p++;
        }
        const tensor = new ort.Tensor('float32', rgb, [1, 3, h, W]);

        const dims = tensor.dims;
        const th = dims[2], tw = dims[3];
        const inH = YOLO_INPUT[2], inW = YOLO_INPUT[3];
        const maxSide = Math.max(tw, th);
        const padW = maxSide - tw, padH = maxSide - th;
        const padL = Math.floor(padW / 2), padR = padW - padL;
        const padT = Math.floor(padH / 2), padB = padH - padT;
        const padTensor = new ort.Tensor('int64',
            new BigInt64Array([padT, padL, padB, padR].map(v => BigInt(v))));
        const scaleW = inW / maxSide, scaleH = inH / maxSide;

        const letterbox = await yoloPreprocess(sess['preprocess-yolo'], tensor, padTensor, scaleW, scaleH);
        const { output0 } = await sess.best.run({ images: letterbox });

        const stride = output0.dims[2];
        const data = output0.data;
        const boxes = [];
        for (let i = 0; i < stride; i++) {
            const conf = data[i + stride * 4];
            if (conf < YOLO_CONF) continue;
            const cx = data[i] / scaleW - padL;
            const cy = data[i + stride] / scaleH - padT;
            const bw = data[i + stride * 2] / scaleW;
            const bh = data[i + stride * 3] / scaleH;
            if (!(bw > 0 && bh > 0)) continue;
            const x = Math.max(Math.round(cx - bw / 2), 2);
            const y = Math.max(Math.round(cy - bh / 2), 2);
            const w = Math.round(bw), hh = Math.round(bh);
            if (w < 6 || hh < 6) continue;
            boxes.push({ label: 0, probability: conf, area: w * hh, bounding: [x, y, w, hh] });
        }
        return boxes;
    }

    // 整图检测：长条漫画不能整张塞进 640x640 —— 文字会被压成几个像素，一框都出不来。
    // 按「接近正方形」切块（块高 ≈ 图宽），每块单独检测，再统一做 NMS。
    async function yoloDetect(bitmap) {
        const ort = await ensureOrt();
        const sess = await ensureOrtSessions();
        const W = bitmap.width, H = bitmap.height;

        const CHUNK = Math.max(640, Math.min(1280, W));
        const OVERLAP = Math.min(80, Math.floor(CHUNK * 0.1));
        const step = Math.max(1, CHUNK - OVERLAP);
        const chunks = [];
        for (let y0 = 0; y0 < H; y0 += step) {
            const h = Math.min(CHUNK, H - y0);
            chunks.push({ y0, h });
            if (y0 + h >= H) break;
        }
        if (chunks.length > 1) {
            addLog('OCR', '长图分 ' + chunks.length + ' 块检测（块高 ' + CHUNK + 'px · 重叠 ' + OVERLAP + 'px）');
        }

        const all = [];
        const CONC = 2;
        let idx = 0;
        const worker = async () => {
            while (idx < chunks.length) {
                if (stopRequested) return;
                const c = chunks[idx++];
                const boxes = await yoloDetectChunk(ort, sess, bitmap, c.y0, c.h);
                for (const b of boxes) {
                    b.bounding[1] += c.y0;
                    b.area = b.bounding[2] * b.bounding[3];
                }
                for (const b of boxes) all.push(b);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONC, chunks.length) }, worker));
        return yoloNms(all, YOLO_NMS);
    }

    // ---- Tesseract：复用同一个 worker 逐框识别（官方是每框重建 worker，这里快很多）----
    function enhanceForOcr(canvas) {
        // 反相白字 → 黑字白底 + 轻度对比度拉伸，Tesseract 对白底黑字最敏感
        try {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = img.data;
            let sum = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
            const avg = n ? sum / n : 255;
            const invert = avg < 120;                            // 深色底（黑底白字）
            for (let i = 0; i < d.length; i += 4) {
                let v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
                if (invert) v = 255 - v;
                v = v < 128 ? Math.max(0, v - 40) : Math.min(255, v + 40);
                d[i] = d[i + 1] = d[i + 2] = v;
                d[i + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
        } catch (e) { }
        return canvas;
    }

        // ── 7.52：把 Tesseract 的 worker / core 脚本先抓下来转成同源 blob URL ──
    // 漫画站 CSP 普遍是 worker-src 'self'，直接 new Worker(cdnUrl) 会被拒：
    //   "Failed to construct 'Worker': Script at ... cannot be accessed from origin ..."
    // GM_xmlhttpRequest 不受页面 CSP 约束，取回文本来自己造 blob 就行。
    let tessWorkerBlob = null, tessCoreBlob = null;

    function fetchTextViaGM(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 60000,
                onload: r => {
                    if (r.status >= 200 && r.status < 300 && typeof r.responseText === 'string') resolve(r.responseText);
                    else reject(new Error('HTTP ' + r.status + ' @ ' + url));
                },
                onerror: () => reject(new Error('拉取失败: ' + url)),
                ontimeout: () => reject(new Error('超时: ' + url))
            });
        });
    }

    async function tessBlobUrls() {
        if (tessWorkerBlob && tessCoreBlob) return { worker: tessWorkerBlob, core: tessCoreBlob };
        if (!tessWorkerBlob) {
            const txt = await fetchTextViaGM(RUNTIME_CDN.tessWorker);
            tessWorkerBlob = URL.createObjectURL(new Blob([txt], { type: 'application/javascript' }));
            addLog('OCR', 'Tesseract worker 已转同源 blob（' + Math.round(txt.length / 1024) + 'KB）');
        }
        if (!tessCoreBlob) {
            const txt = await fetchTextViaGM(RUNTIME_CDN.tessCore);
            // Tesseract 5 treats corePath without a .js suffix as a directory.
            // A URL fragment preserves the blob resource while marking it as a script.
            tessCoreBlob = URL.createObjectURL(new Blob([txt], { type: 'application/javascript' })) + '#tesseract-core-simd-lstm.wasm.js';
            addLog('OCR', 'Tesseract core 已转同源 blob（' + Math.round(txt.length / 1024) + 'KB）');
        }
        return { worker: tessWorkerBlob, core: tessCoreBlob };
    }

    // 从 Tesseract 结果里取「行」。v4 放在 data.lines，v5 改成
    // data.blocks[].paragraphs[].lines[]，两种结构都兼容。
    function extractTessLines(data) {
        if (!data) return [];
        if (Array.isArray(data.lines) && data.lines.length) return data.lines;
        const acc = [];
        if (Array.isArray(data.blocks)) {
            for (const blk of data.blocks) {
                if (!blk) continue;
                for (const para of (blk.paragraphs || [])) {
                    if (!para) continue;
                    for (const ln of (para.lines || [])) if (ln) acc.push(ln);
                }
            }
        }
        return acc;
    }

    async function tessRecognizeBoxes(bitmap, boxes, langCode) {
        const T = await ensureTesseract();
        const W = bitmap.width, H = bitmap.height;
        const full = document.createElement('canvas');
        full.width = W; full.height = H;
        full.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);

        let worker = null;
        const out = [];
        try {
            const blobs = await tessBlobUrls();
            worker = await T.createWorker(langCode, 1, {
                workerPath: blobs.worker,
                corePath: blobs.core,
                langPath: RUNTIME_CDN.tessLang,
                workerBlobURL: false,   // 已经是 blob URL 了，别再包一层
                // 不设 cacheMethod（默认 write）：语言包会落到 IndexedDB，第二次起不用再下载，
                // 这也是「下载模型后离线可用」这个提示能成立的前提。原来写死 'none' 是每次重下。
                logger: () => { }
            });
            for (const box of boxes) {
                const [x, y, w, h] = box.bounding;
                const padX = Math.max(2, Math.round(w * 0.04));
                const padY = Math.max(2, Math.round(h * 0.08));
                const sx = Math.max(0, x - padX), sy = Math.max(0, y - padY);
                const sw = Math.min(W - sx, w + padX * 2), sh = Math.min(H - sy, h + padY * 2);
                if (sw < 4 || sh < 4) continue;
                const c = document.createElement('canvas');
                c.width = sw; c.height = sh;
                c.getContext('2d', { willReadFrequently: true }).drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
                enhanceForOcr(c);
                let text = '';
                let lines = [];
                try {
                    // 显式要 blocks：只拿 data.text 的话，「一整段文字 + 一整个大框」会直接
                    // 输出给后面的聚类，两个气泡被 YOLO 圈进同一个框就再也拆不回来了。
                    let r = null;
                    try {
                        r = await worker.recognize(c, {}, { blocks: true, text: true });
                    } catch (e2) {
                        r = await worker.recognize(c);   // 老版本不认 output 参数时退回默认
                    }
                    const data = (r && r.data) || {};
                    text = String(data.text || '').replace(/\s+/g, ' ').trim();
                    lines = extractTessLines(data);
                } catch (e) { text = ''; }

                // 行级输出：每行单独成块，坐标从裁剪图换算回原图
                let pushed = 0;
                for (const ln of lines) {
                    const bb = ln && ln.bbox;
                    const lt = String((ln && ln.text) || '').replace(/\s+/g, ' ').trim();
                    if (!bb || !lt) continue;
                    const rawX = sx + Math.max(0, Math.round(bb.x0 || 0));
                    const rawY = sy + Math.max(0, Math.round(bb.y0 || 0));
                    if (rawX >= W || rawY >= H) continue;
                    const lw = Math.max(1, Math.min(Math.round((bb.x1 || 0) - (bb.x0 || 0)), W - rawX));
                    const lh = Math.max(1, Math.min(Math.round((bb.y1 || 0) - (bb.y0 || 0)), H - rawY));
                    if (lw < 4 || lh < 4) continue;
                    out.push({ originalText: lt, x: rawX, y: rawY, w: lw, h: lh });
                    pushed++;
                }
                // 拿不到行级数据时才退回整块（保持旧行为，不至于完全没输出）
                if (!pushed && text) {
                    out.push({ originalText: text, x, y, w, h });
                }
                if (MT_DEBUG_OCR) {
                    addLog('OCR', '框(' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(w) + ',' + Math.round(h) +
                        ') 行=' + lines.length + ' 采用=' + pushed + ' 文字=' + text.slice(0, 40));
                }
            }
        } finally {
            if (worker) { try { await worker.terminate(); } catch (e) { } }
        }
        return out;
    }

    // #3：内置引擎每个任务都会建一个 Tesseract worker（几十 MB 内存），
    // 不设上限时"尽快"模式会同时开十几个，手机直接卡死。这里串行化。
    let builtinActive = 0;
    const BUILTIN_CONC = 1;

    async function builtinOcr(bitmap) {
        while (builtinActive >= BUILTIN_CONC) {
            if (stopRequested) throw new Error('已停止');
            await sleep(150);
        }
        builtinActive++;
        try {
            return await builtinOcrInner(bitmap);
        } finally {
            builtinActive--;
        }
    }

    async function builtinOcrInner(bitmap) {
        const t0 = Date.now();
        const boxes = await yoloDetect(bitmap);
        addLog('OCR', '内置检测 ' + boxes.length + ' 个文字框 · ' + (Date.now() - t0) + 'ms');
        const lang = (TESS_LANGS[apiConfig.builtinLang] || TESS_LANGS.eng).code;
        const t1 = Date.now();
        const blocks = await tessRecognizeBoxes(bitmap, boxes, lang);
        addLog('OCR', '内置识别 ' + blocks.length + ' 段（' + lang + '）· ' + (Date.now() - t1) + 'ms');
        return { blocks, width: bitmap.width, height: bitmap.height };
    }

    // 面板「下载模型」按钮用：检测模型 + Tesseract 语言包全部就绪才算成功。
    // 原来只准备了检测模型，语言包要等第一次识别才下载，所以按钮显示"就绪"其实不能离线用。
    async function prepareBuiltinOcr(onStatus) {
        if (builtinBusy) throw new Error('正在准备中');
        builtinBusy = true;
        try {
            onStatus && onStatus('加载运行时 onnxruntime-web …');
            await ensureOrt();
            onStatus && onStatus('检查 / 下载检测模型 …');
            await ensureOrtSessions();

            // 预热 Tesseract：建一个 worker 再销毁，逼它把语言包写进 IndexedDB
            const lang = (TESS_LANGS[apiConfig.builtinLang] || TESS_LANGS.eng).code;
            onStatus && onStatus('下载识别语言包（' + lang + '）…');
            try {
                const T = await ensureTesseract();
                const blobs = await tessBlobUrls();
                const w = await T.createWorker(lang, 1, {
                    workerPath: blobs.worker,
                    corePath: blobs.core,
                    langPath: RUNTIME_CDN.tessLang,
                    workerBlobURL: false,
                    logger: () => { }
                });
                try { await w.terminate(); } catch (e) { }
                addLog('OCR', '语言包已缓存：' + lang);
            } catch (e) {
                throw new Error('语言包准备失败：' + (e && e.message || e));
            }

            onStatus && onStatus('就绪（检测模型 + 语言包均已缓存）');
            return true;
        } finally {
            builtinBusy = false;
        }
    }

    async function clearBuiltinModels() {
        try {
            const db = await openModelDb();
            await new Promise(resolve => {
                const r = db.transaction('models', 'readwrite').objectStore('models').clear();
                r.onsuccess = () => resolve(true); r.onerror = () => resolve(false);
            });
        } catch (e) { }
        for (const k in ortSessions) { try { ortSessions[k].release && ortSessions[k].release(); } catch (e) { } delete ortSessions[k]; }
        apiConfig.modelsReady = {};
        return true;
    }

    /* ================================================================
     * 7.52 排版引擎（移植自沉浸式翻译的 uB / cB）
     *  - 中英混排断行：CJK 逐字、拉丁按词
     *  - 避标点行首、孤字行并入上一行
     *  - 字号自适应：按框面积估初值，再上下微调到既放得下又尽量大
     *  - 配色：框内像素做 16 阶量化直方图取主色，按亮度反差自动决定文字色
     * ================================================================ */
    const CJK_RE = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
    const PUNCT_HEAD_RE = /^[，。！？、：；'"（）【】《》「」『』,.!?:;"()[\]<>]/;

    const Typeset = {
        MIN_FONT_SIZE: 8,
        MAX_FONT_SIZE: 200,
        FONT_STEP: 1,
        V_PADDING: 2,
        H_PADDING: 2,

        isCJK(ch) { return CJK_RE.test(ch); },

        splitText(text) {
            const out = [];
            let buf = '';
            for (const ch of String(text || '')) {
                if (this.isCJK(ch)) { if (buf) { out.push(buf); buf = ''; } out.push(ch); }
                else if (ch === ' ') { if (buf) { out.push(buf); buf = ''; } }
                else buf += ch;
            }
            if (buf) out.push(buf);
            return out;
        },

        breakLines(ctx, text, maxWidth, avoidPunct) {
            const parts = this.splitText(text);
            const lines = [];
            let cur = '', prev = '';
            for (const p of parts) {
                const needSpace = cur !== '' && !this.isCJK(prev) && !this.isCJK(p);
                const cand = cur + (needSpace ? ' ' : '') + p;
                prev = p;
                if (ctx.measureText(cand).width > maxWidth && cur !== '') { lines.push(cur); cur = p; }
                else cur = cand;
            }
            if (cur) lines.push(cur);
            if (!avoidPunct) return lines;

            // 避头尾：标点不放行首。先试着把标点并到上一行；上一行已经排满
            // （并入后超宽）时改用「追字法」——把上一行末字挪到下一行开头，给它腾位置。
            for (let i = 0; i < lines.length - 1; i++) {
                const nextLine = lines[i + 1];
                if (!nextLine || !PUNCT_HEAD_RE.test(nextLine)) continue;
                const p = nextLine[0], curLine = lines[i], rest = nextLine.slice(1);
                const merged = curLine + p;
                if (ctx.measureText(merged).width <= maxWidth * 1.1) {
                    lines[i] = merged;
                    lines[i + 1] = rest || ' ';
                    continue;
                }
                if (curLine.length > 1) {
                    const moved = curLine.slice(-1);
                    const shorter = curLine.slice(0, -1);
                    const newNext = moved + nextLine;
                    if (ctx.measureText(shorter).width <= maxWidth * 1.1
                        && ctx.measureText(newNext).width <= maxWidth * 1.15) {
                        lines[i] = shorter;
                        lines[i + 1] = newNext;
                    }
                }
            }
            // 孤字行：尾行 1~2 字并入上一行
            if (lines.length >= 2) {
                const last = lines[lines.length - 1];
                const orphan = last.length === 1
                    || (last.length === 2 && !this.isCJK(last[0]) && !this.isCJK(last[1]))
                    || (last.length === 2 && this.isCJK(last[0]) && PUNCT_HEAD_RE.test(last[1]));
                if (orphan) {
                    const prevLine = lines[lines.length - 2];
                    const needSpace = !this.isCJK(prevLine.slice(-1)) && !this.isCJK(last[0]);
                    const merged = prevLine + (needSpace ? ' ' : '') + last;
                    if (ctx.measureText(merged).width <= maxWidth * 1.1) lines.splice(-2, 2, merged);
                }
            }
            return lines;
        },

        // 把一句译文画进 box；返回是否画成功
        draw(ctx, text, box, style, opt) {
            opt = opt || {};
            const family = opt.fontFamily || '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
            const innerW = Math.max(8, box.w - this.H_PADDING * 2);
            const innerH = Math.max(8, box.h);
            const maxFont = Math.min(opt.maxFont || this.MAX_FONT_SIZE,
                Math.max(this.MIN_FONT_SIZE, Math.floor(innerH / 1.2)));
            const avoidPunct = opt.avoidPunct !== false;

            // 背景：主色填充（官方客户端的「擦除」就是这一步）
            if (opt.fill !== false && style && style.primary) {
                ctx.fillStyle = style.primary;
                ctx.fillRect(box.x, box.y, box.w, box.h);
            }

            const trySize = (s) => {
                ctx.font = s + 'px ' + family;
                const ls = this.breakLines(ctx, text, innerW, avoidPunct);
                return { ls, fit: ls.length * s * 1.2 + this.V_PADDING * 2 <= innerH };
            };

            // 初值：面积开方估
            const n = Math.max(1, String(text || '').length);
            let guess = Math.sqrt((box.w * box.h) / n) * 0.7;
            guess = Math.max(this.MIN_FONT_SIZE, Math.min(guess, maxFont, box.h / 2));
            let size = 0, lines = null;

            // 先往上放大到刚好放不下
            const start = Math.max(this.MIN_FONT_SIZE, Math.floor(guess));
            let best = null;
            for (let s = start; s <= maxFont; s += this.FONT_STEP) {
                const r = trySize(s);
                if (!r.fit) break;
                best = { s, ls: r.ls };
                if (s === maxFont) break;
            }
            if (best) { size = best.s; lines = best.ls; }
            else {
                for (let s = start; s >= this.MIN_FONT_SIZE; s -= this.FONT_STEP) {
                    const r = trySize(s);
                    if (r.fit) { size = s; lines = r.ls; break; }
                    if (s - this.FONT_STEP < this.MIN_FONT_SIZE) { size = s; lines = r.ls; }
                }
            }
            if (!lines || !lines.length) return false;

            ctx.font = size + 'px ' + family;
            ctx.textBaseline = 'top';
            ctx.textAlign = opt.align === 'left' ? 'left' : (opt.align === 'right' ? 'right' : 'center');
            ctx.direction = opt.rtl ? 'rtl' : 'ltr';
            ctx.fillStyle = (style && style.secondary) || '#111';
            const lineH = size * 1.2;
            const totalH = lines.length * lineH;
            let ty = box.y + (box.h - totalH) / 2;
            const tx = opt.align === 'left' ? box.x + this.H_PADDING
                : opt.align === 'right' ? box.x + box.w - this.H_PADDING
                    : box.x + box.w / 2;
            for (const line of lines) {
                ctx.fillText(line, tx, ty);
                ty += lineH;
            }
            return true;
        }
    };

    // 框内主色/次色（16 阶量化直方图，移植自官方 cB）
    function analyzeBoxColors(ctx, box, hasText) {
        if (!hasText) return { primary: null, secondary: null };
        const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
        const w = Math.max(1, Math.min(Math.floor(box.w), 4096));
        const h = Math.max(1, Math.min(Math.floor(box.h), 4096));
        let data;
        try { data = ctx.getImageData(x, y, w, h).data; } catch (e) { return { primary: null, secondary: null }; }
        const hist = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const key = (Math.round(data[i] / 16) * 16) + ',' + (Math.round(data[i + 1] / 16) * 16) + ',' + (Math.round(data[i + 2] / 16) * 16);
            hist.set(key, (hist.get(key) || 0) + 1);
        }
        if (!hist.size) return { primary: null, secondary: null };
        const top = [...hist.entries()].sort((a, b) => b[1] - a[1])[0];
        const [r, g, b] = top[0].split(',').map(Number);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        return {
            primary: 'rgb(' + top[0] + ')',
            secondary: lum > 140 ? 'rgb(24,24,24)' : 'rgb(246,246,246)'
        };
    }

    function loadImageEl(src) {
        return new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => resolve(null);
            im.src = src;
        });
    }

    // Canvas 整图重绘：在原图上按框填主色 + 画译文，替换 <img> 的内容
    async function renderCanvasOverlay(img, blocks, refW, refH) {
        // 二次渲染保护：已经用 canvas 结果替换过 src 的图，不能再拿它当底图叠加一次
        if (img.dataset.mtCanvasRendered === '1') {
            addLog('渲染', '该图已整图重绘过，跳过重复渲染', 'warn');
            return null;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, refW);
        canvas.height = Math.max(1, refH);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        // 关键：直接把 DOM 里的跨域 <img> 画进 canvas 会污染画布，
        // toDataURL 必然抛 "Tainted canvases may not be exported"，整图重绘就永远失败。
        // 正确做法是用 GM_xhr 取字节（不受 CORS 限制），再 createImageBitmap 得到同源位图。
        try {
            const srcUrl = img.dataset.mtOriginalSrc || img.src;
            let base = null;
            try {
                const blob = await gmFetchBlob(srcUrl);
                if (blob) base = await createImageBitmap(blob);
            } catch (e2) {
                addLog('渲染', '取原始字节失败，改用 DOM 图片（可能污染画布）：' + (e2 && e2.message || e2), 'warn');
            }
            if (!base) base = await loadImageEl(srcUrl);
            if (!base) throw new Error('原图回读失败');
            ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
            if (base.close) base.close();
        } catch (e) {
            addLog('渲染', '整图重绘失败：' + (e && e.message || e), 'warn');
            return null;
        }
        const opts = {
            avoidPunct: apiConfig.typesetAvoidPunct,
            maxFont: 96,
            fontFamily: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif'
        };
        const ordered = blocks.slice().sort((a, b) =>
            (a.chineseText ? a.chineseText.length : 0) - (b.chineseText ? b.chineseText.length : 0));
        let painted = 0;
        for (const b of ordered) {
            if (!b.chineseText) continue;
            if (!(b.x >= 0) || !(b.y >= 0) || !(b.w > 0) || !(b.h > 0)) continue;
            const box = {
                x: Math.round(b.x), y: Math.round(b.y),
                w: Math.max(2, Math.round(b.w)), h: Math.max(2, Math.round(b.h))
            };
            // 先贴擦除补丁（如果有），再用主色兜底
            if (apiConfig.eraseOriginal && b.patch) {
                try {
                    const pim = await loadImageEl(b.patch);
                    if (pim && b.patchBox) {
                        ctx.drawImage(pim, b.patchBox.x, b.patchBox.y, b.patchBox.w, b.patchBox.h);
                    }
                } catch (e) { }
            }
            const style = apiConfig.autoContrast
                ? analyzeBoxColors(ctx, box, !!b.originalText)
                : { primary: null, secondary: '#111' };
            const fill = !(apiConfig.eraseOriginal && b.patch) && !!style.primary;
            // 字号自适应关掉时，用面板字号（像素）当上限
            const maxFont = apiConfig.typesetAutoSize ? 96 : Math.max(8, parseInt(apiConfig.fontSize, 10) || 14);
            // 注意合并顺序：opts 里带着 maxFont:96，必须放在前面，否则会把面板字号覆盖掉
            // （之前就是 Object.assign({ fill, maxFont }, opts)，设置 14 最终仍是 96）
            if (Typeset.draw(ctx, b.chineseText, box, style, Object.assign({}, opts, { fill, maxFont }))) painted++;
        }
        let url = null;
        try {
            url = canvas.toDataURL('image/png');
        } catch (e) {
            addLog('渲染', '导出 PNG 失败（画布被跨域图片污染）：' + (e && e.message || e), 'warn');
            return null;
        }
        return { url, painted };
    }

    /* ---------------- 翻译（大批量 + 并发，走全局 LLM 池） ---------------- */

    async function translateInBatches(flatBlocks) {
        transTotal += flatBlocks.length;
        const batches = [];
        let current = [], chars = 0;
        for (const b of flatBlocks) {
            const n = String(b.originalText || '').length + 12;
            if (current.length && (current.length >= LLM_BATCH_SIZE || chars + n > LLM_BATCH_CHARS)) {
                batches.push(current); current = []; chars = 0;
            }
            current.push(b); chars += n;
        }
        if (current.length) batches.push(current);
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
        // 诊断日志（7.49）：记录本批送审的原文，与模型返回对照，区分"OCR 识别错"与"翻译漏"
        addLog('翻译', '送审 ' + blocks.length + ' 段: ' + blocks.map((b, i) => '#' + (i + 1) + ' ' + String(b.originalText).replace(/\s+/g, ' ').slice(0, 45)).join(' | ').slice(0, 1000));
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
            // 诊断日志（7.49）：模型原始返回（截断到 900 字符）
            addLog('翻译', '模型返回 ' + String(reply || '').length + ' 字符: ' + String(reply || '').replace(/\s+/g, ' ').slice(0, 900));
            const map = parseNumberedLines(reply);
            if (map) {
                blocks.forEach((b, i) => {
                    const t = map.get(i + 1);
                    // 英文原样返回、拒答，以及相对原文明显过短的截断回答都交给逐条补翻。
                    if (t && isRefusal(t)) sawRefusal = true;
                    b.chineseText = isUsableTranslation(b.originalText, t) ? t.trim() : '';
                });
                const filled = blocks.filter(b => b.chineseText).length;
                if (filled < blocks.length) addLog('翻译', '编号回填 ' + filled + '/' + blocks.length, 'warn');
            } else {
                blocks.forEach(b => { b.chineseText = ''; });
                addLog('翻译', '编号格式解析失败，改为单轮批量补翻', 'warn');
            }
        } catch (e) {
            blocks.forEach(b => { b.chineseText = ''; });
            addLog('翻译', '主批次失败，改为单轮批量补翻: ' + (e && e.message || e), 'warn');
        }
        if (sawRefusal) addLog('翻译', '识别到拒答文案，已排除（不落板）', 'warn');

        // 诊断日志（7.49）：主批次未译出的段（原文），便于定位是识别问题还是翻译问题
        const missNow = blocks.filter(b => !b.chineseText);
        if (missNow.length) {
            addLog('翻译', '主批次未译出 ' + missNow.length + ' 段: ' + missNow.map(b => '#' + (blocks.indexOf(b) + 1) + ' ' + String(b.originalText).replace(/\s+/g, ' ').slice(0, 50)).join(' | ').slice(0, 900), 'warn');
        }
        // 缺失项只做一轮批量补翻，每次最多 20 条；避免旧版每条单独请求、失败后再来第二轮。
        // 这里不能走 pools.ll：translateBlocks 本身已经占着 ll 池的槽位，改用独立的双并发窗口。
        miss = blocks.filter(b => !b.chineseText).length;
        if (miss > 0) {
            const todo = blocks.filter(b => !b.chineseText);
            const retryBatches = [];
            for (let i = 0; i < todo.length; i += LLM_RETRY_BATCH_SIZE) retryBatches.push(todo.slice(i, i + LLM_RETRY_BATCH_SIZE));
            const got = await mapLimit(retryBatches, 2, async batch => {
                try {
                    const retryNumbered = batch.map((b, i) => '#' + (i + 1) + ' ' + b.originalText).join('\n');
                    const reply = await callLLM('下面是漫画 OCR 得到的句子或片段。逐条翻译成自然中文；即使片段不完整也给出最合理译文，'
                        + '不要拒答、不要解释、不要遗漏信息。输出必须一行一条，以相同的 #[序号] 开头：\n' + retryNumbered, apiConfig.aiKey);
                    const map = parseNumberedLines(reply);
                    if (!map) return 0;
                    let fixed = 0;
                    batch.forEach((b, i) => {
                        const t = map.get(i + 1);
                        if (isUsableTranslation(b.originalText, t)) { b.chineseText = t.trim(); fixed++; }
                    });
                    return fixed;
                } catch (e) { }
                return 0;
            });
            const fixed = got.reduce((a, b) => a + b, 0);
            miss = blocks.filter(b => !b.chineseText).length;
            if (fixed) addLog('翻译', '单轮批量补翻 ' + fixed + ' 条');
        }
        if (miss) {
            addLog('翻译', '仍有 ' + miss + '/' + blocks.length + ' 段未译出，将显示为空: ' + blocks.filter(b => !b.chineseText).map(b => String(b.originalText).replace(/\s+/g, ' ').slice(0, 50)).join(' | ').slice(0, 900), 'error');
        }

        // #5 记下本批「原文 / 译文」作为后续页的参考上下文；异步提取词条（不阻塞出图）
        const okBlocks = blocks.filter(b => b.originalText && b.chineseText);
        if (okBlocks.length) {
            pushCtxMemory(okBlocks.map(b => b.originalText).join(' / '), okBlocks.map(b => b.chineseText).join(' / '));
            const srcAll = okBlocks.map(b => b.originalText).join('\n');
            const cnAll = okBlocks.map(b => b.chineseText).join('\n');
            maybeExtractGlossary(srcAll, cnAll);
        }
        addLog('翻译', '完成 ' + (Date.now() - t0) + 'ms');
        return blocks;
    }

    /* ---------------- 气泡覆盖 ---------------- */

    // 清掉页面上所有气泡，并把图片从 .mt-shell 外壳里挪回原位（避免外壳残留影响页面布局）
    function clearBubbles() {
        renderEpoch++;   // 让所有在途的异步渲染作废，别再写回译图
        document.querySelectorAll('.mt-bubble').forEach(b => b.remove());
        document.querySelectorAll('.mt-shell').forEach(w => {
            const parent = w.parentNode;
            if (!parent) return;
            while (w.firstChild) parent.insertBefore(w.firstChild, w);
            w.remove();
        });
        // 7.52：整图重绘过的图片要还原成原图，否则 PNG 结果会一直挂着
        document.querySelectorAll('img[data-mt-canvas-rendered="1"]').forEach(im => {
            if (im.dataset.mtOriginalSrc) {
                try { im.src = im.dataset.mtOriginalSrc; } catch (e) { }
            }
            im.dataset.mtCanvasRendered = '';
        });
        // 已经清除的图不再需要跟着窗口尺寸重排
        document.querySelectorAll('img').forEach(im => {
            if (im._mtLastRender) {
                delete im._mtLastRender;
                try { bubbleRO && bubbleRO.unobserve(im); } catch (e) { }
            }
        });
    }

    // #6：DOM 气泡是按创建那一刻的像素算的，窗口缩放 / 手机横竖屏切换后会整体错位。
    // 用一个 ResizeObserver 盯住这些图，尺寸真的变了才重排（带防抖）。
    let bubbleRO = null;
    const bubbleROTimers = new WeakMap();

    function ensureBubbleRO() {
        if (bubbleRO) return bubbleRO;
        if (typeof ResizeObserver === 'undefined') return null;
        bubbleRO = new ResizeObserver(entries => {
            for (const en of entries) {
                const img = en.target;
                const last = img._mtLastRender;
                if (!last || !img.isConnected) continue;
                clearTimeout(bubbleROTimers.get(img));
                bubbleROTimers.set(img, setTimeout(() => {
                    const r = (() => { try { return img.getBoundingClientRect(); } catch (e) { return null; } })();
                    if (!r || !r.width || !r.height) return;
                    if (Math.abs(r.width - (last.dispW || 0)) < 1) return;   // 宽度没变，不动
                    last.dispW = r.width;
                    overlayBubblesDOM(img, last.blocks, last.refW, last.refH);
                }, 180));
            }
        });
        return bubbleRO;
    }

    // 7.52：渲染分派。canvas = 整图重绘（官方那套），dom = 原有的 DOM 气泡叠加
    // 返回 Promise：调用方必须 await，否则"全部完成"会提前报出来，
    // 而且「清除气泡」之后未完成的回调还会把译图写回去。
    async function overlayBubbles(img, blocks, refW, refH, taskId) {
        const myEpoch = renderEpoch;
        const alive = () => ((taskId === undefined) || taskAlive(taskId)) && myEpoch === renderEpoch;
        if (apiConfig.renderMode === 'canvas') {
            if (!img || img.dataset.mtCanvasBusy === '1') return;
            img.dataset.mtCanvasBusy = '1';
            try {
                const r = await renderCanvasOverlay(img, blocks, refW, refH);
                // 任务已作废（点了停止 / 又点了开始）→ 结果直接丢掉，绝不写回图片
                if (!alive()) return;
                if (!r || !r.url || !r.painted) {
                    addLog('渲染', '整图重绘无产出，改走 DOM 叠加', 'warn');
                    overlayBubblesDOM(img, blocks, refW, refH);
                    return;
                }
                if (!img.dataset.mtOriginalSrc) img.dataset.mtOriginalSrc = img.src;
                img.src = r.url;
                img.dataset.mtCanvasRendered = '1';
                addLog('渲染', '整图重绘完成，覆盖 ' + r.painted + ' 段');
            } catch (e) {
                if (!alive()) return;
                addLog('渲染', '整图重绘异常：' + (e && e.message || e) + '，改走 DOM 叠加', 'error');
                overlayBubblesDOM(img, blocks, refW, refH);
            } finally {
                img.dataset.mtCanvasBusy = '';
            }
            return;
        }
        if (!alive()) return;
        overlayBubblesDOM(img, blocks, refW, refH);
    }

    function overlayBubblesDOM(img, blocks, refW, refH) {
        if (!img || !blocks || !blocks.length) return;
        // 重排时先清掉这张图的旧气泡，否则会一层层叠加
        try {
            const shell = img.closest && img.closest('.mt-shell');
            if (shell) shell.querySelectorAll('.mt-bubble').forEach(b => b.remove());
        } catch (e) { }
        // 记下这次的入参，窗口尺寸变化时照着重放
        try {
            img._mtLastRender = { blocks, refW, refH, dispW: img.getBoundingClientRect().width };
            const ro = ensureBubbleRO();
            if (ro) ro.observe(img);
        } catch (e) { }
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

        // 适当加大白底外扩边距（至少 6px），彻底盖住 OCR 框边缘露出的半截英文字母（7.45）
        const PAD = Math.max(6, Math.round(Math.min(refW, refH) * 0.008));
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
        // 测试结果既要进「日志」页（带级别、可回看），也要更新顶部状态栏
        const tlog = (msg, level) => { addLog('测试', msg, level); log(msg); };
        tlog('测试 AI 通道...');
        try {
            const reply = await callLLM('回复“OK”两个字，不要其他内容。', apiConfig.aiKey);
            if (!reply) throw new Error('AI 无返回');
            tlog('✅ AI 正常：' + reply);
        } catch (e) {
            tlog('❌ AI 失败：' + e.message);
            return;
        }

        // 7.52.2：按当前选中的识别服务分别测，不再漏掉内置引擎。
        // 老版本这里没有 builtin 分支，选内置引擎时会掉进最后的 ocr.space 兜底 → 必然报错。
        const modeName = OCR_MODE_NAMES[apiConfig.ocrMode] || apiConfig.ocrMode;
        tlog('测试 OCR 通道（' + modeName + '）...');
        try {
            const c = document.createElement('canvas');
            c.width = 600; c.height = 160;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 160);
            ctx.fillStyle = '#000'; ctx.font = 'bold 42px sans-serif';
            ctx.fillText('HELLO TEST 12345', 20, 90);

            let blocks = null;
            if (apiConfig.ocrMode === 'builtin') {
                // 内置引擎走完整链路（YOLO 检测 + Tesseract 识别），不经过 dataURL
                const t0 = Date.now();
                const r = await builtinOcr(c);
                blocks = (r && r.blocks ? r.blocks : []).map(b => ({ text: b.originalText }));
                tlog('  内置引擎耗时 ' + (Date.now() - t0) + 'ms · 检出 ' + blocks.length + ' 段');
            } else {
                const dataUrl = c.toDataURL('image/jpeg', 0.92);
                blocks = apiConfig.ocrMode === 'baidu' ? await baiduOcr(dataUrl)
                    : apiConfig.ocrMode === 'baidu-direct' ? await baiduDirectOcr(dataUrl)
                    : apiConfig.ocrMode === 'local' ? await localOcr(dataUrl)
                    : await ocrSpace(dataUrl);
            }

            if (blocks && blocks.length) {
                tlog('✅ OCR 正常，识别到：' + blocks.map(x => x.text).join(' / '));
            } else if (apiConfig.ocrMode === 'builtin') {
                tlog('❌ 内置引擎没检出文字。检查顺序：①「OCR」页模型是否显示已下载 ②上面几条日志里 YOLO/Tesseract 的具体报错 ③语言包是否被站点 CSP 拦（看 Console）', 'error');
            } else {
                tlog('❌ OCR 无结果（' + modeName + '）：检查 Key / 代理地址 / 本地服务是否启动 / 限速设置', 'error');
            }
        } catch (e) {
            tlog('❌ OCR 异常（' + modeName + '）：' + (e && e.message || e), 'error');
        }

        // 选了「模型擦除」时顺带测一下擦除服务，省得整章跑完才发现连不上
        if (apiConfig.eraseOriginal && apiConfig.eraseMode === 'model') {
            tlog('测试擦除服务...');
            if (!apiConfig.eraseServiceUrl) {
                tlog('❌ 擦除服务地址没填（设置 → 显示 → 擦除方式下面的输入框）', 'error');
            } else {
                eraseServiceAlive = null;   // 强制重新探测，别用旧结论
                const alive = await probeEraseService();
                if (alive) tlog('✅ 擦除服务可用：' + apiConfig.eraseServiceUrl);
                else tlog('❌ 擦除服务不可用：确认 local-inpaint-server.py 已启动（默认 8001）、模型已下载', 'error');
            }
        }
    }

    createUI();
    registerMenu();
})();
