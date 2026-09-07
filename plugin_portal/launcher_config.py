"""Read-only safety contract for adapted persistent Caddy candidates."""
from __future__ import annotations


def validate_caddy_candidate(config: object, address: str) -> None:
    """Reject alternate listeners, admin API, redirects and alternate upstreams.

    Only a host-matched Portal proxy route and an unmatched 421 fallback are
    accepted. Caddy's adapter may wrap those handlers in subroutes.
    """
    def require(condition: bool) -> None:
        if not condition:
            raise ValueError("Caddy candidate violates the Portal listener/proxy boundary")

    def keys(value: object, required: set[str], allowed: set[str] | None = None) -> None:
        require(isinstance(value, dict) and required <= set(value) <= (allowed or required))

    keys(config, {"admin", "apps"}, {"admin", "apps", "storage", "logging"})
    admin = config["admin"]
    keys(admin, {"disabled", "config"})
    require(admin["disabled"] is True)
    require(admin["config"] == {"persist": False})
    apps = config["apps"]
    keys(apps, {"http", "tls", "pki"})
    keys(apps["pki"], {"certificate_authorities"})
    authorities = apps["pki"]["certificate_authorities"]
    require(isinstance(authorities, dict) and len(authorities) == 1)
    authority = next(iter(authorities.values()))
    require(isinstance(authority, dict) and authority.get("install_trust") is False)
    keys(apps["tls"], {"automation"})
    keys(apps["tls"]["automation"], {"policies"})
    automation = apps["tls"]["automation"]["policies"]
    require(isinstance(automation, list) and len(automation) == 1)
    keys(automation[0], {"subjects", "issuers"})
    require(automation[0]["subjects"] == [address])
    issuers = automation[0]["issuers"]
    require(isinstance(issuers, list) and len(issuers) == 1)
    keys(issuers[0], {"module"}, {"module", "ca"})
    require(issuers[0]["module"] == "internal" and issuers[0].get("ca", "local") in authorities)
    keys(apps["http"], {"servers"})
    servers = apps["http"]["servers"]
    require(isinstance(servers, dict) and len(servers) == 1)
    server = next(iter(servers.values()))
    keys(server, {"listen", "routes", "tls_connection_policies", "automatic_https", "protocols"})
    require(server["listen"] == [f"{address}:9135"])
    require(server["protocols"] == ["h1", "h2"])
    require(server["automatic_https"] == {"disable_redirects": True})
    policies = server["tls_connection_policies"]
    require(isinstance(policies, list) and 1 <= len(policies) <= 2)
    for policy in policies:
        keys(policy, {"default_sni"}, {"default_sni", "match"})
        require(policy["default_sni"] == address)
        if "match" in policy:
            require(policy["match"] in ({"sni": [address]}, {"sni": ["", address]}))
    require("match" not in policies[-1])

    def leaves(route: object, *, outer: bool = False) -> list[dict]:
        keys(route, {"handle"}, {"handle", "match", "terminal"} if outer else {"handle"})
        handles = route["handle"]
        require(isinstance(handles, list) and len(handles) == 1)
        handler = handles[0]
        require(isinstance(handler, dict))
        if handler.get("handler") == "subroute":
            keys(handler, {"handler", "routes"})
            require(isinstance(handler["routes"], list) and len(handler["routes"]) == 1)
            return leaves(handler["routes"][0])
        require(handler.get("handler") in {"reverse_proxy", "static_response"})
        return [handler]

    routes = server["routes"]
    require(isinstance(routes, list) and len(routes) == 2)
    proxy_route, fallback_route = routes
    require(isinstance(proxy_route, dict) and proxy_route.get("match") == [{"host": [address]}])
    require(proxy_route.get("terminal") is True)
    require(isinstance(fallback_route, dict) and "match" not in fallback_route)
    require(fallback_route.get("terminal", True) is True)
    proxy = leaves(proxy_route, outer=True)
    fallback = leaves(fallback_route, outer=True)
    require(proxy == [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:9135"}]}])
    require(fallback in ([{"handler": "static_response", "status_code": 421}],
                         [{"handler": "static_response", "status_code": "421"}]))
