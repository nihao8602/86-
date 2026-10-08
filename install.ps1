# ============================================================
#  漫画翻译引擎 · 本地 OCR 一键部署（Windows 10 / 11）
#  仓库：https://github.com/nihao8602/86-
#
#  用法（任选一种）：
#    1) 双击 install.cmd（推荐，最简单）
#    2) 管理员 PowerShell 里执行：
#       irm https://raw.githubusercontent.com/nihao8602/86-/main/install.ps1 | iex
#    3) 下载本文件后：
#       powershell -ExecutionPolicy Bypass -File install.ps1
#
#  卸载：
#       powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
#  参数：
#    -InstallDir <路径>  自定义安装目录（默认 %USERPROFILE%\manga-ocr）
#    -SkipFirewall       跳过 8000 端口防火墙放行（只影响手机局域网访问）
#    -DryRun             只检查环境并打印将要执行的步骤，不做任何改动
#    -Uninstall          卸载（停服务、删目录、删快捷方式、删防火墙规则）
#
#  说明：全部安装在独立目录 + 独立 venv，不改动系统 Python 环境。
# ============================================================
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE 'manga-ocr'),
    [switch]$SkipFirewall,
    [switch]$DryRun,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------- 常量 ----------
$RepoRaw    = 'https://raw.githubusercontent.com/nihao8602/86-/main'
$ServerFile = 'local-ocr-server.py'
$PyVer      = '3.12.10'
$PyUrls     = @(
    "https://mirrors.huaweicloud.com/python/$PyVer/python-$PyVer-amd64.exe",
    "https://www.python.org/ftp/python/$PyVer/python-$PyVer-amd64.exe"
)
$ServerUrls = @(
    "$RepoRaw/$ServerFile",
    "https://github.com/nihao8602/86-/raw/main/$ServerFile"
)
$PipIndexes = @(
    'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://pypi.org/simple'
)
# 版本组合是硬约束：paddlepaddle 2.6.2 必须配 numpy<2，paddleocr 必须 2.x
$ReqNumpy   = 'numpy==1.26.4'
$Packages   = @(
    'setuptools',
    'wheel',
    $ReqNumpy,
    'paddlepaddle==2.6.2',
    'opencv-python==4.6.0.66',
    'paddleocr==2.7.3',
    'fastapi',
    'uvicorn'
)
$Port       = 8000
$RuleName   = 'Manga OCR 8000'
$TotalSteps = 7

# ---------- 输出助手 ----------
function Say  { param($m, $c = 'Gray')  Write-Host $m -ForegroundColor $c }
function Step { param($n, $m) Write-Host ''; Write-Host "[$n/$TotalSteps] $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [警告] $m" -ForegroundColor Yellow }
function Bad  { param($m) Write-Host "  [失败] $m" -ForegroundColor Red }
function Die {
    param($m)
    Bad $m
    Say ''
    Say '部署中断。排除上面的问题后重新运行本脚本即可（已完成的步骤会自动跳过）。' 'Yellow'
    exit 1
}

# ---------- 工具函数 ----------
# 调用外部程序必须用下面两个包装：PowerShell 5.1 在 $ErrorActionPreference='Stop' 下，
# 原生命令只要往 stderr 写一个字，就会被当成 NativeCommandError 终止整个脚本
# （python 的一句 traceback、pip 的一条 warning 都足以打断部署）。
function Invoke-ExeQuiet {
    # 捕获输出（stdout + stderr 合并）后返回文本，不打印
    param([string]$Exe, [string[]]$ExeArgs = @())
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $o = & $Exe @ExeArgs 2>&1
        return (($o | ForEach-Object { "$_" }) -join "`n")
    } finally { $ErrorActionPreference = $old }
}
function Invoke-ExeLive {
    # 不捕获输出：pip 的进度实时显示在控制台，只返回退出码
    param([string]$Exe, [string[]]$ExeArgs = @())
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @ExeArgs
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
}

