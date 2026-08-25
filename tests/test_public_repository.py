from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PublicRepositoryTests(unittest.TestCase):
    def tracked_paths(self) -> list[str]:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def test_runtime_and_personal_data_are_not_tracked(self) -> None:
        paths = self.tracked_paths()
        forbidden = ("portal-data/", "dist/", "web/", "playwright-report/", "test-results/")
        self.assertFalse([path for path in paths if path.startswith(forbidden)])
        self.assertFalse([path for path in paths if path.endswith(".local.json") or path.startswith(".env")])

    def test_tracked_text_does_not_contain_personal_absolute_paths(self) -> None:
        findings: list[str] = []
        for relative in self.tracked_paths():
            path = ROOT / relative
            if not path.is_file() or path.suffix.lower() in {".png", ".jpg", ".jpeg", ".ico", ".lock"}:
                continue
            text = path.read_text(encoding="utf-8")
            if re.search(r"(?i)\b[A-Z]:[\\/]Users[\\/]", text):
                findings.append(relative)
        self.assertEqual(findings, [])

    def test_documented_start_contract_exists(self) -> None:
        start = ROOT / "scripts" / "start.ps1"
        self.assertTrue(start.is_file())
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("127.0.0.1:9137", readme)
        self.assertIn("人工纳入", readme)
        self.assertNotIn("当前仓库处于设计阶段", readme)


if __name__ == "__main__":
    unittest.main()
