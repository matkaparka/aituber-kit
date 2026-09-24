@echo off
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set NO_PROXY=localhost,127.0.0.1,::1
set NODE_USE_ENV_PROXY=1
cd /d E:\aivup\aituber-kit
call LAUNCH.bat