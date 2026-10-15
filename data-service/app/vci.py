"""Client gọi API công khai của VCI, có cache TTL, gộp request trùng (single-flight) và giới hạn tốc độ."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any, Awaitable, Callable

import httpx

BASE_URL = "https://trading.vietcap.com.vn/api/"
HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": "https://trading.vietcap.com.vn/",
    "User-Agent": "Mozilla/5.0 (vnstock-sim data-service)",
}
BOARD_CHUNK = 100


class UpstreamError(Exception):
    pass


class RateLimiter:
    """Cửa sổ trượt: tối đa `per_minute` request/60s; chờ tối đa `max_wait` giây rồi báo lỗi."""

    def __init__(self, per_minute: int, max_wait: float = 20.0):
        self.per_minute = max(1, per_minute)
        self.max_wait = max_wait
        self.sent: deque[float] = deque()
        self.lock = asyncio.Lock()

    async def acquire(self) -> None:
        deadline = time.monotonic() + self.max_wait
        while True:
            async with self.lock:
                now = time.monotonic()
                while self.sent and now - self.sent[0] >= 60:
                    self.sent.popleft()
                if len(self.sent) < self.per_minute:
                    self.sent.append(now)
                    return
                wait = 60 - (now - self.sent[0])
            if time.monotonic() + wait > deadline:
                raise UpstreamError(f"vượt giới hạn {self.per_minute} request/phút tới nguồn")
            await asyncio.sleep(min(wait, 1.0))

    def used(self) -> int:
        now = time.monotonic()
        return sum(1 for t in self.sent if now - t < 60)


class TTLCache:
    def __init__(self) -> None:
        self.data: dict[Any, tuple[float, Any]] = {}
        self.locks: dict[Any, asyncio.Lock] = {}

    async def get(self, key: Any, ttl: float, load: Callable[[], Awaitable[Any]]) -> tuple[Any, float]:
        """Trả (giá trị, thời điểm nạp). Nhiều request cùng key trong lúc đang nạp chỉ gọi nguồn 1 lần."""
        hit = self.data.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1], hit[0]
        lock = self.locks.setdefault(key, asyncio.Lock())
        async with lock:
            hit = self.data.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1], hit[0]
            value = await load()
            at = time.time()
            self.data[key] = (at, value)
            if len(self.data) > 2000:  # chặn phình bộ nhớ
                oldest = sorted(self.data.items(), key=lambda kv: kv[1][0])[:500]
                for k, _ in oldest:
                    self.data.pop(k, None)
            return value, at


class VciClient:
    def __init__(self, per_minute: int = 120, concurrency: int = 4, timeout: float = 10.0):
        self.http = httpx.AsyncClient(base_url=BASE_URL, headers=HEADERS, timeout=timeout)
        self.limiter = RateLimiter(per_minute)
        self.sem = asyncio.Semaphore(concurrency)
        self.last_ok: float | None = None
        self.last_error: str | None = None

    async def close(self) -> None:
        await self.http.aclose()

    async def _post(self, path: str, payload: dict[str, Any]) -> Any:
        await self.limiter.acquire()
        async with self.sem:
            try:
                r = await self.http.post(path, json=payload)
                r.raise_for_status()
                data = r.json()
            except (httpx.HTTPError, ValueError) as e:
                self.last_error = f"{type(e).__name__}: {e}"[:300]
                raise UpstreamError(self.last_error) from e
        self.last_ok = time.time()
        return data

    async def board(self, symbols: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for i in range(0, len(symbols), BOARD_CHUNK):
            part = await self._post("price/symbols/getList", {"symbols": symbols[i : i + BOARD_CHUNK]})
            if isinstance(part, list):
                out.extend(part)
        return out

    async def daily(self, symbol: str, days: int) -> dict[str, Any] | None:
        """Nến ngày của 1 mã/chỉ số (API chỉ nhận 1 mã mỗi request)."""
        payload = {
            "timeFrame": "ONE_DAY",
            "symbols": [symbol],
            "to": int(time.time()) + 86400,
            "countBack": days,
        }
        data = await self._post("chart/OHLCChart/gap-chart", payload)
        if isinstance(data, dict) and "data" in data:
            data = data["data"]
        if isinstance(data, list) and data and isinstance(data[0], dict):
            return data[0]
        return None
