@echo off
setlocal
rem ============================================================
rem   Change the address below to your server address, e.g.
rem   set "SERVER=http://192.168.1.100:8080"
rem   set "SERVER=https://daka.example.com"
rem ============================================================
set "SERVER=http://localhost:8080"

set "BR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%BR%" goto run
set "BR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%BR%" goto run
set "BR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%BR%" goto run
set "BR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%BR%" goto run
set "BR=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%BR%" goto run

start "" "%SERVER%/"
goto :eof

:run
start "" "%BR%" --app="%SERVER%/" --window-size=1400,900
