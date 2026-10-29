# 漫画翻译引擎（Manga Translate）

作者：百事比可口好喝

> 本项目使用 AI 代码生成工具辅助开发

浏览器用户脚本 + 本地 OCR 服务：自动识别网页漫画里的文字（韩文 / 日文 / 英文），用大模型翻译成中文，并在原文上覆盖白底气泡。

> 当前版本：**7.42.0**

## 功能特性

- 🖼️ 自动识别漫画图片文字：韩文 / 日文 / 英文；**气泡级分组**（同一气泡里的多行合成一句翻译，不再拆成碎片）
- 🧩 **内置免部署 OCR**（借鉴的 xxx 翻译）：YOLO 检测文字框 + Tesseract 逐行识别，全部跑在浏览器里，首次点按钮下载约 10MB 模型，下载时校验完整性、坏了会自动重下，之后离线可用；适合不想装 Python 的场合
- 📐 **漫画排版引擎**：中英混排断行、避标点行首、孤字行合并、按气泡面积自适应字号
- 🎨 **三种擦除方式**：本地像素滤波（快）/ 框内主色填充（彩色气泡更贴合）/ 模型擦除（接本地 LaMa 服务，质量最好但每块约 3 秒）
- 🖼️ **可选 Canvas 整图重绘**：把整页合成一张图再显示，排版更还原、缩放不错位
- 🌐 多种翻译引擎：DeepSeek / 智谱 GLM / 腾讯混元 / 硅基流动 / 本地 Ollama（免费离线）
- 🏠 本地 OCR（PaddleOCR），无云端配额限制；也可用百度 / ocr.space
- 🔍 高清分块 OCR 开关（默认开）：长条小字漫画识别更准；关掉后 OCR 约快一倍
- 📱 手机 + 电脑双端，局域网共用电脑上的 OCR / 翻译服务
- 💬 气泡自动贴合原文框，纯白底完全遮盖原文；可调节字号、气泡大小、面板缩放
- 🧹 擦除原文再打译文（可选）：克隆气泡底色去字 + 边缘羽化，渐变气泡不会被刷成一块白
- 🚫 自动过滤网址水印与 OCR 乱读碎片（不会把 `xxx.com`、气泡边缘曲线、装饰线当成台词打出来）
- 🧠 术语表 + 上下文记忆：人名/专名跨页保持一致；可选手动术语表与自动记人名
- ⚙️ 思考模式开关（默认关，仅 DeepSeek 官方域生效）
- 📋 详细日志，方便排查卡顿
- ✂️ 拟声词（特效字）自动跳过；译文按 `#[序号]` 对齐回填，缺失的逐条补翻，不会整体错位

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
├── local-ocr-server.py       # 本地 OCR 服务（PaddleOCR，默认监听 0.0.0.0:8000；可用 OCR_HOST / OCR_PORT / OCR_TOKEN 覆盖）
├── local-inpaint-server.py   #（可选）本地擦除服务（LaMa ONNX，默认 127.0.0.1:8001；模型约 198MB）
├── restart-ocr.bat           # 一键重启 OCR 服务（含防火墙放行 8000）
├── setup-ollama-lan.bat      #（可选）让 Ollama 局域网可访问
└── baidu-ocr-proxy.js        #（可选）百度 OCR Cloudflare 代理
```

## iOS 用户注意

模型下载依赖浏览器正确处理二进制响应。实测：

- **Safari + Userscripts**：正常
- **Gear 等第三方浏览器**：会把响应重新编码（131072 字节变成 237290 字符），模型校验必然失败

iOS 上请优先用 Safari + Userscripts。

## 环境要求（安装前先对号入座）

一键脚本会自动帮你装 Python 和 PaddleOCR，但**系统本身**要满足下面的底线：

| | Windows 版（`install.cmd` / `install.ps1`） | 手机版（`install-termux.sh`） | Linux 版（同一份 `.sh`） |
|---|---|---|---|
| 系统 | Windows 10 / 11 **64 位** | Android 7 及以上 | Ubuntu 20.04+ / Debian 11+（glibc） |
| 运行环境 | PowerShell 5.1（系统自带） | **Termux**（建议从 [F-Droid](https://f-droid.org/packages/com.termux/) 装，应用商店里的版本太旧） | bash + curl |
| 需要预装 Python 吗 | ❌ 不用（脚本自动装 3.12.10） | ❌ 不用（容器内 apt 安装） | ✅ 需要 Python **3.10 ~ 3.12** 和 `python3-venv` |
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
pip install "paddleocr==2.7.3" "paddlepaddle==2.6.2" "numpy==1.26.4" "scipy==1.17.1" fastapi uvicorn "opencv-python==4.6.0.66"
python local-ocr-server.py
```

