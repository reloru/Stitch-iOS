"""
Object removal (inpainting) server for Stitch, run in a Cloudflare Container.

POST /inpaint   body = image bytes followed by mask bytes; header x-image-length = byte length of the image.
                The image (PNG/JPEG, longest side <= 512) is the area around the object; the mask (PNG, same size)
                is non-zero where the object is. Returns an RGBA PNG of the same size: the filled-in pixels, with
                alpha 255 over the (slightly grown) mask, feathering to 0 just outside it, so the caller can
                composite it over the original and leave every other pixel untouched.
GET  /health    200 once the model is loaded.

The model is LaMa (big-lama, Apache-2.0) exported to ONNX by Carve with a fixed 512x512 input.
"""

import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

MODEL = os.environ.get("LAMA_MODEL", "/app/lama.ort")
THREADS = int(os.environ.get("LAMA_THREADS", "4"))
PORT = int(os.environ.get("PORT", "8080"))
SIZE = 512
MAX_BODY = 8 * 1024 * 1024
# LaMa fills a hole from what borders it: any rim of the object left outside the mask is smeared back in, so the
# mask is grown before inference (the user's brush rarely covers the edge exactly).
GROW = 6
FEATHER = 4


class BadInput(ValueError):
    pass


def load_session() -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.intra_op_num_threads = THREADS
    so.inter_op_num_threads = 1
    return ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])


def inpaint(session: ort.InferenceSession, image: Image.Image, mask: Image.Image) -> Image.Image:
    img = image.convert("RGB")
    w, h = img.size
    if max(w, h) > SIZE or min(w, h) < 8:
        raise BadInput(f"image must be 8..{SIZE} px per side, got {w}x{h}")
    m = mask.convert("L")
    if m.size != img.size:
        m = m.resize(img.size, Image.NEAREST)
    hole = m.point(lambda v: 255 if v > 16 else 0)
    if hole.getbbox() is None:
        raise BadInput("the mask is empty")
    grown = hole.filter(ImageFilter.MaxFilter(2 * GROW + 1))

    a = np.asarray(img, dtype=np.float32) / 255.0
    k = (np.asarray(grown) > 0).astype(np.float32)
    if (w, h) != (SIZE, SIZE):
        # pad to the model's fixed input; mirrored content gives the model plausible surroundings
        pad = ((0, SIZE - h), (0, SIZE - w))
        a = np.pad(a, pad + ((0, 0),), mode="symmetric")
        # mirror the mask too, so mirrored copies of the object are holes as well and cannot leak back in
        k = np.pad(k, pad, mode="symmetric")
    out = session.run(None, {"image": a.transpose(2, 0, 1)[None], "mask": k[None, None]})[0]
    rgb = np.clip(out[0].transpose(1, 2, 0)[:h, :w] + 0.5, 0, 255).astype(np.uint8)

    # alpha: 255 over the grown hole, ramping to 0 a few pixels outside it
    edge = grown.filter(ImageFilter.MaxFilter(2 * FEATHER + 1)).filter(ImageFilter.GaussianBlur(FEATHER / 2))
    alpha = np.maximum(np.asarray(edge), np.asarray(grown))
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


def handle_inpaint_body(session, lock: threading.Lock, body: bytes, image_length: int) -> bytes:
    if image_length <= 0 or image_length >= len(body):
        raise BadInput("x-image-length does not match the body")
    try:
        image = Image.open(io.BytesIO(body[:image_length]))
        mask = Image.open(io.BytesIO(body[image_length:]))
        image.load()
        mask.load()
    except Exception as e:  # noqa: BLE001 - any decode failure is the caller's input
        raise BadInput(f"could not decode the images: {e}") from e
    with lock:
        result = inpaint(session, image, mask)
    buf = io.BytesIO()
    result.save(buf, format="PNG", compress_level=3)
    return buf.getvalue()


def make_handler(session, lock):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, error: str, message: str):
            self._send(status, json.dumps({"error": error, "message": message}).encode(), "application/json")

        def do_GET(self):
            if self.path == "/health":
                self._send(200, b"ok", "text/plain")
            else:
                self._error(404, "not_found", "Not found")

        def do_POST(self):
            if self.path != "/inpaint":
                self._error(404, "not_found", "Not found")
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._error(413, "size", "Body is empty or too large")
                return
            body = self.rfile.read(length)
            started = time.time()
            try:
                png = handle_inpaint_body(session, lock, body, int(self.headers.get("x-image-length") or 0))
            except BadInput as e:
                self._error(400, "input", str(e))
                return
            except Exception as e:  # noqa: BLE001 - report model failures as 500
                self._error(500, "model", f"inpainting failed: {e}")
                return
            print(f"inpaint {len(body)} bytes in {time.time() - started:.2f}s", flush=True)
            self._send(200, png, "image/png")

        def log_message(self, format, *args):  # quiet access log; inpaint timings are printed above
            pass

    return Handler


def serve(port: int = PORT, session=None) -> ThreadingHTTPServer:
    session = session or load_session()
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(session, threading.Lock()))
    return server


if __name__ == "__main__":
    t = time.time()
    s = load_session()
    print(f"model loaded in {time.time() - t:.1f}s with {THREADS} threads", flush=True)
    # listen only once the model is loaded: /health answering means ready
    serve(PORT, s).serve_forever()
