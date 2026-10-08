#!/usr/bin/env bash
# ============================================================
#  漫画翻译引擎 · 本地 OCR 一键部署（Android / Termux / Linux ARM）
#  仓库：https://github.com/nihao8602/86-
#
#  用法（任选一种）：
#   1) Termux 里一行命令（新手推荐）：
#        curl -fsSL https://raw.githubusercontent.com/nihao8602/86-/main/install-termux.sh | bash
#   2) 已经在自己的 Linux 里（含 proot Ubuntu / chroot）：
#        bash install-termux.sh
#   3) 卸载：
#        bash install-termux.sh --uninstall
#
#  参数：
#    --dir <路径>    自定义安装目录（默认 $HOME/manga-ocr）
#    --python <路径> 指定 Python 解释器（必须是 3.10 ~ 3.12，因为 paddlepaddle 2.6.2 只发到 cp312）
#    --no-autostart  不配置开机自启（默认会在 Termux 侧写好 ~/.termux/boot/start-ocr.sh）
#    --uninstall     卸载（停服务、删目录、删启动脚本）
#
#  说明：全部装在独立目录 + 独立 venv，不改动系统 Python。
#        关键版本由 constraints 钉死：numpy<2 + opencv-python-headless==4.10.0.84
#        （装 opencv 5.x 会要求 numpy>=2，和 paddlepaddle 2.6.2 冲突）
# ============================================================

set -u

RAW="${MANGA_OCR_RAW:-https://raw.githubusercontent.com/nihao8602/86-/main}"
INSTALL_DIR="${MANGA_OCR_DIR:-$HOME/manga-ocr}"
PIP_INDEX="${MANGA_OCR_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
PIP_FALLBACK="https://pypi.org/simple"
SERVER_FILE="local-ocr-server.py"
PORT=8000
PY_MIN_MAJOR=3
PY_MIN_MINOR=10
PY_MAX_MINOR=12   # paddlepaddle 2.6.2 的官方 wheel 只发到 cp312：3.13/3.14 上 pip 会去编译源码，基本装不成

# ---------- 输出助手 ----------
c_ok()   { printf '  \033[32m[OK]\033[0m   %s\n' "$*"; }
c_warn() { printf '  \033[33m[警告]\033[0m %s\n' "$*"; }
c_bad()  { printf '  \033[31m[失败]\033[0m %s\n' "$*"; }
step()   { printf '\n== %s ==\n' "$*"; }
die()    { c_bad "$*"; printf '\n部署中断。修好上面的问题后重新运行本脚本即可（已完成的步骤会自动跳过）。\n'; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

in_termux() {
    [ -n "${TERMUX_VERSION:-}" ] && return 0
    case "${PREFIX:-}" in *com.termux*) return 0 ;; esac
    return 1
}

ARCH="$(uname -m)"

# ---------- 从管道执行时自愈 ----------
# `curl ... | bash` 的时候 stdin 是管道，proot 绑定不了它，会报
#   proot warning: can't sanitize binding "/proc/self/fd/0"
# 严重时 proot-distro 会直接卡住。这里自动落成文件、用 /dev/tty 重跑一次。
if [ ! -t 0 ] && [ -z "${MANGA_OCR_REEXEC:-}" ]; then
    printf '\n[提示] 检测到是从管道执行（curl | bash）—— proot 需要真正的终端，\n'
    printf '       正在改用文件方式重跑...\n'
    _tmp="${TMPDIR:-/tmp}/install-termux.sh"
    if has curl && curl -fsSL "$RAW/install-termux.sh" -o "$_tmp" 2>/dev/null && [ -s "$_tmp" ]; then
        if [ -r /dev/tty ]; then
            MANGA_OCR_REEXEC=1 exec bash "$_tmp" "$@" < /dev/tty
        else
            MANGA_OCR_REEXEC=1 exec bash "$_tmp" "$@" < /dev/null
        fi
    fi
    c_warn '自动重跑没成功，请手动执行下面两行：'
    c_warn "  curl -fsSL $RAW/install-termux.sh -o ~/install-termux.sh"
    c_warn '  bash ~/install-termux.sh'
    exit 1
