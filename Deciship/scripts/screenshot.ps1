# Usage: .\screenshot.ps1 [-Path out.png]
param([string]$Path = "$PSScriptRoot\screenshot.png")
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$adb = "$sdk\platform-tools\adb.exe"
$tmp = [IO.Path]::GetTempFileName()
cmd /c "`"$adb`" exec-out screencap -p > `"$tmp`""
Move-Item -Force $tmp $Path
Write-Host "Saved $Path"
