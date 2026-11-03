@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 出图工作台

where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 22.13 或更高版本（推荐 24 LTS）：https://nodejs.org/zh-cn
  pause
  exit /b 1
)
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)
if %NODE_MAJOR% LSS 22 goto oldnode
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 goto oldnode

rem Reinstall when dependencies changed (after an update), not just on first run.
set NEED_INSTALL=0
if not exist node_modules\sharp set NEED_INSTALL=1
fc /b package-lock.json node_modules\.skillhub-lock >nul 2>nul
if errorlevel 1 set NEED_INSTALL=1
if "%NEED_INSTALL%"=="1" (
  echo 正在安装/更新依赖，大约 1-3 分钟……
  call npm ci
  if errorlevel 1 (
    echo 默认源安装失败，改用国内镜像重试……
    call npm ci --registry=https://registry.npmmirror.com
    if errorlevel 1 (
      echo 依赖安装失败，请检查网络后重试。
      pause
      exit /b 1
    )
  )
  copy /y package-lock.json node_modules\.skillhub-lock >nul
)
rem Always rebuild the page so updated code shows up.
(
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist .env copy .env.example .env >nul

echo.
echo 正在启动，浏览器会自动打开 http://localhost:8787
echo.
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:8787"
node --env-file-if-exists=.env backend/server.js
pause
exit /b 0

:oldnode
echo 当前 Node.js 版本太低（需要 22.13 或更高，推荐 24 LTS）：https://nodejs.org/zh-cn
pause
exit /b 1
