const API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

function toApiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function authRequest(path: string, body: Record<string, string>) {
  const res = await fetch(toApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Authentication failed (${res.status})`);
  return data;
}

export function passwordAuth(email: string, password: string, mode: 'signup', name: string, confirmPassword: string): Promise<{ message: string }>;
export function passwordAuth(email: string, password: string, mode: 'login'): Promise<{ token: string; user: { email: string; name?: string; avatar?: string } }>;
export async function passwordAuth(email: string, password: string, mode: 'login' | 'signup', name?: string, confirmPassword?: string) {
  if (mode === 'signup') {
    return authRequest('/api/auth/register', { email, password, confirmPassword: confirmPassword || '', name: name || '' }) as Promise<{ message: string }>;
  }
  const data = await authRequest('/api/auth/login', { email, password });
  if (!data?.token || !data?.user?.email) throw new Error('Unexpected authentication response');
  return data as { token: string; user: { email: string; name?: string; avatar?: string } };
}

export async function getCurrentUser() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('shadowbrain_token') : null;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(toApiUrl('/api/auth/me'), { headers, credentials: 'include' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.email || !data?.token) return null;
  return data as { email: string; name?: string; avatar?: string; token: string };
}

export async function logoutRequest() {
  await fetch(toApiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' }).catch(() => undefined);
}

export async function verifyEmail(token: string) {
  const data = await authRequest('/api/auth/verify-email', { token });
  if (!data?.token || !data?.user?.email) throw new Error('Unexpected verification response');
  return data as { token: string; user: { email: string; name?: string; avatar?: string } };
}

export async function resendVerification(email: string) {
  return authRequest('/api/auth/resend-verification', { email }) as Promise<{ message: string }>;
}

export async function requestPasswordReset(email: string) {
  return authRequest('/api/auth/forgot-password', { email }) as Promise<{ message: string }>;
}

export async function resetPassword(token: string, password: string, confirmPassword: string) {
  return authRequest('/api/auth/reset-password', { token, password, confirmPassword }) as Promise<{ message: string }>;
}

export interface ApiEnrichment {
  topic?: string;
  category?: string;
  summary?: string;
  keywords?: string[];
  entities?: string[];
  importanceScore?: number;
  enrichedAt?: string;
  version?: string;
}

export interface ApiConversation {
  _id: string;
  title: string;
  platform: string;
  externalId: string;
  status: string;
  messages: Array<{ role: string; content: string; timestamp: string; _id?: string }>;
  enrichment?: ApiEnrichment;
  metadata?: {
    url?: string;
    savedAtExtension?: string;
    topic?: string;
    category?: string;
    summary?: string;
    keywords?: string[];
    importance_score?: number;
  };
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function sendChatMessage(
  messages: ApiMessage[],
  systemPrompt?: string,
): Promise<{ content: string }> {
  const url = toApiUrl('/api/chat');
  console.log('[sendChatMessage] POST', url, { messagesCount: messages.length });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, systemPrompt }),
  });
  console.log('[sendChatMessage] Response status:', res.status, res.statusText);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[sendChatMessage] Error response:', text);
    throw new Error(`Chat error ${res.status}: ${text}`);
  }
  const data = await res.json();
  console.log('[sendChatMessage] Parsed response:', data);
  return data;
}

export async function fetchConversations(): Promise<ApiConversation[]> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('shadowbrain_token') : null;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(toApiUrl('/api/conversations?limit=1000'), {
      headers
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export interface MemorySource {
  id: string;
  convId?: string;
  title: string;
  platform: string;
  date?: string | null;
  role?: string;
  snippet?: string;
  summary?: string | null;
  keywords?: string[];
}

export interface AnswerSection {
  text: string;
  convId: string;
}

export async function searchMemory(query: string, platforms?: string[]): Promise<{ answer: string; answerSections?: AnswerSection[]; sources: MemorySource[]; n8nSummary?: { heading: string; summary: string } | null }> {
  const url = toApiUrl('/api/conversations/search');
  const token = typeof window !== 'undefined' ? localStorage.getItem('shadowbrain_token') : null;
  if (!token) {
    return {
      answer: 'Memory search needs a signed-in backend session. Please sign in with Google, then try again.',
      sources: [],
    };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  headers['Authorization'] = `Bearer ${token}`;

  console.log('[api.searchMemory] request', { url, query, platforms });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, platforms: platforms && platforms.length > 0 ? platforms : undefined }),
    });
    console.log('[api.searchMemory] response status', { status: res.status, statusText: res.statusText });
    const data = await res.json().catch((parseError) => {
      console.error('[api.searchMemory] failed to parse JSON', parseError);
      throw parseError;
    });
    console.log('[api.searchMemory] parsed response', data);
    if (!res.ok) {
      const message = data?.message || data?.answer || `Search error ${res.status}`;
      throw new Error(message);
    }
    return data;
  } catch (e) {
    const isNetworkError = e instanceof TypeError;
    return {
      answer: isNetworkError
        ? 'Could not reach the backend. Make sure it is running on port 8000.'
        : `Search failed: ${(e as Error).message}`,
      answerSections: [],
      sources: [],
    };
  }
}

export interface GoogleAuthUser {
  token: string;
  user: {
    email: string;
    name?: string;
    avatar?: string;
  };
}

export async function googleLogin(credential: string): Promise<GoogleAuthUser> {
  const res = await fetch(toApiUrl('/api/auth/google'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ credential }),
  });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.message || `Google sign-in failed (${res.status})`;
    throw new Error(msg);
  }

  if (data?.user?.email && data?.token) {
    return { token: data.token, user: data.user };
  }
  if (data?.email && data?.token) {
    return { token: data.token, user: { email: data.email, name: data.name, avatar: data.avatar } };
  }

  const meRes = await fetch(toApiUrl('/api/auth/me'), { credentials: 'include' });
  const meBody = await meRes.json().catch(() => null);
  if (meRes.ok && meBody?.token) {
    const email = meBody.email || data?.email || '';
    const name = meBody.name || data?.name;
    const avatar = meBody.avatar || data?.avatar;
    return { token: meBody.token, user: { email, name, avatar } };
  }

  throw new Error('Unexpected Google sign-in response');
}

// Exchange a Clerk session token (short-lived) for the same Brain Shadow JWT
// used by Google login. The backend verifies the Clerk token, upserts the
// application user, and returns a Brain Shadow JWT that downstream
// /api/conversations + /api/import (and the browser extension) expect.
export async function clerkLogin(clerkToken: string): Promise<GoogleAuthUser> {
  if (!clerkToken) throw new Error("No Clerk session available. Please try again.");

  const res = await fetch(toApiUrl('/api/auth/clerk'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ token: clerkToken }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.message || `Sign-in failed (${res.status})`;
    throw new Error(msg);
  }

  if (data?.user?.email && data?.token) {
    return { token: data.token, user: data.user };
  }
  if (data?.email && data?.token) {
    return { token: data.token, user: { email: data.email, name: data.name, avatar: data.avatar } };
  }

  // Cookie-only fallback (same as Google path).
  const meRes = await fetch(toApiUrl('/api/auth/me'), { credentials: 'include' });
  const meBody = await meRes.json().catch(() => null);
  if (meRes.ok && meBody?.token) {
    return {
      token: meBody.token,
      user: { email: meBody.email || data?.email || '', name: meBody.name || data?.name, avatar: meBody.avatar || data?.avatar },
    };
  }

  const email = data?.email || data?.user?.email || '';
  if (!email) throw new Error(`Unexpected server response: ${JSON.stringify(data)}`);
  return { token: '', user: { email, name: data?.name || data?.user?.name, avatar: data?.avatar || data?.user?.avatar } };
}

export async function saveConversation(data: {
  external_id: string;
  platform: string;
  title: string;
  messages: ApiMessage[];
}): Promise<void> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('shadowbrain_token') : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    await fetch(toApiUrl('/api/import/capture'), {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
  } catch {
    // fire-and-forget — don't block the UI
  }
}
