from __future__ import annotations

import os
import stat
import subprocess
from collections.abc import Callable
from pathlib import Path


_FOLDER_DIALOG_SCRIPT = """
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Codex 插件目录'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
""".strip()


def choose_plugin_directory(
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> Path | None:
    if os.name != "nt":
        raise RuntimeError("当前系统不支持插件目录选择器")
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    powershell = system_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    try:
        result = runner(
            [
                str(powershell),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                _FOLDER_DIALOG_SCRIPT,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=120,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise RuntimeError("无法打开插件目录选择器") from error
    if result.returncode != 0:
        raise RuntimeError("无法打开插件目录选择器")
    selected = result.stdout.strip()
    if not selected:
        return None
    directory = Path(selected).absolute()
    if not _is_ordinary_directory(directory):
        raise RuntimeError("选择的插件目录无效")
    return directory


def _is_ordinary_directory(directory: Path) -> bool:
    try:
        info = os.lstat(directory)
    except OSError:
        return False
    return (
        stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and not getattr(info, "st_file_attributes", 0) & 0x400
    )
