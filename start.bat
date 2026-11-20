@echo off
REM Duck.ai OpenAI-compatible bridge launcher
REM 把 server.mjs 所在目录作为工作目录运行（放到任意位置都能用）
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found in PATH
  exit /b 1
)
for /f "tokens=*" %%p in ('where node') do set NODE=%%p
start "duckai-bridge" /B "%NODE%" "server.mjs"
timeout /t 3 /nobreak >nul
curl -s http://127.0.0.1:3426/health
echo.
echo [duckai-bridge] started. Health check above should show {"ok":true,...}
