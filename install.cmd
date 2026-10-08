@echo off
chcp 936 >nul
title 漫画翻译引擎 - 本地 OCR 一键部署
cd /d "%~dp0"

set "PS1=%TEMP%\manga-ocr-install.ps1"
set "RAW=https://raw.githubusercontent.com/nihao8602/86-/main/install.ps1"

echo.
echo   ==================================================
echo     漫画翻译引擎 - 本地 OCR 一键部署
echo   ==================================================
echo.
echo   将在这台电脑上装好：Python 3.12 + PaddleOCR + 本地识别服务
echo   需要下载约 600MB 依赖，视网速大概 5-15 分钟
echo   全部装在独立的 manga-ocr 目录里，不影响系统里已有的 Python
echo.

if exist "%~dp0install.ps1" (
    echo   使用本目录下的 install.ps1
    set "PS1=%~dp0install.ps1"
    goto fixbom
)

echo   正在下载部署脚本 install.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '%RAW%' -OutFile '%PS1%' -UseBasicParsing } catch { exit 1 }"

if not exist "%PS1%" (
    echo.
    echo   [失败] install.ps1 下载失败。
    echo.
    echo   原因通常是网络访问不了 raw.githubusercontent.com。
    echo   解决办法（任选一个）：
    echo     1. 打开代理后重新双击本文件
    echo     2. 手动打开仓库页面，下载 install.ps1 放到本目录，再双击本文件
    echo        仓库地址：https://github.com/nihao8602/86-
    echo.
    pause
    exit /b 1
)

:fixbom
rem 给脚本补上 UTF-8 BOM：否则 PowerShell 5.1 会按 GBK 读它，中文提示全乱码
powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=[IO.File]::ReadAllBytes('%PS1%'); if ($b.Length -gt 3 -and -not ($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191)) { $t=[IO.File]::ReadAllText('%PS1%',[Text.Encoding]::UTF8); [IO.File]::WriteAllText('%PS1%', $t, (New-Object Text.UTF8Encoding($true))) }"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
    echo   [提示] 部署脚本退出码 %RC%，请把上面的报错内容截图反馈。
) else (
    echo   部署脚本执行结束。
)
echo.
pause