fi

# ---------- 参数解析 ----------
DO_UNINSTALL=0
DO_AUTOSTART=1
USER_PY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) DO_UNINSTALL=1; shift ;;
        --no-autostart) DO_AUTOSTART=0; shift ;;
        --dir) INSTALL_DIR="${2:-}"; [ -n "$INSTALL_DIR" ] || die "--dir 需要跟一个路径"; shift 2 ;;
        --dir=*) INSTALL_DIR="${1#--dir=}"; shift ;;
        --python) USER_PY="${2:-}"; [ -n "$USER_PY" ] || die "--python 需要跟一个解释器路径"; shift 2 ;;
        --python=*) USER_PY="${1#--python=}"; shift ;;
        -h|--help) sed -n '2,25p' "$0" 2>/dev/null || true; exit 0 ;;
        *) c_warn "忽略未知参数：$1"; shift ;;
    esac
done

VENV="$INSTALL_DIR/venv"
VENV_PY="$VENV/bin/python"
CONSTRAINTS="$INSTALL_DIR/constraints.txt"
START_SH="$INSTALL_DIR/start-ocr.sh"
STOP_SH="$INSTALL_DIR/stop-ocr.sh"
LOG="$INSTALL_DIR/ocr-server.log"

# ============================================================
#  卸载
# ============================================================
if [ "$DO_UNINSTALL" = "1" ]; then
    printf '\n=== 漫画翻译引擎 · 本地 OCR 卸载 ===\n\n'
    pkill -f "$SERVER_FILE" >/dev/null 2>&1 && c_ok '已停止 OCR 服务' || c_ok '服务本来就没在跑'
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        if [ -d "$INSTALL_DIR" ]; then c_warn "目录没删干净，请手动删除：$INSTALL_DIR"; else c_ok "已删除：$INSTALL_DIR"; fi
    else
        c_ok '安装目录本来就不存在'
    fi
    # Termux 侧的包装启动器
    for f in "$HOME/start-ocr-termux.sh" "$HOME/stop-ocr-termux.sh" "$HOME/.termux/boot/start-ocr.sh"; do
        [ -f "$f" ] && rm -f "$f" && c_ok "已删除：$f"
    done
    printf '\n  卸载完成。浏览器/油猴里的那个脚本请自行删除。\n\n'
    exit 0
fi

# ============================================================
#  Termux 分支：先准备 proot Ubuntu，再进里面跑同一份脚本
# ============================================================
if in_termux; then
    printf '\n=====================================================\n'
    printf '   漫画翻译引擎 · 本地 OCR 一键部署（Termux）\n'
    printf '=====================================================\n\n'
    printf '  Termux 自己（bionic libc）装不了 PaddlePaddle（官方只发 glibc 包），\n'
    printf '  所以先装一个 Ubuntu 容器，再在里面装 OCR。需要下载约 600MB，5-15 分钟。\n'
    if [ "$INSTALL_DIR" != "$HOME/manga-ocr" ]; then
        c_warn 'Termux 分支下 --dir 会被忽略：容器里固定装在 /root/manga-ocr'
    fi

    step '1/2 准备 proot-distro 与 Ubuntu'
    if ! has proot-distro; then
        c_warn 'proot-distro 未安装，正在装（需要 pkg）...'
        pkg update -y >/dev/null 2>&1 || c_warn 'pkg update 失败，继续尝试安装'
        pkg install -y proot-distro || die 'proot-distro 安装失败，请检查网络后重试'
    fi
    c_ok 'proot-distro 就绪'
    if proot-distro login ubuntu -- true >/dev/null 2>&1; then
        c_ok 'Ubuntu 容器已存在，跳过安装'
    else
        c_warn '正在安装 Ubuntu 容器（第一次会下几百 MB）...'
        proot-distro install ubuntu || die 'Ubuntu 容器安装失败'
        c_ok 'Ubuntu 容器已安装'
    fi

    step '2/2 在 Ubuntu 里装 OCR（这一步最久，进度会一直刷）'
    # 把安装脚本交给 Ubuntu 里的 bash 执行；它会检测到自己不在 Termux，走 Linux 分支。
    # ⚠️ 这里不能把 Termux 的 $HOME 传进去：Termux 的 home 在 Ubuntu 容器里不可达，
    #    让 Ubuntu 用它自己的 $HOME，也就是 /root/manga-ocr。
    proot-distro login ubuntu -- bash -lc "
        set -e
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq || true
        apt-get install -y -qq curl ca-certificates python3 python3-venv >/dev/null 2>&1 || true
        curl -fsSL '$RAW/install-termux.sh' -o /root/install-termux.sh
        bash /root/install-termux.sh
    " < /dev/null || die 'Ubuntu 里的安装过程失败，请把上面的报错发出来'

    step '收尾：生成 Termux 侧的启动器'
    # ⚠️ 核心坑：proot-distro 起的 proot 带 --kill-on-exit —— proot 一退出，
    #    容器里的 python 服务会被一起杀掉。而 `bash -lc '...start-ocr.sh'` 跑完就退，
    #    所以必须在末尾挂一个不退出的东西（exec sleep infinity）把 proot 拴住，
    #    否则现象是：打印"就绪"之后服务立刻消失，stop 时提示"本来就没在跑"。
    cat > "$HOME/start-ocr-termux.sh" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
