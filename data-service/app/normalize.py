"""Chuyển dữ liệu thô của VCI (trading.vietcap.com.vn — nguồn mặc định của thư viện vnstock)
sang schema ổn định mà backend Node dùng.

- Giá cổ phiếu là số nguyên VNĐ; giá trị giao dịch của VCI tính theo triệu đồng → đổi sang đồng.
- Thời gian trả về dạng epoch mili giây (UTC); ngày dạng YYYY-MM-DD theo giờ Việt Nam.
- Hàm thuần, không gọi mạng — được test bằng fixture JSON.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

VN_TZ = timezone(timedelta(hours=7))

EXCHANGES = {"HSX": "HOSE", "HOSE": "HOSE", "HNX": "HNX", "UPCOM": "UPCOM"}

# Mã chỉ số trong app → mã chỉ số của VCI
INDEX_CODES = {
    "VNINDEX": "VNINDEX",
    "VN30": "VN30",
    "HNXINDEX": "HNXIndex",
    "UPCOMINDEX": "HNXUpcomIndex",
}

MILLION = 1_000_000
# Giá bình quân/CP vượt mức này là vô lý → giá trị đã ở đơn vị đồng (VCI trả lẫn đơn vị ở dữ liệu chỉ số cũ)
MAX_AVG_PRICE = 5_000_000


def _num(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f else 0.0  # loại NaN


def _int(v: Any) -> int:
    return int(round(_num(v)))


def _ms(iso: Any) -> int | None:
    if not isinstance(iso, str) or not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _levels(raw: Any) -> list[dict[str, int]]:
    out = []
    for lv in raw or []:
        if not isinstance(lv, dict):
            continue
        p, v = _int(lv.get("price")), _int(lv.get("volume"))
        if p > 0 and v > 0:
            out.append({"p": p, "v": v})
    return out[:3]


def _value_vnd(raw: Any, volume: int) -> int:
    """Giá trị giao dịch VCI (thường là triệu đồng) → đồng."""
    v = _num(raw)
    if v <= 0:
        return 0
    vnd = v * MILLION
    if volume > 0 and vnd / volume > MAX_AVG_PRICE:
        vnd = v
    return int(round(vnd))


def board_item(raw: dict[str, Any]) -> dict[str, Any] | None:
    """1 phần tử của /price/symbols/getList → dòng bảng giá. Bỏ qua chỉ số và mã không có giá tham chiếu."""
    li = raw.get("listingInfo") or {}
    mp = raw.get("matchPrice") or {}
    ba = raw.get("bidAsk") or {}
    symbol = li.get("symbol") or mp.get("symbol")
    if not symbol or li.get("type") == "INDEX":
        return None
    ref = _int(li.get("refPrice") or mp.get("referencePrice"))
    if ref <= 0:
        return None
    # G1 = khớp lệnh thông thường (không gồm thoả thuận), giống cột "Tổng KL" trên bảng điện
    volume = mp.get("accumulatedVolumeG1", mp.get("accumulatedVolume"))
    value = mp.get("accumulatedValueG1", mp.get("accumulatedValue"))
    return {
        "symbol": symbol,
        "exchange": EXCHANGES.get(li.get("board") or "", li.get("board")),
        "tradingDate": li.get("tradingDate"),
        "session": mp.get("session") or ba.get("session") or "",
        "ref": ref,
        "ceil": _int(li.get("ceiling") or mp.get("ceilingPrice")),
        "floor": _int(li.get("floor") or mp.get("floorPrice")),
        "open": _int(mp.get("openPrice")),
        "high": _int(mp.get("highest")),
        "low": _int(mp.get("lowest")),
        "last": _int(mp.get("matchPrice")),
        "lastVol": _int(mp.get("matchVol")),
        "volume": _int(volume),
        "value": _value_vnd(value, _int(volume)),
        "atoPrice": _int(mp.get("matchPriceATO")),
        "atoVol": _int(mp.get("matchVolumeATO")),
        "atcPrice": _int(mp.get("matchPriceATC")),
        "atcVol": _int(mp.get("matchVolumeATC")),
        "foreignBuy": _int(mp.get("foreignBuyVolume")),
        "foreignSell": _int(mp.get("foreignSellVolume")),
        "listedShares": _int(li.get("listedShare")),
        "matchTime": _ms(mp.get("time")),
        "bookTime": _ms(ba.get("time")),
        "bids": _levels(ba.get("bidPrices")),
        "asks": _levels(ba.get("askPrices")),
    }


def board(raw: Any) -> list[dict[str, Any]]:
    items = []
    for x in raw if isinstance(raw, list) else []:
        if isinstance(x, dict):
            item = board_item(x)
            if item:
                items.append(item)
    return items


def chart_bars(raw: dict[str, Any], is_index: bool = False) -> list[dict[str, Any]]:
    """1 phần tử của /chart/OHLCChart/gap-chart (dạng mảng song song t/o/h/l/c/v) → danh sách nến ngày."""
    keys = ("t", "o", "h", "l", "c", "v")
    cols = [raw.get(k) or [] for k in keys]
    values = raw.get("accumulatedValue") or []
    n = min(len(c) for c in cols)
    by_date: dict[str, dict[str, Any]] = {}
    for i in range(n):
        t, o, h, l, c, v = (col[i] for col in cols)
        ts = _int(t)
        if ts <= 0:
            continue
        date = datetime.fromtimestamp(ts, tz=VN_TZ).date().isoformat()
        if is_index:
            o, h, l, c = (round(_num(x), 2) for x in (o, h, l, c))
        else:
            o, h, l, c = (_int(x) for x in (o, h, l, c))
        if min(o, h, l, c) <= 0:
            continue
        val = _value_vnd(values[i], _int(v)) if i < len(values) else 0
        by_date[date] = {
            "date": date,
            "open": o,
            "high": max(h, o, c),
            "low": min(l, o, c),
            "close": c,
            "volume": _int(v),
            "value": val,
        }
    return [by_date[d] for d in sorted(by_date)]


def index_quote(code: str, bars: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Giá trị chỉ số = nến ngày gần nhất; tham chiếu = đóng cửa phiên trước đó."""
    if not bars:
        return None
    last = bars[-1]
    prev = bars[-2]["close"] if len(bars) > 1 else last["open"]
    return {
        "code": code,
        "date": last["date"],
        "value": last["close"],
        "prevClose": prev,
        "open": last["open"],
        "high": last["high"],
        "low": last["low"],
        "volume": last["volume"],
        "totalValue": last["value"],
    }
