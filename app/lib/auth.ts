const SESSION_KEY = "shadowbrain_session";
const AGENTS_KEY = "shadowbrain_selected_agents";
const EXTENSION_PROMPT_SEEN_KEY = "shadowbrain_extension_prompt_seen";
const LEGACY_USERS_KEY = "shadowbrain_users";

interface Session {
  email: string;
  token: string;
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
