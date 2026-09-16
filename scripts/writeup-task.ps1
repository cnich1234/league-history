# Wrapper for the scheduled writeup runs.
#
# Task Scheduler gives a task a bare environment: no npm on PATH, no working
# directory, and a shell that is not the one Chris types into. Everything the
# run needs is set here rather than assumed, so a task that works when launched
# by hand also works at six in the morning with nobody logged in.
#
# Output goes to a dated log because a scheduled job that fails silently is
# worse than no job at all -- and the run itself pushes a notification on
# publish, on block and on crash, so silence is never the success case.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('preview', 'recap')]
  [string]$Kind,

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo '.writeup-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("{0}-{1}.log" -f $Kind, (Get-Date -Format 'yyyy-MM-dd'))

# npm's global bin holds `claude`; Task Scheduler does not inherit it.
$env:PATH = "$env:APPDATA\npm;$env:PATH"

Set-Location $repo

"=== $(Get-Date -Format o) starting $Kind run ===" | Tee-Object -FilePath $log -Append

try {
  # Pull first: the repo may be behind if a change was pushed from elsewhere,
  # and committing onto a stale tree is how you get a conflict at 6am.
  & git pull --ff-only 2>&1 | Tee-Object -FilePath $log -Append

  $args = @('--env-file=.env.local', 'scripts/writeup.mjs', $Kind)
  if ($DryRun) { $args += '--dry-run' }

  & node @args 2>&1 | Tee-Object -FilePath $log -Append
  $code = $LASTEXITCODE

  "=== $(Get-Date -Format o) finished with exit code $code ===" | Tee-Object -FilePath $log -Append
  exit $code
}
catch {
  "=== $(Get-Date -Format o) FAILED: $_" | Tee-Object -FilePath $log -Append
  exit 1
}
