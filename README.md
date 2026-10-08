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
├── install.ps1               # Windows 一键部署主脚本（install.cmd 会调用它）
├── install-termux.sh         # 手机（Android/Termux）与 Linux 一键部署脚本
├── local-ocr-server.py       # 本地 OCR 服务（PaddleOCR，监听 0.0.0.0:8000）
├── restart-ocr.bat           # 一键重启 OCR 服务（含防火墙放行 8000）
├── setup-ollama-lan.bat      #（可选）让 Ollama 局域网可访问
└── baidu-ocr-proxy.js        #（可选）百度 OCR Cloudflare 代理
```

## 环境要求（安装前先对号入座）

一键脚本会自动帮你装 Python 和 PaddleOCR，但**系统本身**要满足下面的底线：

| | Windows 版（`install.cmd` / `install.ps1`） | 手机版（`install-termux.sh`） | Linux 版（同一份 `.sh`） |
|---|---|---|---|
| 系统 | Windows 10 / 11 **64 位** | Android 7 及以上 | Ubuntu 20.04+ / Debian 11+（glibc） |
| 运行环境 | PowerShell 5.1（系统自带） | **Termux**（建议从 [F-Droid](https://f-droid.org/packages/com.termux/) 装，应用商店里的版本太旧） | bash + curl |
| 需要预装 Python 吗 | ❌ 不用（脚本自动装 3.12.10） | ❌ 不用（容器内 apt 安装） | ✅ 需要 Python **3.10+** 和 `python3-venv` |
| 需要 root / 管理员吗 | ❌ 不需要（只有放行防火墙那步会弹一次 UAC，可跳过） | ❌ **不需要 root**（走 Termux + proot 容器） | 装 venv 时可能需要 sudo |
| CPU 架构 | x64 | **ARM64 / aarch64** | x86_64 或 aarch64 |
| 可用磁盘 | ≥ 4GB（建议 6GB） | ≥ 4GB（装完约 2.5-3GB） | 同左 |
| 内存 | 无特殊要求 | 建议 4GB 以上（PaddleOCR 常驻几百 MB） | 无特殊要求 |

**三套都要的共同前提**

1. **网络**：能访问 `raw.githubusercontent.com`（拿脚本）和 `pypi.tuna.tsinghua.edu.cn`（拿依赖）。
   国内直连 GitHub 经常失败 —— 请挂代理，或先手动下载脚本文件再本地运行。
2. **Tampermonkey**：浏览器/手机上装油猴插件（真正开始翻译时才需要，只装 OCR 服务不需要）。
3. **一个翻译 API Key**：例如 DeepSeek。**不需要**本地大模型，翻译是走云端接口的。

**前提不满足怎么办（每条都有退路，别卡在这儿）**

| 卡住的地方 | 退路 |
|---|---|
| 连不上 GitHub raw | 手动下载 `install.cmd` / `install.ps1` / `install-termux.sh`，再本地运行 |
| 不想装任何环境 / 手机太旧 | **完全不用本地 OCR**：只装油猴脚本，面板里 OCR 模式改成「百度」或 `ocr.space`，填对应 Key 即可 |
| 手机性能弱 | 手机只当显示端：OCR 地址填**电脑**的局域网地址（`http://电脑IP:8000/ocr`），识别在电脑上跑 |
| 不想花钱买 API | 面板里翻译引擎可选「本地 Ollama」（免费离线，需自己装 Ollama），或先用有免费额度的服务商（腾讯混元 / 硅基流动 / 智谱 GLM） |

## 安装

### 先选一条路

| 你的情况 | 走这条 |
|---|---|
| Windows 电脑，想最省事 | **方式 A**：下载 `install.cmd` 双击运行 |
| 安卓手机（装了 Termux，或已有 proot / chroot 的 Linux 容器） | **方式 C**：Termux 里跑一行命令 |
| 只想用云端 OCR，什么都不想装 | 跳过本节，直接看「2. 用户脚本」，面板里 OCR 模式选「百度」或 `ocr.space` |
| 手机只当显示端（识别交给电脑） | 电脑装**方式 A**，手机 OCR 地址填电脑的局域网地址 |

