import type { EntityModel, FieldModel } from "./model.js";
import { entityModels, invalidFor, sampleFor } from "./model.js";
import { PY_HEADER, pyq, snake } from "./names.js";
import { emptyProject, type GenerateContext, type GeneratedProject } from "./types.js";

/**
 * FastAPI generator: Pydantic models (strict numbers/booleans, unknown keys rejected), one CRUD
 * router per entity on a clearly named in-memory repository, OpenAPI docs from FastAPI, and pytest
 * tests covering validation rejection. Ruff fixes/formats the output during setup.
 */

/** A long Python string as implicitly concatenated chunks (keeps lines under ruff's limit). */
function pyLong(text: string): string {
  const chunks = text.match(/.{1,70}(\s|$)|.{1,70}/g) ?? [text];
  return chunks.length <= 1 ? pyq(text) : `(\n${chunks.map((c) => `        ${pyq(c)}`).join("\n")}\n    )`;
}

const jsToPy = (lit: string): string => (lit === "true" ? "True" : lit === "false" ? "False" : lit);

function pyType(f: FieldModel, optional: boolean): string {
  let t: string;
  const c: string[] = [];
  switch (f.type) {
    case "string":
    case "text":
      t = "str";
      if (f.required && !optional) c.push("min_length=1");
      c.push(`max_length=${f.maxLength}`);
      if (f.pattern) c.push(`pattern=r${pyq(f.pattern.re)}`);
      break;
    case "email":
      t = "str";
      c.push(`max_length=${f.maxLength}`, `pattern=r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"`);
      break;
    case "url":
      t = "HttpUrl";
      break;
    case "number":
      t = "float";
      c.push("strict=True");
      break;
    case "integer":
      t = "int";
      c.push("strict=True");
      break;
    case "boolean":
      t = "bool";
      c.push("strict=True");
      break;
    case "date":
      t = "date";
      break;
    case "datetime":
      t = "datetime";
      break;
    case "enum":
      t = `Literal[${f.enumValues.map(pyq).join(", ")}]`;
      break;
    case "reference":
      t = "UUID";
      break;
  }
  if (f.min !== undefined) c.push(`ge=${f.min}`);
  if (f.max !== undefined) c.push(`le=${f.max}`);
  const opt = optional || !f.required;
  const ann = opt ? `${t} | None` : t;
  if (opt) return `${ann} = Field(default=None${c.length ? `, ${c.join(", ")}` : ""})`;
  return c.length ? `${ann} = Field(${c.join(", ")})` : ann;
}

function schemasPy(models: EntityModel[]): string {
  const types = new Set(models.flatMap((m) => m.fields.map((f) => f.type)));
  const imports = [
    `from datetime import ${types.has("date") ? "date, " : ""}datetime`,
    ...(types.has("enum") ? ["from typing import Literal"] : []),
    "from uuid import UUID",
    "",
    `from pydantic import BaseModel, ConfigDict, Field${types.has("url") ? ", HttpUrl" : ""}`,
  ];
  const blocks = models.map((m) => {
    const f = m.fields;
    return `class ${m.name}Create(BaseModel):
    """Request body for creating or replacing a ${m.label.toLowerCase()}. Unknown fields are rejected."""

    model_config = ConfigDict(extra="forbid")

${f.map((x) => `    ${snake(x.name)}: ${pyType(x, false)}`).join("\n")}


class ${m.name}Update(BaseModel):
    """Partial update: any subset of the fields."""

    model_config = ConfigDict(extra="forbid")

${f.map((x) => `    ${snake(x.name)}: ${pyType(x, true)}`).join("\n")}


class ${m.name}(${m.name}Create):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    created_at: datetime
    updated_at: datetime


class ${m.name}List(BaseModel):
    data: list[${m.name}]
    total: int
`;
  });
  return `${PY_HEADER}
${imports.join("\n")}


class Health(BaseModel):
    status: str
    service: str


${blocks.join("\n\n")}`;
}

