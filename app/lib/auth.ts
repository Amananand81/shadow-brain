const SESSION_KEY = "shadowbrain_session";
const AGENTS_KEY = "shadowbrain_selected_agents";
const REMEMBER_KEY = "shadowbrain_remember";
const SAVED_EMAIL_KEY = "shadowbrain_saved_email";
const EXTENSION_PROMPT_SEEN_KEY = "shadowbrain_extension_prompt_seen";
const LEGACY_USERS_KEY = "shadowbrain_users";

interface Session {
  email: string;
  token: string;
}

export interface PasswordRules {
  minLength: boolean;
  hasLetter: boolean;
  hasNumber: boolean;
  hasSymbol: boolean;
}

export function checkPassword(password: string): PasswordRules {
  return {
    minLength: password.length >= 8,
    hasLetter: /[A-Za-z]/.test(password),
    hasNumber: /[0-9]/.test(password),
    hasSymbol: /[^A-Za-z0-9]/.test(password),
  };
}

export function isPasswordValid(password: string): boolean {
  const rules = checkPassword(password);
  return rules.minLength && rules.hasLetter && rules.hasNumber && rules.hasSymbol;
}

export function isEmailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function readJSON<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function saveRememberMe(email: string) {
  if (typeof window === "undefined") return;
  writeJSON(REMEMBER_KEY, true);
  window.localStorage.setItem(SAVED_EMAIL_KEY, email);
}

export function clearRememberMe() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(REMEMBER_KEY);
  window.localStorage.removeItem(SAVED_EMAIL_KEY);
}

export function getSavedEmail(): string | null {
  if (typeof window === "undefined") return null;
  if (!readJSON<boolean>(REMEMBER_KEY)) return null;
  return window.localStorage.getItem(SAVED_EMAIL_KEY);
}

export function setSession(email: string, token: string) {
  if (!token || token.split('.').length !== 3) throw new Error('A valid server session is required');
  writeJSON(SESSION_KEY, { email, token } satisfies Session);
  if (typeof window !== "undefined") window.localStorage.setItem('shadowbrain_token', token);
}

export function getSession(): Session | null {
  const session = readJSON<Session>(SESSION_KEY);
  if (!session?.email || !session.token || session.token.split('.').length !== 3) {
    clearSession();
    return null;
  }
  return session;
}

export function clearSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem('shadowbrain_token');
}

export function clearLegacyCredentials() {
  if (typeof window !== "undefined") window.localStorage.removeItem(LEGACY_USERS_KEY);
}

export function getSelectedAgents(): string[] {
  return readJSON<string[]>(AGENTS_KEY) ?? [];
}

export function setSelectedAgents(agentIds: string[]) {
  writeJSON(AGENTS_KEY, agentIds);
}

export function clearSelectedAgents() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AGENTS_KEY);
}

export function hasSeenExtensionPrompt(email: string): boolean {
  const seen = readJSON<string[]>(EXTENSION_PROMPT_SEEN_KEY) ?? [];
  return seen.includes(email.trim().toLowerCase());
}

export function markExtensionPromptSeen(email: string) {
  const seen = readJSON<string[]>(EXTENSION_PROMPT_SEEN_KEY) ?? [];
  const normalized = email.trim().toLowerCase();
  if (!seen.includes(normalized)) writeJSON(EXTENSION_PROMPT_SEEN_KEY, [...seen, normalized]);
}
