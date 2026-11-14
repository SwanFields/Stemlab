import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLanguage } from "./Language";

interface Props {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Red styling for destructive actions. */
  danger?: boolean;
  /**
   * When given, one phrase is picked at random each time the dialog opens and the
   * person must type it exactly before the confirm button unlocks.
   */
  phrases?: readonly string[];
  /** Extra form fields (e.g. current password) rendered above the phrase box. */
  children?: ReactNode;
  /** Extra validity rule from the parent, e.g. "password field is not empty". */
  canConfirm?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal used before every account change. Mount it only while it is open:
 * the random phrase is chosen on mount, so each opening asks for a fresh one.
 */
export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  phrases,
  children,
  canConfirm = true,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useLanguage();
  const [phrase] = useState(() =>
    phrases && phrases.length > 0 ? phrases[Math.floor(Math.random() * phrases.length)] : null,
  );
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const phraseInputRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const matches = phrase === null || typed.trim() === phrase;
  const ready = matches && canConfirm && !busy;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Start on the safe button; a stray Enter must never confirm.
    cancelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onConfirm();
  };

  return (
    <div className="confirm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && !danger) onCancel(); }}>
      <div
        ref={dialogRef}
        className={`confirm-dialog ${danger ? "confirm-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <form onSubmit={submit}>
          <p className="confirm-eyebrow">{danger ? t("การกระทำที่ย้อนกลับไม่ได้", "This can't be undone") : t("โปรดยืนยันอีกครั้ง", "Please confirm")}</p>
          <h2 id={titleId} className="confirm-title">{title}</h2>
          <div id={descId} className="confirm-text">{description}</div>

          {children && <div className="mt-5">{children}</div>}

          {phrase !== null && (
            <div className="mt-5">
              <p className="confirm-text">
                {t("พิมพ์ข้อความด้านล่างนี้ให้ตรงเพื่อยืนยัน", "Type the phrase below exactly to confirm")}
              </p>
              <p className="confirm-phrase" aria-label={phrase}>{phrase}</p>
              <input
                ref={phraseInputRef}
                className="auth-input mt-3"
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onPaste={(e) => e.preventDefault()}
                onDrop={(e) => e.preventDefault()}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                aria-label={t("พิมพ์ข้อความยืนยัน", "Type the confirmation phrase")}
                aria-invalid={typed.length > 0 && !matches}
                placeholder={phrase}
              />
            </div>
          )}

          {error && <p className="auth-error mt-4" role="alert">{error}</p>}

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button ref={cancelRef} type="button" className="account-secondary-button" onClick={onCancel} disabled={busy}>
              {t("ยกเลิก", "Cancel")}
            </button>
            <button type="submit" className={`confirm-submit ${danger ? "danger" : ""}`} disabled={!ready}>
              {busy ? t("กำลังดำเนินการ...", "Working...") : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const CHANGE_PASSWORD_PHRASES = ["Change my password", "Reset my password", "Update my password"] as const;
export const DELETE_ACCOUNT_PHRASES = ["Delete my account", "Remove my account", "Erase my account"] as const;
