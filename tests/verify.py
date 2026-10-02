"""Independent checks of files the JS tests write, using tools that share no code with the app.
Run after `node tests/pngtest.js` and `node tests/vec.js` (and tests/exports.js for the DXF check):
    MAPNC_TEST_OUT=/tmp/mapnc-out node tests/pngtest.js && MAPNC_TEST_OUT=/tmp/mapnc-out node tests/vec.js
    python3 tests/verify.py /tmp/mapnc-out
Needs: pip install pillow numpy ezdxf
"""
import sys, glob, os
import numpy as np
from PIL import Image

out = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MAPNC_TEST_OUT", ".")
bad = 0
def check(name, ok, extra=""):
    global bad
    print(("PASS " if ok else "FAIL ") + name + ("  " + extra if extra else ""))
    bad += 0 if ok else 1

# 16- and 8-bit PNGs decode to exactly the samples the encoder was given (pngtest.js writes tN.png and tN.raw).
for bits, dt in ((16, ">u2"), (8, "u1")):
    png, raw = f"{out}/t{bits}.png", f"{out}/t{bits}.raw"
    if not (os.path.exists(png) and os.path.exists(raw)):
        print(f"SKIP {bits}-bit PNG (run tests/pngtest.js first)"); continue
    im = Image.open(png); a = np.array(im)
    want = np.frombuffer(open(raw, "rb").read(), dtype="<u2" if bits == 16 else "u1").reshape(a.shape)
    check(f"{bits}-bit PNG decodes bit-exact", (a == want).all(), f"{im.mode} {a.shape}")

# DXF files open in ezdxf with no audit errors.
try:
    import ezdxf
    from ezdxf import recover
    for f in sorted(glob.glob(f"{out}/*.dxf")):
        doc, auditor = recover.readfile(f)
        check("DXF audit clean: " + os.path.basename(f), len(auditor.errors) == 0 and len(doc.modelspace()) > 0, f"{len(doc.modelspace())} entities")
except ImportError:
    print("SKIP DXF checks (pip install ezdxf)")

sys.exit(1 if bad else 0)
