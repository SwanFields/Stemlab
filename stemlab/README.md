# Stemlab: AI-Assisted Stem Separation

เว็บแยกเสียงเพลงออกเป็นแทร็ก (Vocals / Drums / Bass / Other) ด้วยโมเดล AI แล้วเปิดเครื่องเล่น Multi-track Mixer ให้ปรับความดัง Mute และ Solo แต่ละแทร็กได้ทันที

โปรเจ็คนี้ครอบคลุมสามส่วนที่โจทย์ต้องการ

| ส่วน | เทคโนโลยี | งานหลัก |
|---|---|---|
| Web Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, Web Audio API | อัปโหลด, polling สถานะ, Mixer, ดาวน์โหลด |
| Backend API | Python, FastAPI, Celery, Redis, SQLite | สมัคร/เข้าสู่ระบบ, รับไฟล์, ตรวจไฟล์, จัดคิวงาน, ส่งไฟล์กลับ |
| Machine Learning | Demucs `htdemucs` (Meta) | แยกเสียง 4 สเต็ม |

## สถาปัตยกรรม

```
 Browser (React)                    FastAPI                 Redis              Celery worker
 ───────────────                    ───────                 ─────              ─────────────
 1. ลากไฟล์ ──POST /api/upload────▶ ตรวจนามสกุล+magic bytes
                                    +ขนาด, เซฟลงดิสก์ ───▶ job:{id} = uploaded
                ◀──── job_id ─────
 2.        ──POST /api/process/id─▶ uploaded→queued (atomic) ─▶ ส่งงานเข้าคิว ─────▶ หยิบงาน
 3. polling ─GET /api/status/id───▶ อ่านสถานะจาก Redis ◀───── progress 0..100 ◀──── รัน Demucs
                ◀ queued/processing/done                                            (parse progress bar)
 4. done ───GET /api/download/id/vocals ▶ ส่ง WAV (หรือ /all เป็น ZIP)
 5. โหลด 4 WAV → decode → เล่นพร้อมกันด้วย Web Audio API
```

### บัญชีผู้ใช้และการจัดเก็บข้อมูล

- สมัครด้วย Username (3-30 ตัว ใช้ a-z, 0-9 และ `_`), อีเมล และรหัสผ่านอย่างน้อย 10 ตัวอักษร โดยรหัสผ่านต้องมีตัวอักษรและตัวเลขอย่างน้อยชนิดละ 1 ตัว เข้าสู่ระบบได้ด้วยอีเมลหรือ Username รหัสผ่านถูกแฮชด้วย PBKDF2-HMAC-SHA256 พร้อม salt แบบสุ่ม (310,000 รอบ) ก่อนบันทึก ไม่มีการเก็บรหัสผ่านจริง
- ข้อมูลบัญชีและเซสชันอยู่ใน SQLite ที่ `STORAGE_DIR/users.sqlite3` ซึ่งใน Docker คือ `/data/users.sqlite3` บน volume `storage` ข้อมูลบัญชีจึงอยู่ต่อแม้รีสตาร์ตคอนเทนเนอร์
- ประวัติการประมวลผลเก็บในตาราง `job_history` ของ SQLite เดียวกัน แยกตามบัญชี เก็บชื่อไฟล์ สถานะ แทร็ก และเวลาที่งานสำเร็จ แม้ไฟล์เสียง/สถานะชั่วคราวจะถูกลบตามอายุงาน
- โครงสร้างตารางและความสัมพันธ์สำหรับเปิดดูใน DrawDB อยู่ใน [`database_schema.sql`](./database_schema.sql) โดยแสดงความสัมพันธ์ `users` กับ `sessions` และ `job_history`; สถานะงานชั่วคราวเก็บใน Redis และไฟล์เสียงเก็บใน storage จึงไม่อยู่ใน ER diagram ของ SQLite
- หน้าเว็บแสดงประวัติล่าสุดไม่เกิน 100 งาน เวลาสำเร็จแสดงตามเขตเวลาไทย; งานที่ประมวลผลก่อนเพิ่มระบบประวัติจะไม่ถูกนำเข้าย้อนหลัง
- เปิดมิกเซอร์จากประวัติได้เมื่องานยังอยู่ใน Redis และไฟล์ WAV ของทุกแทร็กยังอยู่ใน storage; ประวัติยังคงแสดงหลังไฟล์หมดอายุ แต่จะเปิดมิกเซอร์ไม่ได้
- หน้าแดชบอร์ดแสดง Username, อีเมล และสถานะบัญชี และแก้ไข Username ได้ โดย Username ใหม่ต้องไม่ซ้ำและใช้รูปแบบเดิม รูปโปรไฟล์ (JPG/PNG/WebP ไม่เกิน 5 MB) จะถูกย่อและบันทึกใน local storage ของเบราว์เซอร์บนอุปกรณ์นั้น ไม่ได้อัปโหลดหรือซิงก์ไปยังเซิร์ฟเวอร์
- เซสชันใช้ token แบบสุ่มส่งให้เบราว์เซอร์ผ่านคุกกี้ `HttpOnly`, `SameSite=Lax` และหมดอายุใน 7 วัน ส่วนฐานข้อมูลเก็บเฉพาะ SHA-256 ของ token ไม่เก็บ token จริง
- งานแยกเสียงใน Redis และไฟล์เสียงใน `/data` ผูกกับบัญชีเจ้าของ งานถูกล้างตาม `JOB_TTL_HOURS` (ค่าเริ่มต้น 6 ชั่วโมง) ขณะที่บัญชีไม่หมดอายุตามอายุงาน
- ค่าเริ่มต้น `AUTH_COOKIE_SECURE=false` เหมาะกับการพัฒนาบน HTTP ในเครื่อง เมื่อนำขึ้น production ต้องใช้ HTTPS และตั้ง `AUTH_COOKIE_SECURE=true` พร้อมกำหนด `CORS_ORIGINS` ให้เป็น origin ของหน้าเว็บจริงเท่านั้น

