@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-JishnuSupportShortcut.ps1"
if errorlevel 1 (
  echo.
  echo Shortcut installation failed. See the message above.
  pause
  exit /b 1
)
echo.
pause
