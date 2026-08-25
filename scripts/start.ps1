param(
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "plugin-portal\data"),
    [int]$Port = 9137
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Port -ne 9137) {
    throw "Plugin Portal 正式端口必须是 9137。"
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$webRoot = Join-Path $repoRoot "dist"
$indexPath = Join-Path $webRoot "index.html"
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "尚未找到经过构建的 Portal；请先运行 npm run build。"
}

$existing = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    throw "127.0.0.1:$Port 已被占用，Portal 不会自动更换端口。"
}

New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
$dataInfo = Get-Item -LiteralPath $DataRoot -Force
if (($dataInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Portal 数据目录不能是链接或 reparse point。"
}

$logRoot = Join-Path $DataRoot "logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stdoutPath = Join-Path $logRoot "server.stdout.log"
$stderrPath = Join-Path $logRoot "server.stderr.log"
$arguments = @(
    "-m", "plugin_portal", "serve",
    "--host", "127.0.0.1",
    "--port", "$Port",
    "--data-root", $dataInfo.FullName,
    "--web-root", $webRoot
)

$process = Start-Process -FilePath "python" -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
try {
    $indexHash = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($process.HasExited) {
            throw "Portal 服务在健康检查前退出。"
        }
        try {
            $get = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Get -UseBasicParsing -TimeoutSec 2
            $head = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Head -UseBasicParsing -TimeoutSec 2
            $bodyHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($get.Content))).ToLowerInvariant()
            if ($get.StatusCode -eq 200 -and $head.StatusCode -eq 200 -and $bodyHash -eq $indexHash) {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 200
        }
    }
    if (-not $ready) {
        throw "Portal 独立 GET/HEAD 健康检查未通过。"
    }
    Write-Output "Plugin Portal 已就绪：http://127.0.0.1:$Port/（PID $($process.Id)，index $indexHash）"
}
catch {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit()
    }
    throw
}
