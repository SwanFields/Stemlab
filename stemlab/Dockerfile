FROM python:3.10-slim

# ติดตั้ง ffmpeg ที่จำเป็นสำหรับการประมวลผลเสียงของ Demucs
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ก๊อปปี้ไฟล์ requirements.txt มาติดตั้งไลบรารี
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ก๊อปปี้โค้ดทั้งหมดเข้ามา
COPY . .

# คำสั่งรันเซิร์ฟเวอร์ (ถ้าไฟล์รันไม่ได้ชื่อ main.py ให้แก้ตรง main:app นะครับ)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000"]