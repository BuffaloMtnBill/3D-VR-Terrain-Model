@echo off
rem Terrain Studio launcher for Windows: sets up on first run, then starts the app.
setlocal
cd /d "%~dp0"

set "VENV_PY=.venv\Scripts\python.exe"

if exist "%VENV_PY%" goto :packages

where py >nul 2>nul
if %errorlevel%==0 (set "PY=py -3") else (set "PY=python")
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 goto :nopython

echo Setting up Terrain Studio for the first time. This takes a few minutes...
%PY% -m venv .venv
if errorlevel 1 goto :failed

:packages
rem Install again whenever requirements.txt differs from what was last installed.
fc /b requirements.txt ".venv\requirements.installed" >nul 2>nul
if not errorlevel 1 goto :run
echo Installing required packages...
"%VENV_PY%" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :failed
copy /y requirements.txt ".venv\requirements.installed" >nul

:run
"%VENV_PY%" app.py --open %*
if errorlevel 1 pause
exit /b %errorlevel%

:nopython
echo.
echo Python 3.11 or newer was not found.
echo Install it from https://www.python.org/downloads/windows/ and tick
echo "Add python.exe to PATH" in the installer, then run this file again.
echo.
pause
exit /b 1

:failed
echo.
echo Setup did not finish. Check your internet connection and run this file again.
echo.
pause
exit /b 1
