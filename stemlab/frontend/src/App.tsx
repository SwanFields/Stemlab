import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  cancelJob,
  getHealth,
  getCurrentUser,
  getHistory,
  getStatus,
  login,
  logout,
  register,
  startProcessing,
  updateUsername,
  uploadFile,
  type Health,
  type HistoryItem,
  type JobInfo,
  type JobStatus,
  type StemInfo,
  type User,
} from "./api";
import Mixer from "./components/Mixer";
import ProcessingView from "./components/ProcessingView";
import UploadZone from "./components/UploadZone";
import { useLanguage } from "./components/Language";

type Phase =
  | { name: "idle"; error?: string }
  | { name: "uploading"; file: File; uploadPercent: number }
  | { name: "processing"; file: File; jobId: string; status: JobStatus; aiPercent: number; stage: string }
  | { name: "ready"; jobId: string; filename: string; stems: StemInfo[] };

const POLL_MS = 1000;
const MAX_POLL_FAILURES = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function translateStage(stage: string): string {
  const stages: Record<string, string> = {
    "กำลังส่งงานเข้าคิว": "Sending job to the queue",
    "อยู่ในคิว": "Queued",
    "เริ่มประมวลผล": "Starting processing",
    "กำลังโหลดโมเดล AI (Demucs)": "Loading AI model (Demucs)",
    "AI กำลังแยกเสียง": "AI is separating audio",
    "กำลังจัดเก็บไฟล์เสียง": "Saving audio files",
    "อ่านไฟล์เสียง (โหมดจำลอง DSP)": "Reading audio (DSP demo mode)",
    "กรองย่านเสียงเบส": "Filtering bass frequencies",
    "กรองย่านเสียงกลอง": "Filtering drum frequencies",
    "ดึงเสียงกลาง (vocals)": "Extracting midrange (vocals)",
    "เสร็จสิ้น": "Complete",
  };
  return stages[stage] ?? stage;
}

function translateError(message: string, language: "th" | "en"): string {
  if (language === "th") return message;
  const errors: Record<string, string> = {
    "กรุณาเข้าสู่ระบบก่อนใช้งาน": "Please log in before continuing.",
    "อีเมลหรือรหัสผ่านไม่ถูกต้อง": "Incorrect email or password.",
    "Username นี้มีบัญชีใช้อยู่แล้ว": "This username is already in use.",
    "อีเมลหรือ Username นี้มีบัญชีอยู่แล้ว": "This email or username is already in use.",
    "Origin ไม่ได้รับอนุญาต": "This request origin is not allowed.",
    "รองรับเฉพาะไฟล์ MP3, WAV และ FLAC": "Only MP3, WAV, and FLAC files are supported.",
    "ไฟล์ว่างเปล่า": "The file is empty.",
    "ไฟล์นี้ไม่ใช่รูปภาพที่อ่านได้": "This image file could not be read.",
    "ไฟล์เสียงหมดอายุหรือถูกลบแล้ว จึงเปิดมิกเซอร์ไม่ได้": "The audio files have expired or were deleted, so the mixer is unavailable.",
  };
  return errors[message] ?? message;
}

function EngineBadge({ health }: { health: Health | "offline" | null }) {
  const { t } = useLanguage();
  if (health === null) return null;
  const text =
    health === "offline"
      ? t("ติดต่อ Backend ไม่ได้", "Backend unavailable")
      : health.separator === "mock"
        ? t("โหมดทดสอบ (ฟิลเตอร์ DSP ไม่ใช่ AI)", "Test mode (DSP filters, not AI)")
        : `AI model: ${health.model}`;
  return (
    <p className="flex items-center gap-2 text-xs text-neutral-400">
      <span
        aria-hidden="true"
        className={`inline-block size-1.5 rounded-full ${health === "offline" ? "border border-neutral-500" : "bg-white"}`}
      />
      {text}
    </p>
  );
}

