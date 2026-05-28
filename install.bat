@echo off
setlocal

REM install.bat — copy /inspector-gadget + its node tool into %USERPROFILE%\.claude\
REM Idempotent: re-running updates an existing install (robocopy /MIR on the
REM tool dir keeps it in sync with the repo). Double-click to run.

set "REPO=%~dp0"
set "DST_CMD=%USERPROFILE%\.claude\commands"
set "DST_TOOL=%USERPROFILE%\.claude\tools\inspector-gadget"

echo Installing inspector-gadget into %USERPROFILE%\.claude\
echo.

if not exist "%DST_CMD%"  mkdir "%DST_CMD%"
if not exist "%DST_TOOL%" mkdir "%DST_TOOL%"

REM 1) slash command file
robocopy "%REPO%.claude\commands" "%DST_CMD%" inspector-gadget.md /NJH /NJS /NP /R:1 /W:1 >nul
if errorlevel 8 goto :err
echo   command:  %DST_CMD%\inspector-gadget.md

REM 2) node tool + dotnet helper (mirror, drop .NET build cache)
robocopy "%REPO%tools\inspector-gadget" "%DST_TOOL%" /MIR /XD bin obj /NJH /NJS /NP /R:1 /W:1 >nul
if errorlevel 8 goto :err
echo   tool:     %DST_TOOL%\

echo.
echo done.  /inspector-gadget is now available from any project.
echo        First run on a .NET target builds the helper (one-time, a few seconds).
pause
exit /b 0

:err
echo.
echo error: robocopy failed (exit code %errorlevel%)
pause
exit /b 1
