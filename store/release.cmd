@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 -X utf8 release.py %*
goto finished
:use_python
python -X utf8 release.py %*
:finished
set "release_exit=%errorlevel%"
popd
if "%~1"=="" pause
exit /b %release_exit%
