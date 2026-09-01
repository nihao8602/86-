@echo off
title Local OCR Server (Restart)

set "PY=C:\Users\nihao\AppData\Local\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"

cd /d "%~dp0"

echo [1/4] Stopping old OCR process on port 8000 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo [2/4] Opening firewall for port 8000 (LAN access) ...
netsh advfirewall firewall delete rule name="Local OCR 8000" >nul 2>&1
netsh advfirewall firewall add rule name="Local OCR 8000" dir=in action=allow protocol=TCP localport=8000 >nul 2>&1

echo [3/4] Waiting for port to release ...
timeout /t 1 /nobreak >nul

echo [4/4] Starting local-ocr-server.py ...
echo.
echo   This PC : http://127.0.0.1:8000
echo   LAN     : http://THIS-PC-IP:8000  (find IP by running: ipconfig)
echo   To stop : press Ctrl+C in this window.
echo.
"%PY%" local-ocr-server.py

echo.
echo Server stopped. Press any key to close this window.
pause >nul
