param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ConfigSha256,
    [switch]$Run,
    [ValidateRange(0, 3600)][int]$ProbeSeconds = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Check the shared helper before dot-sourcing any candidate code.
if ((Get-FileHash -LiteralPath $ConfigPath).Hash.ToLowerInvariant() -cne $ConfigSha256) { throw 'Download configuration changed.' }
$bootstrap = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$helper = Join-Path $PSScriptRoot 'portal-supervisor.ps1'
if ($bootstrap.supervisor.path -ne $helper -or $bootstrap.supervisor.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
    (Get-FileHash -LiteralPath $helper).Hash.ToLowerInvariant() -cne $bootstrap.supervisor.sha256) { throw 'Download supervisor changed.' }
. $helper

function Read-DownloadConfiguration {
    Assert-PortalFilePin ([pscustomobject]@{ path = $ConfigPath; sha256 = $ConfigSha256 })
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $keys = 'schemaVersion,python,server,supervisor,shareRoot,logRoot,port,maxRestarts,restartDelaySeconds'.Split(',')
    if (@(Compare-Object @($config.PSObject.Properties.Name) $keys).Count -ne 0 -or $config.schemaVersion -ne '1.0.0') {
        throw 'Unsupported download configuration.'
    }
    foreach ($name in @('python', 'server', 'supervisor')) { Assert-PortalFilePin $config.$name }
    foreach ($path in @($config.shareRoot, $config.logRoot)) { Assert-PortalPlainPath $path -Directory }
    $share = [IO.Path]::GetFullPath($config.shareRoot).TrimEnd('\', '/')
    foreach ($path in @($ConfigPath, $config.python.path, $config.server.path, $config.supervisor.path, $config.logRoot)) {
        $full = [IO.Path]::GetFullPath($path).TrimEnd('\', '/')
        if ($full -eq $share -or $full.StartsWith($share + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Runtime, configuration and logs must be outside the published share.'
        }
    }
    if (($config.port -isnot [int] -and $config.port -isnot [long]) -or ($config.port -ne 9136 -and ($config.port -lt 49152 -or $config.port -gt 65535))) {
        throw 'Only 9136 or an isolated high loopback port is allowed.'
    }
    if (($config.maxRestarts -isnot [int] -and $config.maxRestarts -isnot [long]) -or $config.maxRestarts -lt 0 -or $config.maxRestarts -gt 5 -or
        ($config.restartDelaySeconds -isnot [int] -and $config.restartDelaySeconds -isnot [long]) -or $config.restartDelaySeconds -lt 1 -or $config.restartDelaySeconds -gt 60) {
        throw 'Invalid bounded download restart settings.'
    }
    $config
}

function Assert-DownloadsOffline {
    if (@(Get-NetTCPConnection -State Listen -LocalPort $settings.port -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'Download port is occupied. No existing process will be stopped.'
    }
}

$settings = Read-DownloadConfiguration
$null = Invoke-PortalReadOnlyProbe -Executable $settings.python.path -Arguments @(
    '-I', '-B', $settings.server.path, '--share-root', $settings.shareRoot, '--check'
) -WorkingDirectory $PSScriptRoot -Marker $settings.server.path
$settings = Read-DownloadConfiguration
if (-not $Run) {
    [pscustomobject]@{ Status = 'validated'; Activated = $false; Port = $settings.port } | ConvertTo-Json -Compress
    return
}
Assert-DownloadsOffline
$runRoot = Join-Path $settings.logRoot ('run-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $runRoot
$script:sequence = 0
$start = {
    param($children)
    $script:sequence++
    $children.Add((Start-PortalOwnedChild -Executable $settings.python.path -Arguments @(
        '-I', '-B', $settings.server.path, '--share-root', $settings.shareRoot, '--port', [string]$settings.port
    ) -WorkingDirectory $PSScriptRoot -Marker $settings.server.path -LogPrefix (Join-Path $runRoot "downloads-$script:sequence")))
}
$verify = {
    param($children)
    $child = $children[0]
    $deadline = (Get-Date).AddSeconds(15)
    do {
        if ($child.Process.HasExited) { throw 'Download child exited before listening.' }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $settings.port -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1' -and
            $listeners[0].OwningProcess -eq $child.Process.Id -and (Test-PortalOwnedIdentity $child)) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if ((Get-Date) -ge $deadline) { throw 'Owned download listener did not become ready.' }
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    try {
        $origin = 'http://127.0.0.1:' + $settings.port
        $bytes = $client.GetByteArrayAsync($origin + '/project-delivery-hub/').GetAwaiter().GetResult()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($actual -ne (Get-FileHash -LiteralPath (Join-Path $settings.shareRoot 'project-delivery-hub/index.html')).Hash.ToLowerInvariant()) {
            throw 'Download homepage readback differs from the published share.'
        }
        foreach ($path in @('/api/prompts/lan-access', '/downloads/__portal_missing_probe__.zip')) {
            $response = $client.GetAsync($origin + $path).GetAwaiter().GetResult()
            try { if ([int]$response.StatusCode -ne 404) { throw 'Download read-only boundary check failed.' } }
            finally { $response.Dispose() }
        }
    } finally { $client.Dispose(); $handler.Dispose() }
}
$beforeRestart = { Assert-DownloadsOffline; $null = Read-DownloadConfiguration }
try {
    Invoke-PortalSupervision -StartPair $start -Verify $verify -BeforeRestart $beforeRestart -ExpectedChildren 1 `
        -MaxRestarts $settings.maxRestarts -RestartDelaySeconds $settings.restartDelaySeconds -ProbeSeconds $ProbeSeconds |
        ConvertTo-Json -Compress
} finally { Assert-DownloadsOffline }
