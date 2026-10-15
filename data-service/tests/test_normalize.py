"""Test chuẩn hoá dữ liệu VCI bằng fixture (không gọi mạng).

Chạy:  python -m unittest discover -s tests   (trong thư mục data-service)
"""

import json
import pathlib
import unittest

from app import normalize

FIX = pathlib.Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


class BoardTest(unittest.TestCase):
    def setUp(self):
        self.items = {x["symbol"]: x for x in normalize.board(load("vci_board.json"))}

    def test_skips_indices(self):
        self.assertEqual(sorted(self.items), ["ACV", "FPT", "SHS"])

    def test_maps_hose_row(self):
        fpt = self.items["FPT"]
        self.assertEqual(fpt["exchange"], "HOSE")
        self.assertEqual(fpt["tradingDate"], "2026-10-15")
        self.assertEqual((fpt["ref"], fpt["ceil"], fpt["floor"]), (57100, 61000, 53200))
        self.assertEqual((fpt["open"], fpt["high"], fpt["low"], fpt["last"]), (57500, 58200, 57300, 58000))
        self.assertEqual(fpt["volume"], 4_964_400)
        # VCI trả giá trị theo triệu đồng
        self.assertEqual(fpt["value"], 287_054_530_000)
        self.assertEqual((fpt["atoPrice"], fpt["atoVol"]), (57500, 56000))
        self.assertEqual((fpt["atcPrice"], fpt["atcVol"]), (58000, 152500))
        self.assertEqual(fpt["bids"][0], {"p": 58000, "v": 1300})
        self.assertEqual(fpt["asks"][0], {"p": 58100, "v": 82600})
        self.assertEqual(len(fpt["bids"]), 3)
        self.assertEqual(fpt["matchTime"], 1792050300002)
        self.assertGreater(fpt["listedShares"], 1_000_000_000)

    def test_uses_order_matching_volume(self):
        shs = self.items["SHS"]
        self.assertEqual(shs["exchange"], "HNX")
        self.assertEqual(shs["volume"], 16_614_500)  # G1, không gồm thoả thuận
        self.assertEqual(shs["value"], 204_670_290_000)

    def test_upcom(self):
        self.assertEqual(self.items["ACV"]["exchange"], "UPCOM")

    def test_tolerates_garbage(self):
        self.assertEqual(normalize.board(None), [])
        self.assertEqual(normalize.board([{"listingInfo": {"symbol": "XYZ"}}, 3]), [])


class ChartTest(unittest.TestCase):
    def test_daily_bars(self):
        bars = normalize.chart_bars(load("vci_chart_fpt.json")[0])
        self.assertEqual(len(bars), 5)
        self.assertEqual(bars[-1]["date"], "2026-10-15")
        self.assertEqual(bars[-1]["close"], 58000)
        self.assertEqual(bars[-1]["volume"], 4_964_400)
        self.assertEqual(bars[-1]["value"], 287_054_530_000)
        self.assertEqual([b["date"] for b in bars], sorted(b["date"] for b in bars))
        for b in bars:
            self.assertLessEqual(b["low"], min(b["open"], b["close"]))
            self.assertGreaterEqual(b["high"], max(b["open"], b["close"]))

    def test_value_unit_detection(self):
        # dữ liệu chỉ số cũ: giá trị theo đồng; mới: theo triệu đồng
        raw = {"t": ["1728604800", "1792022400"], "o": [1288, 1701.2], "h": [1290, 1709.54], "l": [1280, 1694.77],
               "c": [1288.39, 1698.35], "v": [437625358, 684777807],
               "accumulatedValue": [11924750690490, 15043470.44184]}
        bars = normalize.chart_bars(raw, is_index=True)
        self.assertEqual(bars[0]["value"], 11_924_750_690_490)
        self.assertEqual(bars[1]["value"], 15_043_470_441_840)

    def test_index_quote(self):
        raw = {"t": ["1791936000", "1792022400"], "o": [1700.1, 1704.9], "h": [1710, 1706.2], "l": [1690, 1695.3],
               "c": [1704.87, 1698.35], "v": [900, 1000]}
        bars = normalize.chart_bars(raw, is_index=True)
        q = normalize.index_quote("VNINDEX", bars)
        self.assertEqual(q["date"], "2026-10-15")
        self.assertEqual((q["value"], q["prevClose"]), (1698.35, 1704.87))
        self.assertIsNone(normalize.index_quote("VNINDEX", []))


if __name__ == "__main__":
    unittest.main()
