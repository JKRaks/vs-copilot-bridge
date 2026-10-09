@echo off
chcp 65001 >nul
node "%~dp0src\start.mjs"
if errorlevel 1 pause
