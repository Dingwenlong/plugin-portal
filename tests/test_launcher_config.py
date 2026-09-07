from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from plugin_portal.launcher_config import validate_caddy_candidate


ADDRESS = "192.168.1.100"


def candidate():
    return {"admin": {"disabled": True, "config": {"persist": False}}, "apps": {
        "pki": {"certificate_authorities": {"local": {"install_trust": False}}},
        "tls": {"automation": {"policies": [{"subjects": [ADDRESS], "issuers": [{"module": "internal"}]}]}},
        "http": {"servers": {"srv0": {
        "listen": [f"{ADDRESS}:9135"], "protocols": ["h1", "h2"],
        "automatic_https": {"disable_redirects": True}, "tls_connection_policies": [{"default_sni": ADDRESS}],
        "routes": [
            {"match": [{"host": [ADDRESS]}], "terminal": True, "handle": [{"handler": "subroute", "routes": [
                {"handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:9135"}]}]}
            ]}]},
            {"handle": [{"handler": "static_response", "status_code": 421}]},
        ],
    }}}}}


class LauncherConfigTests(unittest.TestCase):
    def test_launcher_probe_accepts_utf8_json_with_and_without_windows_bom(self):
        root = Path(__file__).resolve().parents[1]
        launcher = (root / "scripts/start-persistent.ps1").read_text(encoding="utf-8")
        command = re.search(r"'([^'\n]*from plugin_portal\.launcher_config[^'\n]*)'", launcher)
        self.assertIsNotNone(command)
        document = json.dumps(candidate()).encode("utf-8")
        for prefix in (b"", b"\xef\xbb\xbf"):
            with self.subTest(bom=bool(prefix)):
                result = subprocess.run(
                    [sys.executable, "-I", "-B", "-c", command.group(1), str(root), ADDRESS],
                    input=prefix + document, capture_output=True, timeout=20,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                self.assertEqual(0, result.returncode, result.stderr.decode("utf-8", errors="replace"))

    def test_exact_proxy_boundary_is_accepted(self):
        validate_caddy_candidate(candidate(), ADDRESS)

    def test_extra_listeners_redirects_admin_and_alternate_upstreams_rejected(self):
        mutations = [
            lambda c, s: c["admin"].update(disabled=False),
            lambda c, s: c["admin"]["config"].update(persist=True),
            lambda c, s: c["apps"]["pki"]["certificate_authorities"]["local"].update(install_trust=True),
            lambda c, s: c["apps"]["tls"]["automation"]["policies"][0].update(issuers=[{"module": "acme"}]),
            lambda c, s: c["apps"].update(layer4={}),
            lambda c, s: c["apps"]["http"]["servers"].update(extra=copy.deepcopy(s)),
            lambda c, s: s["listen"].append("127.0.0.1:9136"),
            lambda c, s: s.update(listen=[":9135"]),
            lambda c, s: s.update(automatic_https={}),
            lambda c, s: s["protocols"].append("h3"),
            lambda c, s: s.update(tls_connection_policies=[]),
            lambda c, s: s["routes"][0].update(match=[{"host": ["example.test"]}]),
            lambda c, s: s["routes"][0]["handle"][0]["routes"][0]["handle"][0].update(upstreams=[{"dial": "127.0.0.1:9134"}]),
            lambda c, s: s["routes"][0]["handle"][0]["routes"][0]["handle"][0].update(headers={"request": {"set": {"Host": ["other"]}}}),
            lambda c, s: s["routes"][1]["handle"][0].update(status_code=302, headers={"Location": ["https://other"]}),
            lambda c, s: s["routes"].append({"handle": [{"handler": "file_server"}]}),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                value = candidate()
                mutate(value, value["apps"]["http"]["servers"]["srv0"])
                with self.assertRaises(ValueError):
                    validate_caddy_candidate(value, ADDRESS)

    @unittest.skipUnless(os.environ.get("PORTAL_TEST_CADDY"), "Optional parser test needs an explicit Caddy executable")
    def test_real_caddy_adapts_only_an_isolated_candidate_without_listening(self):
        with tempfile.TemporaryDirectory(prefix="portal-caddy-parse-") as directory:
            root = Path(directory)
            config = root / "Caddyfile"
            config.write_text(f"""{{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    default_sni {ADDRESS}
    storage file_system "{root.as_posix()}/storage"
    servers {{
        protocols h1 h2
    }}
}}
https://{ADDRESS}:9135 {{
    bind {ADDRESS}
    tls internal
    reverse_proxy 127.0.0.1:9135
}}
https://:9135 {{
    bind {ADDRESS}
    respond 421
}}
""", encoding="utf-8")
            result = subprocess.run([os.environ["PORTAL_TEST_CADDY"], "adapt", "--config", str(config), "--adapter", "caddyfile"],
                                    capture_output=True, text=True, encoding="utf-8", timeout=20,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(0, result.returncode, result.stderr)
            validate_caddy_candidate(json.loads(result.stdout), ADDRESS)
            self.assertFalse((root / "storage").exists(), "Parse-only must not provision storage")


if __name__ == "__main__":
    unittest.main()
