from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows process identity checks require PowerShell and CIM")
class PersistentLauncherTests(unittest.TestCase):
    def invoke(self, body: str):
        with tempfile.TemporaryDirectory(prefix="portal-supervisor-test-") as temporary:
            root = Path(temporary)
            script = root / "case.ps1"
            library = str(ROOT / "scripts/portal-supervisor.ps1").replace("'", "''")
            python = sys.executable.replace("'", "''")
            escaped_root = str(root).replace("'", "''")
            script.write_text(
                "$ErrorActionPreference='Stop'\n"
                f". '{library}'\n$testRoot = '{escaped_root}'\n$python = '{python}'\n" + body,
                encoding="utf-8-sig",
            )
            completed = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(script)],
                                       capture_output=True, text=True, timeout=55,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(0, completed.returncode, completed.stdout + completed.stderr)
            return completed.stdout

    def test_missing_dependency_and_bad_pin_fail_without_launch(self):
        result = self.invoke("""
$failed = 0
try { Assert-PortalFilePin ([pscustomobject]@{path=(Join-Path $testRoot 'missing.exe');sha256=('a'*64)}) } catch { $failed++ }
try { Assert-PortalFilePin ([pscustomobject]@{path=$python;sha256=('a'*64)}) } catch { $failed++ }
try { Assert-PortalRuntimeLayout $testRoot } catch { $failed++ }
if ($failed -ne 3) { throw 'Missing dependency/pin/layout checks did not fail closed.' }
'passed'
""")
        self.assertIn("passed", result)

    def test_read_only_probe_runs_independently_and_times_out_with_cleanup(self):
        result = self.invoke("""
$value = Invoke-PortalReadOnlyProbe -Executable $python -Arguments @('-I','-B','-c','print(123)','portal-readonly-probe') `
    -WorkingDirectory $testRoot -Marker 'portal-readonly-probe' -TimeoutSeconds 2
if ($value.Trim() -ne '123') { throw 'Independent process readback failed.' }
$failed = $false
try {
    Invoke-PortalReadOnlyProbe -Executable $python -Arguments @('-I','-B','-c','import time; time.sleep(45)','portal-timeout-probe') `
        -WorkingDirectory $testRoot -Marker 'portal-timeout-probe' -TimeoutSeconds 1
} catch { $failed = $_.Exception.Message -eq 'Portal candidate probe timed out.' }
if (-not $failed) { throw 'Expected bounded probe timeout.' }
$leaked = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$PID" | Where-Object { $_.CommandLine -like '*portal-timeout-probe*' })
if ($leaked.Count -ne 0) { throw 'Timed-out probe leaked a child.' }
'passed'
""")
        self.assertIn("passed", result)

    def test_unexpected_child_exit_bounded_restart_and_owned_cleanup(self):
        result = self.invoke("""
$script:attempts = 0
$script:allChildren = [Collections.Generic.List[object]]::new()
$start = {
    param($children)
    $script:attempts++
    foreach ($n in @(1,2)) {
        $delay = if ($n -eq 1) { '2' } else { '45' }
        $code = 'import time; time.sleep(' + $delay + ')'
        $child = Start-PortalOwnedChild -Executable $python -Arguments @('-I','-B','-c',$code,'portal-isolated-child') `
            -WorkingDirectory $testRoot -Marker 'portal-isolated-child' -LogPrefix (Join-Path $testRoot ('child-' + $script:attempts + '-' + $n))
        $children.Add($child)
        $script:allChildren.Add($child)
    }
}
$failed = $false
try { Invoke-PortalSupervision -StartPair $start -Verify {} -BeforeRestart {} -MaxRestarts 1 -RestartDelaySeconds 1 -ProbeSeconds 20 }
catch { $failed = $true }
if (-not $failed -or $script:attempts -ne 2) { throw 'Retry budget did not terminate.' }
foreach ($child in $script:allChildren) { if (-not $child.Process.HasExited) { throw 'Owned child leaked.' } }
'passed'
""")
        self.assertIn("passed", result)

    def test_recovery_probe_stops_owned_pair_and_leaves_unrelated_process(self):
        result = self.invoke("""
$unrelated = Start-PortalOwnedChild -Executable $python -Arguments @('-I','-B','-c','import time; time.sleep(45)','unrelated-control') `
    -WorkingDirectory $testRoot -Marker 'unrelated-control' -LogPrefix (Join-Path $testRoot 'control')
try {
    $script:children = [Collections.Generic.List[object]]::new()
    $start = {
        param($children)
        foreach ($n in @(1,2)) {
            $child = Start-PortalOwnedChild -Executable $python -Arguments @('-I','-B','-c','import time; time.sleep(45)','portal-recovery-probe') `
                -WorkingDirectory $testRoot -Marker 'portal-recovery-probe' -LogPrefix (Join-Path $testRoot ('probe-' + $n))
            $children.Add($child)
            $script:children.Add($child)
        }
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-PortalSupervision -StartPair $start -Verify { Start-Sleep -Seconds 2 } -BeforeRestart {} -MaxRestarts 0 -ProbeSeconds 2
    if ($watch.Elapsed.TotalSeconds -lt 4) { throw 'Probe duration was consumed by startup verification.' }
    if ($result.RestoredState -ne 'offline') { throw 'Probe recovery receipt missing.' }
    foreach ($child in $script:children) { if (-not $child.Process.HasExited) { throw 'Owned child leaked.' } }
    if ($unrelated.Process.HasExited) { throw 'Unrelated process stopped.' }
    $originalMarker = $unrelated.Marker
    $unrelated.Marker = 'wrong-identity-marker'
    if (Test-PortalOwnedIdentity $unrelated) { throw 'Identity mismatch accepted.' }
    $unrelated.Marker = $originalMarker
    'passed'
} finally { Stop-PortalOwnedChildren @($unrelated) }
""")
        self.assertIn("passed", result)

    def test_restart_revalidation_failure_prevents_new_children(self):
        result = self.invoke("""
$script:attempts = 0
$start = { param($children); $script:attempts++; throw 'startup failure before children' }
$failed = $false
try { Invoke-PortalSupervision -StartPair $start -Verify {} -BeforeRestart { throw 'configuration drift' } -MaxRestarts 2 -ProbeSeconds 5 }
catch { $failed = $_.Exception.Message -eq 'configuration drift' }
if (-not $failed -or $script:attempts -ne 1) { throw 'Revalidation failure did not stop restart.' }
'passed'
""")
        self.assertIn("passed", result)

    def test_unexpected_exit_recovers_on_second_pair_then_probe_cleans_up(self):
        result = self.invoke("""
$script:attempts = 0
$script:allChildren = [Collections.Generic.List[object]]::new()
$start = {
    param($children)
    $script:attempts++
    foreach ($n in @(1,2)) {
        $delay = if ($script:attempts -eq 1 -and $n -eq 1) { '2' } else { '45' }
        $child = Start-PortalOwnedChild -Executable $python -Arguments @('-I','-B','-c',('import time; time.sleep(' + $delay + ')'),'portal-restart-recovery') `
            -WorkingDirectory $testRoot -Marker 'portal-restart-recovery' -LogPrefix (Join-Path $testRoot ('recover-' + $script:attempts + '-' + $n))
        $children.Add($child)
        $script:allChildren.Add($child)
    }
}
$result = Invoke-PortalSupervision -StartPair $start -Verify {} -BeforeRestart {} -MaxRestarts 1 -RestartDelaySeconds 1 -ProbeSeconds 8
if ($result.Restarts -ne 1 -or $script:attempts -ne 2 -or $result.RestoredState -ne 'offline') { throw 'Expected one successful recovery.' }
foreach ($child in $script:allChildren) { if (-not $child.Process.HasExited) { throw 'Recovered child leaked.' } }
'passed'
""")
        self.assertIn("passed", result)

    def test_source_parses_and_default_mode_has_no_activation(self):
        script = ROOT / "scripts/start-persistent.ps1"
        result = self.invoke(f"""
$tokens = $null
$errors = $null
$null = [Management.Automation.Language.Parser]::ParseFile('{str(script).replace("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {{ throw ($errors | Out-String) }}
'passed'
""")
        self.assertIn("passed", result)
        source = script.read_text(encoding="utf-8")
        self.assertIn("if (-not $Run)", source)
        self.assertNotIn("Register-ScheduledTask", source)
        self.assertNotIn("9136", source)

    def test_single_download_child_has_the_same_bounded_cleanup(self):
        result = self.invoke("""
$script:owned = $null
$start = {
    param($children)
    $script:owned = Start-PortalOwnedChild -Executable $python -Arguments @('-I','-B','-c','import time; time.sleep(45)','download-single-probe') `
        -WorkingDirectory $testRoot -Marker 'download-single-probe' -LogPrefix (Join-Path $testRoot 'download')
    $children.Add($script:owned)
}
$result = Invoke-PortalSupervision -StartPair $start -Verify {} -BeforeRestart {} -ExpectedChildren 1 -MaxRestarts 0 -ProbeSeconds 1
if ($result.RestoredState -ne 'offline' -or -not $script:owned.Process.HasExited) { throw 'Download child leaked.' }
'passed'
""")
        self.assertIn("passed", result)

    def test_download_candidate_validation_pins_and_real_isolated_start(self):
        launcher = str(ROOT / "scripts/start-downloads.ps1").replace("'", "''")
        server = str(ROOT / "scripts/download-server.py").replace("'", "''")
        result = self.invoke(f"""
$null = New-Item -ItemType Directory -Path (Join-Path $testRoot 'share/downloads'), (Join-Path $testRoot 'share/project-delivery-hub'), (Join-Path $testRoot 'logs')
[IO.File]::WriteAllText((Join-Path $testRoot 'share/project-delivery-hub/index.html'), '<html>Published</html>')
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
do {{ $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop() }} while ($port -lt 49152)
$config = @{{
    schemaVersion = '1.0.0'
    python = @{{ path=$python; sha256=(Get-FileHash -LiteralPath $python).Hash.ToLowerInvariant() }}
    server = @{{ path='{server}'; sha256=(Get-FileHash -LiteralPath '{server}').Hash.ToLowerInvariant() }}
    supervisor = @{{ path='{str(ROOT / 'scripts/portal-supervisor.ps1').replace("'", "''")}'; sha256=(Get-FileHash -LiteralPath '{str(ROOT / 'scripts/portal-supervisor.ps1').replace("'", "''")}').Hash.ToLowerInvariant() }}
    shareRoot = (Join-Path $testRoot 'share'); logRoot = (Join-Path $testRoot 'logs')
    port=$port; maxRestarts=0; restartDelaySeconds=1
}}
$configPath = Join-Path $testRoot 'config.json'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$hash = (Get-FileHash -LiteralPath $configPath).Hash.ToLowerInvariant()
& '{launcher}' -ConfigPath $configPath -ConfigSha256 $hash
if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -ne 0) {{ throw 'Validation activated a listener.' }}
& '{launcher}' -ConfigPath $configPath -ConfigSha256 $hash -Run -ProbeSeconds 1
if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -ne 0) {{ throw 'Probe listener leaked.' }}
[IO.File]::AppendAllText($configPath, ' ')
$failed = $false
try {{ & '{launcher}' -ConfigPath $configPath -ConfigSha256 $hash }} catch {{ $failed = $true }}
if (-not $failed) {{ throw 'Changed candidate config accepted.' }}
'passed'
""")
        self.assertIn("passed", result)


if __name__ == "__main__":
    unittest.main()
