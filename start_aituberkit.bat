@echo off
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set NO_PROXY=localhost,127.0.0.1,::1
set NODE_USE_ENV_PROXY=1
cd /d E:\aivup\aituber-kit
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo AITuberKit is ALREADY RUNNING on http://localhost:3000 - just press F5 in the live window.
  echo To restart it, close the window that is running it first.
  pause
  exit /b 0
)
rem npm output is also written to E:\aivup\aituber_dev.log; window stays open after exit
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run dev 2>&1 | ForEach-Object { \"$_\" } | Tee-Object -FilePath E:\aivup\aituber_dev.log"
echo.
echo [AITuberKit exited - see messages above or E:\aivup\aituber_dev.log]
pause
