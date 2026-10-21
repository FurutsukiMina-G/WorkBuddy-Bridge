$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskName = 'WorkBuddyBridge-8647'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions[0].WorkingDirectory -ne $root) { throw 'Task belongs to a different installation.' }
$runPath = Join-Path $root 'scripts\run-supervisor.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runPath + '"') -WorkingDirectory $root
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Independent WorkBuddy official-SDK bridge for DSH, loopback port 8647.' -Force | Out-Null
# Secrets and SDK scratch homes are private to this Windows user.
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
& icacls.exe $runtime '/inheritance:r' '/grant:r' ($account + ':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect runtime directory.' }
Start-ScheduledTask -TaskName $taskName
Write-Output 'Installed and started WorkBuddyBridge-8647 (current user, login trigger, no time limit).'