# 启动 Ubuntu 容器里的 OCR 服务（后台常驻）
PIDF="$HOME/.ocr-proot.pid"
LOG="$HOME/ocr-start.log"
termux-wake-lock 2>/dev/null

# 已经在跑就不重复启动（用 /dev/tcp 探测，避开 http_proxy 干扰）
if (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null; then
    echo "OCR 已经在跑： http://127.0.0.1:8000/ocr"
    exit 0
fi
# 清掉上一次残留的常驻 proot
if [ -f "$PIDF" ]; then
    kill "$(cat "$PIDF")" 2>/dev/null
    rm -f "$PIDF"
fi
nohup proot-distro login ubuntu -- bash -lc 'bash /root/manga-ocr/start-ocr.sh; exec sleep infinity' \
    < /dev/null > "$LOG" 2>&1 &
echo $! > "$PIDF"

for i in $(seq 1 60); do
    sleep 3
    if (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null; then
        echo "就绪： http://127.0.0.1:8000/ocr"
        exit 0
    fi
done
echo "还没起来，看日志： tail -30 $LOG"
exit 1
SH
    cat > "$HOME/stop-ocr-termux.sh" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
PIDF="$HOME/.ocr-proot.pid"
# 先让容器里的服务自己退，再杀掉拴住它的常驻 proot
proot-distro login ubuntu -- bash -lc 'bash /root/manga-ocr/stop-ocr.sh' 2>/dev/null
if [ -f "$PIDF" ]; then
    kill "$(cat "$PIDF")" 2>/dev/null
    rm -f "$PIDF"
fi
termux-wake-unlock 2>/dev/null
echo "已停止"
SH
    chmod +x "$HOME/start-ocr-termux.sh" "$HOME/stop-ocr-termux.sh" 2>/dev/null
    c_ok "启动： bash ~/start-ocr-termux.sh"
    c_ok "停止： bash ~/stop-ocr-termux.sh"

    printf '\n=====================================================\n'
    printf '  部署完成！\n'
    printf '=====================================================\n\n'
    printf '  OCR 服务跑在 Ubuntu 容器里，装在 /root/manga-ocr\n'
    printf '  日志： /root/manga-ocr/ocr-server.log\n\n'
    printf '  手机上的油猴脚本：安装/打开「漫画翻译引擎」面板 → 识别(OCR)\n'
    printf '    模式选「本地」，地址填： http://127.0.0.1:8000/ocr\n'
    printf '    （服务就在这台手机上，不用连电脑；设备选「手机端」更快）\n\n'
    # 开机自启：Termux:Boot 插件会执行 ~/.termux/boot/ 下的脚本（免 root 的官方方式）
    if [ "$DO_AUTOSTART" = "1" ]; then
        mkdir -p "$HOME/.termux/boot"
        cat > "$HOME/.termux/boot/start-ocr.sh" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
# 由 Termux:Boot 插件在开机时执行。
# 需要先在 F-Droid 安装 Termux:Boot，并至少手动启动它一次（否则开机不会触发）。
termux-wake-lock 2>/dev/null
nohup bash "$HOME/start-ocr-termux.sh" >/dev/null 2>&1 &
SH
        chmod +x "$HOME/.termux/boot/start-ocr.sh" 2>/dev/null
        c_ok '已写好开机自启脚本：~/.termux/boot/start-ocr.sh'
    fi

    printf '  启动： bash ~/start-ocr-termux.sh\n'
    printf '  停止： bash ~/stop-ocr-termux.sh\n\n'
    if [ "$DO_AUTOSTART" = "1" ]; then
        printf '  开机自启：脚本已就位，但还需要你去 F-Droid 装 Termux:Boot 插件，\n'
        printf '            并手动启动它一次（不启动一次的话开机不会触发）。\n'
        printf '            装好后重启手机验证： curl -s http://127.0.0.1:8000/\n\n'
    else
        printf '  开机自启：未配置（你用了 --no-autostart）\n\n'
    fi
    printf '  卸载： proot-distro login ubuntu -- bash /root/install-termux.sh --uninstall\n\n'
    exit 0
fi

# ============================================================
#  Linux / proot Ubuntu 分支（真正的安装逻辑）
# ============================================================
printf '\n=====================================================\n'
printf '   漫画翻译引擎 · 本地 OCR 一键部署（Linux / ARM）\n'
printf '=====================================================\n\n'
printf '  安装目录：%s\n' "$INSTALL_DIR"
printf '  服务端口：%s\n' "$PORT"
printf '  处理器架构：%s\n\n' "$ARCH"

# ---------- 1. 环境自检 ----------
step '1/6 检查环境'
case "$ARCH" in
    x86_64|amd64|aarch64|arm64) c_ok "架构 $ARCH 有官方 wheel" ;;
    *) c_warn "架构 $ARCH 可能没有 PaddlePaddle 官方 wheel，继续尝试" ;;
