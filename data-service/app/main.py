"""vnstock-sim data-service: cung cấp bảng giá + nến ngày thật cho backend Node.

Chạy:  python -m uvicorn app.main:app --port 8001   (trong thư mục data-service)
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query

from . import normalize
from .vci import TTLCache, UpstreamError, VciClient


def _env_float(name: str, fallback: float) -> float:
    try:
        return float(os.environ.get(name, fallback))
    except ValueError:
        return fallback


BOARD_TTL = _env_float("BOARD_TTL", 2)
INDEX_TTL = _env_float("INDEX_TTL", 10)
HISTORY_TTL = _env_float("HISTORY_TTL", 1800)
UPSTREAM_RPM = int(_env_float("UPSTREAM_RPM", 120))

SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,12}$")
MAX_BOARD_SYMBOLS = 300
MAX_HISTORY_SYMBOLS = 20
MAX_DAYS = 2000

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["vci"] = VciClient(per_minute=UPSTREAM_RPM)
    state["cache"] = TTLCache()
    yield
    await state["vci"].close()


app = FastAPI(title="vnstock-sim data-service", version="1.0.0", lifespan=lifespan)


def _symbols(raw: str, limit: int) -> list[str]:
    syms = sorted({s.strip().upper() for s in raw.split(",") if s.strip()})
    if not syms:
        raise HTTPException(400, "Thiếu danh sách mã")
    if len(syms) > limit:
        raise HTTPException(400, f"Tối đa {limit} mã mỗi request")
    bad = [s for s in syms if not SYMBOL_RE.match(s)]
    if bad:
        raise HTTPException(400, f"Mã không hợp lệ: {', '.join(bad[:5])}")
    return syms


def _vci() -> VciClient:
    return state["vci"]


def _cache() -> TTLCache:
    return state["cache"]


async def _daily_bars(code: str, days: int) -> list[dict[str, Any]]:
    """Nến ngày đã chuẩn hoá của 1 mã hoặc 1 chỉ số (VNINDEX/VN30/HNXINDEX/UPCOMINDEX)."""
    upstream = normalize.INDEX_CODES.get(code, code)
    is_index = code in normalize.INDEX_CODES

    async def load():
        raw = await _vci().daily(upstream, days)
        return normalize.chart_bars(raw, is_index) if raw else []

    bars, _ = await _cache().get(("daily", code, days), HISTORY_TTL, load)
    return bars


@app.get("/health")
async def health():
    vci = _vci()
    return {
        "ok": True,
        "source": "vci",
        "lastOk": int(vci.last_ok * 1000) if vci.last_ok else None,
        "lastError": vci.last_error,
        "requestsLastMinute": vci.limiter.used(),
        "limitPerMinute": vci.limiter.per_minute,
    }


@app.get("/board")
async def board(symbols: str = Query(..., description="Danh sách mã, phân tách bằng dấu phẩy")):
    syms = _symbols(symbols, MAX_BOARD_SYMBOLS)

    async def load():
        return normalize.board(await _vci().board(syms))

    try:
        items, at = await _cache().get(("board", tuple(syms)), BOARD_TTL, load)
    except UpstreamError as e:
        raise HTTPException(502, f"Lỗi nguồn dữ liệu: {e}") from e
    return {"source": "vci", "fetchedAt": int(at * 1000), "items": items}


@app.get("/history")
async def history(
    symbols: str = Query(..., description="Mã cổ phiếu hoặc chỉ số, phân tách bằng dấu phẩy"),
    days: int = Query(500, ge=1, le=MAX_DAYS),
):
    syms = _symbols(symbols, MAX_HISTORY_SYMBOLS)
    results = await asyncio.gather(*(_daily_bars(s, days) for s in syms), return_exceptions=True)
    out: dict[str, list[dict[str, Any]]] = {}
    errors: dict[str, str] = {}
    for sym, res in zip(syms, results):
        if isinstance(res, Exception):
            errors[sym] = str(res)[:200]
        else:
            out[sym] = res
    if errors and not out:
        raise HTTPException(502, f"Lỗi nguồn dữ liệu: {next(iter(errors.values()))}")
    return {"source": "vci", "days": days, "bars": out, "errors": errors}


@app.get("/indices")
async def indices(codes: str = Query(",".join(normalize.INDEX_CODES))):
    wanted = _symbols(codes, len(normalize.INDEX_CODES))
    unknown = [c for c in wanted if c not in normalize.INDEX_CODES]
    if unknown:
        raise HTTPException(400, f"Chỉ số không hỗ trợ: {', '.join(unknown)}")

    async def quote(code: str):
        async def load():
            raw = await _vci().daily(normalize.INDEX_CODES[code], 3)
            return normalize.index_quote(code, normalize.chart_bars(raw, True) if raw else [])

        value, _ = await _cache().get(("index", code), INDEX_TTL, load)
        return value

    results = await asyncio.gather(*(quote(c) for c in wanted), return_exceptions=True)
    items = [r for r in results if isinstance(r, dict)]
    if not items and any(isinstance(r, Exception) for r in results):
        raise HTTPException(502, "Lỗi nguồn dữ liệu chỉ số")
    return {"source": "vci", "fetchedAt": int(time.time() * 1000), "items": items}
