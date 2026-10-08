# 漫画翻译引擎（Manga Translate）

作者：百事比可口好喝

> 本项目使用 AI 代码生成工具辅助开发

浏览器用户脚本 + 本地 OCR 服务：自动识别网页漫画里的文字（韩文 / 日文 / 英文），用大模型翻译成中文，并在原文上覆盖白底气泡。

## 功能特性

- 🖼️ 自动识别漫画图片文字：韩文 / 日文 / 英文
- 🌐 多种翻译引擎：DeepSeek / 智谱 GLM / 腾讯混元 / 硅基流动 / 本地 Ollama（免费离线）
- 🏠 本地 OCR（PaddleOCR），无云端配额限制；也可用百度 / ocr.space
- 📱 手机 + 电脑双端，局域网共用电脑上的 OCR / 翻译服务
- 💬 气泡自动贴合原文框，纯白底完全遮盖原文；可调节字号、气泡大小、面板缩放
- 📋 详细日志，方便排查卡顿
- ✂️ 拟声词（特效字）自动跳过；翻译数量差量 ≤3 时自动接受，不反复重试

## 使用场景

- 在韩漫 / 日漫等漫画网站上在线阅读，文字实时翻译成中文
- 电脑、手机（同一局域网）都能用；手机端可开启「手机极速模式」更流畅

## 目录结构

```
manga-translate/
├── manga-translate.user.js   # Tampermonkey 用户脚本（主程序）
├── install.cmd               # Windows 一键部署入口（双击即可装好本地 OCR）
├── install.ps1               # 一键部署主脚本（install.cmd 会调用它）
├── local-ocr-server.py       # 本地 OCR 服务（PaddleOCR，监听 0.0.0.0:8000）
├── restart-ocr.bat           # 一键重启 OCR 服务（含防火墙放行 8000）
├── setup-ollama-lan.bat      #（可选）让 Ollama 局域网可访问
└── baidu-ocr-proxy.js        #（可选）百度 OCR Cloudflare 代理
```

## 安装

### 1. 本地 OCR 服务端

#### 方式 A：一键部署（Windows 10 / 11，新手推荐）

不想折腾 Python 环境就用这个：脚本会自动装好 **Python 3.12 + PaddleOCR + 本地识别服务**，
全部放进独立的 `%USERPROFILE%\manga-ocr` 目录，**不会影响你系统里已有的 Python**。

用法（二选一）：

1. 下载本仓库的 `install.cmd`，**双击运行**（推荐）
2. 或打开 PowerShell，粘贴这一行后回车：

```powershell
irm https://raw.githubusercontent.com/nihao8602/86-/main/install.ps1 | iex
```

过程大约 5-15 分钟（要下载约 600MB 依赖）。装完桌面会多出一个「启动漫画OCR」，
双击它、保持那个黑窗口开着即可。卸载：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\manga-ocr\install.ps1" -Uninstall
```

> ⚠️ 如果运行时报中文乱码或语法错误，说明脚本被当成 GBK 读了：请改用 `install.cmd`
> 双击运行，或用上面的 `irm ... | iex`；**不要**手动下载 `install.ps1` 后直接右键「使用 PowerShell 运行」。
>
> 需要代理才能访问 `raw.githubusercontent.com` 的话，请先开代理再运行。
> 手机连不上电脑的 OCR，一般是 8000 端口没放行 —— 重新运行一次部署脚本即可（会弹 UAC）。

#### 方式 B：手动安装（需要自己装 Python 3.12）

```bash
pip install "paddleocr==2.7.3" paddlepaddle==2.6.2 "numpy<2" fastapi uvicorn opencv-python
python local-ocr-server.py
```

> ⚠️ 版本必须配套：PaddleOCR 2.x + PaddlePaddle **2.6.2** + **numpy 1.x**。
> 装 PaddlePaddle 3.x、或让 numpy 升到 2.x 都会崩；Python 必须是 3.12（3.13 没有 PaddlePaddle 2.6.2 的安装包）。
> Windows 下也可直接双击 `restart-ocr.bat`（首次建议「以管理员身份运行」以添加防火墙规则）。

### 2. 用户脚本

浏览器安装 Tampermonkey，导入 `manga-translate.user.js`。

### 3. 配置（脚本面板）

- **翻译引擎**：选 DeepSeek / 智谱 GLM / 腾讯混元 / 硅基流动，填对应平台的 API Key；或选「本地 Ollama」免费离线翻译
- **OCR 引擎**：选「本地 OCR（PaddleOCR）」，地址填 `http://127.0.0.1:8000/ocr`
- **源语言**：韩文 / 日文 / 英文

## 手机 / 局域网使用

1. 电脑上以管理员运行一次 `restart-ocr.bat`（放行防火墙 8000 端口）
2. 查电脑局域网 IP：`ipconfig`
3. 手机脚本面板：
   - OCR 地址填 `http://电脑IP:8000/ocr`
   - 翻译走云端模型即可（如 DeepSeek）；若用本地 Ollama，先运行 `setup-ollama-lan.bat`，翻译地址填 `http://电脑IP:11434/v1/chat/completions`
   - 「设备」选「手机端」（或「自动」）

## DeepSeek 模型说明

- `deepseek-chat`：V3，稳定，但官方计划弃用（需迁移到 V4）
- `deepseek-v4-flash` / `deepseek-v4-pro`：V4 模型默认开启「思考」，批量翻译会先烧大量推理 token 且易超时。脚本已在请求中**自动关闭思考**（`thinking: { type: "disabled" }`），无需手动处理

## 免责声明

- 本仓库**不含任何 API Key**，所有密钥由使用者自己填写，仅存储在浏览器本地
- 请遵守所使用网站的服务条款；本工具仅供个人学习交流使用
