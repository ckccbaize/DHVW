@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem  DHVW ARM device page - PC test launcher (loopback only).
rem  No Node / Go / Python required. See README.txt for details.
rem  Usage: start-windows.bat [port]     default port: 18080
rem
rem  KEEP THIS FILE PURE ASCII: cmd.exe parses .bat in the OEM code page
rem  (GBK on zh-CN), so UTF-8 Chinese comments garble whole lines into
rem  bogus commands. CRLF line endings are equally required.
rem ------------------------------------------------------------------

set "PORT=%~1"
if "%PORT%"=="" set "PORT=18080"
set "EXE=%~dp0dhvw-shell-windows-amd64.exe"

if not exist "%EXE%" (
  echo [ERROR] missing dhvw-shell-windows-amd64.exe
  pause
  exit /b 1
)

echo [1/3] starting dhvw-shell on http://127.0.0.1:%PORT%
start "dhvw-shell" /min "%EXE%" -dev -addr 127.0.0.1:%PORT% -pair-addr "" -root www

echo [2/3] waiting for /__health ...
set "TRY=0"
:wait
set /a TRY+=1
call :probe && goto ready
if !TRY! GEQ 40 goto failed
timeout /t 1 /nobreak >nul 2>&1
goto wait

:probe
where curl >nul 2>&1 || goto probe_ps
curl -s -o nul "http://127.0.0.1:%PORT%/__health" && exit /b 0
exit /b 1

:probe_ps
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/__health').StatusCode -eq 200}catch{exit 1}" >nul 2>&1
exit /b 1

:failed
echo [ERROR] service not ready on port %PORT%. The port may be in use.
echo         try another port:  start-windows.bat 18081
pause
exit /b 1

:ready
echo [3/3] ready
echo.
echo   overview : http://127.0.0.1:%PORT%/
echo   tour     : http://127.0.0.1:%PORT%/tour.html
echo   map view : http://127.0.0.1:%PORT%/preview.html?scene=home
echo.
echo   stop: Task Manager -^> end dhvw-shell-windows-amd64.exe
if /i "%NOOPEN%"=="1" goto done
start "" "http://127.0.0.1:%PORT%/"
:done
timeout /t 6 /nobreak >nul 2>&1
endlocal
