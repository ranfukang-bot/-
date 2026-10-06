@echo off
title StarPunch Server
cd /d "%~dp0server"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js is not installed.
  echo      Please download and install the LTS version from https://nodejs.org/zh-cn
  echo      then double-click this file again.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
echo  Server stopped.
pause
