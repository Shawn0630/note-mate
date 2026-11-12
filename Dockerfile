FROM node:22-bookworm-slim

# Runtimes for /api/execute: python3 + matplotlib (plots), JDK 17 (javac/java).
# Bookworm ships OpenJDK 17 only — openjdk-21 does not exist in bookworm
# (it is a trixie package); 17 is enough for notebook Java cells.
# LibreOffice (impress) converts PPTX slide decks to PDF for the reader —
# the seed script uses `soffice --headless --convert-to pdf`, and the
# container needs it too for any future in-app conversion. Cost: roughly
# +500MB on the image (LibreOffice + its dependencies); the v1 image was
# small deliberately, this trades size for renderable slides.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-matplotlib \
      openjdk-17-jdk-headless \
      libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 9300
CMD ["node", "src/server.js"]
