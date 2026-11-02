param([string]$BeforeStartScript)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot = Join-Path $projectRoot '.data'
$stateFile = Join-Path $dataRoot 'processes.json'
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$nodePath = (Get-Command node.exe).Source
$previousOrigin = $env:PUBLIC_ORIGIN
$previousInstance = $env:SKILLHUB_INSTANCE_ID
$server = $null
try {
    foreach ($entry in $state.processes) {
        $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if (-not $running -or $running.StartTime.ToUniversalTime().Ticks.ToString() -ne $entry.startedTicks -or $running.Path -ne $entry.path) { throw "进程 $($entry.id) 身份不匹配，请先核对。" }
    }
    foreach ($entry in @($state.processes | Where-Object { $_.kind -eq 'server' })) {
        & taskkill.exe /PID $entry.id /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '无法停止原服务器' }
    }
    $state.processes = @($state.processes | Where-Object { $_.kind -ne 'server' })
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding utf8
    if ($BeforeStartScript) {
        & $nodePath $BeforeStartScript
        if ($LASTEXITCODE -ne 0) { throw '启动前任务失败' }
    }
    $env:PUBLIC_ORIGIN = $state.publicUrl
    $instance = [guid]::NewGuid().ToString()
    $env:SKILLHUB_INSTANCE_ID = $instance
    $serverFile = Join-Path $projectRoot 'backend/server.js'
    $server = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.env',('"'+$serverFile+'"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'server.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'server.stderr.log') -PassThru
    $server.Refresh()
    $state.processes += @{id=$server.Id;startedTicks=$server.StartTime.ToUniversalTime().Ticks.ToString();path=$nodePath;kind='server'}
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding utf8
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) { throw '服务器已退出，请检查本机日志' }
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2; $ready = $health.ok -and $health.instanceId -eq $instance; if ($ready) { break } } catch {}
    }
    if (-not $ready) { throw '服务器启动超时' }
    Write-Output "服务器已更新，公网隧道保持不变：$($state.publicUrl)"
} finally {
    $env:PUBLIC_ORIGIN = $previousOrigin
    $env:SKILLHUB_INSTANCE_ID = $previousInstance
}
