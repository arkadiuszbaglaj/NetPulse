from fastapi.testclient import TestClient

from app.main import app


def test_health_reports_unreachable_database():
    """Without a database the endpoint must answer 503, not crash."""
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 503
    assert response.json()["database"] == "unreachable"