โครงสร้างโฟลเดอร์

```
stemlab/
├── docker-compose.yml          redis + api + worker
├── backend/
│   ├── app/
│   │   ├── main.py             REST endpoints (4 ตัวตามโจทย์ + /health)
│   │   ├── tasks.py            Celery task: แยกเสียง + อัปเดต progress
│   │   ├── separators.py       Demucs wrapper (+ โหมด mock สำหรับพัฒนา)
│   │   ├── store.py            สถานะงานใน Redis
│   │   ├── celery_app.py, config.py
│   ├── tests/                  pytest + Demucs จำลอง
│   ├── requirements*.txt, Dockerfile, .env.example
└── frontend/src/
    ├── App.tsx                 state machine: idle → uploading → processing → ready
    ├── audio/StemPlayer.ts     engine เล่นหลายแทร็กด้วย Web Audio API
    └── components/             UploadZone, ProcessingView, Mixer, TrackStrip, Transport, Waveform, ExportPanel
```

## เตรียมตัวก่อนรัน

1. ดาวน์โหลดโปรเจกต์ให้ครบทั้ง repository แล้วเปิดโฟลเดอร์ `stemlab` ใน VS Code หรือ Terminal
2. เลือกวิธีรันก่อน:
   - **Docker (แนะนำ):** ติดตั้ง Docker Desktop และเปิดใช้งาน Docker Engine ให้เรียบร้อย วิธีนี้จะรัน Redis, API และ worker ให้ ไม่ต้องติดตั้ง Python หรือ ffmpeg บนเครื่อง
   - **รันแยกบริการ:** ติดตั้ง Python 3.10+, Node.js 20+ (รวม npm), Docker สำหรับ Redis และ ffmpeg โดยเพิ่ม `ffmpeg` ไว้ใน `PATH`
3. ตรวจสอบเครื่องมือจาก Terminal:

```powershell
docker --version
docker compose version
node --version
npm --version
```

สำหรับการรันแยกบริการ ให้ตรวจเพิ่มด้วย `python --version` และ `ffmpeg -version` หากคำสั่งใดไม่รู้จัก ให้ติดตั้งเครื่องมือนั้นและเปิด Terminal ใหม่ก่อนดำเนินการต่อ

> ไม่จำเป็นต้องติดตั้ง Git เพื่อรันโปรเจกต์ หากมีไฟล์โปรเจกต์อยู่ในเครื่องแล้ว หากใช้ Docker ให้เปิด Docker Desktop ค้างไว้ก่อนสั่งรัน

## วิธีรัน

### ทางที่ 1: Docker (แนะนำ)

เปิด Terminal ที่โฟลเดอร์โปรเจกต์ แล้วรันบริการ Backend:

```powershell
docker compose up --build
```

เปิด Terminal อีกหน้าต่างเพื่อรัน Frontend:

```powershell
cd frontend
npm ci
npm run dev
```

