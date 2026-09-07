# Shared by the candidate launcher and isolated process tests. Dot-sourcing starts nothing.
Set-StrictMode -Version Latest

function Assert-PortalPlainPath([string]$Path, [switch]$Directory) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'Portal paths must be explicit absolute paths without traversal.'
    }
    $kind = if ($Directory) { 'Container' } else { 'Leaf' }
    if (-not (Test-Path -LiteralPath $Path -PathType $kind)) { throw 'Required Portal path is missing.' }
    $entry = Get-Item -LiteralPath $Path -Force
    while ($null -ne $entry) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked Portal paths are not allowed.' }
        $entry = if ($entry -is [IO.FileInfo]) { $entry.Directory } else { $entry.Parent }
    }
}

function Assert-PortalFilePin($Pin) {
    Assert-PortalPlainPath $Pin.path
    if ($Pin.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath $Pin.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.sha256) {
        throw 'Pinned Portal dependency is missing or changed.'
    }
}

function Get-PortalTreeDigest([string]$Root) {
    Assert-PortalPlainPath $Root -Directory
    $lines = [string[]]@(Get-ChildItem -LiteralPath $Root -Force -Recurse | ForEach-Object {
        if ($_.PSIsContainer) { Assert-PortalPlainPath $_.FullName -Directory }
        else {
            Assert-PortalPlainPath $_.FullName
            $_.FullName.Substring($Root.TrimEnd('\', '/').Length + 1).Replace('\', '/') + ':' +
                (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Assert-PortalRuntimeLayout([string]$Root) {
    foreach ($relative in @('dist/index.html', 'plugin_portal/__init__.py', 'plugin_portal/__main__.py',
                            'plugin_portal/server.py', 'plugin_portal/api.py', 'plugin_portal/audit_config.py',
                            'plugin_portal/launcher_config.py', 'plugin_portal/download_publication.py', 'plugin_portal/uploads.py')) {
        $path = Join-Path $Root $relative
        Assert-PortalPlainPath $path
        if ((Get-Item -LiteralPath $path).Length -eq 0 -and $relative -ne 'plugin_portal/__init__.py') {
            throw 'Portal runtime contains an empty required file.'
        }
    }
}

function ConvertTo-PortalArgument([string]$Value) {
    # CommandLineToArgvW quoting, including trailing backslashes before the quote.
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Start-PortalOwnedChild([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
                              [string]$Marker, [string]$LogPrefix, [hashtable]$Environment = @{}) {
    $saved = @{}
    try {
        foreach ($name in $Environment.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $Environment[$name], 'Process')
        }
        $quoted = @($Arguments | ForEach-Object { ConvertTo-PortalArgument $_ })
        $process = Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput ($LogPrefix + '.stdout.log') `
            -RedirectStandardError ($LogPrefix + '.stderr.log')
        # Retain the original OS handle. Cleanup never kills a newly looked-up PID.
        $null = $process.Handle
        $started = $process.StartTime.ToFileTimeUtc()
        [pscustomobject]@{ Process = $process; Executable = $Executable; Started = $started; Marker = $Marker; Parent = $PID }
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

function Test-PortalOwnedIdentity($Owned) {
    if ($Owned.Process.HasExited) { return $false }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Owned.Process.Id)" -ErrorAction Stop
    $null -ne $current -and $current.ParentProcessId -eq $Owned.Parent -and
        [string]::Equals($current.ExecutablePath, $Owned.Executable, [StringComparison]::OrdinalIgnoreCase) -and
        $Owned.Process.StartTime.ToFileTimeUtc() -eq $Owned.Started -and
        $current.CommandLine.Contains($Owned.Marker)
}

function Invoke-PortalReadOnlyProbe([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
                                  [string]$Marker, [ValidateRange(1,60)][int]$TimeoutSeconds = 20,
                                  [string]$InputText) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-PortalArgument $_ }) -join ' ')
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $PSBoundParameters.ContainsKey('InputText')
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $owned = $null
    try {
        $null = $process.Start()
        $null = $process.Handle
        $owned = [pscustomobject]@{
            Process = $process; Executable = $Executable; Started = $process.StartTime.ToFileTimeUtc(); Marker = $Marker; Parent = $PID
        }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($info.RedirectStandardInput) {
            $process.StandardInput.Write($InputText)
            $process.StandardInput.Close()
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Portal candidate probe timed out.' }
        if ($process.ExitCode -ne 0) { throw 'Portal candidate probe failed.' }
        $null = $stderr.GetAwaiter().GetResult()
        $stdout.GetAwaiter().GetResult()
    } finally {
        if ($null -ne $owned) { Stop-PortalOwnedChildren @($owned) }
        $process.Dispose()
    }
}

function Stop-PortalOwnedChildren($Children) {
    $failure = $null
    foreach ($owned in @($Children)) {
        try {
            if ($owned.Process.HasExited) { continue }
            if (-not (Test-PortalOwnedIdentity $owned)) { throw 'Child identity changed; no unrelated process was stopped.' }
            $owned.Process.Kill()
            if (-not $owned.Process.WaitForExit(5000)) { throw 'Owned child did not stop; restart is forbidden.' }
        } catch { $failure = $_ }
    }
    if ($null -ne $failure) { throw $failure }
}

function Invoke-PortalSupervision([scriptblock]$StartPair, [scriptblock]$Verify,
                                  [scriptblock]$BeforeRestart, [int]$MaxRestarts = 2,
                                  [int]$RestartDelaySeconds = 2, [int]$ProbeSeconds = 0,
                                  [ValidateRange(1, 2)][int]$ExpectedChildren = 2) {
    if ($MaxRestarts -lt 0 -or $MaxRestarts -gt 5 -or $RestartDelaySeconds -lt 1 -or
        $RestartDelaySeconds -gt 60 -or $ProbeSeconds -lt 0 -or $ProbeSeconds -gt 3600) {
        throw 'Invalid bounded supervisor settings.'
    }
    $attempt = 0
    while ($true) {
        $children = [Collections.Generic.List[object]]::new()
        $failure = $null
        try {
            & $StartPair $children
            if ($children.Count -ne $ExpectedChildren) { throw 'Supervisor owned child count differs from the configured count.' }
            & $Verify $children
            $deadline = if ($ProbeSeconds -gt 0) { (Get-Date).AddSeconds($ProbeSeconds) } else { [DateTime]::MaxValue }
            while ((Get-Date) -lt $deadline) {
                foreach ($child in $children) {
                    if ($child.Process.HasExited) { throw 'A Portal child exited unexpectedly.' }
                }
                Start-Sleep -Milliseconds 250
            }
        } catch { $failure = $_ }
        finally { Stop-PortalOwnedChildren $children }
        if ($null -eq $failure) { return [pscustomobject]@{ Status = 'probe-complete'; Restarts = $attempt; RestoredState = 'offline' } }
        if ($attempt -ge $MaxRestarts) { throw $failure }
        # Drift, occupied listeners or cleanup failure is a hard stop, not another retry.
        & $BeforeRestart
        $attempt++
        Write-Warning "Portal child failure; controlled restart $attempt of $MaxRestarts."
        Start-Sleep -Seconds $RestartDelaySeconds
    }
}
