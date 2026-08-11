#!/usr/bin/env python3
"""Rebuild benchmark.py's cross dataset from the on-disk cache, plus a
forward-return PANEL (per timeframe: bar_close_time -> {coin: fwd20}) so that
crosses can be judged against the CONTEMPORANEOUS cross-section instead of a
pooled all-time base rate.

Writes data/calib_<tf>.json. Read-only w.r.t. benchmark.py / scanner.py.
"""
import json
import os
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]          # benchmark.py reads argv at import time
from benchmark import crosses, series, state_timeline, HTF          # noqa: E402
from scanner import PRESETS                                         # noqa: E402

DEEP = Path(__file__).parent / "data" / "deep"
OUT = Path(__file__).parent / "data"
FP, SP = PRESETS["50/200"]
HZ = 20


def load(sym, tf):
    f = DEEP / f"{sym}-{tf}.json"
    return json.loads(f.read_text()) if f.exists() else None


def main():
    syms = sorted({os.path.basename(f).rsplit("-", 1)[0]
                   for f in os.listdir(DEEP) if f.endswith(".json")})
    syms = sorted({s.rsplit("-", 1)[0] for s in
                   (os.path.splitext(f)[0] for f in os.listdir(DEEP))})
    print(f"{len(syms)} symbols", file=sys.stderr)

    for tf in ["4h", "12h", "1d"]:
        allx, base, panel = [], [], {}
        nseries = 0
        for s in syms:
            kl = load(s, tf)
            if not kl or len(kl) <= 260:
                continue
            nseries += 1
            htf_tf = HTF[tf]
            hkl = load(s, htf_tf) if htf_tf else None
            if hkl is not None and len(hkl) <= 260:
                hkl = None
            htf = state_timeline(hkl, FP, SP) if hkl else ([], [])
            d = series(kl)
            xs, bs = crosses(d, FP, SP, htf)
            for x in xs:
                x["sym"] = s
            allx += xs
            base += bs
            # forward-return panel over ALL bars (not just post-warmup)
            c, ct = d["c"], d["ct"]
            for i in range(len(c) - HZ):
                panel.setdefault(str(ct[i]), {})[s] = c[i + HZ] / c[i] - 1
        out = {"tf": tf, "n_series": nseries, "crosses": allx,
               "base": base, "panel": panel}
        p = OUT / f"calib_{tf}.json"
        p.write_text(json.dumps(out, separators=(",", ":")))
        print(f"{tf}: series={nseries} crosses={len(allx)} base={len(base)} "
              f"paneldates={len(panel)} -> {p}", file=sys.stderr)


if __name__ == "__main__":
    main()
