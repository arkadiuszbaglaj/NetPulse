"""Role kont: która trasa wymaga której roli (api/security.py) – bez bazy."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from netpulse.api import app  # noqa: E402
from netpulse.api.security import ROLE_RULES, has_role, required_role  # noqa: E402
from netpulse.db.models import User  # noqa: E402


def test_role_rules_point_at_real_routes():
    """Każdy wyjątek w ROLE_RULES to istniejąca trasa – literówka w szablonie po cichu dawałaby „tylko administrator”."""
    routes = {(m.upper(), path) for path, ops in app.openapi()["paths"].items() for m in ops}
    assert set(ROLE_RULES) <= routes, set(ROLE_RULES) - routes


def test_changes_default_to_admin():
    assert required_role("GET", "/api/devices") == "viewer"
    assert required_role("POST", "/api/devices") == "admin"
    assert required_role("DELETE", "/api/alert-rules/{rule_id}") == "admin"
    assert required_role("POST", "/api/alerts/{alert_id}/ack") == "operator"
    assert required_role("PUT", "/api/preferences/refresh") == "viewer"
    assert required_role("PUT", "/api/dashboards/{dashboard_id}/public") == "admin"  # udostępnienie na zewnątrz


def test_role_ranks():
    viewer, operator, admin = (User(role=r) for r in ("viewer", "operator", "admin"))
    assert has_role(admin, "operator") and has_role(operator, "operator") and not has_role(viewer, "operator")
    assert not has_role(operator, "admin") and has_role(viewer, "viewer")
    assert not has_role(User(role="nieznana"), "operator")
