param([switch]$Public, [string]$Cloudflared, [string]$EdgeBindAddress, [switch]$ResolveEdgeViaHttps)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot = Join-Path $projectRoot '.data'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$stateFile = Join-Path $dataRoot 'processes.json'
if (Test-Path -LiteralPath $stateFile) {
    $previous = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    foreach ($entry in $previous.processes) {
        $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        $expectedTicks = if ($entry.startedTicks) { $entry.startedTicks } else { ([datetime]$entry.started).ToUniversalTime().Ticks.ToString() }
        if ($running -and $running.StartTime.ToUniversalTime().Ticks.ToString() -eq $expectedTicks) {
            throw '工作台已启动。需要重启时先运行 scripts/stop.ps1。'
        }
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/index.html'))) { throw '请先在项目目录运行 npm ci 和 npm run build。' }
$nodePath = (Get-Command node.exe).Source
$started = @()
$publicUrl = $null
$previousOrigin = $env:PUBLIC_ORIGIN
$previousInstance = $env:SKILLHUB_INSTANCE_ID
$instance = [guid]::NewGuid().ToString()
$env:SKILLHUB_INSTANCE_ID = $instance
function Remember-Process($process, $kind, $executable) {
    $process.Refresh()
    return @{id=$process.Id;startedTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();path=$executable;kind=$kind}
}
try {
    if ($Public) {
        if (-not $Cloudflared) { $Cloudflared = Join-Path $projectRoot '../tools/cloudflared.exe' }
        $Cloudflared = (Resolve-Path -LiteralPath $Cloudflared).Path
        $tunnelLog = Join-Path $dataRoot 'tunnel.stderr.log'
        $tunnelArgs = @('tunnel','--url','http://127.0.0.1:8787','--protocol','http2','--edge-ip-version','4','--no-autoupdate')
        if ($EdgeBindAddress) {
            $parsedAddress = [System.Net.IPAddress]::Parse($EdgeBindAddress)
            $tunnelArgs += @('--edge-bind-address', $parsedAddress.ToString())
        }
        if ($ResolveEdgeViaHttps) {
            foreach ($region in @('region1','region2')) {
                $dnsAnswer = Invoke-RestMethod -Uri "https://cloudflare-dns.com/dns-query?name=$region.v2.argotunnel.com&type=A" -Headers @{Accept='application/dns-json'} -TimeoutSec 15
                $addresses = @($dnsAnswer.Answer | Where-Object { $_.type -eq 1 } | Select-Object -First 2)
                if ($addresses.Count -eq 0) { throw '独立 DNS 查询未返回 Cloudflare 节点。' }
                foreach ($answer in $addresses) {
                    $address = [System.Net.IPAddress]::Parse($answer.data)
                    if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw '节点不是 IPv4 地址。' }
                    $tunnelArgs += @('--edge', ($address.ToString() + ':7844'))
                }
            }
        }
        $tunnel = Start-Process -FilePath $Cloudflared -ArgumentList $tunnelArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'tunnel.stdout.log') -RedirectStandardError $tunnelLog -PassThru
        $started += Remember-Process $tunnel 'tunnel' $Cloudflared
        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline) {
            if ($tunnel.HasExited) { throw '隧道启动失败，请检查 .data/tunnel.stderr.log。' }
            $log = Get-Content -LiteralPath $tunnelLog -Raw -ErrorAction SilentlyContinue
            if ($log -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $publicUrl = $Matches[0]; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $publicUrl) { throw '没有获得公网地址，请检查 .data/tunnel.stderr.log。' }
        $env:PUBLIC_ORIGIN = $publicUrl
    }
    $serverFile = Join-Path $projectRoot 'backend/server.js'
    $server = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.env',('"'+$serverFile+'"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'server.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'server.stderr.log') -PassThru
    $started += Remember-Process $server 'server' $nodePath
    $ready = $false
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) { throw '网站启动失败，请检查 .data/server.stderr.log。' }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2
            $ready = $health.ok -and $health.instanceId -eq $instance
            if ($ready) { break }
        } catch {}
    }
    if (-not $ready) { throw '网站启动超时，请检查本机日志。' }
    if ($publicUrl) {
        $connected = $false
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            if ($tunnel.HasExited) { throw '隧道进程已退出，请检查 .data/tunnel.stderr.log。' }
            try {
                $publicHealth = Invoke-RestMethod -Uri "$publicUrl/api/health" -TimeoutSec 5
                $connected = $publicHealth.ok -and $publicHealth.instanceId -eq $instance
                if ($connected) { break }
            } catch {}
            Start-Sleep -Milliseconds 1000
        }
        if (-not $connected) { throw '已分配地址，但公网验证失败。请检查 .data/tunnel.stderr.log；未报告启动成功。' }
    }
    @{processes=$started;publicUrl=$publicUrl} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding utf8
    Write-Output '本机地址：http://localhost:8787'
    if ($publicUrl) { $publicUrl | Set-Content -LiteralPath (Join-Path $dataRoot 'public-url.txt'); Write-Output "公网地址：$publicUrl" }
    Write-Output "访问码文件：$(Join-Path $dataRoot 'access-code.txt')"
} catch {
    foreach ($entry in $started) {
        $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if ($running -and $running.StartTime.ToUniversalTime().Ticks.ToString() -eq $entry.startedTicks) { & taskkill.exe /PID $entry.id /T /F | Out-Null }
    }
    throw
} finally {
    $env:PUBLIC_ORIGIN = $previousOrigin
    $env:SKILLHUB_INSTANCE_ID = $previousInstance
}
