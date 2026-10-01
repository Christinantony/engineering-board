@echo off
rem Engineering Board: stop starting the board automatically at sign-in.
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Engineering Board.lnk"
if exist "%LINK%" (
  del "%LINK%"
  echo.
  echo  Done. The board will no longer start by itself when you sign in.
) else (
  echo.
  echo  The board was not set to start by itself, so there is nothing to undo.
)
echo  If the board is running now, it keeps running until you close its window.
echo.
pause