export default function App() {
  const { t, language } = useLanguage();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [health, setHealth] = useState<Health | "offline" | null>(null);
  const [page, setPage] = useState<"home" | "how-it-works" | "studio" | "history" | "history-mixer" | "account" | "auth">(() => getPageFromPath());
  const [historyJobId, setHistoryJobId] = useState<string | null>(() => getHistoryJobIdFromPath());
  const [historyJob, setHistoryJob] = useState<JobInfo | null>(null);
  const [historyJobLoading, setHistoryJobLoading] = useState(false);
  const [historyJobError, setHistoryJobError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const run = useRef(0); // bumped on every new job / reset so stale async work stops itself
  const upload = useRef<AbortController | null>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth("offline"));
    getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    const syncPage = () => {
      setPage(getPageFromPath());
      setHistoryJobId(getHistoryJobIdFromPath());
    };
    window.addEventListener("popstate", syncPage);
    return () => window.removeEventListener("popstate", syncPage);
  }, []);

  const navigate = useCallback((destination: "home" | "how-it-works" | "studio" | "history" | "account" | "auth") => {
    const path =
      destination === "studio" ? "/studio"
        : destination === "how-it-works" ? "/how-it-works"
          : destination === "history" ? "/history"
          : destination === "account" ? "/account"
          : destination === "auth" ? "/login" : "/";
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setPage(destination);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openHistoryMixer = useCallback((jobId: string) => {
    window.history.pushState({}, "", `/history/${jobId}`);
    setHistoryJobId(jobId);
    setHistoryJob(null);
    setHistoryJobError(null);
    setPage("history-mixer");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (page !== "history-mixer" || !historyJobId) return;
    let cancelled = false;
    setHistoryJob(null);
    setHistoryJobError(null);
    setHistoryJobLoading(true);
    getStatus(historyJobId)
      .then((job) => {
        if (job.status !== "done" || job.stems.length === 0) {
          throw new Error(t("งานนี้ยังไม่พร้อมเปิด หรือไฟล์ผลลัพธ์หมดอายุแล้ว", "This job is not ready to open, or its output files have expired."));
        }
        if (!cancelled) setHistoryJob(job);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHistoryJobError(e instanceof Error ? e.message : t("เปิดมิกเซอร์ไม่สำเร็จ", "Could not open the mixer."));
      })
      .finally(() => {
        if (!cancelled) setHistoryJobLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyJobId, page, t]);

  useEffect(() => {
    if (page === "auth" && !authLoading && user) navigate("studio");
  }, [authLoading, navigate, page, user]);

  const reset = useCallback((error?: string) => {
    run.current++;
    upload.current?.abort();
    upload.current = null;
    setPhase({ name: "idle", error });
  }, []);

  const cancelCurrentJob = useCallback(async () => {
    if (phase.name === "processing") {
      try {
        await cancelJob(phase.jobId);
      } catch (e) {
        reset(e instanceof Error ? `${t("ยกเลิกงานไม่สำเร็จ", "Could not cancel the job")}: ${e.message}` : t("ยกเลิกงานไม่สำเร็จ", "Could not cancel the job"));
        return;
      }
    }
    reset();
  }, [phase, reset, t]);

  const handleFile = useCallback(async (file: File) => {
    const id = ++run.current;
    const alive = () => run.current === id;
    const controller = new AbortController();
    upload.current = controller;

    setPhase({ name: "uploading", file, uploadPercent: 0 });
    try {
      const { job_id } = await uploadFile(
        file,
        (uploadPercent) => {
          if (alive()) setPhase({ name: "uploading", file, uploadPercent });
        },
        controller.signal,
      );
      if (!alive()) return;

      setPhase({ name: "processing", file, jobId: job_id, status: "uploaded", aiPercent: 0, stage: t("กำลังส่งงานเข้าคิว", "Sending job to the queue") });
      await startProcessing(job_id);

      let failures = 0;
      while (alive()) {
        let job: JobInfo;
        try {
          job = await getStatus(job_id);
          failures = 0;
        } catch (e) {
          if (++failures >= MAX_POLL_FAILURES) throw e; // tolerate a few blips, then give up
          await sleep(POLL_MS);
          continue;
        }
        if (!alive()) return;

        if (job.status === "done") {
          setPhase({ name: "ready", jobId: job_id, filename: job.filename, stems: job.stems });
          return;
        }
        if (job.status === "failed") throw new Error(job.error ?? t("ประมวลผลไม่สำเร็จ", "Processing failed."));

        const stage = language === "en" ? translateStage(job.stage) : job.stage;
        setPhase({ name: "processing", file, jobId: job_id, status: job.status, aiPercent: job.progress, stage });
        await sleep(POLL_MS);
      }
    } catch (e) {
      if (!alive()) return;
      setPhase({ name: "idle", error: e instanceof Error ? translateError(e.message, language) : t("เกิดข้อผิดพลาดที่ไม่คาดคิด", "An unexpected error occurred.") });
    }
  }, [language, t]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
      setUser(null);
      setLogoutError(null);
      navigate("home");
    } catch (e) {
      setLogoutError(e instanceof Error ? translateError(e.message, language) : t("ออกจากระบบไม่สำเร็จ", "Could not log out."));
    }
  }, [language, navigate, t]);

  const handleAuthenticated = useCallback((authenticatedUser: User) => {
    setUser(authenticatedUser);
    navigate("studio");
  }, [navigate]);

  if (page === "home") {
    return (
      <HomePage
        user={user}
        error={logoutError}
        onStart={() => navigate(user ? "studio" : "auth")}
        onLogin={() => navigate("auth")}
        onLogout={handleLogout}
        onHowItWorks={() => navigate("how-it-works")}
        onHistory={() => navigate("history")}
        onAccount={() => navigate("account")}
      />
    );
  }

  if (page === "how-it-works") {
    return (
      <HowItWorksPage
        user={user}
        error={logoutError}
        onHome={() => navigate("home")}
        onLogin={() => navigate("auth")}
        onLogout={handleLogout}
        onStart={() => navigate(user ? "studio" : "auth")}
        onHistory={() => navigate("history")}
        onAccount={() => navigate("account")}
      />
    );
  }

  if (page === "auth" || ((page === "studio" || page === "history" || page === "history-mixer" || page === "account") && !authLoading && !user)) {
    return <AuthPage onAuthenticated={handleAuthenticated} onHome={() => navigate("home")} />;
  }

  if ((page === "studio" || page === "history" || page === "history-mixer" || page === "account") && authLoading) {
    return <main className="mx-auto min-h-screen max-w-5xl px-4 pt-20 text-sm text-neutral-400">{t("กำลังตรวจสอบบัญชี...", "Checking your account...")}</main>;
  }

  if (page === "history") {
    return (
      <HistoryPage
        onHome={() => navigate("home")}
        onStudio={() => navigate("studio")}
        onOpenMixer={openHistoryMixer}
        user={user}
        onLogout={handleLogout}
        onAccount={() => navigate("account")}
      />
    );
  }

  if (page === "account" && user) {
    return (
      <AccountPage
        user={user}
        error={logoutError}
        onHome={() => navigate("home")}
        onHistory={() => navigate("history")}
        onStudio={() => navigate("studio")}
        onLogout={handleLogout}
        onUserUpdated={setUser}
      />
    );
  }

  if (page === "history-mixer") {
    return (
      <div className="studio-shell mx-auto min-h-screen max-w-5xl px-4 pb-20 pt-8 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-900 pb-6">
          <button className="text-lg font-semibold tracking-tight text-white" onClick={() => navigate("home")}>
            Stemlab
          </button>
          <div className="flex items-center gap-5">
            <button className="text-sm text-neutral-400 transition hover:text-white" onClick={() => navigate("history")}>
              ← {t("ประวัติ STEM", "STEM history")}
            </button>
            {user && (
              <AccountMenu
                user={user}
                onAccount={() => navigate("account")}
                onHistory={() => navigate("history")}
                onLogout={handleLogout}
              />
            )}
            <button className="logout-button" onClick={handleLogout}>{t("ออกจากระบบ", "Log out")}</button>
            <EngineBadge health={health} />
          </div>
        </header>
        <main className="studio-main pt-12">
          {historyJobLoading && <p className="text-sm text-neutral-400" aria-live="polite">{t("กำลังโหลดแทร็กจากประวัติ...", "Loading tracks from history...")}</p>}
          {historyJobError && (
            <div role="alert" className="border-l-2 border-neutral-500 pl-4">
              <p className="text-neutral-200">{translateError(historyJobError, language)}</p>
              <button className="mt-5 text-sm text-neutral-400 transition hover:text-white" onClick={() => navigate("history")}>
                {t("กลับไปประวัติ STEM", "Back to STEM history")}
              </button>
            </div>
          )}
          {historyJob && (
            <Mixer
              key={historyJob.job_id}
              jobId={historyJob.job_id}
              filename={historyJob.filename}
              stems={historyJob.stems}
              onReset={() => navigate("history")}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="studio-shell mx-auto min-h-screen max-w-5xl px-4 pb-20 pt-8 sm:px-8">
      <header className="flex items-center justify-between border-b border-neutral-900 pb-6">
        <button className="text-lg font-semibold tracking-tight text-white" onClick={() => navigate("home")}>
          Stemlab
        </button>
        <div className="flex items-center gap-5">
          <button className="text-sm text-neutral-400 transition hover:text-white" onClick={() => navigate("how-it-works")}>
          {t("วิธีการทำงาน", "How it works")}
          </button>
          <button className="text-sm text-neutral-400 transition hover:text-white" onClick={() => navigate("home")}>
            {t("หน้าหลัก", "Home")}
          </button>
          {user && (
            <AccountMenu
              user={user}
              onAccount={() => navigate("account")}
              onHistory={() => navigate("history")}
              onLogout={handleLogout}
            />
          )}
          <button className="logout-button" onClick={handleLogout}>{t("ออกจากระบบ", "Log out")}</button>
          <EngineBadge health={health} />
        </div>
      </header>

      <main className="studio-main pt-12">
        {logoutError && <p className="mb-6 border-l-2 border-neutral-500 pl-3 text-sm text-neutral-300" role="alert">{translateError(logoutError, language)}</p>}
        {phase.name === "idle" && (
          <>
            <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
              {t("แยกเพลงออกเป็นแทร็ก", "Split a song into tracks")}
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-neutral-400">
              {t("อัปโหลดเพลง แล้ว AI จะแยกเสียงร้อง กลอง เบส และเครื่องดนตรีอื่นให้ จากนั้นเปิดหรือปิดแต่ละแทร็กและปรับความดังได้ทันที", "Upload a song and AI will separate vocals, drums, bass, and other instruments. Then mute, solo, and adjust each track instantly.")}
            </p>
            <div className="mt-10">
              <UploadZone onFile={handleFile} error={phase.error} />
            </div>
          </>
        )}

        {phase.name === "uploading" && (
          <ProcessingView
            fileName={phase.file.name}
            fileSize={phase.file.size}
            uploadPercent={phase.uploadPercent}
            status="uploading"
            aiPercent={0}
            stage=""
            onCancel={() => void cancelCurrentJob()}
          />
        )}

        {phase.name === "processing" && (
          <ProcessingView
            fileName={phase.file.name}
            fileSize={phase.file.size}
            uploadPercent={100}
            status={phase.status}
            aiPercent={phase.aiPercent}
            stage={phase.stage}
            onCancel={() => void cancelCurrentJob()}
          />
        )}

        {phase.name === "ready" && (
          <Mixer
            key={phase.jobId}
            jobId={phase.jobId}
            filename={phase.filename}
            stems={phase.stems}
            onReset={() => reset()}
          />
        )}
      </main>
    </div>
  );
}

function getPageFromPath(): "home" | "how-it-works" | "studio" | "history" | "history-mixer" | "account" | "auth" {
  if (/^\/history\/[0-9a-f]{32}$/.test(window.location.pathname)) return "history-mixer";
  if (window.location.pathname === "/studio") return "studio";
  if (window.location.pathname === "/how-it-works") return "how-it-works";
  if (window.location.pathname === "/history") return "history";
  if (window.location.pathname === "/account") return "account";
  if (window.location.pathname === "/login" || window.location.pathname === "/register") return "auth";
  return "home";
}

function getHistoryJobIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/history\/([0-9a-f]{32})$/);
  return match?.[1] ?? null;
}

function getUserInitials(user: User): string {
  return user.username.slice(0, 2).toUpperCase();
}

function AccountMenu({
  user,
  onAccount,
  onHistory,
  onLogout,
}: {
  user: User;
  onAccount: () => void;
  onHistory: () => void;
  onLogout: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="account-menu" ref={menuRef}>
      <button
        className="account-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((visible) => !visible)}
      >
        <span className="account-avatar-small" aria-hidden="true">{getUserInitials(user)}</span>
        <span className="max-w-32 truncate">{user.username}</span>
        <span className={`account-chevron ${open ? "open" : ""}`} aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="account-dropdown" role="menu">
          <div className="account-dropdown-heading">
            <span className="block truncate text-sm font-medium text-white">{user.username}</span>
            <span className="mt-1 block max-w-56 truncate text-xs text-neutral-500">{user.email}</span>
          </div>
          <button role="menuitem" type="button" onClick={() => choose(onAccount)}>{t("แดชบอร์ดส่วนตัว", "Personal dashboard")}</button>
          <button role="menuitem" type="button" onClick={() => choose(onHistory)}>{t("ประวัติการแยก STEM", "STEM history")}</button>
          <button className="account-dropdown-logout" role="menuitem" type="button" onClick={() => choose(onLogout)}>
            {t("ล็อกเอาต์", "Log out")}
          </button>
        </div>
      )}
    </div>
  );
}