function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Get-FileFromUrls {
    param([string[]]$Urls, [string]$OutFile, [string]$Label)
    foreach ($u in $Urls) {
        if ($DryRun) { Say "    [DryRun] 下载 $Label ： $u" 'DarkGray'; return $true }
        try {
            Say "    下载 $Label ..." 'DarkGray'
            if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
            Invoke-WebRequest -Uri $u -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
            if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 1024)) {
                $sz = (Get-Item $OutFile).Length
                $szTxt = if ($sz -ge 1MB) { "$([int]($sz / 1MB)) MB" } else { "$([int]($sz / 1KB)) KB" }
                Ok "$Label 下载完成（$szTxt）"
                return $true
            }
            Warn "下载内容不完整，换下一个源试试"
        } catch {
            Warn "这个源不可用：$($_.Exception.Message)"
        }
    }
    return $false
}

function Get-Python312 {
    $cands = New-Object System.Collections.ArrayList
    if (Get-Command py.exe -ErrorAction SilentlyContinue) {
        try {
            $p = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
            if ($p) { [void]$cands.Add($p.Trim()) }
        } catch { }
    }
    foreach ($p in @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
            'C:\Python312\python.exe',
            'C:\Program Files\Python312\python.exe'
        )) {
        if (Test-Path $p) { [void]$cands.Add($p) }
    }
    foreach ($n in @('python.exe', 'python3.12.exe')) {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c -and $c.Source) { [void]$cands.Add($c.Source) }
    }
    foreach ($c in $cands) {
        try {
            if (-not (Test-Path $c)) { continue }
            $v = Invoke-ExeQuiet -Exe $c -ExeArgs @('-c', "import sys; print('%d.%d.%d' % sys.version_info[:3])")
            if ($v -match '\b3\.12\.\d+\b') { return $c }
        } catch { }
    }
    return $null
}

function Get-LanIp {
    try {
        $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Sort-Object InterfaceMetric |
            Select-Object -First 1 -ExpandProperty IPAddress
        if ($ip) { return $ip }
    } catch { }
    try {
        $ip = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily.ToString() -eq 'InterNetwork' -and $_.ToString() -notlike '127.*' } |
            Select-Object -First 1
        if ($ip) { return $ip.ToString() }
    } catch { }
    return $null
}

function Test-OcrAlive {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-PortOwner {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) { return (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue) }
    } catch { }
    return $null
}

# ============================================================
#  卸载分支
# ============================================================
if ($Uninstall) {
    Say ''
    Say '=== 漫画翻译引擎 · 本地 OCR 卸载 ===' 'White'
    Say ''
    if ($DryRun) {
        Say "  [DryRun] 将删除目录：$InstallDir" 'DarkGray'
        Say "  [DryRun] 将删除桌面快捷方式与防火墙规则「$RuleName」" 'DarkGray'
        exit 0
    }
    $proc = Get-PortOwner
    if ($proc -and $proc.ProcessName -like 'python*') {
        Say "  停止正在运行的 OCR 服务（PID $($proc.Id)）..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '启动漫画OCR.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Ok '已删除桌面快捷方式' }
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $InstallDir) { Warn "目录删除不完整，请手动删除：$InstallDir" } else { Ok "已删除目录：$InstallDir" }
    } else { Ok '安装目录本来就不存在' }
    try {
        $out = Invoke-ExeQuiet -Exe 'netsh' -ExeArgs @('advfirewall', 'firewall', 'delete', 'rule', "name=$RuleName")
        Ok '已删除防火墙规则'
    } catch { Warn '删除防火墙规则失败（可能本来就没有，或需要管理员权限）' }
    Say ''
    Say '  卸载完成。浏览器里 Tampermonkey 的那个脚本请自行删除。' 'Green'
    Say ''
    exit 0
}

# ============================================================
#  0. 环境自检
# ============================================================
Say ''
Say '=====================================================' 'White'
Say '   漫画翻译引擎 · 本地 OCR 一键部署（PaddleOCR）' 'White'
Say '=====================================================' 'White'
Say ''
Say "  安装目录：$InstallDir"
Say "  服务端口：$Port"
if ($DryRun) { Say '  模式：DryRun（只检查环境，不做任何改动）' 'Yellow' }
Say ''
Say '  说明：将安装独立的 Python 3.12 运行环境 + PaddleOCR。' 'DarkGray'
Say '        需要下载约 600MB 依赖，视网速约 5-15 分钟。' 'DarkGray'
Say '        不会改动你电脑上已有的 Python 环境。' 'DarkGray'

