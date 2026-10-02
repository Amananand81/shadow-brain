"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, KeyRound, Loader2, Lock, ShieldCheck } from "lucide-react";
import { Logo } from "./Logo";
import { isPasswordValid, setSession } from "@/app/lib/auth";
import { resetPassword, verifyEmail } from "@/app/lib/api";

interface AuthActionScreenProps {
  mode: "verify" | "reset";
  token: string;
}

export function AuthActionScreen({ mode, token }: AuthActionScreenProps) {
  const started = useRef(false);
  const [loading, setLoading] = useState(mode === "verify" && Boolean(token));
  const [error, setError] = useState<string | null>(mode === "verify" && !token ? "This verification link is invalid or expired." : null);
  const [message, setMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showForm, setShowForm] = useState(mode === "reset");

  useEffect(() => {
    if (mode !== "verify" || started.current) return;
    started.current = true;
    if (!token) return;

    verifyEmail(token).then((session) => {
      setSession(session.user.email, session.token);
      setMessage("Email verified. Signing you in…");
      window.location.replace("/");
    }).catch((verificationError: unknown) => {
      setError(verificationError instanceof Error ? verificationError.message : "Unable to verify this email.");
    }).finally(() => setLoading(false));
  }, [mode, token]);

  async function handleReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!isPasswordValid(password)) {
      setError("Password must be 8+ characters with a letter, a number, and a symbol.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const result = await resetPassword(token, password, confirmPassword);
      setMessage(result.message);
      setShowForm(false);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Unable to reset your password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4" style={{ background: "var(--bg-deep)" }}>
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(circle at 18% 20%, rgba(34,211,238,0.10), transparent 38%), radial-gradient(circle at 82% 78%, rgba(236,72,153,0.09), transparent 40%)" }} />
      <section className="relative w-full max-w-[420px] rounded-xl p-7" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-subtle)" }}>
        <div className="mb-7 flex justify-center"><Logo /></div>
        <div className="mb-5 flex items-center gap-2">
          {mode === "verify" ? <ShieldCheck size={18} style={{ color: "var(--blue)" }} /> : <KeyRound size={18} style={{ color: "var(--blue)" }} />}
          <h1 className="text-[16px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {mode === "verify" ? "Verify your email" : "Choose a new password"}
          </h1>
        </div>

        {loading && <p role="status" className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}><Loader2 size={15} className="animate-spin" />{mode === "verify" ? "Verifying your email…" : "Updating password…"}</p>}
        {!loading && error && <p role="alert" className="text-[12.5px]" style={{ color: "#f87171" }}>{error}</p>}
        {!loading && message && <p role="status" className="flex items-center gap-2 text-[12.5px]" style={{ color: "#34d399" }}><Check size={15} />{message}</p>}

        {mode === "reset" && showForm && (
          <form onSubmit={handleReset} className="mt-4 flex flex-col gap-3">
            <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }} htmlFor="new-password">New password</label>
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}>
              <Lock size={15} style={{ color: "var(--text-muted)" }} />
              <input id="new-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="w-full bg-transparent text-[13px] outline-none" style={{ color: "var(--text-primary)" }} />
            </div>
            <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }} htmlFor="confirm-password">Confirm password</label>
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}>
              <Lock size={15} style={{ color: "var(--text-muted)" }} />
              <input id="confirm-password" type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="w-full bg-transparent text-[13px] outline-none" style={{ color: "var(--text-primary)" }} />
            </div>
            <button type="submit" disabled={loading} className="mt-1 rounded-lg py-2.5 text-[13px] font-semibold" style={{ background: "var(--accent-gradient)", color: "white" }}>Reset password</button>
          </form>
        )}

        {!loading && !showForm && mode === "reset" && message && (
          <Link className="mt-5 inline-block text-[12px] font-medium" style={{ color: "var(--blue)" }} href="/">Return to sign in</Link>
        )}
      </section>
    </main>
  );
}