esac

# 在支持范围（3.10 ~ 3.12）里挑一个，按版本从高到低
pick_python() {
    for cand in "$@"; do
        has "$cand" || continue
        v="$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"
        [ -n "$v" ] || continue
        maj="${v%%.*}"; min="${v##*.}"
        if [ "$maj" -eq "$PY_MIN_MAJOR" ] && [ "$min" -ge "$PY_MIN_MINOR" ] && [ "$min" -le "$PY_MAX_MINOR" ]; then
            echo "$cand"
            return 0
        fi
    done
    return 1
}

DEFAULT_PY_VER="$( (python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null) || echo '?' )"
PY=""
_ver_in_range() {
    # $1 = 解释器路径/命令，命中就把它 echo 出来
    [ -n "$1" ] || return 1
    { [ -x "$1" ] || has "$1"; } || return 1
    _v="$("$1" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"
    [ -n "$_v" ] || return 1
    _min="${_v##*.}"
    case "$_min" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$_min" -ge "$PY_MIN_MINOR" ] && [ "$_min" -le "$PY_MAX_MINOR" ]; then echo "$1"; return 0; fi
    return 1
}

if [ -n "$USER_PY" ]; then
    PY="$(_ver_in_range "$USER_PY" || true)"
    [ -n "$PY" ] || die "--python 指定的解释器不可用，或版本不在 3.10 ~ 3.12：$USER_PY"
    c_ok "--python 指定：$PY"
fi
[ -n "$PY" ] || PY="$(pick_python python3.12 python3.11 python3.10 python3 python || true)"
# uv 兜底：发行版仓库里没有 3.12 时，用 uv 拉一个独立构建的 3.12
# uv 常装在 ~/.local/bin，那个目录不一定在 PATH 里，所以两种都找
UV_BIN=""
if has uv; then
    UV_BIN="uv"
elif [ -x "$HOME/.local/bin/uv" ]; then
    UV_BIN="$HOME/.local/bin/uv"
