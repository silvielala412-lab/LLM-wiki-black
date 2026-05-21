$connections = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
  Write-Output "Port 7777 is not listening."
  exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
  Stop-Process -Id $processId -Force
  Write-Output "Stopped process $processId on port 7777."
}
