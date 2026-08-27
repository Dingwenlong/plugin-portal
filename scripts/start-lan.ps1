param(
    [Parameter(Mandatory)][string]$Address,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "plugin-portal\data"),
    [string]$LogRoot = (Join-Path $env:LOCALAPPDATA "plugin-portal\lan\logs"),
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-PlainDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { throw "目录不存在。" }
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "运行目录不能经过链接或 reparse point。"
        }
        $item = $item.Parent
    }
}

$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$webRoot = Join-Path $runtimeRoot "dist"
$dataPath = [IO.Path]::GetFullPath($DataRoot)
Assert-PlainDirectory $runtimeRoot
Assert-PlainDirectory $webRoot
Assert-PlainDirectory $dataPath
$indexPath = Join-Path $webRoot "index.html"
$indexHash = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash.ToLowerInvariant()
$parsedAddress = [Net.IPAddress]::Parse($Address)
if ($parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    $Address -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or
    -not (Get-NetIPAddress -IPAddress $Address -ErrorAction SilentlyContinue)) {
    throw "必须指定本机已配置的局域网 IPv4 地址。"
}
if (Get-NetTCPConnection -LocalPort 9135 -State Listen -ErrorAction SilentlyContinue) {
    throw "9135 已被占用，不会停止或替换已有进程。"
}
if ($CheckOnly) {
    Write-Output "只读 Portal 启动检查通过；未启动监听。"
    return
}

$logPath = [IO.Path]::GetFullPath($LogRoot)
$logAncestor = $logPath
while (-not (Test-Path -LiteralPath $logAncestor)) { $logAncestor = Split-Path $logAncestor -Parent }
Assert-PlainDirectory $logAncestor
New-Item -ItemType Directory -Path $logPath -Force | Out-Null
Assert-PlainDirectory $logPath
$arguments = @("-m", "plugin_portal", "serve", "--read-only", "--host", $Address,
    "--port", "9135", "--data-root", ('"' + $dataPath + '"'), "--web-root", ('"' + $webRoot + '"'))
$process = Start-Process -FilePath "python" -ArgumentList $arguments -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logPath "lan.stdout.log") -RedirectStandardError (Join-Path $logPath "lan.stderr.log")
$client = $null
try {
    $client = [Net.Http.HttpClient]::new([Net.Http.HttpClientHandler]@{ UseProxy = $false })
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($process.HasExited) { throw "只读 Portal 在就绪检查前退出。" }
        try {
            $url = "http://${Address}:9135"
            $get = $client.GetAsync("$url/").GetAwaiter().GetResult()
            $bytes = $get.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            $head = $client.SendAsync([Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head, "$url/")).GetAwaiter().GetResult()
            $access = $client.GetStringAsync("$url/api/access").GetAwaiter().GetResult() | ConvertFrom-Json
            $actualHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
            $listener = @(Get-NetTCPConnection -LocalAddress $Address -LocalPort 9135 -State Listen -ErrorAction Stop)
            if ([int]$get.StatusCode -eq 200 -and [int]$head.StatusCode -eq 200 -and
                $get.Content.Headers.ContentType.MediaType -eq "text/html" -and
                $head.Content.Headers.ContentLength -eq $bytes.Length -and
                $actualHash -eq $indexHash -and $access.readOnly -eq $true -and
                $listener.Count -eq 1 -and $listener[0].OwningProcess -eq $process.Id) {
                $ready = $true
                break
            }
        } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $ready) { throw "只读 Portal 的 PID、GET/HEAD、首页哈希或模式检查未通过。" }
    [pscustomobject]@{ Url = $url; Pid = $process.Id; ReadOnly = $true; IndexSha256 = $indexHash } | ConvertTo-Json -Compress
} catch {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
    throw
} finally {
    if ($null -ne $client) { $client.Dispose() }
}
