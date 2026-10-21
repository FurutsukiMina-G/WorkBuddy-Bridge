param([int]$CandidatePid, [string]$ExpectedScript, [string]$ExpectedExe)
$ErrorActionPreference = 'Stop'
$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $CandidatePid)
if ($p -and $p.ExecutablePath -eq $ExpectedExe -and ([string]$p.CommandLine).Contains($ExpectedScript)) { Write-Output 'owned' } else { Write-Output 'stale' }
