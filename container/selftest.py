"""Self-test run inside the built image (CI): real model, real HTTP server, synthetic photos."""

import io
import json
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

import server


def scene(w: int, h: int, box: tuple[int, int, int, int]) -> tuple[Image.Image, Image.Image]:
    """A textured grey-green surface with a solid red object in `box`, and a mask that covers the object."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    rng = np.random.default_rng(1)
    base = 120 + 25 * np.sin(x / 9.0) + 15 * np.cos(y / 13.0) + rng.normal(0, 6, (h, w))
    rgb = np.dstack([base * 0.9, base * 1.05, base * 0.85])
    x0, y0, x1, y1 = box
    rgb[y0:y1, x0:x1] = (220, 30, 30)
    mask = np.zeros((h, w), np.uint8)
    mask[y0:y1, x0:x1] = 255
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)), Image.fromarray(mask)


def png(im: Image.Image) -> bytes:
    b = io.BytesIO()
    im.save(b, format="PNG")
    return b.getvalue()


def post(port: int, image: bytes, mask: bytes):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/inpaint",
        data=image + mask,
        headers={"x-image-length": str(len(image)), "content-type": "application/octet-stream"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.headers.get("content-type"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type"), e.read()


def check(port: int, w: int, h: int, box):
    img, mask = scene(w, h, box)
    t = time.time()
    status, ctype, body = post(port, png(img), png(mask))
    took = time.time() - t
    assert status == 200 and ctype == "image/png", (status, body[:200])
    out = Image.open(io.BytesIO(body))
    assert out.mode == "RGBA" and out.size == (w, h), (out.mode, out.size)
    o = np.asarray(out).astype(np.int32)
    x0, y0, x1, y1 = box
    inside = o[y0:y1, x0:x1]
    assert (inside[..., 3] == 255).all(), "alpha must be solid over the mask"
    far = o.copy()
    far[max(0, y0 - 20) : y1 + 20, max(0, x0 - 20) : x1 + 20, 3] = 0
    assert (far[..., 3] == 0).all(), "alpha must be 0 away from the mask"
    redness = (inside[..., 0] - inside[..., 1]).mean()
    assert redness < 40, f"the red object is still there (red-green {redness:.0f})"
    print(f"ok {w}x{h} object {x1 - x0}x{y1 - y0}: {took:.2f}s, leftover red-green {redness:.1f}")


def main() -> int:
    srv = server.serve(0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10) as r:
        assert r.status == 200
    check(port, 512, 512, (200, 220, 300, 330))
    check(port, 300, 180, (120, 60, 170, 120))  # smaller than the model input: padded
    status, _, body = post(port, b"not an image", png(Image.new("L", (10, 10))))
    assert status == 400 and json.loads(body)["error"] == "input", (status, body)
    img, _ = scene(64, 64, (10, 10, 20, 20))
    status, _, body = post(port, png(img), png(Image.new("L", (64, 64))))
    assert status == 400 and b"empty" in body, (status, body)
    srv.shutdown()
    print("selftest passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
