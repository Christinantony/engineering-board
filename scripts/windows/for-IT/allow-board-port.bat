@echo off
rem Engineering Board: firewall rule so colleagues on the LAN can open the board.
rem For IT: right-click, "Run as administrator". It adds ONE inbound TCP rule for the
rem board's port, for the Domain and Private network profiles only. Nothing else changes.
setlocal
fltmc >nul 2>&1
if errorlevel 1 (
  echo.
  echo  This needs administrator rights. Right-click allow-board-port.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)
cd /d "%~dp0.."

rem The port: from config.json if it sets one, otherwise the default 8080.
set PORT=8080
if exist "config.json" (
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try { $c = ConvertFrom-Json (Get-Content -Raw config.json); if ($c.port) { $c.port } else { 8080 } } catch { 8080 }" 2^>nul`) do set PORT=%%p
)

echo.
echo  Adding an inbound rule "Engineering Board" for TCP port %PORT% (Domain and Private profiles)...
netsh advfirewall firewall delete rule name="Engineering Board" >nul 2>&1
netsh advfirewall firewall add rule name="Engineering Board" dir=in action=allow protocol=TCP localport=%PORT% profile=domain,private description="Engineering Board (internal workboard). Inbound TCP %PORT% from the LAN."
if errorlevel 1 (
  echo  Adding the rule failed. See for-IT\FOR-IT.html for the manual steps.
  pause
  exit /b 1
)

echo.
echo  Checking for "Block" rules for node.exe. Windows creates these when someone without admin
echo  rights clicks Cancel on the "allow access" prompt, and a Block rule overrides the rule above:
powershell -NoProfile -Command "$r = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*\node.exe' } | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }; if ($r) { $r | Format-Table DisplayName, Profile, Enabled -AutoSize; Write-Host '  Remove these in Windows Defender Firewall, Inbound Rules, so the board can be reached.' } else { Write-Host '  None found. Good.' }"

echo.
echo  Done. Colleagues can now open http://%COMPUTERNAME%:%PORT%
echo.
pause
