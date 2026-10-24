# Object removal for Stitch: LaMa (ONNX, CPU) behind a small HTTP server on :8080.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LAMA_MODEL=/app/lama.ort LAMA_THREADS=4
WORKDIR /app

RUN pip install --no-cache-dir onnxruntime==1.31.0 numpy==2.5.4 pillow==13.0.0

# Carve/LaMa-ONNX at a pinned revision, verified by checksum, then saved in ONNX Runtime's own format, which loads in
# about half the time (cold starts). 'Extended' optimisations only: the higher level adds CPU-specific layouts, and
# the image is built on a different machine than the one it runs on. One layer, so the .onnx never stays in the image.
ARG MODEL_URL=https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx
ARG MODEL_SHA256=1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6
RUN python -c "import hashlib,sys,urllib.request; \
d=urllib.request.urlopen('${MODEL_URL}', timeout=300).read(); \
h=hashlib.sha256(d).hexdigest(); \
sys.exit(f'model checksum mismatch: {h}') if h!='${MODEL_SHA256}' else open('/tmp/lama.onnx','wb').write(d)" \
 && python -c "import onnxruntime as ort; \
so=ort.SessionOptions(); so.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED; \
so.optimized_model_filepath='${LAMA_MODEL}'; so.add_session_config_entry('session.save_model_format','ORT'); \
ort.InferenceSession('/tmp/lama.onnx', so, providers=['CPUExecutionProvider'])" \
 && rm /tmp/lama.onnx

COPY server.py selftest.py ./
EXPOSE 8080
CMD ["python", "/app/server.py"]
