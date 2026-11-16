@echo off
setlocal
cd /d "%~dp0"

echo [1/4] rebuilding manifest ...
where node >nul 2>&1 && (
  node tools\pack.mjs
  node tools\verify.mjs
) || echo   node not found, skip pack/verify

echo [2/4] stopping process on 127.0.0.1:8080 ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8080 .*LISTENING"') do (
  echo   kill PID %%P
  taskkill /F /PID %%P >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

echo [3/4] starting dhvw-shell ...
start "dhvw-shell" /min /D "%~dp0shell" cmd /c "go run . -dev -addr 127.0.0.1:8080 -root ../www"

echo [4/4] waiting for health ...
for /l %%i in (1,1,20) do (
  curl -s -o nul http://127.0.0.1:8080/__health && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo FAILED: http://127.0.0.1:8080/__health not ready
exit /b 1

:ready
echo OK
curl -s http://127.0.0.1:8080/__health
echo.
endlocal