function repositoryPy(): string {
  return `${PY_HEADER}
"""In-memory repository: rows live in this process and are lost on restart.

It keeps the API runnable without a database; replace it with a persistent adapter that has the
same methods for production.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


class ConflictError(Exception):
    """A unique field already has this value."""

    def __init__(self, field: str) -> None:
        super().__init__(f"{field} already exists")
        self.field = field


class InMemoryRepository:
    def __init__(self, unique: tuple[str, ...] = ()) -> None:
        self._rows: dict[str, dict[str, Any]] = {}
        self._unique = unique

    def list(self, limit: int = 100, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
        rows = list(self._rows.values())
        return rows[offset : offset + limit], len(rows)

    def get(self, item_id: str) -> dict[str, Any] | None:
        return self._rows.get(item_id)

    def create(self, data: dict[str, Any]) -> dict[str, Any]:
        self._check_unique(data)
        now = datetime.now(UTC).isoformat()
        row = {**data, "id": str(uuid4()), "created_at": now, "updated_at": now}
        self._rows[row["id"]] = row
        return row

    def update(self, item_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        current = self._rows.get(item_id)
        if current is None:
            return None
        merged = {**current, **data}
        self._check_unique(merged, except_id=item_id)
        merged["updated_at"] = datetime.now(UTC).isoformat()
        self._rows[item_id] = merged
        return merged

    def delete(self, item_id: str) -> bool:
        return self._rows.pop(item_id, None) is not None

    def _check_unique(self, data: dict[str, Any], except_id: str | None = None) -> None:
        for key in self._unique:
            value = data.get(key)
            if value is None:
                continue
            for row in self._rows.values():
                if row["id"] != except_id and row.get(key) == value:
                    raise ConflictError(key)
`;
}

