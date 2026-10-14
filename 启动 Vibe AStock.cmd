@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
rem ---- WorkBuddy / CodeBuddy subscription bridge ----
rem Prefer the standalone official CLI (npm i -g @tencent-ai/codebuddy-code);
rem it is auto-discovered from %%APPDATA%%\npm. Only fall back to the
rem WorkBuddy-bundled headless CLI if no standalone install exists.
if not defined CODEBUDDY_BIN (
  if not exist "%APPDATA%\npm\codebuddy.ps1" (
    for %%P in (
      "%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
      "E:\AppStoreSoftstore\Install\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
      "C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
      "C:\Program Files (x86)\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
    ) do if exist %%~P set "CODEBUDDY_BIN=%%~P"
  )
)
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -X utf8 scripts\manage.py auto
) else (
  py -3 -X utf8 scripts\manage.py auto
)
if errorlevel 1 pause
endlocal
