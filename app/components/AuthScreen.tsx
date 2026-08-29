"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mail, Lock, Eye, EyeOff, AlertCircle, Check,
  Loader2, KeyRound, ShieldCheck, MessageSquareWarning, ArrowLeft,
} from "lucide-react";
import { useSignUp, useSignIn, useAuth } from "@clerk/nextjs";
import { Logo } from "./Logo";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { isEmailValid, checkPassword } from "@/app/lib/auth";
import { clerkLogin, googleLogin } from "@/app/lib/api";

interface AuthScreenProps {
  onAuthenticated: (email: string) => void;
}

type Mode = "login" | "signup" | "forgot";
type SignupStage = "email" | "otp" | "password";

function RuleRow({ met, label }: { met: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: met ? "#34d399" : "var(--text-muted)" }}>
      <span
        className="flex items-center justify-center w-3.5 h-3.5 rounded-full flex-shrink-0"
        style={{
          background: met ? "rgba(52,211,153,0.15)" : "transparent",
          border: `1px solid ${met ? "#34d399" : "var(--text-muted)"}`,
        }}
      >
        {met && <Check size={9} />}
      </span>
      {label}
    </div>
  );
}

function InputRow({
  icon: Icon,
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
  required = true,
  rightEl,
  invalid,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; className?: string }>;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete?: string;
  required?: boolean;
  rightEl?: React.ReactNode;
  invalid?: boolean;
}) {
  return (
    <div>
      <label className="text-[11px] font-medium mb-1.5 block" style={{ color: "var(--text-secondary)" }}>
        {label}
      </label>
      <div
        className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
        style={{
          background: "var(--bg-surface)",
          border: `1px solid ${invalid ? "rgba(239,68,68,0.5)" : "var(--border-subtle)"}`,
        }}
      >
        <Icon size={15} style={{ color: "var(--text-muted)" }} />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          className="flex-1 bg-transparent outline-none text-[13px]"
          style={{ color: "var(--text-primary)" }}
        />
        {rightEl}
      </div>
    </div>
  );
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const { signUp } = useSignUp();
  const { signIn } = useSignIn();
  const { getToken } = useAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Sign-up multi-step stage + status text
  const [signupStage, setSignupStage] = useState<SignupStage>("email");
  const [otpStatus, setOtpStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [signupStatus, setSignupStatus] = useState<string | null>(null);

  // Forgot-password flow
  const [sendResetEmail, setSendResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetStep, setResetStep] = useState<"request" | "code" | "newPassword">("request");
  const [resetEmailUsed, setResetEmailUsed] = useState("");

  const rules = checkPassword(password);
  const newRules = checkPassword(newPassword);
  const emailLooksValid = email.length === 0 || isEmailValid(email);

  // ── Google sign-in (unchanged) ─────────────────────────────────────────────
  async function handleGoogleCredential(credential: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await googleLogin(credential);
      if (res.token) {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("shadowbrain_token", res.token);
        }
      }
      onAuthenticated(res.user.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Exchange the active Clerk session for a Brain Shadow JWT ───────────────
  async function finalizeSession(expectedEmail: string) {
    const token = (await getToken()) as string;
    if (!token) throw new Error("Could not obtain a session token. Please try again.");
    const res = await clerkLogin(token);
    onAuthenticated(res.user.email || expectedEmail);
  }

  // ── Login (email + password, no OTP) ──────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signIn) {
      setError("Sign-in is not ready yet. Please try again.");
      return;
    }
    setLoading(true);
    try {
      const res = await signIn.password({ emailAddress: email.trim(), password });
      if (res.error) {
        setError(res.error.message || "Invalid email or password.");
        return;
      }
      if (signIn.status === "complete" && signIn.createdSessionId) {
        await signIn.finalize();
        await finalizeSession(email);
      } else {
        setError("Sign-in could not be completed. Please try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Sign-up step 1: email → send OTP ──────────────────────────────────────
  async function handleSignupEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signUp) {
      setError("Sign-up is not ready yet. Please try again.");
      return;
    }
    if (!isEmailValid(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    setOtpStatus("sending");
    try {
      const createRes = await signUp.create({ emailAddress: email.trim().toLowerCase() });
      if (createRes.error) {
        setOtpStatus("error");
        setError(createRes.error.message || "Could not start sign-up.");
        return;
      }
      const sendRes = await signUp.verifications.sendEmailCode();
      if (sendRes.error) {
        setOtpStatus("error");
        setError(sendRes.error.message || "Could not send the verification code.");
        return;
      }
      setOtpStatus("sent");
      setSignupStage("otp");
      setSignupStatus("OTP sent to your email");
    } catch (err) {
      setOtpStatus("error");
      setError(err instanceof Error ? err.message : "Could not send the verification code.");
    } finally {
      setLoading(false);
    }
  }

  // ── Sign-up step 2: verify OTP ────────────────────────────────────────────
  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signUp) return;
    setLoading(true);
    try {
      const verifyRes = await signUp.verifications.verifyEmailCode({ code: otp.trim() });
      if (verifyRes.error) {
        setError(verifyRes.error.message || "Invalid or expired code. Please try again.");
        return;
      }
      const emailVerified = signUp.verifications?.emailAddress?.status === "verified";
      if (!emailVerified) {
        setError("Email could not be verified. Please check the code.");
        return;
      }
      setSignupStatus("Email verified");
      setSignupStage("password");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code.");
    } finally {
      setLoading(false);
    }
  }

  // ── Sign-up step 3: password + confirm → create account ───────────────────
  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!signUp) return;
    setLoading(true);
    setSignupStatus("Creating account...");
    try {
      const pwRes = await signUp.password({ emailAddress: email.trim().toLowerCase(), password });
      if (pwRes.error) {
        setSignupStatus(null);
        setError(pwRes.error.message || "Password could not be set.");
        return;
      }
      if (signUp.status !== "complete" || !signUp.createdSessionId) {
        setSignupStatus(null);
        setError("Account could not be finalized. Please try again.");
        return;
      }
      await signUp.finalize();
      setSignupStatus("Account created");
      await finalizeSession(email);
    } catch (err) {
      setSignupStatus(null);
      setError(err instanceof Error ? err.message : "Could not create your account.");
    } finally {
      setLoading(false);
    }
  }

  // ── Resend sign-up OTP ────────────────────────────────────────────────────
  async function handleResendOtp() {
    setError(null);
    if (!signUp) return;
    setLoading(true);
    setOtpStatus("sending");
    try {
      const res = await signUp.verifications.sendEmailCode();
      if (res.error) {
        setOtpStatus("error");
        setError(res.error.message || "Could not resend the code.");
        return;
      }
      setOtpStatus("sent");
    } catch (err) {
      setOtpStatus("error");
      setError(err instanceof Error ? err.message : "Could not resend the code.");
    } finally {
      setLoading(false);
    }
  }

  // ── Forgot password: send reset code ─────────────────────────────────────
  async function handleForgotRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signIn) return;
    setLoading(true);
    try {
      const createRes = await signIn.create({ identifier: sendResetEmail.trim() });
      if (createRes.error) {
        setError(createRes.error.message || "Could not start password reset.");
        return;
      }
      const sendRes = await signIn.resetPasswordEmailCode.sendCode();
      if (sendRes.error) {
        setError(sendRes.error.message || "Could not send the reset code.");
        return;
      }
      setResetEmailUsed(sendResetEmail.trim());
      setResetStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset code.");
    } finally {
      setLoading(false);
    }
  }

  // ── Forgot password: verify code + set new password ──────────────────────
  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmNewPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!signIn) return;
    setLoading(true);
    try {
      if (resetStep === "code") {
        const verifyRes = await signIn.resetPasswordEmailCode.verifyCode({ code: resetCode.trim() });
        if (verifyRes.error) {
          setError(verifyRes.error.message || "Invalid or expired reset code.");
          return;
        }
        if (signIn.status !== "needs_new_password") {
          setError("The reset code could not be verified. Please try again.");
          return;
        }
        setResetStep("newPassword");
        return;
      }
      const submitRes = await signIn.resetPasswordEmailCode.submitPassword({ password: newPassword });
      if (submitRes.error) {
        setError(submitRes.error.message || "Could not reset your password.");
        return;
      }
      if (signIn.status === "complete") {
        await signIn.finalize();
        await finalizeSession(resetEmailUsed);
      } else {
        setError("Password reset could not be completed. Please try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset your password.");
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirmPassword("");
    setOtp("");
    setOtpStatus("idle");
    setSignupStage("email");
    setSignupStatus(null);
    setResetCode("");
    setNewPassword("");
    setConfirmNewPassword("");
    setResetStep("request");
    setSendResetEmail(email || "");
  }

  const eyeBtn = (show: boolean, toggle: () => void) => (
    <button type="button" onClick={toggle} style={{ color: "var(--text-muted)" }}>
      {show ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div
      className="flex items-center justify-center min-h-screen w-full px-4"
      style={{ background: "var(--bg-deep)" }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 20% 20%, rgba(34,211,238,0.12), transparent 40%), radial-gradient(circle at 80% 80%, rgba(236,72,153,0.12), transparent 40%)",
        }}
      />

      <motion.div
        key={mode + (mode === "signup" ? signupStage : "")}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="relative w-full max-w-[400px] rounded-2xl p-7"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border-subtle)",
          boxShadow: "0 0 60px rgba(59, 130, 246,0.08)",
        }}
      >
        <div className="flex flex-col items-center mb-6">
          <Logo />
        </div>

        {/* ── Forgot password screen ───────────────────────────────────── */}
        {mode === "forgot" && (
          <>
            <button
              type="button"
              onClick={() => switchMode("login")}
              className="flex items-center gap-1.5 text-[12px] mb-4"
              style={{ color: "var(--text-muted)" }}
            >
              <ArrowLeft size={13} />
              Back to login
            </button>

            <div className="flex items-center gap-2 mb-5">
              <KeyRound size={18} style={{ color: "var(--blue)" }} />
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>
                Reset your password
              </h2>
            </div>

            {resetStep === "request" && (
              <form onSubmit={handleForgotRequest} className="flex flex-col gap-3.5">
                <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  Enter your account email and we&apos;ll send you a reset code.
                </p>
                <InputRow
                  icon={Mail}
                  label="Email address"
                  type="email"
                  value={sendResetEmail}
                  onChange={setSendResetEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label="Send reset code" />
              </form>
            )}

            {resetStep === "code" && (
              <form onSubmit={handleResetSubmit} className="flex flex-col gap-3.5">
                <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-[11.5px]" style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)", color: "#34d399" }}>
                  <ShieldCheck size={13} className="flex-shrink-0" />
                  A reset code was sent to {resetEmailUsed}
                </div>
                <InputRow
                  icon={KeyRound}
                  label="6-digit reset code"
                  type="text"
                  value={resetCode}
                  onChange={setResetCode}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label="Verify code" />
              </form>
            )}

            {resetStep === "newPassword" && (
              <form onSubmit={handleResetSubmit} className="flex flex-col gap-3.5">
                <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-[11.5px]" style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)", color: "#34d399" }}>
                  <Check size={13} className="flex-shrink-0" />
                  Code verified — set a new password
                </div>
                <InputRow
                  icon={Lock}
                  label="New password"
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  rightEl={eyeBtn(showNewPassword, () => setShowNewPassword((v) => !v))}
                />
                <InputRow
                  icon={Lock}
                  label="Confirm new password"
                  type={showNewPassword ? "text" : "password"}
                  value={confirmNewPassword}
                  onChange={setConfirmNewPassword}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
                {newPassword.length > 0 && (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-xl" style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}>
                    <RuleRow met={newRules.minLength} label="8+ characters" />
                    <RuleRow met={newRules.hasLetter} label="A letter" />
                    <RuleRow met={newRules.hasNumber} label="A number" />
                    <RuleRow met={newRules.hasSymbol} label="A symbol" />
                  </div>
                )}
                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label="Reset password" />
              </form>
            )}
          </>
        )}

        {/* ── Login / Signup screens ────────────────────────────────────── */}
        {(mode === "login" || mode === "signup") && (
          <>
            {/* Mode toggle */}
            <div
              className="flex p-1 rounded-xl mb-6"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}
            >
              {(["login", "signup"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className="flex-1 py-2 rounded-lg text-[12.5px] font-medium transition-all"
                  style={{
                    background: mode === m ? "var(--bg-hover)" : "transparent",
                    color: mode === m ? "var(--text-primary)" : "var(--text-secondary)",
                    border: mode === m ? "1px solid var(--border-glow)" : "1px solid transparent",
                  }}
                >
                  {m === "login" ? "Log in" : "Sign up"}
                </button>
              ))}
            </div>

            <GoogleSignInButton onCredential={handleGoogleCredential} />

            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px" style={{ background: "var(--border-subtle)" }} />
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>or</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-subtle)" }} />
            </div>

            {/* ── LOGIN form ───────────────────────────────────────────── */}
            {mode === "login" && (
              <form onSubmit={handleLogin} className="flex flex-col gap-3.5">
                <InputRow
                  icon={Mail}
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                  invalid={!emailLooksValid}
                />
                <InputRow
                  icon={Lock}
                  label="Password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={setPassword}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  rightEl={eyeBtn(showPassword, () => setShowPassword((v) => !v))}
                />

                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[11.5px]" style={{ color: "var(--text-secondary)" }}>Welcome back</span>
                  <button
                    type="button"
                    onClick={() => switchMode("forgot")}
                    className="text-[11.5px] font-medium"
                    style={{ color: "var(--blue)" }}
                  >
                    Forgot password?
                  </button>
                </div>

                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label="Log in" />
              </form>
            )}

            {/* ── SIGNUP flow (email → OTP → password) ─────────────────── */}
            {mode === "signup" && signupStage === "email" && (
              <form onSubmit={handleSignupEmail} className="flex flex-col gap-3.5">
                <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  We&apos;ll send a one-time code to verify your email.
                </p>
                <InputRow
                  icon={Mail}
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                  invalid={!emailLooksValid}
                />
                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label="Continue" />
              </form>
            )}

            {mode === "signup" && signupStage === "otp" && (
              <form onSubmit={handleVerifyOtp} className="flex flex-col gap-3.5">
                <StatusBanner
                  icon={otpStatus === "error" ? MessageSquareWarning : ShieldCheck}
                  tone={otpStatus === "error" ? "error" : "success"}
                  text={otpStatus === "sending" ? "Sending OTP..." : otpStatus === "sent" ? `OTP sent to ${email}` : signupStatus || "Enter the code from your email"}
                />
                <InputRow
                  icon={KeyRound}
                  label="Verification code"
                  type="text"
                  value={otp}
                  onChange={setOtp}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    disabled={loading}
                    className="text-[11.5px] font-medium"
                    style={{ color: "var(--blue)" }}
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSignupStage("email"); setOtpStatus("idle"); setError(null); }}
                    className="text-[11.5px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Change email
                  </button>
                </div>
                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label="Verify OTP" />
              </form>
            )}

            {mode === "signup" && signupStage === "password" && (
              <form onSubmit={handleCreateAccount} className="flex flex-col gap-3.5">
                <StatusBanner icon={Check} tone="success" text="Email verified — create a password" />
                <InputRow
                  icon={Lock}
                  label="Password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={setPassword}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  rightEl={eyeBtn(showPassword, () => setShowPassword((v) => !v))}
                />
                <InputRow
                  icon={Lock}
                  label="Confirm password"
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
                <div
                  className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-xl"
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}
                >
                  <RuleRow met={rules.minLength} label="8+ characters" />
                  <RuleRow met={rules.hasLetter} label="A letter" />
                  <RuleRow met={rules.hasNumber} label="A number" />
                  <RuleRow met={rules.hasSymbol} label="A symbol" />
                </div>
                <AnimatePresence>{error && <ErrorBanner message={error} />}</AnimatePresence>
                <SubmitButton loading={loading} label={loading ? (signupStatus || "Creating account...") : "Create account"} />
              </form>
            )}

            <p className="text-center text-[11.5px] mt-5" style={{ color: "var(--text-muted)" }}>
              {mode === "login" ? "Don't have an account? " : "Already have an account? "}
              <button
                type="button"
                onClick={() => switchMode(mode === "login" ? "signup" : "login")}
                className="font-medium"
                style={{ color: "var(--blue)" }}
              >
                {mode === "login" ? "Sign up" : "Log in"}
              </button>
            </p>
          </>
        )}
      </motion.div>
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[11.5px]"
      style={{
        background: "rgba(239,68,68,0.1)",
        border: "1px solid rgba(239,68,68,0.3)",
        color: "#f87171",
      }}
    >
      <AlertCircle size={13} className="flex-shrink-0" />
      {message}
    </motion.div>
  );
}

function StatusBanner({
  icon: Icon,
  text,
  tone,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  text: string;
  tone: "success" | "error";
}) {
  const color = tone === "success" ? "#34d399" : "#f87171";
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-[11.5px]"
      style={{
        background: tone === "success" ? "rgba(52,211,153,0.08)" : "rgba(239,68,68,0.08)",
        border: `1px solid ${tone === "success" ? "rgba(52,211,153,0.25)" : "rgba(239,68,68,0.3)"}`,
        color,
      }}
    >
      <Icon size={13} className="flex-shrink-0" />
      {text}
    </motion.div>
  );
}

function SubmitButton({ loading, label }: { loading: boolean; label: string }) {
  return (
    <motion.button
      type="submit"
      disabled={loading}
      whileHover={{ y: -1, boxShadow: "0 0 24px rgba(59, 130, 246,0.35)" }}
      whileTap={{ scale: 0.98 }}
      className="mt-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold"
      style={{
        background: "var(--accent-gradient)",
        color: "white",
        opacity: loading ? 0.7 : 1,
      }}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : label}
    </motion.button>
  );
}
