@echo off
rem Engineering Board: start the server. Keep this window open while the team uses the board.
cd /d "%~dp0"
title Engineering Board
if not exist "node.exe" (
  echo.
  echo  node.exe is missing from this folder.
  echo.
  echo  1. Go to https://nodejs.org/en/download and choose "Windows Binary (.zip)", 64-bit, version 22 LTS.
  echo  2. Open the downloaded zip and copy node.exe into:
  echo     %~dp0
  echo  3. Run start.bat again.
  echo.
  pause
  exit /b 1
)
node.exe --disable-warning=ExperimentalWarning app\server.mjs
echo.
echo  The board has stopped.
pause