fi
if [ -z "$PY" ] && [ -n "$UV_BIN" ]; then
    c_warn '系统里没有 3.10~3.12，尝试用 uv 装一个 3.12 ...'
    "$UV_BIN" python install 3.12 >/dev/null 2>&1 || true
    PY="$(_ver_in_range "$("$UV_BIN" python find 3.12 2>/dev/null || true)" || true)"
    [ -n "$PY" ] && c_ok "uv 装好了 Python：$PY"
fi
if [ -z "$PY" ]; then
    c_warn "系统里的 Python（默认 python3 = $DEFAULT_PY_VER）不在支持范围内。"
    c_warn "原因：paddlepaddle 2.6.2 的官方 wheel 只发到 cp312（Python 3.12），"
    c_warn "      3.13 / 3.14 上 pip 会去编译源码，numpy 1.26 也编不过，基本注定失败。"
    if has apt-get; then
        c_warn '尝试用 apt 装一个 python3.12 ...'
        (sudo apt-get install -y python3.12 python3.12-venv >/dev/null 2>&1 \
            || apt-get install -y python3.12 python3.12-venv >/dev/null 2>&1) || true
        PY="$(pick_python python3.12 python3.11 python3.10 || true)"
    fi
fi
if [ -z "$PY" ]; then
    c_warn 'apt 里也没有可用版本。手动装一个 3.12 再重跑本脚本，例如：'
    c_warn '  Ubuntu： sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt update && sudo apt install python3.12 python3.12-venv'
    c_warn '  Debian： sudo apt install python3.12 python3.12-venv（仓库里没有的话用 uv）'
    c_warn '  或者：  curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12'
    die "没有可用的 Python 3.10 ~ 3.12。"
fi
[ "$PY" = "python3" ] || c_warn "系统默认 python3 是 $DEFAULT_PY_VER，已改用 $PY（paddlepaddle 2.6.2 只支持到 3.12）"
PY_VER="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
c_ok "Python： $("$PY" -c 'import sys;print(sys.version.split()[0], sys.executable)')"

if ! has curl; then
    c_warn '没装 curl（探活和下载会失败）。Debian/Ubuntu 上装： sudo apt install curl'
fi

if ! "$PY" -c 'import venv' >/dev/null 2>&1; then
    c_warn '缺 venv 模块，尝试 apt 安装 python3-venv ...'
    if has apt-get; then
        (sudo apt-get install -y python3-venv >/dev/null 2>&1 || apt-get install -y python3-venv >/dev/null 2>&1) || true
    fi
    "$PY" -c 'import venv' >/dev/null 2>&1 || die 'venv 不可用。请手动装 python3-venv 后重试'
fi
c_ok 'venv 模块可用'

FREE_KB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "${FREE_KB:-}" ]; then
    FREE_GB=$((FREE_KB / 1024 / 1024))
    if [ "$FREE_GB" -lt 4 ]; then die "可用空间只有 ${FREE_GB}GB，PaddleOCR 至少需要 4GB（建议 6GB）"; fi
    c_ok "可用空间 ${FREE_GB}GB"
else
    c_warn '读不到磁盘剩余空间，跳过检查（建议至少留 4GB）'
fi

if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/"; then
    c_warn "$PORT 端口已经有 OCR 服务在跑，本次会复用（要重装先 --uninstall）"
fi

# ---------- 2. venv ----------
step '2/6 创建独立运行环境（venv）'
mkdir -p "$INSTALL_DIR" || die "无法创建目录：$INSTALL_DIR"
if [ -x "$VENV_PY" ]; then
    _vv="$("$VENV_PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo '?')"
    if [ "$_vv" = "$PY_VER" ]; then
        c_ok "已存在，跳过：$VENV"
    else
        c_warn "已有的 venv 是 Python $_vv，和选定的 $PY_VER 不一致，删掉重建"
        rm -rf "$VENV"
        "$PY" -m venv "$VENV" || die "创建虚拟环境失败：$VENV"
        c_ok "已重建：$VENV（Python $PY_VER）"
    fi
else
    "$PY" -m venv "$VENV" || die '创建虚拟环境失败'
    c_ok "已创建：$VENV（Python $PY_VER）"
fi

# ---------- 3. 依赖 ----------
step '3/6 安装依赖（约 600MB，请耐心等待）'
printf 'numpy<2\nopencv-python-headless==4.10.0.84\n' > "$CONSTRAINTS"