Step 1 '检查系统环境'
$os = [Environment]::OSVersion.Version
if ($os.Major -lt 10) { Die "本脚本需要 Windows 10 及以上（当前 $os）。" }
if (-not [Environment]::Is64BitOperatingSystem) { Die '本脚本需要 64 位 Windows。' }
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') { Warn "CPU 架构为 $arch，可能没有对应的 PaddlePaddle 安装包。" }
$drive = (Split-Path -Qualifier $InstallDir)
try {
    $drv = Get-PSDrive -Name ($drive.TrimEnd(':')) -ErrorAction Stop
    if ($null -ne $drv.Free -and $drv.Free -gt 0) {
        $freeGB = [int]($drv.Free / 1GB)
        if ($freeGB -lt 4) { Die "$drive 剩余空间只有 $freeGB GB，PaddleOCR 需要至少 4GB（建议 6GB）。" }
        Ok "系统 Windows $($os.Major).$($os.Minor) / $arch，$drive 可用空间 $freeGB GB"
    } else {
        Warn "读不到 $drive 剩余空间，跳过空间检查（建议至少留 4GB）。"
        Ok "系统 Windows $($os.Major).$($os.Minor) / $arch"
    }
} catch {
    Warn '检查磁盘空间失败，跳过（建议至少留 4GB）。'
    Ok "系统 Windows $($os.Major).$($os.Minor) / $arch"
}
if (Test-OcrAlive) {
    Warn "检测到 $Port 端口已经有 OCR 服务在运行。"
    Warn '如果这是你之前部署的，本脚本会直接跳过安装并复用；如需重装，先运行 -Uninstall。'
}

# ============================================================
#  1. Python 3.12
# ============================================================
Step 2 "准备 Python $PyVer"
$pyExe = Get-Python312
if ($pyExe) {
    Ok "已找到 Python：$pyExe"
} else {
    Warn "没有找到 Python 3.12，准备自动安装（$PyVer，约 26MB）。"
    Warn '为什么必须 3.12：PaddlePaddle 2.6.2 没有 3.13 的安装包。'
    if ($DryRun) {
        foreach ($u in $PyUrls) { Say "    [DryRun] 下载安装器： $u" 'DarkGray' }
        Say '    [DryRun] 静默安装到 %LOCALAPPDATA%\Programs\Python\Python312' 'DarkGray'
        $pyExe = 'C:\...\Python312\python.exe'
    } else {
        $installer = Join-Path $env:TEMP "python-$PyVer-amd64.exe"
        if (-not (Get-FileFromUrls -Urls $PyUrls -OutFile $installer -Label 'Python 安装包')) {
            Die "Python 安装包下载失败。请手动安装 Python $PyVer（勾选 Add to PATH）后重新运行本脚本：https://www.python.org/downloads/release/python-31210/"
        }
        Say '    正在静默安装（1-3 分钟，请不要关闭窗口）...' 'DarkGray'
        $installerArgs = @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1',
            'Include_test=0', 'Include_doc=0', 'Include_tcltk=1', 'SimpleInstall=1')
        $p = Start-Process -FilePath $installer -ArgumentList $installerArgs -Wait -PassThru
        if ($p.ExitCode -ne 0) { Warn "安装程序返回代码 $($p.ExitCode)，继续尝试查找 Python。" }
        Start-Sleep -Seconds 2
        $pyExe = Get-Python312
        if (-not $pyExe) { Die "Python 安装后仍未找到 3.12。请手动安装后重试：https://www.python.org/downloads/release/python-31210/" }
        Ok "Python 已安装：$pyExe"
    }
}

$venvDir = Join-Path $InstallDir 'venv'
$venvPy  = Join-Path $venvDir 'Scripts\python.exe'

# ============================================================
#  2. 独立虚拟环境
# ============================================================
Step 3 '创建独立运行环境（venv，不影响系统 Python）'
if (Test-Path $venvPy) {
    Ok "已存在，跳过：$venvDir"
} elseif ($DryRun) {
    Say "    [DryRun] 执行： `"$pyExe`" -m venv `"$venvDir`"" 'DarkGray'
} else {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    [void](Invoke-ExeLive -Exe $pyExe -ExeArgs @('-m', 'venv', $venvDir))
    if (-not (Test-Path $venvPy)) { Die "创建虚拟环境失败：$venvDir" }
    Ok "虚拟环境已创建：$venvDir"
}

