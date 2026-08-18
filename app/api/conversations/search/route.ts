import { NextRequest } from 'next/server';

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'https://shadow-brain-u4ua.onrender.com';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const authorization = request.headers.get('authorization');
    const cookie = request.headers.get('cookie');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authorization) headers.Authorization = authorization;
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(`${BACKEND}/api/conversations/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const text = await res.text();

    try {
      const data = JSON.parse(text);
      if (!res.ok) {
        return Response.json(
          { message: data?.message || data?.error || 'Search failed', answer: data?.answer || data?.message || 'Search failed', sources: [] },
          { status: res.status }
        );
      }
      return Response.json(data);
    } catch {
      if (!res.ok) {
        return Response.json(
          { message: text || 'Search failed', answer: text || 'Search failed', sources: [] },
          { status: res.status }
        );
      }
      return Response.json({ answer: text, sources: [] });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg, answer: 'Search could not be completed right now.', sources: [] }, { status: 503 });
  }
}
