FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt requirements-ml.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-ml.txt

COPY app ./app
COPY start.sh ./start.sh
RUN chmod +x ./start.sh
ENV STORAGE_DIR=/data
EXPOSE 8000
CMD ["./start.sh"]
