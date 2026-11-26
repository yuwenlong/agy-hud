@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 goto :check_program_files
node "%~dp0agy-hud.js" %*
exit /b %ERRORLEVEL%
:check_program_files
if exist "%ProgramFiles%\nodejs\node.exe" goto :use_program_files
echo agy-hud: node.exe not found on PATH or in "%ProgramFiles%\nodejs\node.exe". 1>&2
exit /b 9009
:use_program_files
"%ProgramFiles%\nodejs\node.exe" "%~dp0agy-hud.js" %*
exit /b %ERRORLEVEL%