function HomePage({
  user,
  error,
  onStart,
  onLogin,
  onLogout,
  onHowItWorks,
  onHistory,
  onAccount,
}: {
  user: User | null;
  error: string | null;
  onStart: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onHowItWorks: () => void;
  onHistory: () => void;
  onAccount: () => void;
}) {
  const { t } = useLanguage();
  const stems = [
    { name: t("เสียงร้อง", "Vocals"), color: "#cf9474", level: "72%" },
    { name: t("กลอง", "Drums"), color: "#cf9474", level: "88%" },
    { name: t("เบส", "Bass"), color: "#cf9474", level: "56%" },
    { name: t("ดนตรีอื่น ๆ", "Other"), color: "#cf9474", level: "66%" },
  ];

  return (
    <div className="landing-page min-h-screen overflow-hidden">
      <header className="landing-nav mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <a className="flex items-center gap-3 font-semibold tracking-tight text-white" href="/" aria-label={t("Stemlab หน้าหลัก", "Stemlab home")}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="text-xl">Stemlab</span>
        </a>
        <nav className="flex items-center gap-6 text-sm">
          <a className="hidden text-neutral-400 transition hover:text-white sm:inline" href="#features">{t("ความสามารถ", "Features")}</a>
          <button className="hidden text-neutral-400 transition hover:text-white sm:inline" onClick={onHowItWorks}>{t("วิธีการทำงาน", "How it works")}</button>
          {user ? (
            <>
              <AccountMenu user={user} onAccount={onAccount} onHistory={onHistory} onLogout={onLogout} />
              <button className="logout-button" onClick={onLogout}>{t("ออกจากระบบ", "Log out")}</button>
            </>
          ) : (
            <button className="text-neutral-400 transition hover:text-white" onClick={onLogin}>{t("เข้าสู่ระบบ", "Log in")}</button>
          )}
          <button className="button button-small" onClick={onStart}>{t("เริ่มต้นใช้งาน", "Get started")} <span aria-hidden="true">↗</span></button>
        </nav>
      </header>

      <main>
        {error && <p className="mx-auto mt-6 max-w-6xl border-l-2 border-neutral-500 px-5 pl-3 text-sm text-neutral-300 sm:px-8" role="alert">{error}</p>}
        <section className="hero-section relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-24 pt-14 sm:px-8 md:grid-cols-[1.05fr_0.95fr] md:pb-32 md:pt-24">
          <div className="hero-copy relative z-10">
            <p className="eyebrow"><span className="status-dot" /> {t("เครื่องมือแยกเสียงเพลงสำหรับทุกไอเดีย", "A music separation tool for every idea")}</p>
            <h1 className="mt-7 max-w-2xl text-5xl font-semibold leading-[1.1] tracking-tight text-white sm:text-6xl lg:text-7xl">
              {t("ฟังทุกเลเยอร์", "Hear every layer")}<br />
              <span className="text-accent">{t("ในแบบของคุณ", "your way")}</span>
            </h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-neutral-400 sm:text-lg">
              {t("แยกเสียงร้อง กลอง เบส และเครื่องดนตรีออกจากเพลง แล้วมิกซ์ ปรับเสียง และดาวน์โหลดแทร็กที่คุณต้องการ", "Separate vocals, drums, bass, and instruments from your music. Mix, adjust, and download the tracks you need.")}
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-5">
              <button className="button" onClick={onStart}>{t("เริ่มต้นการใช้งาน", "Start using Stemlab")} <span aria-hidden="true">↗</span></button>
              <button className="text-sm text-neutral-400 transition hover:text-white" onClick={onHowItWorks}>{t("อ่านวิธีทำงาน", "How it works")} <span aria-hidden="true">↗</span></button>
            </div>
            <p className="mt-6 text-xs text-neutral-500">{t("อัปโหลดเพลงของคุณ แล้วเริ่มแยกแทร็กได้ในไม่กี่ขั้นตอน", "Upload a song and separate its tracks in just a few steps.")}</p>
          </div>

          <div className="hero-art relative mx-auto w-full max-w-[510px]" aria-label={t("ตัวอย่างแทร็กเสียงที่แยกออกจากกัน", "Preview of separated audio tracks")}>
            <div className="art-glow" />
            <div className="audio-card relative">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div>
                  <p className="text-sm font-medium text-white">Midnight Session</p>
                  <p className="mt-1 text-xs text-neutral-500">{t("ตัวอย่างโปรเจกต์", "Project preview")}</p>
                </div>
                <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-neutral-400">4 stems</span>
              </div>
              <div className="waveform-preview" aria-hidden="true">
                {Array.from({ length: 64 }, (_, i) => (
                  <span key={i} style={{ height: `${18 + ((i * 37 + 19) % 68)}%` }} />
                ))}
              </div>
              <div className="flex items-center justify-between px-5 pb-4 text-[10px] tracking-wide text-neutral-500">
                <span>00:42</span><span>03:18</span>
              </div>
              <div className="space-y-2 px-4 pb-4">
                {stems.map((stem, index) => (
                  <div className="stem-preview-row" key={stem.name}>
                    <span className="stem-number">0{index + 1}</span>
                    <span className="stem-dot" style={{ backgroundColor: stem.color }} />
                    <span className="stem-name">{stem.name}</span>
                    <div className="stem-meter"><span style={{ width: stem.level, backgroundColor: stem.color }} /></div>
                    <span className="stem-toggle" aria-hidden="true">●</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-white/10 px-5 py-4">
                <span className="flex items-center gap-2 text-xs text-neutral-400"><span className="play-button">▶</span> {t("เล่นทุกแทร็ก", "Play all tracks")}</span>
                <span className="text-xs text-accent">{t("พร้อมมิกซ์", "Ready to mix")}</span>
              </div>
            </div>
            <div className="floating-note note-one">{t("เสียงร้อง", "Vocals")} <span>↗</span></div>
            <div className="floating-note note-two"><span className="status-dot" /> {t("แยกเสียงเรียบร้อย", "Tracks separated")}</div>
          </div>
        </section>

        <section id="features" className="feature-section border-y border-white/[0.08]">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 md:py-24">
            <div className="max-w-xl">
              <p className="eyebrow">{t("เครื่องมือที่ทำให้เพลงเป็นของคุณ", "Tools that make music yours")}</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{t("มากกว่าแค่แยกเสียง", "More than separation")}</h2>
              <p className="mt-4 leading-7 text-neutral-400">{t("ควบคุมแต่ละส่วนของเพลงได้อย่างอิสระ ตั้งแต่การฟังไปจนถึงการส่งออกไฟล์", "Control every part of a song, from listening to exporting.")}</p>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-3">
              <FeatureCard number="01" title={t("แยกเป็น 4 แทร็ก", "Four separate tracks")} description={t("แยกเสียงร้อง กลอง เบส และเครื่องดนตรีอื่น ๆ ออกจากเพลงต้นฉบับ", "Separate vocals, drums, bass, and other instruments from the original song.")} />
              <FeatureCard number="02" title={t("มิกซ์ได้ตามใจ", "Mix your way")} description={t("ปรับความดัง เปิดหรือปิดเสียงแต่ละแทร็ก แล้วฟังผลได้ทันที", "Adjust volume, mute or solo tracks, and hear the changes instantly.")} />
              <FeatureCard number="03" title={t("ดาวน์โหลดแทร็ก", "Download tracks")} description={t("ส่งออกไฟล์เสียงของแต่ละแทร็ก เพื่อนำไปสร้างสรรค์ต่อในแบบของคุณ", "Export individual audio tracks and continue creating your way.")} />
            </div>
          </div>
        </section>

        <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-20 sm:px-8 md:py-24">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div>
              <p className="eyebrow">{t("เริ่มได้ง่าย ๆ", "Easy to get started")}</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{t("สามขั้นตอนสู่ทุกเสียง", "Three steps to every sound")}</h2>
            </div>
            <button className="text-left text-sm text-accent transition hover:text-white" onClick={onHowItWorks}>{t("อ่านรายละเอียดการทำงาน", "Learn how it works")} <span aria-hidden="true">↗</span></button>
          </div>
          <div className="mt-12 grid gap-8 border-t border-white/10 pt-7 sm:grid-cols-3">
            <Step number="01" title={t("อัปโหลดเพลง", "Upload a song")} description={t("เลือกไฟล์เพลงที่ต้องการแยกจากอุปกรณ์ของคุณ", "Choose a song from your device to separate.")} />
            <Step number="02" title={t("รอระบบประมวลผล", "Let it process")} description={t("Stemlab จะแยกเสียงออกเป็นแทร็กที่ปรับแต่งได้", "Stemlab separates the audio into tracks you can adjust.")} />
            <Step number="03" title={t("ฟังและดาวน์โหลด", "Listen and download")} description={t("มิกซ์แทร็กตามต้องการ แล้วดาวน์โหลดไฟล์เสียง", "Mix the tracks as you like, then download the audio.")} />
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8 md:pb-28">
          <div className="cta-panel flex flex-col items-start justify-between gap-7 px-7 py-9 sm:px-10 md:flex-row md:items-center md:px-14 md:py-12">
            <div>
              <p className="eyebrow">{t("พร้อมเริ่มหรือยัง?", "Ready to get started?")}</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{t("เพลงเดิม ฟังได้อีกมุม", "Hear your music differently")}</h2>
            </div>
            <button className="button" onClick={onStart}>{t("ไปที่หน้าสตูดิโอ", "Open the studio")} <span aria-hidden="true">↗</span></button>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col gap-3 border-t border-white/[0.08] px-5 py-6 text-xs text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span className="font-medium text-neutral-300">Stemlab</span>
        <span>{t("แยกเสียงเพลง แล้วสร้างสรรค์ต่อในแบบของคุณ", "Separate your music and keep creating your way.")}</span>
      </footer>
    </div>
  );
}

function HowItWorksPage({
  user,
  error,
  onHome,
  onLogin,
  onLogout,
  onStart,
  onHistory,
  onAccount,
}: {
  user: User | null;
  error: string | null;
  onHome: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onStart: () => void;
  onHistory: () => void;
  onAccount: () => void;
}) {
  const { t } = useLanguage();
  const steps = [
    {
      number: "01",
      title: t("เลือกและอัปโหลดไฟล์", "Choose and upload a file"),
      description: t("เริ่มจากเลือกไฟล์เพลง MP3, WAV หรือ FLAC ขนาดไม่เกิน 50 MB ระบบตรวจสอบชนิดและข้อมูลเบื้องต้นของไฟล์ก่อนรับงาน", "Choose an MP3, WAV, or FLAC file up to 50 MB. The system checks its format and basic file data before accepting it."),
      detail: t("ไฟล์ต้นฉบับถูกส่งไปยัง Backend เพื่อเตรียมเป็นงานประมวลผล", "The original file is sent to the backend to prepare it for processing."),
    },
    {
      number: "02",
      title: t("ส่งงานเข้าคิว", "Queue the job"),
      description: t("เมื่ออัปโหลดสำเร็จ ระบบจะสร้างรหัสงานและส่งงานไปยังคิว เพื่อให้ตัวประมวลผลทำงานแยกจากหน้าที่คุณกำลังใช้อยู่", "After upload, the system creates a job ID and queues the work so processing can run independently from the page you are using."),
      detail: t("หน้าเว็บติดตามสถานะและความคืบหน้าของงานเป็นระยะ", "The page periodically checks the job status and progress."),
    },
    {
      number: "03",
      title: t("วิเคราะห์และแยกแหล่งเสียง", "Analyze and separate sound sources"),
      description: t("ตัวแยกเสียงประมวลผลเพลงทั้งมิกซ์ แล้วประมาณองค์ประกอบเสียงหลักออกมาเป็น 4 กลุ่ม ได้แก่ เสียงร้อง กลอง เบส และเสียงอื่น ๆ", "The separator analyzes the full mix and estimates four main groups: vocals, drums, bass, and other sounds."),
      detail: t("ผลลัพธ์เป็นแทร็กเสียงแยก ไม่ใช่การแยกเครื่องดนตรีทุกชิ้นอย่างสมบูรณ์", "The result is a set of separated audio tracks, not a perfect isolation of every instrument."),
    },
    {
      number: "04",
      title: t("ฟัง ปรับ และส่งออก", "Listen, adjust, and export"),
      description: t("เมื่อแยกเสร็จ แทร็กจะถูกโหลดเข้าหน้ามิกซ์ คุณสามารถเล่นพร้อมกันหรือเลือกฟังทีละแทร็ก ปรับระดับเสียง และปิดเสียงบางแทร็กได้", "Once separated, tracks load into the mixer. Play them together or individually, adjust volume, and mute tracks."),
      detail: t("ดาวน์โหลดเป็นไฟล์ WAV รายแทร็ก หรือรวมทุกแทร็กเป็นไฟล์ ZIP", "Download individual WAV files or all tracks together in a ZIP."),
    },
  ];

  return (
    <div className="landing-page info-page min-h-screen">
      <header className="landing-nav mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <button className="flex items-center gap-3 font-semibold tracking-tight text-white" onClick={onHome} aria-label={t("กลับหน้าหลัก", "Back to home")}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="text-xl">Stemlab</span>
        </button>
        <nav className="flex items-center gap-5 text-sm">
          <button className="text-neutral-400 transition hover:text-white" onClick={onHome}>{t("หน้าหลัก", "Home")}</button>
          {user ? (
            <>
              <AccountMenu user={user} onAccount={onAccount} onHistory={onHistory} onLogout={onLogout} />
              <button className="logout-button" onClick={onLogout}>{t("ออกจากระบบ", "Log out")}</button>
            </>
          ) : (
            <button className="text-neutral-400 transition hover:text-white" onClick={onLogin}>{t("เข้าสู่ระบบ", "Log in")}</button>
          )}
          <button className="button button-small" onClick={onStart}>{t("เริ่มต้นใช้งาน", "Get started")} <span aria-hidden="true">↗</span></button>
        </nav>
      </header>

      <main>
        {error && <p className="mx-auto mt-6 max-w-6xl border-l-2 border-neutral-500 px-5 pl-3 text-sm text-neutral-300 sm:px-8" role="alert">{error}</p>}
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-16 sm:px-8 md:pb-20 md:pt-24">
          <p className="eyebrow"><span className="status-dot" /> {t("เรียนรู้เบื้องหลังการแยกเสียง", "Learn how audio separation works")}</p>
          <h1 className="mt-6 max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl md:text-6xl">
            {t("How it works", "How it works")}<br />
            <span className="text-accent">{t("จากเพลงหนึ่งเพลง สู่สี่แทร็กเสียง", "From one song to four audio tracks")}</span>
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-8 text-neutral-400 sm:text-lg">
            {t("Stemlab ใช้กระบวนการประมวลผลเสียงเพื่อแยกองค์ประกอบหลักของเพลง ให้คุณเข้าใจขั้นตอนตั้งแต่เลือกไฟล์จนถึงนำผลลัพธ์ไปใช้งานต่อ", "Stemlab uses audio processing to separate a song's main components. Learn how the process works, from choosing a file to using the results.")}
          </p>
        </section>

        <section className="border-y border-white/[0.08]">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-20">
            <div className="max-w-2xl">
              <p className="eyebrow">{t("ลำดับการทำงาน", "The workflow")}</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{t("หนึ่งงาน มีสี่ช่วงสำคัญ", "Four key stages in every job")}</h2>
              <p className="mt-4 leading-7 text-neutral-400">
                {t("แต่ละช่วงเชื่อมต่อกันเป็นลำดับ คุณจึงติดตามได้ว่างานอยู่ตรงไหนและจะได้ผลลัพธ์แบบใด", "Each stage connects to the next, so you can track your job and understand what results to expect.")}
              </p>
            </div>
            <div className="mt-12 grid gap-0 md:grid-cols-2">
              {steps.map((step) => (
                <article className="info-step" key={step.number}>
                  <span className="info-step-number">{step.number}</span>
                  <div>
                    <h3 className="text-lg font-medium text-white">{step.title}</h3>
                    <p className="mt-3 text-sm leading-7 text-neutral-400">{step.description}</p>
                    <p className="info-step-detail mt-4 border-l pl-3 text-xs leading-6 text-neutral-500">{step.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-20">
          <p className="eyebrow">{t("เบื้องหลังระบบ", "Behind the system")}</p>
          <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">{t("ทำไมต้องแยกเสียงเป็นแทร็ก?", "Why separate audio into tracks?")}</h2>
          <div className="mt-8 grid gap-8 md:grid-cols-[1fr_0.85fr]">
            <div className="space-y-5 text-sm leading-7 text-neutral-400">
              <p>
                {t("เพลงที่เราได้ยินทั่วไปมักเป็นเสียงหลายแหล่งที่ผสมรวมกันแล้ว การแยกแหล่งเสียง หรือ audio source separation พยายามประมาณว่าองค์ประกอบใดน่าจะเป็นเสียงร้อง กลอง เบส หรือเสียงประกอบอื่น โดยอาศัยรูปแบบเสียงที่เรียนรู้จากข้อมูลเพลง", "Most music is a mix of many sound sources. Audio source separation estimates which components are likely vocals, drums, bass, or other sounds based on patterns learned from music data.")}
              </p>
              <p>
                {t("การได้แทร็กแยกช่วยให้ควบคุมการฟังได้ละเอียดขึ้น เช่น ลดเสียงร้องเพื่อฝึกเล่นดนตรี ฟังจังหวะกลองให้ชัดขึ้น ทดลองมิกซ์ใหม่ หรือใช้เป็นจุดเริ่มต้นสำหรับการเรียนรู้และทำงานด้านเสียง", "Separate tracks give you finer control: lower vocals to practice an instrument, focus on the drums, experiment with a new mix, or use the tracks as a starting point for learning and audio work.")}
              </p>
              <p>
                {t("สำหรับผู้เรียน นี่เป็นตัวอย่างที่จับต้องได้ของการประยุกต์ AI กับสัญญาณเสียง: ระบบรับเสียงผสมหนึ่งชุด แล้วสร้างผลลัพธ์หลายชุดที่เรานำมาเปรียบเทียบและสำรวจได้", "For learners, this is a practical example of applying AI to audio signals: one mixed input becomes several outputs that you can compare and explore.")}
              </p>
            </div>
            <aside className="learning-callout">
              <p className="text-sm font-medium text-white">{t("ทำไมผลลัพธ์จึงเป็น “การประมาณ”?", "Why are the results estimates?")}</p>
              <p className="mt-3 text-sm leading-7 text-neutral-400">
                {t("เครื่องดนตรีหลายชนิดอาจมีช่วงความถี่และจังหวะซ้อนกัน โมเดลจึงอาจแยกบางเสียงได้ไม่หมดหรือมีเสียงปน โดยเฉพาะเพลงที่มิกซ์หนาแน่น ผลลัพธ์ขึ้นอยู่กับไฟล์ต้นฉบับและรูปแบบเสียงในเพลง", "Different instruments can overlap in frequency and timing, so a model may not fully isolate every sound. This is especially true for dense mixes. Results depend on the source file and the sounds in the song.")}
              </p>
            </aside>
          </div>
        </section>

        <section className="border-y border-white/[0.08] bg-white/[0.015]">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-20">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <div>
                <p className="eyebrow">{t("ผลลัพธ์ที่นำไปใช้ต่อได้", "What you can do with the results")}</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{t("เปิดพื้นที่ให้ทดลองกับเพลง", "Explore your music")}</h2>
              </div>
              <p className="max-w-md text-sm leading-7 text-neutral-400">
                {t("ใช้แทร็กที่แยกแล้วเป็นเครื่องมือช่วยฟังและเรียนรู้ ทั้งนี้ควรเคารพลิขสิทธิ์และเงื่อนไขการใช้งานของเพลงต้นฉบับเสมอ", "Use separated tracks as a tool for listening and learning. Always respect the copyright and terms of use of the original music.")}
              </p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <InfoCard title={t("ฝึกฟังและฝึกเล่น", "Practice listening and playing")} description={t("โฟกัสเสียงร้อง จังหวะ หรือไลน์เบสทีละส่วน", "Focus on vocals, rhythm, or bass one part at a time.")} />
              <InfoCard title={t("ทดลองมิกซ์", "Experiment with mixing")} description={t("เปรียบเทียบสมดุลเสียงและสร้างแนวทางการมิกซ์ใหม่", "Compare the balance and try a new mix.")} />
              <InfoCard title={t("ทำความเข้าใจเพลง", "Understand the song")} description={t("สังเกตว่าองค์ประกอบต่าง ๆ ทำงานร่วมกันอย่างไร", "Explore how the different elements work together.")} />
              <InfoCard title={t("ต่อยอดงานเสียง", "Continue your audio work")} description={t("นำไฟล์ WAV ไปใช้ในเวิร์กโฟลว์เสียงที่เหมาะสม", "Use the WAV files in your preferred audio workflow.")} />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-20">
          <p className="eyebrow">{t("ข้อมูลที่ควรรู้", "What you should know")}</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white">{t("ข้อจำกัดและความโปร่งใส", "Limitations and transparency")}</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <InfoCard title={t("รองรับไฟล์เสียง", "Supported audio")} description={t("อัปโหลด MP3, WAV หรือ FLAC ขนาดไม่เกิน 50 MB ในการตั้งค่าปัจจุบัน", "Upload MP3, WAV, or FLAC files up to 50 MB with the current settings.")} />
            <InfoCard title={t("แทร็กที่ได้", "Output tracks")} description={t("ผลลัพธ์ประกอบด้วย vocals, drums, bass และ other ในรูปแบบเสียง WAV", "The output contains vocals, drums, bass, and other tracks in WAV format.")} />
            <InfoCard title={t("โหมดทดสอบ", "Test mode")} description={t("หากระบบแสดงโหมด mock จะใช้ฟิลเตอร์ DSP แบบพื้นฐาน ไม่ใช่โมเดล AI และผลแยกเป็นเพียงตัวอย่าง", "If mock mode is shown, basic DSP filters are used instead of an AI model, so the separation is only a demonstration.")} />
          </div>
          <div className="learning-callout mt-5">
            <p className="text-sm font-medium text-white">{t("ความเป็นส่วนตัวของไฟล์", "File privacy")}</p>
            <p className="mt-2 text-sm leading-7 text-neutral-400">
              {t("ไฟล์ที่อัปโหลดถูกจัดเก็บบนระบบเพื่อประมวลผล งานเก่าจะถูกล้างตามอายุที่กำหนดโดยระบบ (ค่าเริ่มต้น 6 ชั่วโมง) จึงควรดาวน์โหลดผลลัพธ์เก็บไว้หลังประมวลผลเสร็จ", "Uploaded files are stored for processing. Old jobs are cleaned up according to the system retention period (6 hours by default), so download your results when processing is complete.")}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8 md:pb-28">
          <div className="cta-panel flex flex-col items-start justify-between gap-7 px-7 py-9 sm:px-10 md:flex-row md:items-center md:px-14 md:py-12">
            <div>
              <p className="eyebrow">{t("พร้อมทดลองแล้วหรือยัง?", "Ready to try it?")}</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{t("เริ่มสำรวจเสียงในเพลงของคุณ", "Explore the sounds in your music")}</h2>
            </div>
            <button className="button" onClick={onStart}>{t("ไปที่หน้าสตูดิโอ", "Open the studio")} <span aria-hidden="true">↗</span></button>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col gap-3 border-t border-white/[0.08] px-5 py-6 text-xs text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span className="font-medium text-neutral-300">Stemlab</span>
        <button className="text-left transition hover:text-white" onClick={onHome}>{t("กลับหน้าหลัก", "Back to home")}</button>
      </footer>
    </div>
  );
}

function InfoCard({ title, description }: { title: string; description: string }) {
  return (
    <article className="feature-card">
      <h3 className="text-base font-medium text-white">{title}</h3>
      <p className="mt-3 text-sm leading-7 text-neutral-400">{description}</p>
    </article>
  );
}

function AccountPage({
  user,
  error,
  onHome,
  onHistory,
  onStudio,
  onLogout,
  onUserUpdated,
}: {
  user: User;
  error: string | null;
  onHome: () => void;
  onHistory: () => void;
  onStudio: () => void;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}) {
  const { t, language } = useLanguage();
  const [avatar, setAvatar] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [username, setUsername] = useState(user.username);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const avatarKey = `stemlab.avatar.${user.id}`;

  useEffect(() => {
    try {
      setAvatar(window.localStorage.getItem(avatarKey));
    } catch {
      setAvatarError(t("เบราว์เซอร์ไม่อนุญาตให้โหลดรูปโปรไฟล์ที่บันทึกไว้", "Your browser does not allow access to the saved profile photo."));
    }
  }, [avatarKey]);

  const saveAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setAvatarError(t("เลือกรูปภาพ JPG, PNG หรือ WebP", "Choose a JPG, PNG, or WebP image."));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError(t("รูปภาพต้องมีขนาดไม่เกิน 5 MB", "The image must be 5 MB or smaller."));
      return;
    }

    setAvatarError(null);
    setAvatarLoading(true);
    try {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("อ่านไฟล์รูปภาพไม่สำเร็จ", "Could not read the image file.")));
        reader.onerror = () => reject(new Error(t("อ่านไฟล์รูปภาพไม่สำเร็จ", "Could not read the image file.")));
        reader.readAsDataURL(file);
      });
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const loaded = new Image();
        loaded.onload = () => resolve(loaded);
        loaded.onerror = () => reject(new Error(t("ไฟล์นี้ไม่ใช่รูปภาพที่อ่านได้", "This image file could not be read.")));
        loaded.src = source;
      });
      const size = 256;
      const crop = Math.min(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error(t("ไม่สามารถประมวลผลรูปโปรไฟล์ได้", "Could not process the profile photo."));
      context.drawImage(
        image,
        (image.naturalWidth - crop) / 2,
        (image.naturalHeight - crop) / 2,
        crop,
        crop,
        0,
        0,
        size,
        size,
      );
      const resized = canvas.toDataURL("image/jpeg", 0.82);
      window.localStorage.setItem(avatarKey, resized);
      setAvatar(resized);
    } catch (e) {
      setAvatarError(e instanceof Error ? translateError(e.message, language) : t("บันทึกรูปโปรไฟล์ไม่สำเร็จ", "Could not save the profile photo."));
    } finally {
      setAvatarLoading(false);
    }
  };

  const removeAvatar = () => {
    try {
      window.localStorage.removeItem(avatarKey);
      setAvatar(null);
      setAvatarError(null);
    } catch {
      setAvatarError(t("ลบรูปโปรไฟล์ไม่สำเร็จ", "Could not remove the profile photo."));
    }
  };

  const saveUsername = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
      setUsernameError(t("Username ต้องมี 3-30 ตัว ใช้ได้เฉพาะ a-z, 0-9 และ _", "Username must be 3–30 characters and use only a-z, 0-9, and _."));
      return;
    }
    setUsernameSaving(true);
    setUsernameError(null);
    try {
      const updatedUser = await updateUsername(normalizedUsername);
      onUserUpdated(updatedUser);
      setUsername(updatedUser.username);
      setEditingUsername(false);
    } catch (e) {
      setUsernameError(e instanceof Error ? translateError(e.message, language) : t("แก้ไข Username ไม่สำเร็จ", "Could not update username."));
    } finally {
      setUsernameSaving(false);
    }
  };

  return (
    <div className="landing-page info-page min-h-screen">
      <header className="landing-nav mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <button className="flex items-center gap-3 font-semibold tracking-tight text-white" onClick={onHome} aria-label={t("กลับหน้าหลัก", "Back to home")}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="text-xl">Stemlab</span>
        </button>
        <nav className="flex items-center gap-3 sm:gap-5">
          <button className="text-sm text-neutral-400 transition hover:text-white" onClick={onHome}>
            {t("กลับหน้าหลัก", "Back to home")}
          </button>
          <AccountMenu user={user} onAccount={() => undefined} onHistory={onHistory} onLogout={onLogout} />
          <button className="logout-button" onClick={onLogout}>{t("ออกจากระบบ", "Log out")}</button>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8 md:py-16">
        {error && <p className="mb-6 border-l-2 border-neutral-500 pl-3 text-sm text-neutral-300" role="alert">{translateError(error, language)}</p>}
        <p className="eyebrow"><span className="status-dot" /> {t("หน้าแดชบอร์ดส่วนตัว", "Personal dashboard")}</p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl">{t("บัญชีของฉัน", "My account")}</h1>
        <p className="mt-3 text-sm leading-7 text-neutral-400">{t("จัดการข้อมูลโปรไฟล์และดูสถานะบัญชี Stemlab ของคุณ", "Manage your profile and view your Stemlab account status.")}</p>

        <section className="account-profile-card mt-10">
          <div className="account-profile-top">
            <div className="profile-avatar" aria-label={`รูปโปรไฟล์ ${user.username}`}>
              {avatar ? <img src={avatar} alt="" /> : <span>{getUserInitials(user)}</span>}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.16em] text-neutral-500">{t("โปรไฟล์", "Profile")}</p>
              <h2 className="mt-2 truncate text-xl font-medium text-white">{user.username}</h2>
              <p className="mt-1 truncate text-sm text-neutral-400">{user.email}</p>
              <span className="account-active-badge mt-3"><span /> {t("บัญชีใช้งานอยู่", "Active account")}</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className={`avatar-upload-button ${avatarLoading ? "disabled" : ""}`}>
                {avatarLoading ? t("กำลังบันทึก...", "Saving...") : t("เปลี่ยนรูป", "Change photo")}
                <input
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={avatarLoading}
                  onChange={saveAvatar}
                />
              </label>
              {avatar && <button className="account-secondary-button" type="button" onClick={removeAvatar}>{t("ลบรูป", "Remove photo")}</button>}
            </div>
          </div>
          {avatarError && <p className="auth-error mt-5" role="alert">{avatarError}</p>}
          <p className="mt-5 text-xs leading-6 text-neutral-500">{t("รูปโปรไฟล์นี้บันทึกไว้ในเบราว์เซอร์และอุปกรณ์นี้เท่านั้น ยังไม่ได้อัปโหลดไปยังเซิร์ฟเวอร์", "This profile photo is saved only in this browser and on this device. It is not uploaded to the server.")}</p>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <article className="account-detail-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.15em] text-neutral-500">Username</p>
              {!editingUsername && (
                <button
                  className="account-secondary-button"
                  type="button"
                  onClick={() => {
                    setUsername(user.username);
                    setUsernameError(null);
                    setEditingUsername(true);
                  }}
                >
                  {t("แก้ไข Username", "Edit username")}
                </button>
              )}
            </div>
            {editingUsername ? (
              <form className="mt-4" onSubmit={saveUsername}>
                <label className="auth-label" htmlFor="account-username">Username</label>
                <input
                  id="account-username"
                  className="auth-input"
                  type="text"
                  name="username"
                  autoComplete="username"
                  minLength={3}
                  maxLength={30}
                  pattern="[A-Za-z0-9_]{3,30}"
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={usernameSaving}
                />
                <p className="mt-2 text-xs text-neutral-500">{t("ใช้ตัวอักษรภาษาอังกฤษ ตัวเลข หรือ _ จำนวน 3-30 ตัว", "Use 3–30 English letters, numbers, or underscores (_).")}</p>
                {usernameError && <p className="auth-error mt-3" role="alert">{usernameError}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="button button-small" type="submit" disabled={usernameSaving}>
                    {usernameSaving ? t("กำลังบันทึก...", "Saving...") : t("บันทึก Username", "Save username")}
                  </button>
                  <button
                    className="account-secondary-button"
                    type="button"
                    onClick={() => {
                      setUsername(user.username);
                      setUsernameError(null);
                      setEditingUsername(false);
                    }}
                    disabled={usernameSaving}
                  >
                    {t("ยกเลิก", "Cancel")}
                  </button>
                </div>
              </form>
            ) : (
              <p className="mt-3 break-all text-base text-white">{user.username}</p>
            )}
          </article>
          <article className="account-detail-card">
            <p className="text-xs uppercase tracking-[0.15em] text-neutral-500">{t("อีเมลที่ผูกกับบัญชี", "Account email")}</p>
            <p className="mt-3 break-all text-base text-white">{user.email}</p>
          </article>
          <article className="account-detail-card">
            <p className="text-xs uppercase tracking-[0.15em] text-neutral-500">{t("สถานะบัญชี", "Account status")}</p>
            <p className="mt-3 flex items-center gap-2 text-base text-white"><span className="account-online-dot" /> {t("ใช้งานอยู่", "Active")}</p>
          </article>
          <article className="account-detail-card">
            <p className="text-xs uppercase tracking-[0.15em] text-neutral-500">{t("ความปลอดภัย", "Security")}</p>
            <p className="mt-3 text-sm leading-6 text-neutral-300">{t("เข้าสู่ระบบด้วยอีเมลหรือ Username และรหัสผ่าน", "Sign in with your email or username and password.")}</p>
          </article>
        </section>

        <section className="account-actions mt-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-medium text-white">{t("พื้นที่ทำงานของคุณ", "Your workspace")}</h2>
            <p className="mt-1 text-sm text-neutral-400">{t("กลับไปดูรายการ STEM ที่แยกไว้ หรือเริ่มประมวลผลเพลงใหม่", "Review your separated STEMs or start processing a new song.")}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="account-secondary-button" onClick={onHistory}>{t("ประวัติการแยก STEM", "STEM history")}</button>
            <button className="button button-small" onClick={onStudio}>{t("แยกเพลงใหม่", "Separate a new song")} <span aria-hidden="true">↗</span></button>
          </div>
        </section>
      </main>
    </div>
  );
}

