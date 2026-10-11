@echo off
rem Engineering Board: start the board automatically when you sign in to Windows.
rem Adds a shortcut to start.bat in your own Startup folder. No administrator rights needed.
cd /d "%~dp0"
setlocal
set "TARGET=%~dp0start.bat"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Engineering Board.lnk"
set "WD=%~dp0"

rem replace any old shortcut (for example one pointing at a folder that has since moved)
del "%LINK%" >nul 2>&1

rem 1st try: PowerShell
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath=$env:TARGET; $s.WorkingDirectory=(Split-Path $env:TARGET); $s.WindowStyle=7; $s.Description='Engineering Board server'; $s.Save()" >nul 2>&1
if exist "%LINK%" goto done

rem 2nd try: Windows Script Host (some PCs block PowerShell)
set "VBS=%TEMP%\eb-shortcut.vbs"
> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>>"%VBS%" echo Set s = sh.CreateShortcut(sh.ExpandEnvironmentStrings("%%LINK%%"))
>>"%VBS%" echo s.TargetPath = sh.ExpandEnvironmentStrings("%%TARGET%%")
>>"%VBS%" echo s.WorkingDirectory = sh.ExpandEnvironmentStrings("%%WD%%")
>>"%VBS%" echo s.WindowStyle = 7
>>"%VBS%" echo s.Save
cscript //nologo "%VBS%" >nul 2>&1
del "%VBS%" >nul 2>&1
if exist "%LINK%" goto done

echo.
echo  Windows did not let this script make the shortcut. Do it by hand instead:
echo   1. Press Windows+R, type  shell:startup  and press Enter. A folder opens.
echo   2. In this folder, "%~dp0", right-click start.bat and choose "Create shortcut".
echo   3. Move the new shortcut into the Startup folder.
echo   4. Right-click the shortcut, choose Properties, set "Run" to "Minimized", and click OK.
echo.
pause
exit /b 1

:done
echo.
echo  Done. The board will now start by itself, minimised, each time you sign in to Windows.
echo  To stop that, run autostart-off.bat.
echo.
echo  Tip: the board can only be reached while this PC is on and awake. In Settings, System,
echo  Power, set "When plugged in, put my device to sleep after" to Never.
echo.
pause
