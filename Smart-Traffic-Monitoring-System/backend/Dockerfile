ARG PYTHON_IMAGE=python:3.11-slim

# libgl/libglib are required at runtime by OpenCV. Git is installed only in the
# dependency stage because CLIP is retrieved from its Git repository.
FROM ${PYTHON_IMAGE} AS dependencies
ARG DEVICE=cpu

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /install
COPY requirements_cpu.txt requirements_gpu.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    if [ "$DEVICE" = "gpu" ]; then \
        pip install --no-cache-dir --prefix=/install/python -r requirements_gpu.txt; \
    else \
        pip install --no-cache-dir --prefix=/install/python -r requirements_cpu.txt; \
    fi

FROM ${PYTHON_IMAGE} AS runtime
WORKDIR /backend

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /install/python /usr/local
COPY . .

RUN chmod +x entrypoint.sh

EXPOSE 8000
CMD ["./entrypoint.sh"]
