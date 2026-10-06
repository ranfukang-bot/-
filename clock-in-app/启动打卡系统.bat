@echo off
setlocal
set "APP=%~dp0index.html"
set "URL=file:///%APP:\=/%"

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

start "" "%APP%"
goto :eof

:run
start "" "%BR%" --app="%URL%" --window-size=1400,900