pip_try() {
    # 先用清华源，失败再退回官方源
    if "$VENV_PY" -m pip install --no-warn-script-location -c "$CONSTRAINTS" -i "$PIP_INDEX" "$@"; then
        return 0
    fi
    c_warn '清华源没成功，改用官方 PyPI 重试一次...'
    "$VENV_PY" -m pip install --no-warn-script-location -c "$CONSTRAINTS" -i "$PIP_FALLBACK" "$@"
}

if "$VENV_PY" -c 'import paddleocr, paddle, cv2, numpy, fastapi' >/dev/null 2>&1; then
    c_ok '依赖已装好，跳过'
else
    "$VENV_PY" -m pip install -q --upgrade pip setuptools wheel -i "$PIP_INDEX" \
        || c_warn '升级 pip/setuptools 失败，继续尝试'
    # 顺序有讲究：先把 numpy 和 opencv 钉死，再装 paddlepaddle
    pip_try 'numpy<2' 'opencv-python-headless==4.10.0.84' || die 'numpy / opencv 安装失败'
    pip_try 'paddlepaddle==2.6.2' || die 'paddlepaddle 安装失败（检查网络或换源）'
    # paddleocr 用 --no-deps 装，绕开 visualdl / imgaug 那些又大又不用的训练依赖
    pip_try --no-deps 'paddleocr==2.7.3' || die 'paddleocr 安装失败'
    c_ok '核心依赖装好（numpy/opencv/paddlepaddle/paddleocr）'
fi

# ---------- 4. 自愈补依赖 ----------
step '4/6 补齐缺的依赖（自动检测，最多 15 轮）'
# paddleocr 是 --no-deps 装的，这里靠 ImportError 反查缺什么、装什么
mod_to_pkg() {
    case "$1" in
        cv2) echo 'opencv-python-headless==4.10.0.84' ;;
        skimage) echo 'scikit-image' ;;
        PIL) echo 'Pillow' ;;
        yaml) echo 'pyyaml' ;;
        paddle) echo 'paddlepaddle==2.6.2' ;;
        numpy) echo 'numpy<2' ;;
        pydantic_core) echo 'pydantic-core' ;;
        typing_extensions) echo 'typing_extensions' ;;
        *) echo "$1" ;;
    esac
}

# imgaug 补丁：推理根本用不到它，改成可选导入，省掉一大串训练侧依赖。
# ⚠️ 必须在自愈循环**之前**打：imgaug 挡在 paddleocr 的 import 链最前面，
#    不打补丁的话循环每轮只会看到它，永远发现不了后面还缺 lmdb / pyyaml / tqdm 之类。
patch_imgaug() {
    _site="$("$VENV_PY" -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])' 2>/dev/null || true)"
    [ -n "$_site" ] || return 0
    _iaa="$_site/paddleocr/ppocr/data/imaug/iaa_augment.py"
    if [ ! -f "$_iaa" ]; then
        c_warn '没找到 iaa_augment.py，跳过 imgaug 补丁'
        return 0
    fi
    "$VENV_PY" - "$_iaa" <<'PYEOF'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
if 'imgaug = None' in s:
    print('  [OK]   imgaug patch already applied')
    raise SystemExit
out, patched = [], False
for line in s.splitlines(True):
    st = line.strip()
    if st in ('import imgaug', 'import imgaug.augmenters as iaa'):
        if not patched:
            out.append('# [manga-ocr patch] imgaug is optional (inference does not need it)\n')
            out.append('try:\n    import imgaug\nexcept Exception:\n    imgaug = None\n')
            out.append('try:\n    import imgaug.augmenters as iaa\nexcept Exception:\n    iaa = None\n')
            patched = True
        continue
    out.append(line)
if patched:
    p.write_text(''.join(out), encoding='utf-8')
    print('  [OK]   imgaug made optional in iaa_augment.py')
else:
    print('  [警告] no imgaug import line found (paddleocr version changed?)')
PYEOF
}

patch_imgaug

