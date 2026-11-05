from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

client = TestClient(create_app(Settings(environment="test")))


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_echo_validates_body() -> None:
    ok = client.post("/v1/echo", json={"message": "hej", "uppercase": True})
    assert ok.status_code == 200
    assert ok.json() == {"message": "HEJ"}

    assert client.post("/v1/echo", json={"message": ""}).status_code == 422
    assert client.post("/v1/echo", json={"message": "x", "extra": 1}).status_code == 422
