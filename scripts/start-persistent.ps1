param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ConfigSha256,
    [switch]$Run,
    [ValidateRange(0, 3600)][int]$ProbeSeconds = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portal-supervisor.ps1')

function Read-PortalConfiguration {
    Assert-PortalFilePin ([pscustomobject]@{ path = $ConfigPath; sha256 = $ConfigSha256 })
    $settings = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $required = 'schemaVersion,runtime,python,caddy,caddyConfig,certificate,dataRoot,logRoot,lanAddress,auditConfigPath,maxRestarts,restartDelaySeconds'.Split(',')
    if (@(Compare-Object @($settings.PSObject.Properties.Name) $required).Count -ne 0 -or $settings.schemaVersion -ne '1.0.0') {
        throw 'Unsupported Portal configuration.'
    }
    if ($settings.lanAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or
        ([Net.IPAddress]::Parse($settings.lanAddress)).AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        -not (Get-NetIPAddress -IPAddress $settings.lanAddress -ErrorAction SilentlyContinue)) {
        throw 'Configured LAN IPv4 address is not assigned to this machine.'
    }
    if (($settings.maxRestarts -isnot [int] -and $settings.maxRestarts -isnot [long]) -or $settings.maxRestarts -lt 0 -or $settings.maxRestarts -gt 5 -or
        ($settings.restartDelaySeconds -isnot [int] -and $settings.restartDelaySeconds -isnot [long]) -or $settings.restartDelaySeconds -lt 1 -or $settings.restartDelaySeconds -gt 60) {
        throw 'Invalid bounded restart configuration.'
    }
    foreach ($name in @('python', 'caddy', 'caddyConfig', 'certificate')) { Assert-PortalFilePin $settings.$name }
    Assert-PortalPlainPath $settings.runtime.path -Directory
    Assert-PortalRuntimeLayout $settings.runtime.path
    if ($settings.runtime.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        (Get-PortalTreeDigest $settings.runtime.path) -cne $settings.runtime.sha256) { throw 'Pinned Portal runtime changed.' }
    foreach ($path in @($settings.dataRoot, $settings.logRoot)) { Assert-PortalPlainPath $path -Directory }
    $runtimePrefix = $settings.runtime.path.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    foreach ($path in @($settings.dataRoot, $settings.logRoot)) {
        if ([IO.Path]::GetFullPath($path).StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFullPath($path).TrimEnd('\', '/') -eq $settings.runtime.path.TrimEnd('\', '/')) {
            throw 'Mutable data and logs must be outside the pinned runtime.'
        }
    }
    # Optional audit dependencies are intentionally not opened, executed, or required here.
    if ($settings.auditConfigPath -isnot [string] -or -not [IO.Path]::IsPathRooted($settings.auditConfigPath)) {
        throw 'auditConfigPath must be an explicit absolute path (the audit file may be unavailable).'
    }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($settings.certificate.path)
    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        if ($certificate.HasPrivateKey -or $certificate.Thumbprint -ne $settings.certificate.thumbprint -or
            -not (Test-Path -LiteralPath ('Cert:\LocalMachine\Root\' + $certificate.Thumbprint)) -or
            -not $chain.Build($certificate)) { throw 'Pinned certificate is not system trusted.' }
    } finally { $chain.Dispose(); $certificate.Dispose() }
    $settings
}

function Assert-PortalOffline {
    if (@(Get-NetTCPConnection -State Listen -LocalPort 9135 -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'Port 9135 is occupied. No existing process will be stopped.'
    }
}

function Wait-PortalOwnedListener($Child, [string]$Address) {
    $deadline = (Get-Date).AddSeconds(25)
    do {
        if ($Child.Process.HasExited) { throw 'Portal child exited before listening.' }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 9135 -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -eq $Address })
        if ($listeners.Count -eq 1 -and $listeners[0].OwningProcess -eq $Child.Process.Id -and (Test-PortalOwnedIdentity $Child)) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'Owned Portal listener did not become ready.'
}

$settings = Read-PortalConfiguration
# Independent processes test the read-back candidate without binding any listener.
# `adapt` parses only; unlike `validate`, it does not provision Caddy storage/certificates.
$adapted = Invoke-PortalReadOnlyProbe -Executable $settings.caddy.path -Arguments @(
    'adapt', '--config', $settings.caddyConfig.path, '--adapter', 'caddyfile'
) -WorkingDirectory (Split-Path $settings.caddyConfig.path -Parent) -Marker $settings.caddyConfig.path
$null = ($adapted | Out-String | ConvertFrom-Json)
$null = Invoke-PortalReadOnlyProbe -Executable $settings.python.path -Arguments @(
    '-I', '-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import plugin_portal.server; import plugin_portal.audit_config', $settings.runtime.path
) -WorkingDirectory $settings.runtime.path -Marker $settings.runtime.path
$null = Invoke-PortalReadOnlyProbe -Executable $settings.python.path -Arguments @(
    '-I', '-B', '-c', 'import sys,json; sys.path.insert(0,sys.argv[1]); from plugin_portal.launcher_config import validate_caddy_candidate; validate_caddy_candidate(json.load(sys.stdin.buffer),sys.argv[2])',
    $settings.runtime.path, $settings.lanAddress
) -WorkingDirectory $settings.runtime.path -Marker $settings.runtime.path -InputText ($adapted | Out-String)
# Recheck both candidate config and dependency hashes after the independent tests.
$settings = Read-PortalConfiguration
if (-not $Run) {
    [pscustomobject]@{ Status = 'validated'; Activated = $false; AuditDependency = 'checked-on-use'; Port = 9135 } | ConvertTo-Json -Compress
    return
}
Assert-PortalOffline
$runRoot = Join-Path $settings.logRoot ('run-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $runRoot
$origin = 'https://' + $settings.lanAddress + ':9135'
$sequence = 0
$startPair = {
    param($children)
    $script:sequence++
    $backend = Start-PortalOwnedChild -Executable $settings.python.path -Arguments @(
        '-E', '-s', '-B', '-m', 'plugin_portal', 'serve', '--remote-management', '--host', '127.0.0.1', '--port', '9135',
        '--https-origin', $origin, '--data-root', $settings.dataRoot, '--web-root', (Join-Path $settings.runtime.path 'dist')
    ) -WorkingDirectory $settings.runtime.path -Marker '--remote-management' -LogPrefix (Join-Path $runRoot "backend-$script:sequence") `
        -Environment @{ PORTAL_AUDIT_CONFIG = $settings.auditConfigPath; PYTHONDONTWRITEBYTECODE = '1' }
    $children.Add($backend)
    Wait-PortalOwnedListener $backend '127.0.0.1'
    $proxy = Start-PortalOwnedChild -Executable $settings.caddy.path -Arguments @(
        'run', '--config', $settings.caddyConfig.path, '--adapter', 'caddyfile'
    ) -WorkingDirectory (Split-Path $settings.caddyConfig.path -Parent) -Marker $settings.caddyConfig.path `
        -LogPrefix (Join-Path $runRoot "caddy-$script:sequence")
    $children.Add($proxy)
}
$verify = {
    param($children)
    Wait-PortalOwnedListener $children[0] '127.0.0.1'
    Wait-PortalOwnedListener $children[1] $settings.lanAddress
    # System certificate validation remains enabled. No trust bypass or session/write request.
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    try {
        $access = $client.GetStringAsync($origin + '/api/access').GetAwaiter().GetResult() | ConvertFrom-Json
        if ($access.readOnly -ne $false -or $access.fileSelectionMode -ne 'browser-upload') { throw 'Portal access mode readback failed.' }
        $bytes = $client.GetByteArrayAsync($origin + '/').GetAwaiter().GetResult()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($actual -ne (Get-FileHash -LiteralPath (Join-Path $settings.runtime.path 'dist/index.html')).Hash.ToLowerInvariant()) {
            throw 'Portal homepage readback differs from the pinned runtime.'
        }
    } finally { $client.Dispose(); $handler.Dispose() }
}
$beforeRestart = { Assert-PortalOffline; $null = Read-PortalConfiguration }
try {
    Invoke-PortalSupervision -StartPair $startPair -Verify $verify -BeforeRestart $beforeRestart `
        -MaxRestarts $settings.maxRestarts -RestartDelaySeconds $settings.restartDelaySeconds -ProbeSeconds $ProbeSeconds |
        ConvertTo-Json -Compress
} finally { Assert-PortalOffline }