# 依赖是一层层暴露的（imgaug → six → lmdb → pyyaml → …），每轮一次 pip 太慢。
# 直接从 paddleocr 自己的 metadata 里读出依赖清单，一次装上；
# 只跳过 imgaug（已用补丁替代）和 visualdl（训练用，一百多 MB 还拉一堆东西）。
if "$VENV_PY" -c 'import paddleocr' >/dev/null 2>&1; then
    c_ok 'paddleocr 导入正常'
else
    c_warn '按 paddleocr 声明的依赖一次补齐（跳过 imgaug / visualdl）...'
    _reqs="$("$VENV_PY" -m pip show paddleocr 2>/dev/null | sed -n 's/^Requires: //p')"
    if [ -n "$_reqs" ]; then
        # 必须用数组逐个传，不能拼成一个字符串再让 shell 拆词：
        # 包名里带 <= / >=（opencv-python<=4.6.0.66、fire>=0.3.0），
        # 不加引号时 < 和 > 会被 shell 当成重定向 —— 版本约束会丢失（opencv 被升到最新），
        # > 还可能凭空建出文件来。
        _pkgs=()
        while IFS= read -r _p; do
            [ -n "$_p" ] || continue
            _pkgs+=("$_p")
        done <<EOF
$(printf '%s' "$_reqs" | tr ',' '\n' | tr -d ' ' | grep -v '^imgaug' | grep -v '^visualdl' | grep -v '^opencv-python' | grep -v '^opencv-contrib-python')
EOF
        if [ "${#_pkgs[@]}" -gt 0 ]; then
            pip_try "${_pkgs[@]}" || c_warn '这批里有装失败的，下面自愈循环会再逐个补'
        fi
    fi
fi

round=1
while [ "$round" -le 15 ]; do
    missing="$("$VENV_PY" -c 'import paddleocr, fastapi, uvicorn' 2>&1 | sed -n "s/.*No module named '\([^']*\)'.*/\1/p" | head -1)"
    [ -z "$missing" ] && break
    pkg="$(mod_to_pkg "${missing%%.*}")"
    c_warn "缺 ${missing} → 安装 ${pkg}"
    pip_try "$pkg" || c_warn "${pkg} 安装失败，继续尝试下一轮"
    round=$((round + 1))
done
if "$VENV_PY" -c 'import paddleocr, fastapi, uvicorn' >/dev/null 2>&1; then
    c_ok 'paddleocr / fastapi / uvicorn 导入正常'
else
    c_warn '依赖还是不全。手动补漏网的那个（把报错里的模块名填进去）：'
    c_warn "  $VENV_PY -m pip install <模块名> -i $PIP_INDEX"
    c_warn '  常见对应：lmdb→lmdb、yaml→pyyaml、PIL→Pillow、skimage→scikit-image'
fi

# ---------- 5. 打补丁 + 服务端 ----------
step '5/6 打补丁并放置服务端'
patch_imgaug    # Step 4 开头已经打过，这里幂等确认一次

# 服务端：优先用脚本同目录的副本，否则从仓库下载
SRC_SERVER="$(dirname "$0")/$SERVER_FILE"
if [ -f "$SRC_SERVER" ]; then
    cp -f "$SRC_SERVER" "$INSTALL_DIR/$SERVER_FILE"
    c_ok "服务端已从本地复制：$INSTALL_DIR/$SERVER_FILE"
elif curl -fsSL "$RAW/$SERVER_FILE" -o "$INSTALL_DIR/$SERVER_FILE"; then
    c_ok "服务端已下载：$INSTALL_DIR/$SERVER_FILE"
else
    die "服务端下载失败。可手动下载 $RAW/$SERVER_FILE 放到 $INSTALL_DIR/ 后重跑"
fi

# MKLDNN 是 x86 专用，ARM 上开了会崩，这里按架构关掉
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then
    "$VENV_PY" - "$INSTALL_DIR/$SERVER_FILE" <<'PYEOF'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
s2 = s.replace("FLAGS_use_mkldnn'] = '1'", "FLAGS_use_mkldnn'] = '0'").replace('enable_mkldnn=True', 'enable_mkldnn=False')
if s2 != s:
    p.write_text(s2, encoding='utf-8')
    print('  [OK]   MKLDNN disabled for non-x86 (ARM)')