เปิดเว็บที่ `http://localhost:5173`; API อยู่ที่ `http://localhost:8000` และเอกสาร API อยู่ที่ `http://localhost:8000/docs` ครั้งแรก worker จะดาวน์โหลดน้ำหนักโมเดล Demucs โดยอัตโนมัติและเก็บไว้ใน Docker volume `model-cache` จึงอาจใช้เวลานานและต้องเชื่อมต่ออินเทอร์เน็ต

หยุดบริการ Docker ด้วย `Ctrl+C` ใน Terminal ที่รัน `docker compose up` หรือใช้ `docker compose down` จากโฟลเดอร์โปรเจกต์

### ทางที่ 2: รันแยกบริการ

เปิด Terminal แยกสำหรับแต่ละบริการ โดยคำสั่งด้านล่างเป็นตัวอย่างสำหรับ Windows PowerShell

**Terminal 1 — Redis**

```powershell
docker run --rm -p 6379:6379 redis:7-alpine
```

**Terminal 2 — Backend API**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
Copy-Item .env.example .env
pip install -r requirements.txt -r requirements-ml.txt
uvicorn app.main:app --reload
```

การติดตั้ง `requirements-ml.txt` จะติดตั้ง PyTorch และ Demucs ซึ่งมีขนาดใหญ่ หากต้องการเพียงทดลองการทำงานโดยไม่ใช้โมเดลจริง ให้ตั้ง `SEPARATOR=mock` ใน `backend\.env` และติดตั้งเฉพาะ `requirements.txt`

**Terminal 3 — Worker**

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
celery -A app.celery_app.celery worker --loglevel=info --concurrency=1 --pool=solo
```

**Terminal 4 — Frontend**

```powershell
cd frontend
npm ci
npm run dev
```

### โหมดทดสอบโดยไม่ใช้ AI

ถ้าเครื่องไม่มี torch/GPU ตั้ง `SEPARATOR=mock` ใน `.env` ระบบจะแยกเสียงด้วยฟิลเตอร์ความถี่ (เบส < 150 Hz, กลองสูง > 6 kHz, เสียงกลางเป็น vocals) เพื่อให้ลองเดินระบบครบทั้งเส้นทางได้ **นี่ไม่ใช่ Machine Learning** และคุณภาพต่ำมาก หน้าเว็บจะแสดงป้าย "โหมดทดสอบ" มุมขวาบนเสมอ เพื่อไม่ให้เข้าใจผิดตอนนำเสนอ

## API

| Method | Path | ผลลัพธ์ |
|---|---|---|
| POST | `/api/auth/register` | สมัครสมาชิกด้วย `{email, username, password}` และเริ่มเซสชัน |
| POST | `/api/auth/login` | เข้าสู่ระบบด้วย `{identifier, password}` โดย `identifier` เป็นอีเมลหรือ Username |
| GET | `/api/auth/me` | ตรวจสอบบัญชีจากเซสชันปัจจุบัน |
| PUT | `/api/auth/username` | แก้ Username ของบัญชีปัจจุบันด้วย `{username}` |
| POST | `/api/auth/logout` | ยกเลิกเซสชันปัจจุบัน |
| GET | `/api/history` | รายการงานของบัญชีปัจจุบัน พร้อมสถานะ รายชื่อ STEM และเวลาที่สำเร็จ |
| POST | `/api/upload` | รับไฟล์ `file` (MP3/WAV/FLAC ≤ 50 MB) → `201 {job_id}` · `415` ชนิดไฟล์ไม่ถูกต้อง · `413` ใหญ่เกิน |
| POST | `/api/process/{job_id}` | ส่งงานเข้าคิว → `202` · `409` ถ้างานถูกส่งไปแล้ว · `503` ถ้าคิวใช้ไม่ได้ |
| GET | `/api/status/{job_id}` | (ต้องเข้าสู่ระบบและเป็นเจ้าของงาน) `{status, progress, stage, error, stems[]}` |
| GET | `/api/download/{job_id}/{track}` | (ต้องเข้าสู่ระบบและเป็นเจ้าของงาน) WAV ของแต่ละแทร็ก หรือ `all` เป็น ZIP |
| GET | `/api/health` | สถานะ Redis และโมเดลที่ใช้ |

ยกเว้น `/api/health`, endpoint งานเพลงต้องใช้เซสชันที่ได้จากการเข้าสู่ระบบ การอัปโหลด ประมวลผล สถานะ และดาวน์โหลดจะถูกจำกัดให้เจ้าของงานเท่านั้น