### 1. 本地 OCR 服务端

#### 方式 A：一键部署（Windows 10 / 11，新手推荐）

不想折腾 Python 环境就用这个：脚本会自动装好 **Python 3.12 + PaddleOCR + 本地识别服务**，
全部放进独立的 `%USERPROFILE%\manga-ocr` 目录，**不会影响你系统里已有的 Python**。

用法（三种任选，效果一样）：

1. 下载本仓库的 `install.cmd`，**双击运行**（推荐，最省事）
2. 或下载 `install.ps1` 后直接跑：`powershell -ExecutionPolicy Bypass -File .\install.ps1`
3. 或打开 PowerShell，粘贴这一行回车（自动下载 install.cmd 再执行）：

```powershell
irm https://raw.githubusercontent.com/nihao8602/86-/main/install.cmd -OutFile "$env:TEMP\manga-install.cmd"; & "$env:TEMP\manga-install.cmd"
```

过程大约 5-15 分钟（要下载约 600MB 依赖）。装完桌面会多出一个「启动漫画OCR」，
双击它、保持那个黑窗口开着即可。卸载：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\manga-ocr\install.ps1" -Uninstall
```

> ⚠️ **不要**写成 `irm https://.../install.ps1 | iex`（把脚本内容直接管道给 iex）：
> 这种写法会让脚本丢掉 UTF-8 BOM，PowerShell 5.1 就会按 GBK 解码，中文注释里的引号、括号被吞掉，
> 直接报一堆「意外的标记」「缺少右括号」的语法错误。请用上面三种方式之一（都以"文件"形式执行）。
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

#### 方式 C：装在手机上（Android / Termux，进阶）

手机（尤其是有 root 的机器）也能跑这份 OCR 服务，思路和 Linux 一样：**先有一个 glibc 的 Ubuntu 环境**
（Termux + proot-distro，或你自己的 chroot/proot 容器），再在里面装 PaddleOCR。

一键脚本（Termux 里一行，会自动装 proot Ubuntu 再装 OCR，约 600MB）：

```bash
curl -fsSL https://raw.githubusercontent.com/nihao8602/86-/main/install-termux.sh | bash
```

已经身处自己的 Linux / proot Ubuntu / chroot 里的话，直接 `bash install-termux.sh` 即可（不带参数）。

装完手机上的油猴脚本 OCR 地址填 `http://127.0.0.1:8000/ocr` —— 服务就在这台手机上，**不需要电脑**。

> ⚠️ 手机上的几个硬约束（脚本已自动处理，列出来免得你踩）：
> - `paddlepaddle` 官方只发 **glibc** 包，**Termux 原生（bionic）装不了**，必须走 Ubuntu 容器
> - `opencv-python-headless==4.10.0.84` 要钉死：opencv 5.x 会要求 numpy≥2，和 paddlepaddle 2.6.2 冲突
> - ARM 上必须**关掉 MKLDNN**（Intel x86 专用），脚本按架构自动处理
> - `imgaug` 推理用不到（只有训练用），脚本把它改成可选导入，省掉一堆依赖
> - 启动必须 `setsid` 完全后台：proot 是 ptrace 型，前台跑会一直占住调用方的终端会话
> - 手机 CPU 上单张漫画页大约 **5-30 秒**（电脑上通常 1-3 秒）

### 2. 用户脚本

浏览器安装 Tampermonkey，导入 `manga-translate.user.js`。

### 3. 配置（脚本面板）

- **翻译引擎**：选 DeepSeek / 智谱 GLM / 腾讯混元 / 硅基流动，填对应平台的 API Key；或选「本地 Ollama」免费离线翻译
- **OCR 引擎**：选「本地 OCR（PaddleOCR）」，地址填 `http://127.0.0.1:8000/ocr`
- **源语言**：韩文 / 日文 / 英文

## 手机 / 局域网使用

1. 放行防火墙 8000 端口：用一键部署（方式 A）的已经自动放行了，跳过这步；手动装的请以管理员运行一次 `restart-ocr.bat`
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
