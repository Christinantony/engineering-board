@echo off
rem Engineering Board: start the server. Keep this window open while the team uses the board.
cd /d "%~dp0"
title Engineering Board
rem (no parenthesised block below: a folder path containing ")" or "&" would break it)
if exist "node.exe" goto run
echo.
echo  node.exe is missing from this folder.
echo.
echo  1. Go to https://nodejs.org/en/download and choose "Windows Binary (.zip)", x64, version 22 LTS.
echo  2. Open the downloaded zip and copy node.exe into this folder:
echo     "%~dp0"
echo  3. Run start.bat again.
echo.
pause
exit /b 1

:run
node.exe --disable-warning=ExperimentalWarning app\server.mjs
echo.
echo  The board has stopped.
pause
