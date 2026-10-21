$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeExe = (Get-Command node.exe).Source
New-Item -ItemType Directory -Path (Join-Path $root 'reports') -Force | Out-Null
$child = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + (Join-Path $root 'scripts\supervisor.mjs') + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'reports\supervisor.out.log') -RedirectStandardError (Join-Path $root 'reports\supervisor.err.log') -PassThru
$child.WaitForExit()
exit $child.ExitCode
