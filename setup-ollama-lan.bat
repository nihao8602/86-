@echo off
title Setup Ollama LAN access (run as admin)
setlocal

echo [1/3] Setting OLLAMA_HOST=0.0.0.0 (registry + current session) ...
setx OLLAMA_HOST "0.0.0.0" >nul
rem setx only writes the registry; the CURRENT cmd environment is not refreshed.
rem Without the next line the freshly started Ollama still binds 127.0.0.1 and the
rem "now listens on 0.0.0.0" message below would be a lie.
set "OLLAMA_HOST=0.0.0.0"

echo [2/3] Opening firewall for port 11434 (private/domain only) ...
netsh advfirewall firewall delete rule name="Ollama 11434" >nul 2>&1
netsh advfirewall firewall add rule name="Ollama 11434" dir=in action=allow protocol=TCP localport=11434 profile=private,domain >nul 2>&1

echo [3/3] Restarting Ollama ...
taskkill /F /IM "ollama app.exe" >nul 2>&1
taskkill /F /IM "ollama.exe" >nul 2>&1
timeout /t 2 /nobreak >nul
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else (
    start "" ollama
)

echo.
echo Done. Ollama now listens on 0.0.0.0:11434.
echo WARNING: there is NO auth on 0.0.0.0 - anyone on the same LAN can use or delete your models.
echo WARNING: to undo, run:  setx OLLAMA_HOST ""   then restart Ollama.
echo.
echo On the PHONE, set translation URL to:
echo   http://THIS-PC-IP:11434/v1/chat/completions
echo   (THIS-PC-IP = your PC's LAN IP, find with: ipconfig)
echo.
pause
endlocal