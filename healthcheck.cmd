@echo off
cd /d "%~dp0"
node dist\index.js --healthcheck
pause
