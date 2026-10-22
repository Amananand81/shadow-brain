const API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

function toApiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
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
  const response = await fetch(toApiUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`Application logout failed (${response.status})`);
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
  const token = typeof window !== 'undefined' ? localStorage.getItem('shadowbrain_token') : null;
  if (!token) throw new Error('Your session is missing. Please sign in again.');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, systemPrompt }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Chat error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data;
}

export async function fetchConversations(): Promise<ApiConversation[]> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('shadowbrain_token') : null;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(toApiUrl('/api/conversations?limit=1000'), {
    headers,
  });
  if (!res.ok) {
    throw new Error(`Could not load conversations from the backend (HTTP ${res.status})`);
  }
  return res.json();
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
      answer: 'Memory search needs a signed-in backend session. Please sign in, then try again.',
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

export interface AuthUser {
  token: string;
  user: {
    email: string;
    name?: string;
    avatar?: string;
  };
}

export class ClerkSessionExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ClerkSessionExchangeError';
  }
}

export async function clerkLogin(clerkToken: string, expectedSessionId: string): Promise<AuthUser> {
  if (!clerkToken) throw new Error('No active Clerk session.');
  if (!expectedSessionId) throw new Error('No active Clerk session.');
  const res = await fetch(toApiUrl('/api/auth/clerk'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clerkToken}`,
      'X-Clerk-Session-Id': expectedSessionId,
    },
    credentials: 'include',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof data?.code === 'string' && /^[A-Z0-9_]+$/.test(data.code)
      ? data.code
      : `HTTP_${res.status}`;
    const retryHeader = Number(res.headers.get('Retry-After'));
    const retryBody = Number(data?.retryAfterSeconds);
    const retryAfterSeconds = res.status === 429
      ? Math.max(1, Math.ceil(Number.isFinite(retryHeader) && retryHeader > 0
        ? retryHeader
        : Number.isFinite(retryBody) && retryBody > 0
          ? retryBody
          : 1))
      : undefined;
    throw new ClerkSessionExchangeError(
      typeof data?.message === 'string' ? data.message : `Sign-in failed (${res.status})`,
      res.status,
      code,
      retryAfterSeconds,
    );
  }
  if (typeof data?.user?.email === 'string' && typeof data?.token === 'string') {
    return { token: data.token, user: data.user };
  }
  throw new Error('Unexpected authentication response.');
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