else:
    print('  [OK]   MKLDNN already off')
PYEOF
else
    c_ok 'x86 架构，保留 MKLDNN 加速'
fi

# ---------- 6. 启动脚本 ----------
step '6/6 生成启动脚本并自检'
cat > "$START_SH" <<'SHEOF'
#!/usr/bin/env bash
# 启动本地 OCR 服务（后台运行，不占终端）
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/ocr-server.log"
if curl -s -m 2 -o /dev/null "http://127.0.0.1:8000/"; then
    echo "OCR 服务已经在跑了： http://127.0.0.1:8000/ocr"
    exit 0
fi
cd "$HERE" || exit 1
# setsid + nohup：彻底脱离终端。注意 proot 是 ptrace 型的，
# 前台跑会把调用方的会话一直占住（这是手机上"命令卡死"的根因）
if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$HERE/venv/bin/python" "$HERE/local-ocr-server.py" >> "$LOG" 2>&1 < /dev/null &
else
    nohup "$HERE/venv/bin/python" "$HERE/local-ocr-server.py" >> "$LOG" 2>&1 < /dev/null &
fi
echo "已启动，正在等它就绪（首次会自动下载模型，可能要等一会儿）..."
for i in $(seq 1 60); do
    sleep 3
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:8000/"; then
        echo "就绪： http://127.0.0.1:8000/ocr"
        exit 0
    fi
done
echo "还没起来，看日志： tail -30 $LOG"
exit 1
SHEOF
cat > "$STOP_SH" <<'SHEOF'
#!/usr/bin/env bash
if pkill -f local-ocr-server.py; then echo "已停止 OCR 服务"; else echo "服务本来就没在跑"; fi
SHEOF
chmod +x "$START_SH" "$STOP_SH"
c_ok "启动： bash $START_SH"
c_ok "停止： bash $STOP_SH"

"$START_SH" || true

# ---------- 完成 ----------
# 拿本机局域网 IP：容器里常缺 ip/hostname/ifconfig，所以先用 venv 的 python 选一次路由
LAN_IP=""
if [ -x "$VENV_PY" ]; then
    LAN_IP="$("$VENV_PY" - <<'PY' 2>/dev/null || true
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("8.8.8.8", 80))   # 只用来选路由，不会真的发包
    print(s.getsockname()[0])
except Exception:
    pass
PY
)"
fi
if [ -z "$LAN_IP" ]; then
    LAN_IP="$(ip route get 1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
fi
if [ -z "$LAN_IP" ]; then
    LAN_IP="$(ip -4 addr show 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | grep -v '^127\.' | head -1)"
fi
if [ -z "$LAN_IP" ]; then
    LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -1)"
fi
printf '\n=====================================================\n'
printf '  部署完成！\n'
printf '=====================================================\n\n'
printf '  本机 OCR 地址（浏览器打开应显示 {"ok":true,...}）：\n'
printf '      http://127.0.0.1:%s/\n' "$PORT"
if [ -n "${LAN_IP:-}" ]; then
    printf '\n  局域网地址（同一 WiFi 下的其他设备/手机用）：\n'
    printf '      http://%s:%s/ocr\n' "$LAN_IP" "$PORT"
fi
printf '\n  ── 接下来 ──\n\n'
printf '  1) 装 Tampermonkey，再装用户脚本： https://github.com/nihao8602/86-\n'
printf '  2) 打开脚本面板这样填：\n'
printf '       识别(OCR) → 模式选「本地」→ 地址填 http://127.0.0.1:%s/ocr\n' "$PORT"
printf '       翻译引擎 → 选 DeepSeek（或其他），填你自己的 API Key\n'
printf '       源语言   → 按漫画选 韩文 / 日文 / 英文\n\n'
printf '  ── 日常 ──\n'
printf '  启动： bash %s\n' "$START_SH"
printf '  停止： bash %s\n' "$STOP_SH"
printf '  日志： %s\n\n' "$LOG"
printf '  ── 卸载 ──\n'
printf '  bash install-termux.sh --uninstall --dir %s\n\n' "$INSTALL_DIR"
