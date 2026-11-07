# HoloLoop installer: copies the packed app to Program Files, adds a Start menu
# shortcut and a firewall rule so phones on the home Wi-Fi can reach it.
# ASCII only, saved with a UTF-8 BOM. Asks for admin rights when it needs them.
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    return
}
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $here) { $here = (Get-Location).Path }
$src = Join-Path $here 'HoloLoop-win32-x64'
if (-not (Test-Path (Join-Path $src 'HoloLoop.exe'))) { throw "HoloLoop.exe not found beside this script ($src). Nothing was changed." }
$dst = Join-Path $env:ProgramFiles 'HoloLoop'

Get-Process HoloLoop -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy $LASTEXITCODE)" }

$lnkDir = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $lnkDir 'HoloLoop.lnk'))
$lnk.TargetPath = Join-Path $dst 'HoloLoop.exe'
$lnk.WorkingDirectory = $dst
$lnk.IconLocation = (Join-Path $dst 'HoloLoop.exe') + ',0'
$lnk.Description = 'HoloLoop: 3D videos for the Looking Glass Go'
$lnk.Save()

$exe = Join-Path $dst 'HoloLoop.exe'
Get-NetFirewallRule -DisplayName 'HoloLoop (phones)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'HoloLoop (phones)' -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile Private | Out-Null

Write-Host 'HoloLoop is installed. Open it from the Start menu.'
Start-Sleep -Seconds 4
