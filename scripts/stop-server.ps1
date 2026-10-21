$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$task = Get-ScheduledTask -TaskName 'WorkBuddyBridge-8647' -ErrorAction SilentlyContinue
if ($task) {
    if ($task.Actions[0].WorkingDirectory -ne $root) { throw 'Task belongs to a different installation.' }
    Stop-ScheduledTask -TaskName 'WorkBuddyBridge-8647'
}
$nodeExe = (Get-Command node.exe).Source
foreach ($entry in @(@{File='supervisor.lock';Script='scripts\supervisor.mjs'}, @{File='worker.pid';Script='src\main.mjs'})) {
    $path = Join-Path $root ('.runtime\' + $entry.File)
    if (!(Test-Path -LiteralPath $path)) { continue }
    $storedPid = [int](Get-Content -LiteralPath $path -Raw)
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $storedPid)
    $expected = Join-Path $root $entry.Script
    if ($p -and $p.Name -eq 'node.exe' -and ([string]$p.CommandLine).Contains($expected)) { Stop-Process -Id $storedPid -Force }
}
Write-Output 'Stopped only verified processes from this WorkBuddy bridge installation.'
