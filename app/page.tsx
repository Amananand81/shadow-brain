"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { startTransition, useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/Sidebar";
import { RightPanel, SearchRecord } from "./components/RightPanel";
import { GraphCenter } from "./components/GraphCenter";
import { ChatArea } from "./components/ChatArea";
import { AgentSelectScreen } from "./components/AgentSelectScreen";
import { ExtensionInstallModal } from "./components/ExtensionInstallModal";
import { ChatSession, Message } from "./types";
import { generateId, getMemoryGraph } from "./lib/utils";
import {
  clearSelectedAgents,
  clearLegacyCredentials,
  clearSession,
  getSelectedAgents,
  hasSeenExtensionPrompt,
  markExtensionPromptSeen,
  setSelectedAgents,
  setSession,
} from "./lib/auth";
import {
  sendChatMessage,
  fetchConversations,
  saveConversation,
  clerkLogin,
  ClerkSessionExchangeError,
  logoutRequest,
  ApiConversation,
  MemorySource,
} from "./lib/api";

type Stage = "loading" | "auth" | "session-error" | "select-agents" | "app";
type CenterView = "graph" | "chat";

interface AuthState {
  stage: Stage;
  userEmail: string | null;
  selectedAgents: string[];
}

function apiConvToSession(conv: ApiConversation): ChatSession {
  const enr = conv.enrichment ?? {};
  return {
    id: conv._id,
    title: conv.title || enr.topic || "Untitled",
    platform: conv.platform,
    topic: enr.topic,
    category: enr.category,
    keywords: enr.keywords,
    summary: enr.summary,
    importanceScore: enr.importanceScore,
    url: conv.metadata?.url,
    messages: conv.messages.map((m) => ({
      id: generateId(),
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: new Date(m.timestamp),
    })),
    createdAt: new Date(conv.createdAt),
    lastMessageAt: new Date(conv.updatedAt),
  };
}

function notifyExtensionLogin(token: string) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '');
  window.postMessage({
    type: "SHADOWBRAIN_LOGIN",
    token,
    ...(backendUrl ? { backendUrl } : {}),
  }, window.location.origin);
}