> ⚠️ 版本必须配套（一键脚本钉的就是这套）：PaddleOCR **2.7.3** + PaddlePaddle **2.6.2** + numpy **1.26.4** +
> scipy **1.17.1** + opencv-python **4.6.0.66**。装 PaddlePaddle 3.x、或让 numpy 升到 2.x 都会崩；
> Python 必须是 3.12（3.13 没有 PaddlePaddle 2.6.2 的安装包）。
> 手机 / Linux 侧的 opencv 用的是 `opencv-python-headless==4.10.0.84`：4.6.0.66 没有 aarch64 的 wheel，
> 硬装会去编译源码。这是平台差异，不是版本不一致。
> Windows 下也可直接双击 `restart-ocr.bat`（它会自动用 `%USERPROFILE%\manga-ocr\venv` 里的 Python；
> 首次建议「以管理员身份运行」以添加防火墙规则）。

#### 方式 D：擦除服务（可选，只有想用「模型擦除」才需要）

**不装也能用**——擦除方式默认是「本地像素滤波」，不需要任何服务。只有想让擦除质量更好（渐变底、彩色气泡、字压在图案上）才装这个。

依赖很小（onnxruntime + opencv + fastapi），和 OCR 服务**互不干扰**，跑在另一个端口：

```bash
pip install onnxruntime opencv-python fastapi uvicorn numpy
python local-inpaint-server.py --download-model   # 只需一次，约 198MB
python local-inpaint-server.py                    # 默认 127.0.0.1:8001
```

然后面板里「设置 → 显示 → 擦除方式」选「模型擦除」，地址填 `http://127.0.0.1:8001/inpaint`。

- 想局域网/手机也能用：`python local-inpaint-server.py --host 0.0.0.0`
- 端口冲突：`--port 8010`
- 模型地址可换镜像：`--url <地址>`，或环境变量 `LAMA_MODEL_URL`
- 服务没起 / 连不上时会**自动回退**到本地像素滤波，不影响主流程

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
- **访问令牌**（可选）：服务端设了 `OCR_TOKEN` 环境变量时，这里填同一个值，脚本会带 `X-OCR-Token` 头；不设就留空
- **清气泡**：面板底部「清气泡」按钮，一键清掉当前页所有译文气泡（连 `.mt-shell` 外壳一起还原，不会残留包裹层）
- **源语言**：韩文 / 日文 / 英文
- **术语表**（可选）：每行 `原文=译名`，如 `Elena=艾琳娜`；「上下文页数」0~3（默认 1）决定参考前几页的原文+译文；「自动记人名」会把名字沉淀成固定译名
- **思考模式**（默认关）：仅对 DeepSeek 官方域生效，打开后更慢更贵，一般不用开
- **擦除原文再打译文**（默认关）：用克隆底补丁去掉原文字，失败/跨域时自动回退纯白底

## 手机 / 局域网使用

1. 放行防火墙 8000 端口：用一键部署（方式 A）的已经自动放行了，跳过这步；手动装的请以管理员运行一次 `restart-ocr.bat`
2. 查电脑局域网 IP：`ipconfig`
3. 手机脚本面板：
   - OCR 地址填 `http://电脑IP:8000/ocr`
   - 翻译走云端模型即可（如 DeepSeek）；若用本地 Ollama，先运行 `setup-ollama-lan.bat`，翻译地址填 `http://电脑IP:11434/v1/chat/completions`
   - 「设备」选「手机端」（或「自动」）

## DeepSeek 模型说明

- `deepseek-chat`：V3，稳定，但官方计划弃用（需迁移到 V4）
- `deepseek-v4-flash` / `deepseek-v4-pro`：V4 模型默认开启「思考」，批量翻译会先烧大量推理 token 且易超时。脚本**默认关闭思考**（`thinking: { type: "disabled" }`），需要时可在面板「处理」里打开「思考模式」
  - 这个字段**只在接口域名是 `deepseek.com` 时**才加。第三方平台托管的 deepseek 模型可能不认它，硬塞会被拒（400）——脚本按域名判断，不会误伤

## 免责声明

- 本仓库**不含任何 API Key**，所有密钥由使用者自己填写，仅存储在浏览器本地
- 请遵守所使用网站的服务条款；本工具仅供个人学习交流使用
