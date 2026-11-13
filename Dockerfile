FROM node:22-bookworm-slim

# Runtimes for /api/execute: python3 + matplotlib (plots), JDK 17 (javac/java).
# Bookworm ships OpenJDK 17 only — openjdk-21 does not exist in bookworm
# (it is a trixie package); 17 is enough for notebook Java cells.
# LibreOffice (impress) converts PPTX slide decks to PDF for the reader —
# the seed script uses `soffice --headless --convert-to pdf`, and the
# container needs it too for any future in-app conversion. Cost: roughly
# +500MB on the image (LibreOffice + its dependencies); the v1 image was
# small deliberately, this trades size for renderable slides.
# PyTorch (CPU) + torchvision + scipy, installed with pip: the UDL labs
# import torch, torchvision and scipy, and the container python3 only had
# matplotlib (+numpy). CPU wheel only — small learning models, no GPU
# needed. Cost: roughly +800MB–1GB on the image; rebuild takes longer.
# Bookworm's python3 is externally managed (PEP 668), so a system-wide pip
# install needs --break-system-packages (the executor runs plain `python3`,
# so no venv). scipy comes from PyPI, not the torch index.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-matplotlib \
      openjdk-17-jdk-headless \
      libreoffice-impress \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages \
         torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && python3 -m pip install --no-cache-dir --break-system-packages scipy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 9300
CMD ["node", "src/server.js"]
