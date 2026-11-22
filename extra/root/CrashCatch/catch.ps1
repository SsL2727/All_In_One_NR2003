# NR2003 crash catcher. Start this, then start NR2003 (before or after - it waits for the game and attaches by itself).
# It attaches as a debugger (the game runs as normal) and, when the game ends, writes to Documents\NR2003 CrashCatch (or -Out <folder>):
#   nr2003-<time>.txt   what ended it: the exception (code, address, module+offset) or the exit code, registers, a short stack of
#                       return addresses with module + offset, the last exceptions and debug strings before it
#   nr2003-<time>.dmp   a small minidump (open in Visual Studio / WinDbg)
# A FREEZE is written down too, while it is happening: when the game window stops responding for -HangSeconds (default 8) in a row,
#   nr2003-<time>-hang.txt / .dmp   every thread's stack + a minidump (watching goes on; the game is not touched)
# It watches NR2003.exe and RaceLab's builds (NR2003_MS.exe, NR2003_RaceLabV2.exe) unless -Process names others (comma separated).
# NR2003 runs as administrator, so this needs it too: it asks for it. Leave the window open while you race.
param([string]$Process = 'NR2003,NR2003_MS,NR2003_RaceLabV2', [string]$Out = '', [int]$Runs = 0, [int]$HangSeconds = 8, [switch]$NoElevate)
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NR2003 CrashCatch' }   # reports go to Documents\NR2003 CrashCatch
$id = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $NoElevate -and -not $id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Process', "`"$Process`"", '-Out', "`"$Out`"", '-Runs', $Runs, '-HangSeconds', $HangSeconds)
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}
Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'CrashCatch.cs') -Raw) -Language CSharp
[CrashCatch]::Run($Process, $Out, $Runs, $HangSeconds)