function HistoryPage({
  user,
  onHome,
  onStudio,
  onOpenMixer,
  onAccount,
  onLogout,
}: {
  user: User | null;
  onHome: () => void;
  onStudio: () => void;
  onOpenMixer: (jobId: string) => void;
  onAccount: () => void;
  onLogout: () => void;
}) {
  const { t, language } = useLanguage();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHistory()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? translateError(e.message, language) : t("โหลดประวัติไม่สำเร็จ", "Could not load history.")));
  }, [language, t]);

  const dateTime = (timestamp: number) => new Date(timestamp * 1000).toISOString();
  const displayDateTime = (timestamp: number) =>
    new Intl.DateTimeFormat(language === "th" ? "th-TH" : "en-GB", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Asia/Bangkok",
    }).format(new Date(timestamp * 1000));
  const stemLabels: Record<string, string> = {
    vocals: t("เสียงร้อง", "Vocals"),
    drums: t("กลอง", "Drums"),
    bass: t("เบส", "Bass"),
    other: t("เสียงอื่น ๆ", "Other"),
  };

  return (
    <div className="landing-page info-page min-h-screen">
      <header className="landing-nav mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <button className="flex items-center gap-3 font-semibold tracking-tight text-white" onClick={onHome} aria-label={t("กลับหน้าหลัก", "Back to home")}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="text-xl">Stemlab</span>
        </button>
        <nav className="flex items-center gap-5 text-sm">
          <button className="text-neutral-400 transition hover:text-white" onClick={onHome}>{t("หน้าหลัก", "Home")}</button>
          {user && <AccountMenu user={user} onAccount={onAccount} onHistory={() => undefined} onLogout={onLogout} />}
          {user && <button className="logout-button" onClick={onLogout}>{t("ออกจากระบบ", "Log out")}</button>}
          <button className="button button-small" onClick={onStudio}>{t("แยกเพลงใหม่", "Separate a new song")} <span aria-hidden="true">↗</span></button>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-14 sm:px-8 md:py-20">
        <p className="eyebrow"><span className="status-dot" /> {t("พื้นที่ส่วนตัวของคุณ", "Your personal space")}</p>
        <div className="mt-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">{t("ประวัติการแยก STEM", "STEM history")}</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-neutral-400">
              {t("รายการเพลงที่คุณส่งประมวลผล พร้อมวันและเวลาที่การแยก STEM สำเร็จ", "Songs you have processed, with the date and time each STEM separation completed.")}
            </p>
          </div>
          {items && <span className="text-xs text-neutral-500">{language === "th" ? `${items.length} รายการล่าสุด` : `${items.length} recent ${items.length === 1 ? "item" : "items"}`}</span>}
        </div>

        {error && <p className="mt-8 border-l-2 border-neutral-500 pl-3 text-sm text-neutral-300" role="alert">{error}</p>}
        {items === null && !error && <p className="mt-10 text-sm text-neutral-400" aria-live="polite">{t("กำลังโหลดประวัติ...", "Loading history...")}</p>}
        {items?.length === 0 && (
          <div className="history-empty mt-10">
            <p className="text-base font-medium text-white">{t("ยังไม่มีประวัติการแยกเสียง", "No separation history yet")}</p>
            <p className="mt-2 text-sm leading-6 text-neutral-400">{t("เมื่อคุณประมวลผลเพลงแล้ว รายการและเวลาที่สำเร็จจะแสดงที่หน้านี้", "After you process a song, its status and completion time will appear here.")}</p>
            <button className="button button-small mt-6" onClick={onStudio}>{t("เริ่มแยกเพลง", "Start separating")} <span aria-hidden="true">↗</span></button>
          </div>
        )}
        {items && items.length > 0 && (
          <div className="mt-10 divide-y divide-white/[0.08] border-y border-white/[0.08]">
            {items.map((item) => (
              <article className="history-row" key={item.job_id}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="break-all text-base font-medium text-white">{item.filename}</h2>
                    <span className={`history-status ${item.status === "done" ? "complete" : ""}`}>
                      {item.status === "done" ? t("สำเร็จ", "Complete") : item.status === "failed" ? t("ไม่สำเร็จ", "Failed") : t("กำลังดำเนินการ", "In progress")}
                    </span>
                  </div>
                  {item.status === "done" && item.completed_at !== null ? (
                    <time className="mt-2 block text-sm text-neutral-400" dateTime={dateTime(item.completed_at)}>
                      {t("สำเร็จเมื่อ", "Completed")} {displayDateTime(item.completed_at)}
                    </time>
                  ) : (
                    <p className="mt-2 text-sm text-neutral-500">
                      {item.status === "failed" ? t("งานนี้ประมวลผลไม่สำเร็จ", "This job did not complete successfully.") : t("ยังไม่มีเวลาสำเร็จ", "No completion time available.")}
                    </p>
                  )}
                  {item.stems.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {item.stems.map((stem) => (
                        <span className="history-stem" key={stem}>{stemLabels[stem] ?? stem}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-5">
                    {item.available ? (
                      <button
                        className="history-open-button"
                        onClick={() => onOpenMixer(item.job_id)}
                        type="button"
                      >
                        {t("เปิดมิกเซอร์", "Open mixer")} <span aria-hidden="true">↗</span>
                      </button>
                    ) : item.status === "done" ? (
                      <p className="text-xs text-neutral-500">{t("ไฟล์เสียงหมดอายุหรือถูกลบแล้ว จึงเปิดมิกเซอร์ไม่ได้", "The audio files have expired or were deleted, so the mixer is unavailable.")}</p>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="mt-6 text-xs leading-6 text-neutral-500">
          {t("ประวัติรายการเก็บไว้ในบัญชีของคุณ ส่วนไฟล์เสียงผลลัพธ์อาจถูกลบอัตโนมัติตามระยะเวลาจัดเก็บของระบบ", "History is saved to your account. Audio files may be deleted automatically according to the system's retention period.")}
        </p>
      </main>
    </div>
  );
}

function AuthPage({ onAuthenticated, onHome }: { onAuthenticated: (user: User) => void; onHome: () => void }) {
  const { t, language } = useLanguage();
  const [mode, setMode] = useState<"login" | "register">(
    window.location.pathname === "/register" ? "register" : "login",
  );
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (mode === "register") {
      if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) {
        setError(t("รหัสผ่านต้องมีตัวอักษรและตัวเลขอย่างน้อยอย่างละ 1 ตัว", "Password must contain at least one letter and one number."));
        return;
      }
    }
    setSubmitting(true);
    try {
      const user = mode === "register"
        ? await register(email, username, password)
        : await login(email, password);
      onAuthenticated(user);
    } catch (e) {
      setError(e instanceof Error ? translateError(e.message, language) : t("ไม่สามารถดำเนินการได้ กรุณาลองใหม่", "Could not complete the request. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="landing-page auth-page flex min-h-screen flex-col">
      <header className="landing-nav mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <button className="flex items-center gap-3 font-semibold tracking-tight text-white" onClick={onHome} aria-label={t("กลับหน้าหลัก", "Back to home")}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="text-xl">Stemlab</span>
        </button>
        <button className="text-sm text-neutral-400 transition hover:text-white" onClick={onHome}>{t("กลับหน้าหลัก", "Back to home")}</button>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-12">
        <section className="auth-card w-full max-w-md">
          <p className="eyebrow"><span className="status-dot" /> {t("บัญชี Stemlab", "Stemlab account")}</p>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white">
            {mode === "login" ? t("ยินดีต้อนรับกลับ", "Welcome back") : t("สร้างบัญชีใหม่", "Create an account")}
          </h1>
          <p className="mt-3 text-sm leading-6 text-neutral-400">
            {mode === "login" ? t("เข้าสู่ระบบเพื่อเริ่มแยกและจัดการงานเพลงของคุณ", "Log in to separate and manage your music.") : t("สมัครสมาชิกเพื่อเริ่มใช้งานสตูดิโอ", "Create an account to start using the studio.")}
          </p>

          <div className="auth-tabs mt-7 grid grid-cols-2">
            <button
              className={`auth-tab ${mode === "login" ? "active" : ""}`}
              type="button"
              onClick={() => { setMode("login"); setError(null); }}
              aria-pressed={mode === "login"}
            >
              {t("เข้าสู่ระบบ", "Log in")}
            </button>
            <button
              className={`auth-tab ${mode === "register" ? "active" : ""}`}
              type="button"
              onClick={() => { setMode("register"); setError(null); }}
              aria-pressed={mode === "register"}
            >
              {t("สมัครสมาชิก", "Sign up")}
            </button>
          </div>

          <form className="mt-6 space-y-5" onSubmit={submit}>
            {mode === "register" ? (
              <>
                <label className="auth-label">
                  Username
                  <input
                    className="auth-input"
                    type="text"
                    name="username"
                    autoComplete="username"
                    minLength={3}
                    maxLength={30}
                    pattern="[A-Za-z0-9_]{3,30}"
                    title={t("ใช้ตัวอักษรภาษาอังกฤษ ตัวเลข หรือ _ จำนวน 3-30 ตัว", "Use 3–30 English letters, numbers, or underscores (_).")}
                    required
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                  <span className="mt-2 block text-xs font-normal text-neutral-500">
                    {t("ใช้ตัวอักษรภาษาอังกฤษ ตัวเลข หรือ _ จำนวน 3-30 ตัว", "Use 3–30 English letters, numbers, or underscores (_).")}
                  </span>
                </label>
                <label className="auth-label">
                  {t("อีเมล", "Email")}
                  <input
                    className="auth-input"
                    type="email"
                    name="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="auth-label">
                {t("อีเมล / Username", "Email / Username")}
                <input
                  className="auth-input"
                  type="text"
                  name="identifier"
                  autoComplete="username"
                  maxLength={254}
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            )}
            <div className="auth-label">
              {t("รหัสผ่าน", "Password")}
              <div className="auth-password-field">
                <input
                  className="auth-input"
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  minLength={10}
                  maxLength={128}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  className="auth-password-toggle"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? t("ซ่อนรหัสผ่าน", "Hide password") : t("แสดงรหัสผ่าน", "Show password")}
                  aria-pressed={showPassword}
                >
                  {showPassword ? t("ซ่อน", "Hide") : t("แสดง", "Show")}
                </button>
              </div>
              {mode === "register" && (
                <span className="mt-2 block text-xs font-normal leading-6 text-neutral-500">
                  {t("อย่างน้อย 10 ตัวอักษร และต้องมีตัวอักษรกับตัวเลขอย่างละ 1 ตัวขึ้นไป", "At least 10 characters, including at least one letter and one number.")}
                </span>
              )}
            </div>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="button w-full" type="submit" disabled={submitting}>
              {submitting ? t("กำลังดำเนินการ...", "Please wait...") : mode === "login" ? t("เข้าสู่ระบบ", "Log in") : t("สร้างบัญชี", "Create account")}
              {!submitting && <span aria-hidden="true">↗</span>}
            </button>
          </form>
          <p className="mt-6 text-center text-xs leading-6 text-neutral-500">
            {t("เซสชันจะถูกจัดเก็บในคุกกี้ที่ JavaScript อ่านไม่ได้ และหมดอายุภายใน 7 วัน", "Your session is stored in an HttpOnly cookie and expires after 7 days.")}
          </p>
        </section>
      </main>
    </div>
  );
}

function FeatureCard({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <article className="feature-card">
      <span className="text-xs tracking-[0.18em] text-accent">{number}</span>
      <h3 className="mt-8 text-lg font-medium text-white">{title}</h3>
      <p className="mt-3 text-sm leading-7 text-neutral-400">{description}</p>
      <span className="feature-arrow" aria-hidden="true">↗</span>
    </article>
  );
}

function Step({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <article>
      <p className="text-sm tracking-[0.18em] text-neutral-500">{number}</p>
      <h3 className="mt-5 text-lg font-medium text-white">{title}</h3>
      <p className="mt-2 max-w-xs text-sm leading-7 text-neutral-400">{description}</p>
    </article>
  );
}