# ============================================================
#  3. 安装依赖
# ============================================================
Step 4 '安装 PaddleOCR 依赖（约 600MB，请耐心等待）'
$constraints = Join-Path $InstallDir 'constraints.txt'
$needInstall = $true
if (Test-Path $venvPy) {
    $cur = Invoke-ExeQuiet -Exe $venvPy -ExeArgs @('-c', "import paddleocr, paddle, numpy; print('MANGA_OK')")
    if ($cur -like '*MANGA_OK*') { $needInstall = $false }
}
if (-not $needInstall) {
    Ok '依赖已装好，跳过'
} elseif ($DryRun) {
    Say "    [DryRun] 执行： `"$venvPy`" -m pip install $($Packages -join ' ')" 'DarkGray'
    Say '    [DryRun] pip 源：清华镜像，失败自动回退官方源' 'DarkGray'
} else {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    # 用 constraints 钉住 numpy<2：paddleocr 的依赖会试图把 numpy 升到 2.x，升了就崩
    Set-Content -Path $constraints -Value $ReqNumpy -Encoding ASCII
    $installed = $false
    foreach ($idx in $PipIndexes) {
        try {
            Say "    pip 源：$idx" 'DarkGray'
            [void](Invoke-ExeLive -Exe $venvPy -ExeArgs @('-m', 'pip', 'install', '--upgrade', 'pip', '--no-warn-script-location', '-i', $idx, '--quiet'))
            $rc = Invoke-ExeLive -Exe $venvPy -ExeArgs (@('-m', 'pip', 'install', '-c', $constraints, '--no-warn-script-location', '-i', $idx) + $Packages)
            if ($rc -ne 0) { throw "pip 返回代码 $rc" }
            $installed = $true
            break
        } catch {
            Warn "该源安装失败：$($_.Exception.Message)"
        }
    }
    if (-not $installed) {
        Die '依赖安装失败。常见原因：网络不稳定 / 需要代理 / 磁盘空间不足。可挂上代理后重新运行本脚本。'
    }
    Ok '依赖安装完成'
}

# 复核版本（装错版本一定会崩，这里提前拦住）
if (-not $DryRun) {
    if (-not (Test-Path $venvPy)) { Die "虚拟环境异常：$venvPy 不存在" }
    $verLine = Invoke-ExeQuiet -Exe $venvPy -ExeArgs @('-c', "import numpy, paddle, cv2, paddleocr, fastapi, uvicorn; print('MANGA_VER', numpy.__version__, paddle.__version__, paddleocr.__version__)")
    if ($verLine -notlike '*MANGA_VER*') {
        Die "依赖导入失败：$verLine"
    }
    $m = [regex]::Match($verLine, 'MANGA_VER\s+(\S+)\s+(\S+)\s+(\S+)')
    if ($m.Success) {
        $npVer = $m.Groups[1].Value
        Ok "numpy=$npVer  paddlepaddle=$($m.Groups[2].Value)  paddleocr=$($m.Groups[3].Value)"
        if ([version]$npVer -ge [version]'2.0.0') {
            Warn 'numpy 被升级到了 2.x，正在降回 1.26.4 ...'
            $rc = Invoke-ExeLive -Exe $venvPy -ExeArgs @('-m', 'pip', 'install', $ReqNumpy, '--no-warn-script-location', '-i', $PipIndexes[0])
            if ($rc -ne 0) { Die 'numpy 降级失败。请手动执行：venv\Scripts\python.exe -m pip install "numpy==1.26.4"' }
            Ok 'numpy 已固定为 1.26.4'
        }
    } else {
        Warn "版本输出无法解析：$verLine"
    }
} else {
    Say '    [DryRun] 校验 numpy<2 / paddleocr 2.x / paddlepaddle 2.6.2' 'DarkGray'
}

# ============================================================
#  4. 服务端程序
# ============================================================
Step 5 '部署 OCR 服务端程序'
$serverDst = Join-Path $InstallDir $ServerFile
$localCopy = $null
if ($PSScriptRoot) {
    $cand = Join-Path $PSScriptRoot $ServerFile
    if (Test-Path $cand) { $localCopy = $cand }
}
if ($DryRun) {
    if ($localCopy) { Say "    [DryRun] 从脚本同目录复制：$localCopy" 'DarkGray' }
    else { foreach ($u in $ServerUrls) { Say "    [DryRun] 下载： $u" 'DarkGray' } }
    Say "    [DryRun] 保存到：$serverDst" 'DarkGray'
} elseif ($localCopy) {
    Copy-Item $localCopy $serverDst -Force
    Ok "已从本地复制：$serverDst"
} else {
    if (-not (Get-FileFromUrls -Urls $ServerUrls -OutFile $serverDst -Label 'OCR 服务端程序')) {
        Die "服务端程序下载失败。可手动下载 $RepoRaw/$ServerFile 放到 $InstallDir\ 后重新运行。"
    }
    Ok "已下载：$serverDst"
}

# ============================================================
#  5. 启动器 + 快捷方式
# ============================================================
Step 6 '创建启动器与桌面快捷方式'
$launcher = Join-Path $InstallDir '启动漫画OCR.cmd'
# 内容保持纯 ASCII：cmd 按 ANSI/GBK 读文件，写中文会乱码（服务窗口里的中文提示由 Python 输出，正常显示）
$launcherBody = @'
@echo off
title Manga OCR Server (PaddleOCR :8000)
cd /d "%~dp0"
echo Starting local OCR server on http://127.0.0.1:8000 ...
echo Keep this window open while translating. Press Ctrl+C to stop.
echo.
"%~dp0venv\Scripts\python.exe" "%~dp0local-ocr-server.py"
echo.
echo [Server stopped]
pause
'@
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '启动漫画OCR.lnk'
# 把本脚本留一份在安装目录，之后卸载直接用它
$selfDst = Join-Path $InstallDir 'install.ps1'
$selfSrc = $MyInvocation.MyCommand.Path
$uninstallCmd = "powershell -ExecutionPolicy Bypass -File `"$selfDst`" -Uninstall"
if ($DryRun) {
    Say "    [DryRun] 生成启动器：$launcher" 'DarkGray'
    Say "    [DryRun] 生成桌面快捷方式：$desktopLnk" 'DarkGray'
    Say "    [DryRun] 备份部署脚本到：$selfDst" 'DarkGray'
} else {
    Set-Content -Path $launcher -Value $launcherBody -Encoding ASCII
    if ($selfSrc -and (Test-Path $selfSrc)) {
        Copy-Item $selfSrc $selfDst -Force
        Ok "部署脚本已备份：$selfDst"
    } elseif (-not (Get-FileFromUrls -Urls @("$RepoRaw/install.ps1") -OutFile $selfDst -Label '卸载脚本')) {
        Warn "卸载脚本备份失败，卸载时请手动删除目录 + 防火墙规则。"
        $uninstallCmd = '手动删除安装目录，并执行： netsh advfirewall firewall delete rule name="Manga OCR 8000"'
    }
    try {
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut($desktopLnk)
        $lnk.TargetPath = $launcher
        $lnk.WorkingDirectory = $InstallDir
        $lnk.Description = 'Manga Translate - Local OCR (PaddleOCR)'
        $lnk.Save()
        Ok "启动器：$launcher"
        Ok "桌面快捷方式：$desktopLnk"
    } catch {
        Warn "创建桌面快捷方式失败（不影响使用）：$($_.Exception.Message)"
        Ok "启动器：$launcher"
    }
}

# ============================================================
#  6. 防火墙
# ============================================================
Step 7 '放行 8000 端口（手机 / 局域网访问需要）'
$fwDone = $false
if ($SkipFirewall) {
    Warn '按参数要求跳过防火墙设置（手机将无法访问电脑上的 OCR）。'
} elseif ($DryRun) {
    Say "    [DryRun] 添加防火墙入站规则「$RuleName」放行 TCP $Port" 'DarkGray'
} else {
    try {
        $exists = Invoke-ExeQuiet -Exe 'netsh' -ExeArgs @('advfirewall', 'firewall', 'show', 'rule', "name=$RuleName")
        if ($exists -match [regex]::Escape($RuleName)) {
            Ok '防火墙规则已存在，跳过'
            $fwDone = $true
        }
    } catch { }
    if (-not $fwDone) {
        $fwArgs = @('advfirewall', 'firewall', 'add', 'rule', "name=$RuleName",
            'dir=in', 'action=allow', 'protocol=TCP', "localport=$Port")
        try {
            if (Test-Admin) {
                $rc = Invoke-ExeLive -Exe 'netsh' -ExeArgs $fwArgs
                if ($rc -eq 0) { Ok "已放行 TCP $Port"; $fwDone = $true }
            } else {
                Say '    需要管理员权限，正在弹出 UAC 确认框（点「是」即可）...' 'DarkGray'
                $p = Start-Process -FilePath 'netsh' -ArgumentList $fwArgs -Verb RunAs -Wait -PassThru -ErrorAction Stop
                if ($p.ExitCode -eq 0) { Ok "已放行 TCP $Port"; $fwDone = $true }
            }
        } catch { }
        if (-not $fwDone) {
            Warn "没能自动放行 $Port（你拒绝了 UAC 或权限不足）。"
            Warn '只影响手机访问；电脑上照常使用。需要时用管理员 PowerShell 执行：'
            Warn "  netsh advfirewall firewall add rule name=`"$RuleName`" dir=in action=allow protocol=TCP localport=$Port"
        }
    }
}

# ============================================================
#  完成：启动服务 + 探活
# ============================================================
Say ''
Say '=====================================================' 'White'
if ($DryRun) {
    Say '  DryRun 结束：以上环境检查全部通过，计划如上。' 'Yellow'
    Say "  去掉 -DryRun 重新运行即可真正部署到：$InstallDir" 'Yellow'
    Say '=====================================================' 'White'
    Say ''
    exit 0
}

if (Test-OcrAlive) {
    Ok "$Port 端口已有 OCR 服务在运行，直接复用（未重复启动）"
} else {
    $busy = Get-PortOwner
    if ($busy) {
        Warn "$Port 端口被其他程序占用（$($busy.ProcessName)，PID $($busy.Id)），无法启动 OCR 服务。"
        Warn '请先关掉占用该端口的程序，然后双击桌面的「启动漫画OCR」。'
    } else {
        Say '正在启动 OCR 服务（首次识别会自动下载模型，需要等一会儿）...' 'DarkGray'
        Start-Process -FilePath $launcher | Out-Null
        $deadline = (Get-Date).AddSeconds(240)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            Write-Host '.' -NoNewline
            if (Test-OcrAlive) { break }
        }
        Write-Host ''
        if (Test-OcrAlive) { Ok 'OCR 服务已启动并响应正常' }
        else { Warn '服务还没起来。可能仍在初始化 / 首次下载模型，看看那个黑窗口里的提示；也可以稍后双击桌面快捷方式重试。' }
    }
}

$lanIp = Get-LanIp
Say ''
Say '=====================================================' 'Green'
Say '  部署完成！' 'Green'
Say '=====================================================' 'Green'
Say ''
Say '  本机 OCR 地址（浏览器打开应显示 {"ok":true,...}）：'
Say "      http://127.0.0.1:$Port/" 'White'
if ($lanIp) {
    Say ''
    Say '  手机 / 局域网 OCR 地址（手机要和电脑连同一个 WiFi）：'
    Say "      http://${lanIp}:$Port/ocr" 'White'
    Warn '若手机连不上：检查电脑防火墙是否放行了 8000（可重新运行本脚本）。'
}
Say ''
Say '  ── 接下来做两件事 ──' 'White'
Say ''
Say '  1) 浏览器装 Tampermonkey，再安装用户脚本：'
Say '      https://github.com/nihao8602/86-' 'White'
Say ''
Say '  2) 打开脚本面板，这样填：'
Say "      识别(OCR) → 模式选「本地」→ 地址填  http://127.0.0.1:$Port/ocr" 'White'
if ($lanIp) { Say "      手机上填： http://${lanIp}:$Port/ocr ，设备选「手机端」" 'White' }
Say '      翻译引擎 → 选 DeepSeek（或其他），填你自己的 API Key' 'White'
Say '      源语言 → 按漫画选 韩文 / 日文 / 英文' 'White'
Say ''
Say '  ── 日常使用 ──' 'White'
Say '  双击桌面的「启动漫画OCR」，那个黑窗口保持开着；不用时关掉窗口即可。'
Say ''
Say '  ── 卸载 ──' 'White'
Say "  $uninstallCmd" 'DarkGray'
Say ''
