@echo off
title Local OCR Server (Restart)
setlocal

rem Usage:  restart-ocr.bat [port]     default port = 8000
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"
set "OCR_PORT=%PORT%"

rem Use the venv created by install.ps1. Do NOT hardcode a personal Python path:
rem PaddleOCR lives inside the venv, so a bare "python" usually fails.
set "PY=%USERPROFILE%\manga-ocr\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

set "RULE=Manga OCR %PORT%"
set "OLD_RULE=Local OCR 8000"
set "SERVER=%~dp0local-ocr-server.py"
if not exist "%SERVER%" set "SERVER=%USERPROFILE%\manga-ocr\local-ocr-server.py"

cd /d "%~dp0"

echo [1/4] Releasing port %PORT% ...
rem Get-NetTCPConnection cannot see listeners owned by other users from a normal shell,
rem so use netstat, which lists every listener together with its PID.
set "OLD_PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do set "OLD_PID=%%a"
if defined OLD_PID (
    echo        port %PORT% is held by PID %OLD_PID%, stopping it ...
    taskkill /F /PID %OLD_PID% >nul 2>&1
    ping -n 2 127.0.0.1 >nul
)
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [ERROR] port %PORT% is still in use and this window cannot stop it.
    echo         Usually that service was started with administrator rights.
    echo.
    echo   Do one of these:
    echo     1. Right-click this file and choose "Run as administrator"
    echo     2. In an admin PowerShell run:  taskkill /F /PID %OLD_PID%
    echo     3. Use another port:           restart-ocr.bat 8010
    echo.
    pause
    exit /b 1
)

echo [2/4] Opening firewall for port %PORT% (LAN access, private/domain only) ...
echo        (this step needs admin; ignore the warning if you only use the PC locally)
netsh advfirewall firewall delete rule name="%OLD_RULE%" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain >nul 2>&1

echo [3/4] Waiting ...
ping -n 2 127.0.0.1 >nul

echo [4/4] Starting local-ocr-server.py ...
echo.
echo   Server : %SERVER%
echo   Python : %PY%
echo   Port   : %PORT%
echo   This PC: http://127.0.0.1:%PORT%
echo   LAN    : http://THIS-PC-IP:%PORT%  (find IP by running: ipconfig)
echo   To stop: press Ctrl+C in this window.
echo.
if not exist "%SERVER%" (
    echo [ERROR] local-ocr-server.py not found next to this file or in %USERPROFILE%\manga-ocr
    pause
    exit /b 1
)
"%PY%" "%SERVER%"

echo.
echo [INFO] the service exited.
echo        If you saw a Python error above, fix that first.
echo        Common causes: venv is missing PaddleOCR (re-run install.cmd),
echo                       or the port is busy (try: restart-ocr.bat 8010).
echo.
pause >nul
endlocal