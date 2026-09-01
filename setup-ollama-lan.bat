@echo off
title Setup Ollama LAN access (run as admin)

echo [1/3] Setting OLLAMA_HOST=0.0.0.0 ...
setx OLLAMA_HOST "0.0.0.0" >nul

echo [2/3] Opening firewall for port 11434 ...
netsh advfirewall firewall delete rule name="Ollama 11434" >nul 2>&1
netsh advfirewall firewall add rule name="Ollama 11434" dir=in action=allow protocol=TCP localport=11434 >nul 2>&1

echo [3/3] Restarting Ollama ...
taskkill /F /IM "ollama app.exe" >nul 2>&1
taskkill /F /IM "ollama.exe" >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "C:\Users\nihao\AppData\Local\Programs\Ollama\ollama app.exe"

echo.
echo Done. Ollama now listens on 0.0.0.0:11434.
echo.
echo On the PHONE, set translation URL to:
echo   http://THIS-PC-IP:11434/v1/chat/completions
echo   (THIS-PC-IP = your PC's LAN IP, find with: ipconfig)
echo.
pause
