param(
    [Parameter(Mandatory)][string]$Address,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "plugin-portal\data"),
    [string]$WebRoot = (Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))) "dist"),
    [string]$LogRoot = (Join-Path $env:LOCALAPPDATA "plugin-portal\remote-management\logs"),
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-PlainDirectory([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label 不存在。"
    }
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label 不能经过链接或 reparse point。"
        }
        $item = $item.Parent
    }
}

function Quote-ProcessArgument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$webPath = [IO.Path]::GetFullPath($WebRoot)
$dataPath = [IO.Path]::GetFullPath($DataRoot)
Assert-PlainDirectory $runtimeRoot "Portal 运行目录"
Assert-PlainDirectory $webPath "Portal 构建目录"
Assert-PlainDirectory $dataPath "Portal 数据目录"

$indexPath = Join-Path $webPath "index.html"
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "Portal 构建缺少 index.html。"
}
$indexHash = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash.ToLowerInvariant()

$parsedAddress = [Net.IPAddress]::Parse($Address)
if ($parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    $Address -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or
    -not (Get-NetIPAddress -IPAddress $Address -ErrorAction SilentlyContinue)) {
    throw "必须指定本机已配置的局域网 IPv4 地址。"
}

$backendListeners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 9135 -State Listen -ErrorAction SilentlyContinue)
if ($backendListeners.Count -ne 0) {
    throw "127.0.0.1:9135 已被占用，不会停止或替换已有进程。"
}
$externalListeners = @(Get-NetTCPConnection -LocalAddress $Address -LocalPort 9135 -State Listen -ErrorAction SilentlyContinue)
if ($externalListeners.Count -ne 1) {
    throw "未找到 $Address`:9135 的唯一 HTTPS 代理监听。"
}
$caddyProcess = Get-Process -Id $externalListeners[0].OwningProcess -ErrorAction Stop
if ($caddyProcess.ProcessName -ne "caddy") {
    throw "$Address`:9135 不是由 Caddy 监听。"
}

if ($CheckOnly) {
    [pscustomobject]@{
        Status = "ready"
        Address = $Address
        CaddyPid = $caddyProcess.Id
        IndexSha256 = $indexHash
        Started = $false
    } | ConvertTo-Json -Compress
    return
}

$logPath = [IO.Path]::GetFullPath($LogRoot)
$logAncestor = $logPath
while (-not (Test-Path -LiteralPath $logAncestor)) {
    $parent = Split-Path $logAncestor -Parent
    if ($parent -eq $logAncestor -or -not $parent) { throw "日志目录无法解析。" }
    $logAncestor = $parent
}
Assert-PlainDirectory $logAncestor "日志目录上层"
New-Item -ItemType Directory -Path $logPath -Force | Out-Null
Assert-PlainDirectory $logPath "日志目录"

$origin = "https://${Address}:9135"
$python = (Get-Command python -CommandType Application -ErrorAction Stop).Source
$arguments = @(
    "-m", "plugin_portal", "serve",
    "--remote-management",
    "--host", "127.0.0.1",
    "--port", "9135",
    "--https-origin", $origin,
    "--data-root", (Quote-ProcessArgument $dataPath),
    "--web-root", (Quote-ProcessArgument $webPath)
)
$process = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $runtimeRoot `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logPath "remote.stdout.log") `
    -RedirectStandardError (Join-Path $logPath "remote.stderr.log")

$client = $null
try {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($process.HasExited) { throw "远程管理后端在就绪检查前退出。" }
        try {
            $authority = "${Address}:9135"
            $getRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "http://127.0.0.1:9135/")
            $getRequest.Headers.Host = $authority
            $getRequest.Headers.TryAddWithoutValidation("Origin", $origin) | Out-Null
            $get = $client.SendAsync($getRequest).GetAwaiter().GetResult()
            $bytes = $get.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()

            $headRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head, "http://127.0.0.1:9135/")
            $headRequest.Headers.Host = $authority
            $headRequest.Headers.TryAddWithoutValidation("Origin", $origin) | Out-Null
            $head = $client.SendAsync($headRequest).GetAwaiter().GetResult()

            $accessRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "http://127.0.0.1:9135/api/access")
            $accessRequest.Headers.Host = $authority
            $accessRequest.Headers.TryAddWithoutValidation("Origin", $origin) | Out-Null
            $accessResponse = $client.SendAsync($accessRequest).GetAwaiter().GetResult()
            $access = $accessResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json

            $actualHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
            $backend = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 9135 -State Listen -ErrorAction Stop)
            $external = @(Get-NetTCPConnection -LocalAddress $Address -LocalPort 9135 -State Listen -ErrorAction Stop)
            $accessFields = @($access.PSObject.Properties.Name | Sort-Object)
            if ([int]$get.StatusCode -eq 200 -and [int]$head.StatusCode -eq 200 -and
                [int]$accessResponse.StatusCode -eq 200 -and
                $get.Content.Headers.ContentType.MediaType -eq "text/html" -and
                $head.Content.Headers.ContentLength -eq $bytes.Length -and
                $actualHash -eq $indexHash -and
                ($accessFields -join ",") -eq "fileSelectionMode,readOnly" -and
                $access.readOnly -eq $false -and $access.fileSelectionMode -eq "browser-upload" -and
                $backend.Count -eq 1 -and $backend[0].OwningProcess -eq $process.Id -and
                $external.Count -eq 1 -and $external[0].OwningProcess -eq $caddyProcess.Id) {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 200
        }
    }
    if (-not $ready) {
        throw "远程管理后端的 PID、GET/HEAD、首页哈希或 browser-upload 模式检查未通过。"
    }
    [pscustomobject]@{
        Url = "$origin/"
        Backend = "http://127.0.0.1:9135/"
        Pid = $process.Id
        CaddyPid = $caddyProcess.Id
        ReadOnly = $false
        FileSelectionMode = "browser-upload"
        IndexSha256 = $indexHash
    } | ConvertTo-Json -Compress
}
catch {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit()
    }
    throw
}
finally {
    if ($null -ne $client) { $client.Dispose() }
}
