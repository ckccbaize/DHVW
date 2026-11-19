@echo off
setlocal
cd /d "%~dp0"

rem Local ARM sim defaults to port 18080 (keeps 8080 free for standalone llama-server)
rem and uses -default-ws to auto-connect PC orchestrator without manual pairing.
set "ARM_PORT=%~1"
if "%ARM_PORT%"=="" set "ARM_PORT=18080"
set "PC_WS_URL=%~2"
if "%PC_WS_URL%"=="" set "PC_WS_URL=ws://127.0.0.1:8877/dhvw"

echo [1/4] rebuilding manifest ...
where node >nul 2>&1 && (
  node tools\pack.mjs
  node tools\verify.mjs
) || echo   node not found, skip pack/verify

echo [2/4] stopping existing ARM sim on 127.0.0.1:%ARM_PORT% / :8081 ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%ARM_PORT% .*LISTENING" /C:":8081 .*LISTENING"') do (
  echo   kill PID %%P
  taskkill /F /PID %%P >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

echo [3/4] starting dhvw-shell on http://127.0.0.1:%ARM_PORT% (default-ws=%PC_WS_URL%) ...
start "dhvw-shell" /min /D "%~dp0shell" cmd /c "go run . -dev -addr 127.0.0.1:%ARM_PORT% -default-ws %PC_WS_URL% -root ../www"

echo [4/4] waiting for health ...
for /l %%i in (1,1,20) do (
  curl -s -o nul http://127.0.0.1:%ARM_PORT%/__health && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo FAILED: http://127.0.0.1:%ARM_PORT%/__health not ready
exit /b 1

:ready
echo OK: http://127.0.0.1:%ARM_PORT% (default PC WS: %PC_WS_URL%)
curl -s http://127.0.0.1:%ARM_PORT%/__health
echo.
endlocal