เอกสาร Swagger อัตโนมัติอยู่ที่ `http://localhost:8000/docs`

## จุดเด่นที่ควรเล่าตอนนำเสนอ

**Machine Learning**
- ใช้ `htdemucs` (Hybrid Transformer Demucs) ซึ่งประมวลผลทั้งรูปคลื่นและสเปกโตรแกรมแล้วรวมด้วย Transformer
- Worker เรียก Demucs เป็น subprocess แล้วอ่าน progress bar จาก output เพื่อส่งเปอร์เซ็นต์จริงให้หน้าเว็บ (ไม่ใช่แถบหลอก)
- การรันโมเดลใช้เวลานาน จึงแยกเป็น Celery task: API ตอบกลับทันทีพร้อม `job_id` ผู้ใช้ไม่ต้องรอค้างและรองรับหลายผู้ใช้ผ่านคิว

**Backend**
- ตรวจไฟล์สามชั้น: นามสกุล, magic bytes ของไฟล์จริง (กันไฟล์ปลอมที่เปลี่ยนนามสกุล), ขนาดระหว่างสตรีมเขียนลงดิสก์ (ไม่โหลดทั้งไฟล์ลงแรม)
- `POST /process` ใช้ Redis WATCH/MULTI เปลี่ยนสถานะแบบ atomic กดซ้ำสองครั้งจะไม่เกิดงานซ้ำ
- ชื่อแทร็กใน download เป็น whitelist เพราะไม่มีข้อความจากผู้ใช้ไปถึง path บนดิสก์ จึงกัน path traversal
- ไฟล์งานถูกลบอัตโนมัติหลัง `JOB_TTL_HOURS` (ค่าเริ่มต้น 6 ชั่วโมง)

**Frontend**
- เล่นสี่แทร็กด้วย `AudioBufferSourceNode` ทุกตัวที่ถูกกำหนดเวลาเริ่ม `start(when)` ด้วยค่า `when` เดียวกันบน `AudioContext` เดียวกัน จึงเริ่มพร้อมกันจากนาฬิกาเสียงเดียว ต่างจากใช้ `<audio>` สี่ตัวที่แต่ละตัวมีนาฬิกาของตัวเองและค่อยๆ เหลื่อมกัน
- Mute/Solo/Volume ทำที่ `GainNode` ด้วย `setTargetAtTime` ไม่มีเสียงแตกเวลากด
- Waveform วาดจากข้อมูลเสียงจริงของแต่ละสเต็ม คลิกเพื่อ seek ได้ และมี level meter จาก `AnalyserNode`
- ใช้ keyboard ได้ (Space = เล่น/หยุดชั่วคราว) และมี focus ring ครบ

## การทดสอบ

```bash
cd backend
pip install -r requirements-dev.txt
pytest -v
```

ชุดทดสอบครอบคลุม: ปฏิเสธไฟล์ผิดชนิด/ไฟล์ปลอม/ไฟล์ใหญ่เกิน, flow ครบตั้งแต่ upload ถึง ZIP, ส่งงานซ้ำ, คิวล่ม, path traversal, ตัวแยกเสียงโหมด mock แยกย่านความถี่ได้ถูกต้อง และตัวห่อ Demucs (อ่าน progress, เก็บไฟล์, รายงาน error) โดยใช้ Demucs จำลองใน `tests/fake_demucs`

## ข้อจำกัดและต่อยอด

- บน CPU การแยกเสียงช้ากว่า GPU มาก ตอนสาธิตควรเตรียมเพลงสั้น 30 ถึง 60 วินาที หรือรัน worker บนเครื่องที่มี CUDA (`DEMUCS_DEVICE=cuda`)
- รองรับโมเดล 4 สเต็ม (`htdemucs`, `htdemucs_ft`, `mdx_extra`) ส่วน `htdemucs_6s` มี 6 สเต็มจึงต้องปรับ `STEMS` ใน `config.py`
- ไม่มีระบบล็อกอิน ใครรู้ `job_id` (สุ่ม 128 บิต) ก็ดึงไฟล์ได้ ถ้าจะใช้งานจริงควรเพิ่มการยืนยันตัวตน
- แนวต่อยอด: ส่งสถานะด้วย WebSocket/SSE แทน polling, ส่งออกไฟล์มิกซ์ตามที่ปรับใน Mixer ด้วย `OfflineAudioContext`, เก็บไฟล์บน S3
