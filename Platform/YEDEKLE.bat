@echo off
chcp 65001 >nul
rem -Bekle: cift tiklayinca pencere sonucu okumadan kapanmasin. Gece gorevi yedekle.ps1 dosyasini dogrudan cagirir.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\yedekle.ps1" -Bekle %*
exit /b %ERRORLEVEL%
