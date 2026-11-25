# Starts the DeciShip_Pixel AVD if not running, waits for boot, sets up adb reverse for the API.
# If the emulator stays "offline" in `adb devices` for 120 s, the process we started (and its qemu-system child) is
# stopped by PID and started once more with -no-snapshot-load (cold boot).
param([string]$Avd = "DeciShip_Pixel", [int]$Port = 8088, [switch]$ColdBoot)
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$adb = "$sdk\platform-tools\adb.exe"; $emu = "$sdk\emulator\emulator.exe"
& $adb start-server | Out-Null

function Test-EmulatorOnline { [bool]((& $adb devices) -match "^emulator-\d+\s+device") }

function Start-Emulator([bool]$Cold) {
  $emuArgs = @("-avd", $Avd, "-gpu", "host", "-no-boot-anim", "-netdelay", "none", "-netspeed", "full")
  if ($Cold) { $emuArgs += "-no-snapshot-load" }
  Start-Process -FilePath $emu -ArgumentList $emuArgs -WindowStyle Normal -PassThru
}

# Only the PID we started and its qemu-system child; never kill by name.
function Stop-StartedEmulator($proc) {
  $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($proc.Id)" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "qemu-system*" })
  foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

function Wait-EmulatorOnline([int]$Seconds) {
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    if (Test-EmulatorOnline) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

if (-not (Test-EmulatorOnline)) {
  $proc = Start-Emulator ([bool]$ColdBoot)
  Write-Host "Starting $Avd ..."
  if (-not (Wait-EmulatorOnline 120)) {
    Write-Host "Emulator still offline after 120 s; stopping it and restarting once with -no-snapshot-load ..." -ForegroundColor Yellow
    Stop-StartedEmulator $proc
    & $adb kill-server | Out-Null
    & $adb start-server | Out-Null
    $proc = Start-Emulator $true
    Write-Host "Restarted $Avd (cold boot)."
  }
}
& $adb wait-for-device
$deadline = (Get-Date).AddMinutes(8)
while ((Get-Date) -lt $deadline) {
  if ((& $adb shell getprop sys.boot_completed 2>$null).Trim() -eq "1") { break }
  Start-Sleep -Seconds 3
}
if ((& $adb shell getprop sys.boot_completed).Trim() -ne "1") { throw "Emulator did not finish booting" }
& $adb reverse "tcp:$Port" "tcp:$Port" | Out-Null
Write-Host "Booted. adb reverse tcp:$Port -> host:$Port set."
& $adb devices
