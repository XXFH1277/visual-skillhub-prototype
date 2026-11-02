$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stateFile = Join-Path $projectRoot '.data/processes.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output '没有此启动脚本管理的进程。'; exit }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
foreach ($entry in $state.processes) {
    $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if (-not $running) { continue }
    $expectedTicks = if ($entry.startedTicks) { $entry.startedTicks } else { ([datetime]$entry.started).ToUniversalTime().Ticks.ToString() }
    if ($running.StartTime.ToUniversalTime().Ticks.ToString() -ne $expectedTicks -or $running.Path -ne $entry.path) {
        throw "进程 $($entry.id) 身份已变化，未停止。进程记录保留，请手动核对。"
    }
    & taskkill.exe /PID $entry.id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "无法停止进程 $($entry.id)，请检查任务管理器。" }
}
Remove-Item -LiteralPath $stateFile
Write-Output '网站和隧道已停止。运行中任务将在下次启动时标记失败并退回测试积分。'