function routerPy(m: EntityModel, auth: boolean): string {
  const s = snake(m.name);
  const base = `/v1/${m.pluralKebab}`;
  const dep = auth ? ", dependencies=[Depends(require_api_token)]" : "";
  return `${auth ? PY_HEADER : `# forge:public — the spec defines an API without user accounts (spec.auth = false); these routes are public.\n${PY_HEADER}`}
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, ${auth ? "Depends, " : ""}HTTPException, Query, Response, status

${auth ? "from app.auth import require_api_token\n" : ""}from app.repository import ConflictError, InMemoryRepository
from app.schemas import ${m.name}, ${m.name}Create, ${m.name}List, ${m.name}Update


def create_router(repo: InMemoryRepository) -> APIRouter:
    router = APIRouter(tags=[${pyq(m.labelPlural)}]${dep})

    def found(item_id: UUID) -> ${m.name}:
        row = repo.get(str(item_id))
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
        return ${m.name}.model_validate(row)

    @router.get(${pyq(base)})
    def list_${snake(m.pluralCamel)}(
        limit: Annotated[int, Query(ge=1, le=100)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> ${m.name}List:
        rows, total = repo.list(limit, offset)
        return ${m.name}List(data=[${m.name}.model_validate(r) for r in rows], total=total)

    @router.get(${pyq(`${base}/{item_id}`)})
    def get_${s}(item_id: UUID) -> ${m.name}:
        return found(item_id)

    @router.post(${pyq(base)}, status_code=status.HTTP_201_CREATED)
    def create_${s}(body: ${m.name}Create) -> ${m.name}:
        try:
            row = repo.create(body.model_dump(mode="json"))
        except ConflictError as e:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{e.field} already exists") from e
        return ${m.name}.model_validate(row)

    @router.put(${pyq(`${base}/{item_id}`)})
    def replace_${s}(item_id: UUID, body: ${m.name}Create) -> ${m.name}:
        found(item_id)
        try:
            row = repo.update(str(item_id), body.model_dump(mode="json"))
        except ConflictError as e:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{e.field} already exists") from e
        return ${m.name}.model_validate(row)

    @router.patch(${pyq(`${base}/{item_id}`)})
    def update_${s}(item_id: UUID, body: ${m.name}Update) -> ${m.name}:
        changes = body.model_dump(mode="json", exclude_unset=True)
        if not changes:
            raise HTTPException(status_code=422, detail="Provide at least one field")
        current = found(item_id).model_dump(mode="json")
        merged = ${m.name}Create.model_validate({k: v for k, v in {**current, **changes}.items() if k in ${m.name}Create.model_fields})
        try:
            row = repo.update(str(item_id), merged.model_dump(mode="json"))
        except ConflictError as e:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{e.field} already exists") from e
        return ${m.name}.model_validate(row)

    @router.delete(${pyq(`${base}/{item_id}`)}, status_code=status.HTTP_204_NO_CONTENT)
    def delete_${s}(item_id: UUID) -> Response:
        if not repo.delete(str(item_id)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
`;
}

function mainPy(ctx: GenerateContext, models: EntityModel[]): string {
  const unique = (m: EntityModel) => m.fields.filter((f) => /^(sku|slug|email|code)$/i.test(f.name)).map((f) => pyq(snake(f.name)));
  return `${PY_HEADER}
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import RequestResponseEndpoint

from app.kit import mount_kit
from app.repository import InMemoryRepository
from app.routers import ${models.map((m) => snake(m.pluralCamel)).join(", ")}
from app.schemas import Health
from app.settings import Settings, get_settings

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or get_settings()
    app = FastAPI(
        title=cfg.service_name,
        description=${pyLong(ctx.spec.summary.slice(0, 300))},
        docs_url="/docs" if cfg.environment != "production" else None,
    )

    if cfg.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cfg.cors_origin_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        return response

    @app.get("/health")
    def health() -> Health:
        return Health(status="ok", service=cfg.service_name)

    # One in-memory repository per app instance (not persisted).
${models.map((m) => `    app.include_router(${snake(m.pluralCamel)}.create_router(InMemoryRepository(unique=(${unique(m).join(", ")}${unique(m).length === 1 ? "," : ""}))))`).join("\n")}

    mount_kit(app)
    return app


app = create_app()
`;
}

function authPy(): string {
  return `${PY_HEADER}
import hmac
import os

from fastapi import Header, HTTPException, status


def require_api_token(authorization: str = Header(default="")) -> None:
    """Bearer token check (constant-time) against API_TOKEN for every /v1 route."""
    expected = os.environ.get("API_TOKEN", "")
    token = authorization.removeprefix("Bearer ")
    if not expected or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
`;
}

function entityTestPy(m: EntityModel, auth: boolean): string {
  const base = `/v1/${m.pluralKebab}`;
  const valid = `{${m.fields.map((f) => `${pyq(snake(f.name))}: ${jsToPy(sampleFor(f, "json"))}`).join(", ")}}`;
  const invalids = m.fields
    .map((f) => ({ f, v: invalidFor(f) }))
    .filter((x) => x.v !== null)
    .slice(0, 5)
    .map(({ f, v }) => `        (${pyq(snake(f.name))}, ${jsToPy(v!)}),`)
    .join("\n");
  const first = m.fields[0];
  const missing = m.fields.find((f) => f.required && f.type !== "boolean");
  return `${PY_HEADER}
${auth ? "import os\n\n" : ""}from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

${auth ? `TOKEN = "t" * 40\nos.environ["API_TOKEN"] = TOKEN\nHEADERS = {"Authorization": f"Bearer {TOKEN}"}\n` : ""}BASE = ${pyq(base)}
VALID: dict[str, object] = ${valid}


def make_client() -> TestClient:
    return TestClient(create_app(Settings(environment="test"))${auth ? ", headers=HEADERS" : ""})


def test_crud_${snake(m.name)}() -> None:
    client = make_client()
    created = client.post(BASE, json=VALID)
    assert created.status_code == 201, created.text
    item_id = created.json()["id"]
    assert client.get(f"{BASE}/{item_id}").status_code == 200
    assert client.get(BASE).json()["total"] == 1
    assert client.put(f"{BASE}/{item_id}", json=VALID).status_code == 200
${first ? `    patched = client.patch(f"{BASE}/{item_id}", json={${pyq(snake(first.name))}: ${jsToPy(sampleFor(first, "json", 3))}})\n    assert patched.status_code == 200, patched.text\n` : ""}    assert client.delete(f"{BASE}/{item_id}").status_code == 204
    assert client.get(f"{BASE}/{item_id}").status_code == 404


def test_rejects_invalid_${snake(m.name)}() -> None:
    client = make_client()
    cases: list[tuple[str, object]] = [
${invalids}
    ]
    for field, value in cases:
        res = client.post(BASE, json={**VALID, field: value})
        assert res.status_code == 422, (field, res.text)
${missing ? `    without = {k: v for k, v in VALID.items() if k != ${pyq(snake(missing.name))}}\n    assert client.post(BASE, json=without).status_code == 422\n` : ""}    assert client.post(BASE, json={**VALID, "unexpected": True}).status_code == 422
    assert client.get(f"{BASE}/not-a-uuid").status_code == 422
    assert client.get(BASE, params={"limit": 0}).status_code == 422


def test_unknown_${snake(m.name)}_is_404() -> None:
    client = make_client()
    missing_id = "00000000-0000-4000-8000-000000000000"
    assert client.put(f"{BASE}/{missing_id}", json=VALID).status_code == 404
    assert client.delete(f"{BASE}/{missing_id}").status_code == 404
${auth ? `\n\ndef test_requires_token() -> None:\n    anonymous = TestClient(create_app(Settings(environment="test")))\n    assert anonymous.get(BASE).status_code == 401\n` : ""}`;
}

function appTestPy(models: EntityModel[]): string {
  return `${PY_HEADER}
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

client = TestClient(create_app(Settings(environment="test")))


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_openapi_docs_describe_every_resource() -> None:
    doc = client.get("/openapi.json").json()
${models.map((m) => `    assert ${pyq(`/v1/${m.pluralKebab}/{item_id}`)} in doc["paths"]`).join("\n")}
    assert client.get("/docs").status_code == 200
`;
}

export function generateFastapi(ctx: GenerateContext): GeneratedProject {
  const out = emptyProject("fastapi");
  const models = entityModels(ctx.spec);
  const auth = ctx.spec.auth;
  const f = out.files;
  f["app/schemas.py"] = schemasPy(models);
  f["app/repository.py"] = repositoryPy();
  f["app/routers/__init__.py"] = `${PY_HEADER}\n`;
  for (const m of models) {
    f[`app/routers/${snake(m.pluralCamel)}.py`] = routerPy(m, auth);
    f[`tests/test_${snake(m.pluralCamel)}.py`] = entityTestPy(m, auth);
  }
  if (auth) f["app/auth.py"] = authPy();
  f["app/main.py"] = mainPy(ctx, models);
  f["tests/test_app.py"] = appTestPy(models);
  out.setup.push(".venv/bin/ruff check --fix --exit-zero . && .venv/bin/ruff format .");
  out.verify.push(".venv/bin/mypy app tests", ".venv/bin/ruff check . && .venv/bin/ruff format --check .");
  out.autofix = ".venv/bin/ruff check --fix . ; .venv/bin/ruff format .";
  out.notes.push(
    "Data is kept by InMemoryRepository (app/repository.py): it lives in the server process and is lost on restart.",
    "OpenAPI docs: /docs (Swagger UI, not in production) and /openapi.json, generated by FastAPI from the Pydantic models.",
    auth ? "All /v1 routes require `Authorization: Bearer $API_TOKEN`." : "The spec has no user accounts, so the /v1 routes are marked `forge:public` (intentionally unauthenticated).",
  );
  return out;
}
