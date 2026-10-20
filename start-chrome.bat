@echo off
echo Starting Chrome with remote debugging...
taskkill /F /IM chrome.exe 2>nul
timeout /t 2 /nobreak >nul

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\chrome-debug-profile"

echo Chrome started! Please log into Moxfield in the browser window.
echo Then run: docker compose up tracker
pause