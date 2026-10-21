$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$task = Get-ScheduledTask -TaskName 'WorkBuddyBridge-8647' -ErrorAction SilentlyContinue
if ($task) {
    if ($task.Actions[0].WorkingDirectory -ne $root) { throw 'Task belongs to a different installation.' }
    Start-ScheduledTask -TaskName 'WorkBuddyBridge-8647'
} else {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'scripts\run-supervisor.ps1') + '"')) -WorkingDirectory $root -WindowStyle Hidden
}
Write-Output 'WorkBuddy bridge supervisor requested. Run npm.cmd run status after startup.'