export default function Home() {
  const { getToken, isLoaded, isSignedIn, sessionId, signOut } = useAuth();
  const router = useRouter();
  const [auth, setAuth] = useState<AuthState>({
    stage: "loading",
    userEmail: null,
    selectedAgents: [],
  });
  const { stage, userEmail, selectedAgents } = auth;

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeId, setActiveId] = useState<string>("");
  const [centerView, setCenterView] = useState<CenterView>("graph");
  const [isTyping, setIsTyping] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchHistory, setSearchHistory] = useState<SearchRecord[]>([]);
  const [aiSources, setAiSources] = useState<MemorySource[]>([]);
  const [panelResetKey, setPanelResetKey] = useState(0);
  const [searchTriggerKey, setSearchTriggerKey] = useState(0);
  const [isMemorySearchLoading, setIsMemorySearchLoading] = useState(false);
  const [resultsPanelContent, setResultsPanelContent] = useState<ReactNode>(null);
  const [showExtensionPrompt, setShowExtensionPrompt] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [dashboardSessionId, setDashboardSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);

  // Track which session IDs have already been saved to backend
  const persistedIds = useRef<Set<string>>(new Set());
  const backendConversationIds = useRef<Set<string>>(new Set());
  const sessionExchanges = useRef(new Map<string, Promise<Awaited<ReturnType<typeof clerkLogin>>>>());
  const automaticExchangeAttempts = useRef(new Set<string>());
  const activeClerkSession = useRef<string | null>(null);

  const activateApplicationSession = useCallback(async (clerkToken: string, clerkSessionId: string) => {
    if (activeClerkSession.current === clerkSessionId) return;
    if (activeClerkSession.current && activeClerkSession.current !== clerkSessionId) {
      setSessions([]);
      setActiveId("");
      persistedIds.current.clear();
      backendConversationIds.current.clear();
      setToken(null);
      setDashboardSessionId(null);
      setAuth({ stage: "loading", userEmail: null, selectedAgents: [] });
    }
    let exchange = sessionExchanges.current.get(clerkSessionId);
    if (!exchange) {
      exchange = clerkLogin(clerkToken, clerkSessionId);
      sessionExchanges.current.set(clerkSessionId, exchange);
    }
    try {
      const result = await exchange;
      setSession(result.user.email, result.token);
      setToken(result.token);
      activeClerkSession.current = clerkSessionId;
      setDashboardSessionId(clerkSessionId);
      setAuth({
        stage: "app",
        userEmail: result.user.email,
        selectedAgents: getSelectedAgents(),
      });
      setSessionError(null);
      if (typeof window !== "undefined") {
        notifyExtensionLogin(result.token);
      }
      if (!hasSeenExtensionPrompt(result.user.email)) {
        markExtensionPromptSeen(result.user.email);
        setShowExtensionPrompt(true);
      }
    } finally {
      sessionExchanges.current.delete(clerkSessionId);
    }
  }, []);

  const handleSessionExchangeError = useCallback((error: unknown, allowRateLimitRetry: boolean) => {
    if (error instanceof ClerkSessionExchangeError) {
      console.warn("[auth] Clerk application session exchange failed", {
        status: error.status,
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    } else {
      console.warn("[auth] Clerk application session exchange failed", {
        code: "SESSION_EXCHANGE_FAILED",
      });
    }
    const cooldown = allowRateLimitRetry &&
      error instanceof ClerkSessionExchangeError &&
      error.status === 429
      ? error.retryAfterSeconds ?? 1
      : 0;
    setRetryAfterSeconds(cooldown);
    setSessionError(cooldown > 0
      ? "Brain Shadow is temporarily limiting sign-in attempts."
      : "Your Clerk sign-in succeeded, but Brain Shadow could not establish its application session.");
    setAuth({ stage: "session-error", userEmail: null, selectedAgents: [] });
  }, []);

  useEffect(() => {
    let cancelled = false;
    clearLegacyCredentials();
    if (!isLoaded) return () => { cancelled = true; };
    if (!isSignedIn || !sessionId) {
      activeClerkSession.current = null;
      queueMicrotask(() => {
        if (cancelled) return;
        clearSession();
        setSessions([]);
        setActiveId("");
        persistedIds.current.clear();
        backendConversationIds.current.clear();
        setToken(null);
        setDashboardSessionId(null);
        setAuth({ stage: "auth", userEmail: null, selectedAgents: [] });
      });
      return () => { cancelled = true; };
    }

    getToken().then((clerkToken) => {
      if (!clerkToken) throw new Error("No active Clerk session token");
      if (cancelled || automaticExchangeAttempts.current.has(sessionId)) return;
      automaticExchangeAttempts.current.add(sessionId);
      return activateApplicationSession(clerkToken, sessionId);
    }).catch((error: unknown) => {
      if (cancelled) return;
      clearSession();
      setSessions([]);
      setActiveId("");
      persistedIds.current.clear();
      backendConversationIds.current.clear();
      setToken(null);
      setDashboardSessionId(null);
      handleSessionExchangeError(error, true);
    });
    if (activeClerkSession.current && activeClerkSession.current !== sessionId) {
      setSessions([]);
      setActiveId("");
      persistedIds.current.clear();
      backendConversationIds.current.clear();
      setToken(null);
      setDashboardSessionId(null);
      setAuth({ stage: "loading", userEmail: null, selectedAgents: [] });
    }
    return () => { cancelled = true; };
  }, [activateApplicationSession, getToken, handleSessionExchangeError, isLoaded, isSignedIn, sessionId]);

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timeout = window.setTimeout(() => {
      setRetryAfterSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [retryAfterSeconds]);

  useEffect(() => {
    if (stage === "auth") router.replace("/sign-in");
  }, [router, stage]);

  // Refresh authenticated conversations so extension captures appear without
  // a page reload, while retaining locally-created chat sessions.
  useEffect(() => {
    if (stage !== "app" || !token) return;
    let cancelled = false;
    let fetching = false;
    let firstRefresh = true;
    const refreshConversations = async () => {
      if (fetching) return;
      fetching = true;
      if (firstRefresh) startTransition(() => setSessionsLoading(true));
      try {
        const conversations = await fetchConversations();
        if (cancelled) return;
        const backendSessions = conversations.map(apiConvToSession);
        const previousBackendIds = backendConversationIds.current;
        backendConversationIds.current = new Set(backendSessions.map((session) => session.id));
        backendSessions.forEach((session) => persistedIds.current.add(session.id));
        setSessions((previous) => [
          ...backendSessions,
          ...previous.filter((session) => !previousBackendIds.has(session.id)),
        ]);
      } catch {
        if (!cancelled) console.warn("[conversations] Could not refresh saved conversations.");
      } finally {
        fetching = false;
        if (firstRefresh) {
          firstRefresh = false;
          if (!cancelled) setSessionsLoading(false);
        }
      }
    };

    void refreshConversations();
    const interval = window.setInterval(refreshConversations, 15000);
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") void refreshConversations();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [stage, token]);

  // Keep the universal extension paired even when the page or extension is
  // reloaded after the user has already signed in.
  useEffect(() => {
    if (typeof window === "undefined" || !token) return;
    notifyExtensionLogin(token);
  }, [token]);

  const handleAgentsSelected = useCallback((agents: string[]) => {
    setSelectedAgents(agents);
    setAuth((prev) => ({ ...prev, stage: "app", selectedAgents: agents }));
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch (error) {
      console.error("[auth] Brain Shadow server-session cleanup failed.", {
        reason: error instanceof Error
          ? (/^Application logout failed \(\d+\)$/.test(error.message) ? error.message : error.name)
          : "UnknownError",
      });
    }

    try {
      await signOut();
    } catch (error) {
      console.error("[auth] Clerk sign-out failed.", {
        reason: error instanceof Error ? error.name : "UnknownError",
      });
      return;
    }

    activeClerkSession.current = null;
    clearSession();
    clearSelectedAgents();
    setSessions([]);
    setActiveId("");
    persistedIds.current.clear();
    backendConversationIds.current.clear();
    setToken(null);
    setDashboardSessionId(null);
    setAuth({ stage: "auth", userEmail: null, selectedAgents: [] });
    if (typeof window !== "undefined") {
      window.postMessage({ type: "SHADOWBRAIN_LOGOUT" }, window.location.origin);
    }
  }, [signOut]);

  const retryApplicationSession = useCallback(async () => {
    if (!sessionId || retryAfterSeconds > 0 || sessionExchanges.current.has(sessionId)) return;
    setAuth((prev) => ({ ...prev, stage: "loading" }));
    try {
      const clerkToken = await getToken();
      if (!clerkToken) throw new Error("No active Clerk session token");
      await activateApplicationSession(clerkToken, sessionId);
    } catch (error: unknown) {
      handleSessionExchangeError(error, true);
    }
  }, [activateApplicationSession, getToken, handleSessionExchangeError, retryAfterSeconds, sessionId]);

  const handleNewChat = useCallback(() => {
    const newSession: ChatSession = {
      id: generateId(),
      title: "New conversation",
      messages: [],
      createdAt: new Date(),
      lastMessageAt: new Date(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveId(newSession.id);
    setCenterView("chat");
  }, []);

  const handleSelect = useCallback((id: string) => {
    if (!id) return;
    const exists = sessions.some((s) => s.id === id);
    if (!exists) {
      console.warn(`[handleSelect] Conversation ${id} not found in user sessions`);
      return;
    }
    setActiveId(id);
    setCenterView("chat");
    setIsMobileOpen(false);
  }, [sessions]);

  const handleSend = useCallback(
    async (text: string) => {
      const activeSession = sessions.find((s) => s.id === activeId);
      if (!activeSession) return;

      const isFirstMessage = activeSession.messages.length === 0;

      const userMsg: Message = {
        id: generateId(),
        role: "user",
        content: text,
        timestamp: new Date(),
      };

      // Build history for the API call before the optimistic update
      const history = [
        ...activeSession.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: text },
      ];

      // Optimistically show the user message immediately
      setSessions((prev) =>
        prev.map((s) =>
          s.id !== activeId
            ? s
            : {
              ...s,
              messages: [...s.messages, userMsg],
              title: isFirstMessage ? text.slice(0, 45) : s.title,
              lastMessageAt: new Date(),
            }
        )
      );

      setIsTyping(true);

      try {
        const { content } = await sendChatMessage(history);

        const aiMsg: Message = {
          id: generateId(),
          role: "assistant",
          content,
          timestamp: new Date(),
          graph: getMemoryGraph(text),
        };

        setSessions((prev) =>
          prev.map((s) =>
            s.id !== activeId
              ? s
              : { ...s, messages: [...s.messages, aiMsg], lastMessageAt: new Date() }
          )
        );

        // Persist to backend (fire-and-forget on first message of a session)
        if (!persistedIds.current.has(activeId)) {
          persistedIds.current.add(activeId);
          saveConversation({
            external_id: activeId,
            platform: "brain-shadow",
            title: isFirstMessage ? text.slice(0, 60) : activeSession.title,
            messages: [...history, { role: "assistant", content }],
          });
        }
      } catch (err) {
        console.error("[Chat]", err);
        const errMsg: Message = {
          id: generateId(),
          role: "assistant",
          content:
            "Sorry, I couldn't reach the AI backend. Make sure the backend server is running on port 8000.",
          timestamp: new Date(),
        };
        setSessions((prev) =>
          prev.map((s) =>
            s.id !== activeId
              ? s
              : { ...s, messages: [...s.messages, errMsg], lastMessageAt: new Date() }
          )
        );
      } finally {
        setIsTyping(false);
      }
    },
    [activeId, sessions]
  );

  const handleSuggest = useCallback(
    (text: string) => {
      handleSend(text);
    },
    [handleSend]
  );

  const handleClear = useCallback(() => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeId ? { ...s, messages: [] } : s))
    );
  }, [activeId]);

  const handleHistoryUpdate = useCallback((record: SearchRecord) => {
    setSearchHistory((prev) => {
      const existing = prev.find((r) => r.keyword === record.keyword);
      const merged = existing ? { ...record, summary: record.summary ?? existing.summary } : record;
      return [merged, ...prev.filter((r) => r.keyword !== record.keyword)];
    });
  }, []);

  const handleAiAnswerReady = useCallback((keyword: string, answer: string) => {
    setSearchHistory((prev) =>
      prev.map((r) => r.keyword === keyword ? { ...r, summary: answer } : r)
    );
  }, []);

  const handleForgetPast = useCallback(() => {
    setSearchHistory([]);
    setSearchKeyword("");
  }, []);

  const handleMemorySearchSubmit = useCallback(() => {
    const trimmed = searchKeyword.trim();
    if (!trimmed || isMemorySearchLoading) return;
    setSearchTriggerKey((k) => k + 1);
    setSearchHistory((prev) => {
      const existing = prev.find((r) => r.keyword === trimmed.toLowerCase());
      if (existing) {
        return [
          { ...existing, count: existing.count + 1, lastAt: Date.now(), summary: existing.summary },
          ...prev.filter((r) => r.keyword !== trimmed.toLowerCase()),
        ];
      }
      return [{ keyword: trimmed.toLowerCase(), count: 1, firstAt: Date.now(), lastAt: Date.now() }, ...prev];
    });
  }, [searchKeyword, isMemorySearchLoading]);

  const handleMemorySearchLoadingChange = useCallback((loading: boolean) => {
    setIsMemorySearchLoading(loading);
  }, []);

  const handleDeleteHistory = useCallback((keyword: string) => {
    setSearchHistory((prev) => prev.filter((r) => r.keyword !== keyword));
  }, []);

  // Hooks must be called unconditionally — before any early returns
  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime()),
    [sessions]
  );

  // Filter to only sessions from selected agents (mscopilot counts as copilot)
  const filteredSessions = useMemo(() => {
    if (selectedAgents.length === 0) return sortedSessions;
    return sortedSessions.filter((s) => {
      if (!s.platform || s.platform === "brain-shadow") return true;
      const key = s.platform === "mscopilot" ? "copilot" : s.platform;
      return selectedAgents.includes(key);
    });
  }, [sortedSessions, selectedAgents]);

  // When a search is active and the LLM has returned sources, show only those in the sidebar
  const sidebarSessions = useMemo(() => {
    if (!searchKeyword.trim() || aiSources.length === 0) return filteredSessions;
    const ids = new Set(aiSources.map((s) => s.convId ?? s.id));
    return filteredSessions.filter((s) => ids.has(s.id));
  }, [filteredSessions, searchKeyword, aiSources]);

  const activeSession = sessions.find((s) => s.id === activeId);

  let content: React.ReactNode;
  if (stage === "loading" || !isLoaded || !isSignedIn || !sessionId
    || (stage === "app" && dashboardSessionId !== sessionId)) {
    content = <div className="min-h-screen w-full" style={{ background: "var(--bg-deep)" }} />;
  } else if (stage === "auth") {
    content = <div className="min-h-screen w-full" style={{ background: "var(--bg-deep)" }} />;
  } else if (stage === "session-error") {
    content = (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center" style={{ background: "var(--bg-deep)", color: "var(--text-primary)" }}>
        <h1 className="text-lg font-semibold">Could not open Brain Shadow</h1>
        <p className="max-w-md text-sm" style={{ color: "var(--text-secondary)" }}>
          {sessionError}{retryAfterSeconds > 0 ? ` Try again in ${retryAfterSeconds} seconds.` : ""}
        </p>
        <div className="flex gap-3">
          <button type="button" onClick={retryApplicationSession} disabled={retryAfterSeconds > 0} className="rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50" style={{ background: "var(--blue)", color: "white" }}>
            {retryAfterSeconds > 0 ? `Retry (${retryAfterSeconds}s)` : "Retry"}
          </button>
          <button type="button" onClick={handleLogout} className="rounded-lg px-4 py-2 text-sm" style={{ border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}>
            Sign out
          </button>
        </div>
      </main>
    );
  } else if (stage === "select-agents") {
    content = <AgentSelectScreen initialSelected={selectedAgents} onContinue={handleAgentsSelected} />;
  } else {
    content = (
      <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-deep)", width: "100vw" }}>
        {/* Left sidebar */}
        <Sidebar
          sessions={sidebarSessions}
          activeId={activeId}
          onSelect={handleSelect}
          onNewChat={handleNewChat}
          isMobileOpen={isMobileOpen}
          onMobileClose={() => setIsMobileOpen(false)}
          userEmail={userEmail ?? undefined}
          agentCount={selectedAgents.length}
          selectedAgents={selectedAgents}
          onChangeAgents={() => setAuth((prev) => ({ ...prev, stage: "select-agents" }))}
          onLogout={handleLogout}
          sessionsLoading={sessionsLoading}
        />

        {/* Center — Brain Graph or Chat, toggled by session selection */}
        {centerView === "chat" && activeSession ? (
          <ChatArea
            messages={activeSession.messages}
            isTyping={isTyping}
            onSend={handleSend}
            onSuggest={handleSuggest}
            onExplore={(label) => setSearchKeyword(label)}
            onClear={handleClear}
            onMenuClick={() => setIsMobileOpen(true)}
            onGraphView={() => setCenterView("graph")}
          />
        ) : (
          <GraphCenter
            searchKeyword={searchKeyword}
            searchTriggerKey={searchTriggerKey}
            onAiSourcesChange={setAiSources}
            onAiAnswerReady={handleAiAnswerReady}
            onAiLoadingChange={handleMemorySearchLoadingChange}
            onResultsPanelContentChange={setResultsPanelContent}
            panelResetKey={panelResetKey}
            sessions={filteredSessions}
            sessionsLoading={sessionsLoading}
            selectedAgents={selectedAgents}
            onSelectConversation={handleSelect}
          />
        )}

        {/* Right panel — search + history */}
        <RightPanel
          searchKeyword={searchKeyword}
          onSearchChange={setSearchKeyword}
          onSearchSubmit={handleMemorySearchSubmit}
          onOpenPanel={() => setPanelResetKey((k) => k + 1)}
          searchHistory={searchHistory}
          onHistoryUpdate={handleHistoryUpdate}
          onDeleteHistory={handleDeleteHistory}
          onForgetPast={handleForgetPast}
          isSearchLoading={isMemorySearchLoading}
          resultsPanelContent={resultsPanelContent}
        />
      </div>
    );
  }

  return (
    <>
      <AnimatePresence mode="wait">
        <motion.div
          key={stage}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeInOut" }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
      <ExtensionInstallModal open={showExtensionPrompt} onClose={() => setShowExtensionPrompt(false)} />
      {token && (
        <div
          id="shadowbrain-auth-bridge"
          data-token={token}
          data-backend-url={process.env.NEXT_PUBLIC_API_URL ?? ""}
          style={{ display: "none" }}
        />
      )}
    </>
  );
}
