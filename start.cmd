@echo off
rem Nijimaku launcher for Windows. Keep this file ASCII-only: cmd.exe reads it in the console code page.
setlocal
cd /d "%~dp0"
if not exist "node\node.exe" (
  echo node\node.exe not found. Extract the whole ZIP first, then run start.cmd in the extracted folder.
  pause
  exit /b 1
)
"node\node.exe" --env-file-if-exists=.env app\launcher.ts --open
if errorlevel 1 pause
