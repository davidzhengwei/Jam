@echo off
rem Jam launcher: install deps on first run, then build and start
cd /d %~dp0
title Jam
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --registry=https://registry.npmmirror.com
)
call npx vite build
call npx electron .
