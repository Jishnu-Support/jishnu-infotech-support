import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDown, ArrowDownUp, ArrowRight, ArrowUp, BarChart3, Bell, Check,
  CheckCheck, ChevronDown, CircleHelp, Clock3, Inbox, LogOut, Mail, MessageCircle,
  Download, Paperclip, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, UserRound, Users, X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";

type Role = "agent" | "customer";
type Status = "open" | "in_progress" | "waiting" | "resolved";
type Priority = "low" | "normal" | "high" | "urgent";
type TicketCategory = "Account access" | "Billing" | "Technical support" | "Feature request" | "Other";
type User = {
  id: number; name: string; email: string; role: Role; isAdmin?: boolean;
  isCompanyAdmin?: boolean; companyId?: number | null; companyName?: string | null;
};
type Company = { id: number; name: string; domain?: string | null };
type Ticket = {
  id: number; subject: string; description: string; status: Status; priority: Priority;
  category: TicketCategory; tags: string[]; customFields: Record<string, string>;
  source: "portal" | "email"; createdAt: string; updatedAt: string;
  customer: { id: number; name: string; email: string };
  company: Company | null;
  assignee: { id: number; name: string } | null;
  messageCount: number; lastMessage: string;
  firstResponseDueAt: string; resolutionDueAt: string;
  firstResponseAt: string | null; isFirstResponseOverdue: boolean; isResolutionOverdue: boolean;
  rating: { rating: number; comment: string; createdAt: string; customerId: number } | null;
};
type Message = { id: number; body: string; isInternal: boolean; createdAt: string; authorId: number; authorName: string; authorRole: Role };
type TicketAttachment = { id: number; name: string; mimeType: string; sizeBytes: number; createdAt: string; uploadedBy: number };
type TicketDetail = { ticket: Ticket; messages: Message[]; attachments: TicketAttachment[]; assignmentHistory: AssignmentEvent[]; categories: TicketCategory[]; canRate: boolean };
type Customer = {
  id: number; name: string; email: string; companyId?: number; companyName?: string;
  routingPriority?: number; priorityLabel?: string;
};
type AssignmentEvent = {
  id: number; source: string; createdAt: string; agentId: number | null;
  agentName: string; assignedByName: string | null;
};
type Notification = { id: number; ticketId: number; kind: string; message: string; readAt: string | null; createdAt: string };
type AnalyticsReport = {
  days: number; startDate: string; endDate: string;
  summary: { created: number; activeInPeriod: number; activeBacklog: number };
  statuses: Array<{ status: Status; count: number }>;
  priorities: Array<{ priority: Priority; count: number }>;
  sources: Array<{ source: "portal" | "email"; count: number }>;
  daily: Array<{ day: string; created: number; resolved: number }>;
  sla: {
    firstResponse: { onTime: number; evaluated: number; targetHours: number };
    resolution: { onTime: number; evaluated: number; targetHours: number };
  };
  agentWorkload: Array<{ id: number; name: string; routingPriority: number; active: number; assignedInPeriod: number; resolvedInPeriod: number }>;
  companyVolume: Array<{ name: string; count: number }>;
  customerActivity: Array<{ id: number; name: string; email: string; companyName: string | null; raisedInPeriod: number; active: number; inProgress: number; resolvedInPeriod: number }>;
};
type PortalMode = "login" | "register";
type ApiError = { error?: string };
type AuthFlow = "portal" | "invite" | "client-invite" | "reset";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "include",
    headers: { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...options.headers },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function timeAgo(date: string) {
  const elapsed = Math.max(0, Date.now() - new Date(date.replace(" ", "T") + "Z").getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

function CompanyLogo({ className }: { className: string }) {
  return <picture className={className}>
    <source media="(max-width: 820px)" srcSet="/jishnu-infotech-favicon.webp" />
    <img src="/jishnu-infotech-logo.webp" alt="Jishnu Infotech" />
  </picture>;
}

function StatusPill({ status }: { status: Status }) {
  const labels: Record<Status, string> = {
    open: "Open", in_progress: "In progress", waiting: "Waiting", resolved: "Closed",
  };
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{labels[status]}</span>;
}

function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === "urgent") return <span className="priority-icon urgent"><ArrowUp size={14} /> Urgent</span>;
  if (priority === "high") return <span className="priority-icon high"><ArrowUp size={14} /> High</span>;
  if (priority === "low") return <span className="priority-icon low"><ArrowDown size={14} /> Low</span>;
  return <span className="priority-icon normal"><ArrowDownUp size={14} /> Normal</span>;
}

function App() {
  const [authFlow, setAuthFlow] = useState<AuthFlow>(() => window.location.pathname === "/invite" ? "invite"
    : window.location.pathname === "/client-invite" ? "client-invite"
    : window.location.pathname === "/reset-password" ? "reset" : "portal");
  const authToken = useMemo(() => new URLSearchParams(window.location.search).get("token") || "", []);
  const [user, setUser] = useState<User | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [agents, setAgents] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [activeView, setActiveView] = useState("inbox");
  const [filter, setFilter] = useState<Status | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [prefillCustomerId, setPrefillCustomerId] = useState<number | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginNotice, setLoginNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const [loginPortal, setLoginPortal] = useState<Role>("customer");
  const [portalMode, setPortalMode] = useState<PortalMode>("login");
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [actionMessage, setActionMessage] = useState("");
  const [replyInternal, setReplyInternal] = useState(false);
  const [createCustomFields, setCreateCustomFields] = useState<Record<string, string>>({});
  const searchInput = useRef<HTMLInputElement>(null);

  const refreshTickets = useCallback(async () => {
    const result = await api<{ tickets: Ticket[] }>("/tickets");
    setTickets(result.tickets);
    setSelectedId((current) => current && result.tickets.some((ticket) => ticket.id === current)
      ? current : result.tickets[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then(({ user: currentUser }) => { setUser(currentUser); return api<{ tickets: Ticket[] }>("/tickets"); })
      .then(({ tickets: loaded }) => { setTickets(loaded); setSelectedId(loaded[0]?.id ?? null); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId || !user) { setDetail(null); return; }
    api<TicketDetail>(`/tickets/${selectedId}`)
      .then(setDetail)
      .catch((error: Error) => setActionError(error.message));
  }, [selectedId, user, tickets]);

  useEffect(() => {
    if (!selectedId || user?.role !== "agent" || (activeView !== "inbox" && activeView !== "assigned")) return;
    const intervalId = window.setInterval(() => {
      api<TicketDetail>(`/tickets/${selectedId}`)
        .then(setDetail)
        .catch((error: Error) => setActionError(error.message));
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [activeView, selectedId, user]);

  useEffect(() => { setReplyInternal(false); }, [selectedId]);

  useEffect(() => {
    if (user?.role !== "agent") { setCustomers([]); return; }
    api<{ customers: Customer[] }>("/customers")
      .then(({ customers: loaded }) => setCustomers(loaded))
      .catch((error: Error) => setActionError(error.message));
  }, [user]);

  const refreshNotifications = useCallback(async () => {
    if (user?.role !== "agent") return;
    const result = await api<{ notifications: typeof notifications; unreadCount: number }>("/notifications");
    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
  }, [user]);

  useEffect(() => {
    if (!user || user.role !== "agent") return;
    refreshNotifications().catch((error: Error) => setActionError(error.message));
    const intervalId = window.setInterval(() => {
      refreshNotifications().catch((error: Error) => setActionError(error.message));
    }, 30000);
    return () => window.clearInterval(intervalId);
  }, [refreshNotifications, user]);

  useEffect(() => {
    if (!user) { setAgents([]); return; }
    api<{ agents: Customer[] }>("/agents")
      .then(({ agents: loaded }) => setAgents(loaded))
      .catch((error: Error) => setActionError(error.message));
  }, [user]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!user) return;
    const intervalId = window.setInterval(() => {
      refreshTickets().catch((error: Error) => setActionError(error.message));
    }, 30000);
    return () => window.clearInterval(intervalId);
  }, [refreshTickets, user]);

  const filteredTickets = useMemo(() => tickets.filter((ticket) => {
    const matchStatus = filter === "all" || ticket.status === filter;
    const matchPriority = priorityFilter === "all" || ticket.priority === priorityFilter;
    const query = search.trim().toLowerCase();
    const matchSearch = !query || `${ticket.subject} ${ticket.customer.name} ${ticket.lastMessage}`.toLowerCase().includes(query);
    const matchView = activeView !== "assigned" || ticket.assignee?.id === user?.id;
    return matchStatus && matchPriority && matchSearch && matchView;
  }), [activeView, filter, priorityFilter, search, tickets, user]);

  const counts = useMemo(() => ({
    all: tickets.length,
    open: tickets.filter((ticket) => ticket.status === "open").length,
    in_progress: tickets.filter((ticket) => ticket.status === "in_progress").length,
    waiting: tickets.filter((ticket) => ticket.status === "waiting").length,
    resolved: tickets.filter((ticket) => ticket.status === "resolved").length,
  }), [tickets]);

  async function signIn(event: FormEvent<HTMLFormElement>, portal: Role) {
    event.preventDefault();
    setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (result.user.role !== portal) {
        await api("/auth/logout", { method: "POST" });
        throw new Error(`This account is for the ${result.user.role === "agent" ? "agent" : "client"} portal. Choose the matching portal and try again.`);
      }
      setUser(result.user);
      const loaded = await api<{ tickets: Ticket[] }>("/tickets");
      setTickets(loaded.tickets);
      setSelectedId(loaded.tickets[0]?.id ?? null);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Unable to sign in.");
    }
  }

  async function registerClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ user?: User; pendingApproval?: boolean; message?: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          companyId: form.get("companyId"),
          joinCode: form.get("joinCode"),
        }),
      });
      if (result.pendingApproval) {
        setLoginNotice(result.message || "Your company administrator must approve this account before you can sign in.");
        setPortalMode("login");
      } else if (result.user) {
        setUser(result.user);
        setTickets([]);
        setSelectedId(null);
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Unable to create your account.");
    }
  }

  async function signOut() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    setTickets([]);
    setSelectedId(null);
    setDetail(null);
  }

  async function updateTicket(values: {
    status?: Status; priority?: Priority; assigneeId?: number | null;
    category?: TicketCategory; tags?: string[]; customFields?: Record<string, string>;
  }) {
    if (!selectedId) return;
    setActionError("");
    try {
      await api(`/tickets/${selectedId}`, { method: "PATCH", body: JSON.stringify(values) });
      await refreshTickets();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update ticket.");
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("customFields", JSON.stringify(createCustomFields));
    const body = String(form.get("reply") || "").trim();
    if (!body) return;
    setActionError("");
    try {
      const result = await api<{ emailQueued: boolean }>(`/tickets/${selectedId}/messages`, { method: "POST", body: JSON.stringify({ body, internal: isAgent && replyInternal }) });
      setActionMessage(replyInternal ? "Internal note added for the support team." : result.emailQueued ? "Reply added and queued for email delivery." : "Reply added to the ticket conversation.");
      await refreshTickets();
      formElement.reset();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not send reply.");
    }
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setActionError("");
    try {
      const result = await api<{ ticket: Ticket }>("/tickets", { method: "POST", body: form });
      setShowCreate(false);
      await refreshTickets();
      setSelectedId(result.ticket.id);
      setActiveView("inbox");
      setFilter("all");
      setPrefillCustomerId(null);
      setCreateCustomFields({});
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not create ticket.");
    }
  }

  if (loading) return <div className="loading-screen"><CompanyLogo className="company-logo-loading" /><span>Loading your workspace…</span></div>;

  if (!user && authFlow !== "portal") return <InvitationOrResetScreen
    flow={authFlow}
    token={authToken}
    notice={actionMessage}
    error={actionError}
    onComplete={async (acceptedUser) => {
      if (acceptedUser) {
        setUser(acceptedUser);
        const loaded = await api<{ tickets: Ticket[] }>("/tickets");
        setTickets(loaded.tickets);
        setSelectedId(loaded.tickets[0]?.id ?? null);
      } else {
        window.history.replaceState({}, "", "/");
        setAuthFlow("portal");
        setPortalMode("login");
        setLoginError("Password reset complete. Please sign in with your new password.");
      }
    }}
  />;

  if (!user) return <LoginScreen
    error={loginError}
    notice={loginNotice}
    portal={loginPortal}
    mode={portalMode}
    onModeChange={setPortalMode}
    onPortalChange={(portal) => { setLoginPortal(portal); setPortalMode("login"); setLoginError(""); setLoginNotice(""); }}
    onSubmit={signIn}
    onRegister={registerClient}
  />;

  const isAgent = user.role === "agent";
  const isCompanyAdmin = user.role === "customer" && Boolean(user.isCompanyAdmin);
  const selectedTicket = detail?.ticket;
  const heading = isAgent ? "Support inbox" : "My requests";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <CompanyLogo className="company-logo-sidebar" />
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button aria-label={isAgent ? "Inbox" : "My requests"} title={isAgent ? "Inbox" : "My requests"} className={`nav-item ${activeView === "inbox" ? "active" : ""}`} onClick={() => { setActiveView("inbox"); setFilter("all"); }}>
            <Inbox size={17} /><span>{isAgent ? "Inbox" : "My requests"}</span><span className="nav-count">{isAgent ? counts.open : counts.all}</span>
          </button>
          {isAgent && <>
            <button aria-label="Assigned to me" title="Assigned to me" className={`nav-item ${activeView === "assigned" ? "active" : ""}`} onClick={() => { setActiveView("assigned"); setFilter("all"); }}>
              <UserRound size={17} /><span>Assigned to me</span><span className="nav-count">{tickets.filter((ticket) => ticket.assignee?.id === user.id && ticket.status !== "resolved").length}</span>
            </button>
            <button aria-label="Customers" title="Customers" className={`nav-item ${activeView === "customers" ? "active" : ""}`} onClick={() => setActiveView("customers")}>
              <Users size={17} /><span>Customers</span>
            </button>
            <button aria-label="Notifications" title="Notifications" className={`nav-item ${activeView === "notifications" ? "active" : ""}`} onClick={() => setActiveView("notifications")}>
              <Bell size={17} /><span>Notifications</span>{unreadCount > 0 && <span className="nav-count">{unreadCount}</span>}
            </button>
          </>}
          {isCompanyAdmin && <button aria-label="Company users" title="Company users" className={`nav-item ${activeView === "company-users" ? "active" : ""}`} onClick={() => setActiveView("company-users")}>
            <Users size={17} /><span>Company users</span>
          </button>}
          {isAgent && user.isAdmin && <button aria-label="Companies" title="Companies" className={`nav-item ${activeView === "companies" ? "active" : ""}`} onClick={() => setActiveView("companies")}>
            <Users size={17} /><span>Companies</span>
          </button>}
          {(isAgent || isCompanyAdmin) && <button aria-label="Reports" title="Reports" className={`nav-item ${activeView === "reports" ? "active" : ""}`} onClick={() => setActiveView("reports")}>
            <BarChart3 size={17} /><span>Reports</span>
          </button>}
          <div className="nav-divider" />
          {isAgent && <>
            <div className="workspace-label">CHANNELS</div>
            <button aria-label="Email" title="Email" className={`nav-item ${activeView === "email" ? "active" : ""}`} onClick={() => setActiveView("email")}>
              <Mail size={17} /><span>Email</span><span className="connected-dot" title="Email integration status is available in administrator settings" />
            </button>
          </>}
          <button aria-label="Knowledge base" title="Knowledge base" className={`nav-item ${activeView === "knowledge" ? "active" : ""}`} onClick={() => setActiveView("knowledge")}>
            <CircleHelp size={17} /><span>Knowledge base</span><span className="soon-tag">SOON</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          {isAgent && user.isAdmin && <button aria-label="Settings" title="Settings" className={`nav-item ${activeView === "settings" ? "active" : ""}`} onClick={() => setActiveView("settings")}><Settings2 size={17} /><span>Settings</span></button>}
          <div className="sidebar-profile">
            <div className={`avatar ${isAgent ? "avatar-agent" : ""}`}>{initials(user.name)}</div>
            <div className="profile-copy"><strong>{user.name}</strong><span>{isAgent ? "Support agent" : user.companyName || "Client"}{isCompanyAdmin ? " · Admin" : ""}</span></div>
            <button className="icon-button profile-menu" onClick={signOut} title="Sign out"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{activeView === "inbox" || activeView === "assigned" ? heading : activeView[0].toUpperCase() + activeView.slice(1)}</strong></div>
          <div className="topbar-actions">
            <div className="search-box"><Search size={15} /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tickets…" /><kbd>Ctrl K</kbd></div>
            <div className="topbar-avatar">{initials(user.name)}</div>
          </div>
        </header>

        {activeView === "inbox" || activeView === "assigned" ? (
          <div className={`workbench ${selectedTicket ? "has-detail" : ""}`}>
            <section className="ticket-list-panel">
              <div className="page-heading">
                <div>
                  <div className="eyebrow"><span className="eyebrow-live" />{isAgent ? "YOUR TEAM, IN SYNC" : "WE'RE HERE TO HELP"}</div>
                  <h1>{activeView === "assigned" ? "Assigned to me" : heading}</h1>
                  <p>{isAgent ? "Stay on top of every customer conversation." : "Track your support conversations in one place."}</p>
                </div>
                <button className="button button-primary" onClick={() => { setPrefillCustomerId(null); setActionError(""); setShowCreate(true); }}><Plus size={16} /> New ticket</button>
              </div>

              {isAgent && <div className="metrics-row">
                <Metric icon={<Inbox size={15} />} label="Open tickets" value={counts.open} tone="blue" />
                <Metric icon={<Activity size={15} />} label="In progress" value={counts.in_progress} tone="violet" />
                <Metric icon={<Clock3 size={15} />} label="Waiting" value={counts.waiting} tone="amber" />
                <Metric icon={<CheckCheck size={15} />} label="Closed" value={counts.resolved} tone="green" />
              </div>}

              <div className="list-toolbar">
                <div className="filter-tabs">
                  {(["all", "open", "in_progress", "waiting", "resolved"] as const).map((value) => (
                    <button key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>
                      {value === "all" ? "All tickets" : value === "in_progress" ? "In progress" : value === "resolved" ? "Closed" : value[0].toUpperCase() + value.slice(1)}
                      {value === "all" && <span className="filter-count">{activeView === "assigned" ? counts.in_progress : tickets.length}</span>}
                    </button>
                  ))}
                </div>
                <label className="priority-filter"><span>Priority</span><select aria-label="Filter by priority" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as Priority | "all")}><option value="all">All</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
              </div>

              <div className="ticket-list">
                {filteredTickets.length === 0 ? (
                  <div className="empty-list"><Inbox size={28} /><strong>No tickets found</strong><span>Try another filter or create a new ticket.</span></div>
                ) : filteredTickets.map((ticket) => (
                  <button key={ticket.id} className={`ticket-row ${selectedId === ticket.id ? "selected" : ""}`} onClick={() => setSelectedId(ticket.id)}>
                    <div className="ticket-row-top">
                      <span className="ticket-number">#{String(ticket.id).padStart(4, "0")}</span>
                      <span className="ticket-time">{timeAgo(ticket.updatedAt)}</span>
                    </div>
                    <div className="ticket-subject">{ticket.subject}</div>
                    <div className="ticket-row-taxonomy"><span>{ticket.category}</span>{ticket.tags.slice(0, 2).map((tag) => <span className="ticket-tag" key={tag}>{tag}</span>)}</div>
                    <div className="ticket-preview">{ticket.lastMessage}</div>
                    <div className="ticket-row-bottom">
                      <div className="ticket-person">
                        <span className={`tiny-avatar ${ticket.source === "email" ? "email-avatar" : ""}`}>{initials(ticket.customer.name)}</span>
                        <span>{ticket.customer.name}</span>
                      </div>
                      <div className="ticket-row-meta"><PriorityIcon priority={ticket.priority} /><StatusPill status={ticket.status} /></div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="list-footer"><span>Showing <strong>{filteredTickets.length}</strong> of {tickets.length} tickets</span><button className="footer-refresh" onClick={() => refreshTickets()}><ArrowDownUp size={13} /> Refresh</button></div>
            </section>

            {selectedTicket ? (
              <section className="detail-panel">
                <div className="detail-heading">
                  <div className="detail-title-wrap"><span className="ticket-number">#{String(selectedTicket.id).padStart(4, "0")}</span><h2>{selectedTicket.subject}</h2></div>
                  <div className="detail-actions"><button className="icon-button" aria-label="Close ticket detail" onClick={() => setSelectedId(null)}><X size={18} /></button></div>
                </div>
                <div className="detail-statusbar">
                  <StatusPill status={selectedTicket.status} />
                  <span className="detail-status-separator" />
                  <PriorityIcon priority={selectedTicket.priority} />
                  {isAgent && <div className="status-actions">
                    <select aria-label="Update status" value={selectedTicket.status} onChange={(event) => updateTicket({ status: event.target.value as Status })}>
                      <option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="resolved">Closed</option>
                    </select>
                    <select aria-label="Update priority" value={selectedTicket.priority} onChange={(event) => updateTicket({ priority: event.target.value as Priority })}>
                      <option value="urgent">Urgent priority</option><option value="high">High priority</option><option value="normal">Normal priority</option><option value="low">Low priority</option>
                    </select>
                  </div>}
                </div>
                <div className="detail-info">
                  <div className="detail-person"><div className="avatar customer-avatar">{initials(selectedTicket.customer.name)}</div><div><strong>{selectedTicket.customer.name}</strong><span>{selectedTicket.customer.email}</span></div></div>
                  <div className="detail-info-item"><span>Created</span><strong>{timeAgo(selectedTicket.createdAt)}</strong></div>
                  {selectedTicket.company && <div className="detail-info-item"><span>Company</span><strong>{selectedTicket.company.name}</strong></div>}
                  <div className="detail-info-item"><span>Source</span><strong><span className={`source-icon ${selectedTicket.source}`} />{selectedTicket.source === "email" ? "Email" : "Portal"}</strong></div>
                  {isAgent ? <label className="detail-assignee"><div className="assignee-avatar">{selectedTicket.assignee ? initials(selectedTicket.assignee.name) : <UserRound size={14} />}</div><select aria-label="Assign ticket to agent" value={selectedTicket.assignee?.id ?? ""} onChange={(event) => updateTicket({ assigneeId: event.target.value ? Number(event.target.value) : null })}><option value="">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.priorityLabel} · {agent.name}</option>)}</select><ChevronDown size={13} /></label>
                    : <div className="detail-assignee"><div className="assignee-avatar">{selectedTicket.assignee ? initials(selectedTicket.assignee.name) : <UserRound size={14} />}</div><span>{selectedTicket.assignee?.name || "Unassigned"}</span></div>}
                </div>
                <TicketMetadataEditor
                  key={selectedTicket.id}
                  ticket={selectedTicket}
                  categories={detail?.categories || ["Account access", "Billing", "Technical support", "Feature request", "Other"]}
                  canEdit={isAgent}
                  onSave={(metadata) => updateTicket(metadata)}
                />
                {(selectedTicket.isFirstResponseOverdue || selectedTicket.isResolutionOverdue) && <div className="detail-sla detail-sla-overdue" role="status">
                  <Clock3 size={14} /><strong>SLA overdue</strong>
                  {selectedTicket.isFirstResponseOverdue && <span>First response target missed</span>}
                  {selectedTicket.isResolutionOverdue && <span>Resolution target missed</span>}
                </div>}
                {!selectedTicket.isFirstResponseOverdue && !selectedTicket.isResolutionOverdue && selectedTicket.status !== "resolved" && <div className="detail-sla">
                  <Clock3 size={14} /><span>First response by {new Date(selectedTicket.firstResponseDueAt).toLocaleString()}</span><span>Resolve by {new Date(selectedTicket.resolutionDueAt).toLocaleString()}</span>
                </div>}
                {detail?.assignmentHistory.length ? <section className="assignment-history" aria-label="Assignment history">
                  <strong>Assignment history</strong>
                  {detail.assignmentHistory.map((entry) => <span key={entry.id}>
                    {entry.agentName}{entry.assignedByName ? ` · assigned by ${entry.assignedByName}` : " · automatic assignment"} · {timeAgo(entry.createdAt)}
                  </span>)}
                </section> : null}
                <div className="conversation-heading"><span>CONVERSATION</span><span>{detail?.messages.length ?? 0} messages</span></div>
                {detail?.attachments.length ? <div className="attachment-list" aria-label="Ticket attachments">
                  {detail.attachments.map((attachment) => <a key={attachment.id} className="ticket-attachment" href={`/api/tickets/${selectedTicket.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                    <span className="attachment-icon"><Paperclip size={14} /></span><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span><Download size={14} />
                  </a>)}
                </div> : null}
                {isAgent && <div className="internal-note-notice"><ShieldCheck size={13} /><span>Internal notes are visible only to support agents.</span></div>}
                <div className="conversation">
                  {detail?.messages.map((message, index) => {
                    const fromAgent = message.authorRole === "agent";
                    return <article key={message.id} className={`message ${fromAgent ? "message-agent" : ""} ${message.isInternal ? "message-internal" : ""}`}>
                      <div className={`message-avatar ${fromAgent ? "agent-message-avatar" : ""}`}>{initials(message.authorName)}</div>
                      <div className="message-content">
                        <div className="message-meta"><strong>{message.authorName}</strong>{message.isInternal ? <span className="internal-note-badge">INTERNAL NOTE</span> : fromAgent && <span className="agent-badge">SUPPORT</span>}<time>{timeAgo(message.createdAt)}</time>{index === 0 && !message.isInternal && <span className="original-label">Original request</span>}</div>
                        <p>{message.body}</p>
                      </div>
                    </article>;
                  })}
                </div>
                {!isAgent && detail?.canRate && <CustomerRatingForm
                  key={selectedTicket.id}
                  rating={selectedTicket.rating}
                  onSubmit={async (rating, comment) => {
                    const result = await api<{ rating: NonNullable<Ticket["rating"]> }>(`/tickets/${selectedTicket.id}/rating`, {
                      method: "POST", body: JSON.stringify({ rating, comment }),
                    });
                    setDetail((current) => current ? { ...current, ticket: { ...current.ticket, rating: result.rating } } : current);
                  }}
                />}
                <div className="reply-wrap">
                  {actionError && <div className="inline-error">{actionError}<button onClick={() => setActionError("")}><X size={13} /></button></div>}
                  {actionMessage && <div className="inline-success">{actionMessage}<button onClick={() => setActionMessage("")}><X size={13} /></button></div>}
                  {isAgent && <div className="reply-mode-toggle" role="group" aria-label="Reply type">
                    <button type="button" className={!replyInternal ? "selected" : ""} onClick={() => setReplyInternal(false)}>Reply to customer</button>
                    <button type="button" className={replyInternal ? "selected" : ""} onClick={() => setReplyInternal(true)}>Internal note</button>
                  </div>}
                  <form className="reply-composer" onSubmit={sendReply}>
                    <textarea name="reply" placeholder={isAgent ? (replyInternal ? "Write an internal note for the support team…" : "Write a reply to the customer…") : "Reply to this conversation…"} maxLength={5000} required />
                    <div className="composer-footer"><span>{replyInternal ? <><ShieldCheck size={14} /> Only support agents can see this note</> : <><Sparkles size={14} /> Replies are visible to the customer</>}</span><button className="button button-primary send-button" type="submit">{replyInternal ? "Add note" : "Send reply"} <Send size={14} /></button></div>
                  </form>
                </div>
              </section>
            ) : (
              <section className="detail-placeholder"><div className="placeholder-art"><MessageCircle size={30} /></div><strong>Select a ticket</strong><span>Choose a conversation to see the full story.</span></section>
            )}
          </div>
        ) : (
          activeView === "customers" && isAgent
            ? <CustomerDirectory
              customers={customers}
              tickets={tickets}
              onCreateTicket={(customerId) => { setPrefillCustomerId(customerId); setShowCreate(true); setActionError(""); }}
              onViewTickets={(customerName) => { setSearch(customerName); setActiveView("inbox"); setFilter("all"); }}
            />
            : activeView === "notifications" && isAgent
              ? <NotificationCenter
                notifications={notifications}
                onOpen={async (notification) => {
                  if (!notification.readAt) {
                    await api("/notifications/read", { method: "POST", body: JSON.stringify({ id: notification.id }) });
                    await refreshNotifications();
                  }
                  setSelectedId(notification.ticketId);
                  setActiveView("inbox");
                }}
              />
              : activeView === "reports" && (isAgent || isCompanyAdmin)
                ? <AnalyticsDashboard workspaceWide={isAgent} />
                : activeView === "settings" && isAgent && user.isAdmin
                ? <AdminSettings onChanged={async () => {
                  await refreshTickets();
                  const result = await api<{ agents: Customer[] }>("/agents");
                  setAgents(result.agents);
                }} />
                : (activeView === "companies" && isAgent && user.isAdmin) || (activeView === "company-users" && isCompanyAdmin)
                  ? <CompanyManagement
                    workspaceAdmin={isAgent && Boolean(user.isAdmin)}
                    initialCompanyId={user.role === "customer" ? user.companyId || null : null}
                    onChanged={async () => {
                      await refreshTickets();
                      if (isAgent) {
                        const [customerResult, agentResult] = await Promise.all([
                          api<{ customers: Customer[] }>("/customers"),
                          api<{ agents: Customer[] }>("/agents"),
                        ]);
                        setCustomers(customerResult.customers);
                        setAgents(agentResult.agents);
                      }
                    }}
                  />
            : <FeaturePlaceholder view={activeView} />
        )}
      </main>

      {showCreate && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowCreate(false); setPrefillCustomerId(null); } }}>
        <form className="create-modal" onSubmit={createTicket}>
          <div className="modal-heading"><div><div className="eyebrow">SUPPORT REQUEST</div><h2>Create a ticket</h2></div><button type="button" className="icon-button" onClick={() => { setShowCreate(false); setPrefillCustomerId(null); }} aria-label="Close"><X size={18} /></button></div>
          {isAgent && <label>Customer<select name="customerId" required value={prefillCustomerId ?? ""} onChange={(event) => setPrefillCustomerId(event.target.value ? Number(event.target.value) : null)}><option value="" disabled>Select a customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.companyName ? `${customer.companyName} · ` : ""}{customer.name} · {customer.email}</option>)}</select></label>}
          {!isAgent && <label>Send to an agent (optional)<select name="assigneeId" defaultValue=""><option value="">Auto-assign by support priority</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.priorityLabel} · {agent.name}</option>)}</select><span className="form-hint">Choose a preferred agent or leave automatic assignment on. The support team’s primary-to-secondary order is used first.</span></label>}
          <label>Subject<input name="subject" required minLength={4} maxLength={160} placeholder="What do you need help with?" autoFocus /></label>
          <label>Description<textarea name="description" required minLength={10} maxLength={5000} placeholder="Share a few details so we can help…" rows={5} /></label>
          <label>Category<select name="category" defaultValue="Other"><option>Account access</option><option>Billing</option><option>Technical support</option><option>Feature request</option><option>Other</option></select></label>
          <label>Tags (optional)<input name="tags" maxLength={320} placeholder="e.g. login, urgent follow-up" /><span className="form-hint">Separate up to 10 tags with commas.</span></label>
          <CustomFieldsEditor fields={createCustomFields} onChange={setCreateCustomFields} />
          <label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
          <label>Attachments<input name="attachments" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" /><span className="form-hint">Up to 5 PDF or image files, 10 MB each.</span></label>
          {actionError && <div className="inline-error">{actionError}</div>}
          <div className="modal-footer"><button type="button" className="button button-quiet" onClick={() => { setShowCreate(false); setPrefillCustomerId(null); }}>Cancel</button><button className="button button-primary" type="submit"><Plus size={15} /> Create ticket</button></div>
        </form>
      </div>}
    </div>
  );
}

function AnalyticsDashboard({ workspaceWide }: { workspaceWide: boolean }) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoadingReport(true);
    setError("");
    setReport(null);
    api<AnalyticsReport>(`/reports?days=${days}`)
      .then((result) => { if (active) setReport(result); })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoadingReport(false); });
    return () => { active = false; };
  }, [days]);

  function exportReport() {
    if (!report) return;
    const rows: Array<Array<string | number>> = [
      ["Jishnu Infotech Support Report", `${report.startDate} to ${report.endDate}`],
      ["Scope", workspaceWide ? "All client companies" : "Your company"],
      ["Tickets created", report.summary.created],
      ["Active backlog", report.summary.activeBacklog],
      ["Active tickets created in period", report.summary.activeInPeriod],
      ["First response SLA on time", `${report.sla.firstResponse.onTime}/${report.sla.firstResponse.evaluated}`],
      ["Resolution SLA on time", `${report.sla.resolution.onTime}/${report.sla.resolution.evaluated}`],
      [],
      ["Daily activity", "Created", "Closed"],
      ...report.daily.map((entry) => [entry.day, entry.created, entry.resolved]),
      [],
      ["Status", "Tickets created in period"],
      ...report.statuses.map((entry) => [entry.status === "resolved" ? "closed" : entry.status, entry.count]),
      [],
      ["Priority", "Tickets created in period"],
      ...report.priorities.map((entry) => [entry.priority, entry.count]),
      [],
      ["Channel", "Tickets created in period"],
      ...report.sources.map((entry) => [entry.source, entry.count]),
      [],
      ["Agent", "Active assigned tickets", "Assigned in period", "Closed in period"],
      ...report.agentWorkload.map((entry) => [entry.name, entry.active, entry.assignedInPeriod, entry.resolvedInPeriod]),
      [],
      ["Company", "Client user", "Email", "Tickets raised", "Active", "In progress", "Closed in period"],
      ...report.customerActivity.map((entry) => [entry.companyName || "", entry.name, entry.email, entry.raisedInPeriod, entry.active, entry.inProgress, entry.resolvedInPeriod]),
      ...(workspaceWide ? [[], ["Company", "Tickets created in period"], ...report.companyVolume.map((entry) => [entry.name, entry.count])] : []),
    ];
    const csv = rows.map((row) => row.map((value) => {
      const text = String(value);
      const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    }).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `jishnu-support-report-${report.startDate}-to-${report.endDate}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const resolvedInPeriod = report?.daily.reduce((total, entry) => total + entry.resolved, 0) || 0;
  const maxDaily = Math.max(1, ...(report?.daily.map((entry) => Math.max(entry.created, entry.resolved)) || [0]));

  return <section className="feature-page report-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow"><span className="eyebrow-live" />{workspaceWide ? "SUPPORT WORKSPACE" : "COMPANY SUPPORT"}</div>
        <h1>Reports &amp; analytics</h1>
        <p>{workspaceWide ? "Track ticket volume, service targets, and team workload." : "See your company's support activity and service targets."}</p>
      </div>
      <button className="button button-quiet" onClick={exportReport} disabled={!report}><Download size={14} /> Export CSV</button>
    </div>
    <div className="report-toolbar">
      <label>Reporting period
        <select aria-label="Reporting period" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </label>
      {report && <span>{report.startDate} – {report.endDate}</span>}
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loadingReport ? <div className="report-loading" role="status">Loading report…</div> : report && <>
      <div className="report-metric-grid">
        <ReportMetric icon={<Inbox size={16} />} label="Tickets created" value={report.summary.created} tone="blue" caption={`In the last ${report.days} days`} />
        <ReportMetric icon={<Activity size={16} />} label="Active backlog" value={report.summary.activeBacklog} tone="amber" caption="Open across this report's scope" />
        <ReportMetric icon={<CheckCheck size={16} />} label="Closed" value={resolvedInPeriod} tone="green" caption="Closed during this period" />
        <ReportMetric icon={<Clock3 size={16} />} label="Still active" value={report.summary.activeInPeriod} tone="violet" caption="From tickets created in this period" />
      </div>
      <div className="report-grid">
        <section className="report-card report-trend-card">
          <div className="report-card-heading"><div><h2>Ticket activity</h2><p>Created and closed each day</p></div><span>{report.days} days</span></div>
          <div className="report-chart-legend"><span><i className="legend-created" />Created</span><span><i className="legend-resolved" />Closed</span></div>
          <div className="report-trend-chart" role="img" aria-label={`Daily ticket activity over ${report.days} days`}>
            {report.daily.map((entry) => <div className="report-trend-day" key={entry.day} title={`${entry.day}: ${entry.created} created, ${entry.resolved} closed`} aria-label={`${entry.day}: ${entry.created} created, ${entry.resolved} closed`}>
              <div className="report-bar-pair">
                <span className="report-bar-created" style={{ height: `${Math.max(3, entry.created / maxDaily * 112)}px` }} />
                <span className="report-bar-resolved" style={{ height: `${Math.max(3, entry.resolved / maxDaily * 112)}px` }} />
              </div>
              {(report.days <= 7 || entry.day.endsWith("-01") || entry.day.endsWith("-15")) && <small>{entry.day.slice(5)}</small>}
            </div>)}
          </div>
        </section>
        <section className="report-card report-sla-card">
          <div className="report-card-heading"><div><h2>Service-level performance</h2><p>Based on configured elapsed-hour targets</p></div><Clock3 size={16} /></div>
          <ReportSla label="First response" metric={report.sla.firstResponse} />
          <ReportSla label="Resolution" metric={report.sla.resolution} />
          <p className="report-footnote">Unresolved tickets enter the calculation after their target has elapsed.</p>
        </section>
        <ReportBreakdown title="Ticket status" subtitle="Current status of tickets opened in this period" rows={report.statuses.map((entry) => ({
          label: entry.status === "in_progress" ? "In progress" : entry.status === "resolved" ? "Closed" : entry.status[0].toUpperCase() + entry.status.slice(1),
          count: entry.count, tone: entry.status,
        }))} />
        <ReportBreakdown title="Priority mix" subtitle="Priority selected when tickets were opened" rows={report.priorities.map((entry) => ({
          label: entry.priority[0].toUpperCase() + entry.priority.slice(1), count: entry.count, tone: entry.priority,
        }))} />
        <section className="report-card">
          <div className="report-card-heading"><div><h2>Support channel</h2><p>Where tickets in this period came from</p></div><Mail size={16} /></div>
          {report.sources.map((entry) => <div className="report-source-row" key={entry.source}><span><i className={`source-icon ${entry.source}`} />{entry.source === "email" ? "Email" : "Client portal"}</span><strong>{entry.count}</strong></div>)}
        </section>
        <section className="report-card report-wide-card">
          <div className="report-card-heading"><div><h2>Agent workload &amp; closures</h2><p>Current backlog, tickets assigned, and tickets closed by each agent</p></div><Users size={16} /></div>
          {report.agentWorkload.length ? <div className="report-table-wrap"><table className="report-data-table"><thead><tr><th>Priority</th><th>Agent</th><th>Active</th><th>Assigned</th><th>Closed</th></tr></thead><tbody>
            {report.agentWorkload.map((entry) => <tr key={entry.id}><td>{entry.routingPriority === 1 ? "Primary" : entry.routingPriority === 2 ? "Secondary" : `#${entry.routingPriority}`}</td><td>{entry.name}</td><td>{entry.active}</td><td>{entry.assignedInPeriod}</td><td>{entry.resolvedInPeriod}</td></tr>)}
          </tbody></table></div> : <p className="report-empty">No active agents to report.</p>}
        </section>
        {report.customerActivity.length > 0 && <section className="report-card report-wide-card">
          <div className="report-card-heading"><div><h2>Client ticket activity</h2><p>Ticket ownership and progress by client user in this report’s scope</p></div><Users size={16} /></div>
          <div className="report-table-wrap"><table className="report-data-table"><thead><tr><th>Company</th><th>Client user</th><th>Email</th><th>Raised</th><th>Active</th><th>In progress</th><th>Closed</th></tr></thead><tbody>
            {report.customerActivity.map((entry) => <tr key={entry.id}><td>{entry.companyName || "—"}</td><td>{entry.name}</td><td>{entry.email}</td><td>{entry.raisedInPeriod}</td><td>{entry.active}</td><td>{entry.inProgress}</td><td>{entry.resolvedInPeriod}</td></tr>)}
          </tbody></table></div>
        </section>}
        {workspaceWide && <section className="report-card">
          <div className="report-card-heading"><div><h2>Company volume</h2><p>Top companies by new tickets this period</p></div><Users size={16} /></div>
          {report.companyVolume.length ? <div className="report-ranked-list">{report.companyVolume.map((entry) => {
            const maxCount = Math.max(1, ...report.companyVolume.map((item) => item.count));
            return <div className="report-ranked-row" key={entry.name}>
              <span>{entry.name}</span><div className="report-rank-track"><i style={{ width: `${entry.count / maxCount * 100}%` }} /></div><strong>{entry.count}</strong>
            </div>;
          })}</div> : <p className="report-empty">No new tickets in this period.</p>}
        </section>}
      </div>
    </>}
  </section>;
}

function ReportMetric({ icon, label, value, tone, caption }: { icon: ReactNode; label: string; value: number; tone: string; caption: string }) {
  return <div className="report-metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{caption}</small></div></div>;
}

function ReportSla({ label, metric }: {
  label: string;
  metric: { onTime: number; evaluated: number; targetHours: number };
}) {
  const percentage = metric.evaluated ? Math.round(metric.onTime / metric.evaluated * 100) : null;
  return <div className="report-sla-row">
    <div><strong>{label}</strong><span>{metric.evaluated ? `${metric.onTime} of ${metric.evaluated} on time` : "No evaluated tickets yet"} · {metric.targetHours}h target</span></div>
    <strong className={percentage !== null && percentage < 80 ? "report-sla-low" : ""}>{percentage === null ? "—" : `${percentage}%`}</strong>
  </div>;
}

function ReportBreakdown({ title, subtitle, rows }: {
  title: string; subtitle: string; rows: Array<{ label: string; count: number; tone: string }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return <section className="report-card">
    <div className="report-card-heading"><div><h2>{title}</h2><p>{subtitle}</p></div></div>
    {rows.map((row) => <div className="report-breakdown-row" key={row.label}>
      <span className="report-breakdown-label"><i className={`report-dot ${row.tone}`} />{row.label}</span>
      <div className="report-breakdown-track"><i className={row.tone} style={{ width: `${total ? row.count / total * 100 : 0}%` }} /></div>
      <strong>{row.count}</strong>
    </div>)}
    {!total && <p className="report-empty">No tickets in this period.</p>}
  </section>;
}

function CustomFieldsEditor({ fields, onChange }: {
  fields: Record<string, string>;
  onChange: (fields: Record<string, string>) => void;
}) {
  const entries = Object.entries(fields);
  function updateEntry(index: number, key: string, value: string) {
    const updated = [...entries];
    const previous = updated[index];
    updated[index] = [key, value];
    const next = Object.fromEntries(updated.filter((entry) => entry[0] || entry[1]));
    if (!key && value) next[`Field ${index + 1}`] = value;
    if (previous[0] && previous[0] !== key) delete next[previous[0]];
    onChange(next);
  }
  return <fieldset className="custom-fields-editor">
    <legend>Custom fields (optional)</legend>
    {entries.map(([key, value], index) => <div className="custom-field-input-row" key={`${index}-${key}`}>
      <input aria-label={`Custom field ${index + 1} name`} value={key.startsWith("Field ") && !value ? "" : key}
        placeholder="Field name" maxLength={40} onChange={(event) => updateEntry(index, event.target.value, value)} />
      <input aria-label={`Custom field ${index + 1} value`} value={value} placeholder="Value" maxLength={500}
        onChange={(event) => updateEntry(index, key, event.target.value)} />
      <button type="button" className="icon-button" aria-label={`Remove custom field ${index + 1}`}
        onClick={() => onChange(Object.fromEntries(entries.filter((_, itemIndex) => itemIndex !== index)))}><X size={14} /></button>
    </div>)}
    {entries.length < 10 && <button type="button" className="custom-field-add" onClick={() => onChange({ ...fields, [`Field ${entries.length + 1}`]: "" })}>
      <Plus size={13} /> Add custom field
    </button>}
  </fieldset>;
}

function TicketMetadataEditor({ ticket, categories, canEdit, onSave }: {
  ticket: Ticket;
  categories: TicketCategory[];
  canEdit: boolean;
  onSave: (metadata: { category: TicketCategory; tags: string[]; customFields: Record<string, string> }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState<TicketCategory>(ticket.category);
  const [tags, setTags] = useState(ticket.tags.join(", "));
  const [customFields, setCustomFields] = useState(ticket.customFields);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave({ category, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), customFields });
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update ticket details.");
    } finally {
      setSaving(false);
    }
  }

  return <section className={`ticket-metadata ${editing ? "ticket-metadata-editing" : ""}`}>
    <div className="ticket-metadata-heading"><strong>Details</strong>{canEdit && <button type="button" onClick={() => { setError(""); setEditing((value) => !value); }}>{editing ? "Cancel" : "Edit details"}</button>}</div>
    {editing ? <form className="ticket-metadata-form" onSubmit={save}>
      <label>Category<select value={category} onChange={(event) => setCategory(event.target.value as TicketCategory)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} maxLength={320} placeholder="Separate tags with commas" /></label>
      <CustomFieldsEditor fields={customFields} onChange={setCustomFields} />
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button className="button button-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save details"}</button>
    </form> : <div className="ticket-metadata-content">
      <span className="category-chip">{ticket.category}</span>
      {ticket.tags.map((tag) => <span className="ticket-tag" key={tag}>{tag}</span>)}
      {Object.entries(ticket.customFields).map(([key, value]) => <span className="custom-field-value" key={key}><strong>{key}:</strong> {value}</span>)}
      {!ticket.tags.length && !Object.keys(ticket.customFields).length && <span className="metadata-empty">No tags or custom fields</span>}
    </div>}
  </section>;
}

function CustomerRatingForm({ rating, onSubmit }: {
  rating: Ticket["rating"];
  onSubmit: (rating: number, comment: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(Boolean(rating));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await onSubmit(selected, comment);
      setSubmitted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not submit your feedback.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="customer-rating">
    <div className="customer-rating-heading"><strong>How was your support experience?</strong><span>Your feedback helps us improve.</span></div>
    {submitted && rating ? <div className="rating-result" aria-label={`Submitted rating: ${rating.rating} out of 5`}>
      <span className="rating-stars">{Array.from({ length: 5 }, (_, index) => <span key={index} className={index < rating.rating ? "filled" : ""}>★</span>)}</span>
      <span>Thank you for your feedback.</span>{rating.comment && <p>{rating.comment}</p>}
    </div> : <form onSubmit={submit}>
      <div className="rating-star-picker" role="radiogroup" aria-label="Rate your support experience">
        {[1, 2, 3, 4, 5].map((value) => <button type="button" role="radio" aria-checked={selected === value} aria-label={`${value} out of 5 stars`}
          className={selected >= value ? "selected" : ""} key={value} onClick={() => setSelected(value)}>★</button>)}
      </div>
      <label className="rating-comment-label">Comment (optional)<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} rows={2} placeholder="Tell us a little more…" /></label>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button className="button button-primary" type="submit" disabled={!selected || saving}>{saving ? "Submitting…" : "Submit feedback"}</button>
    </form>}
  </section>;
}

function Metric({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{String(value).padStart(2, "0")}</strong></div></div>;
}

function CompanyManagement({ workspaceAdmin, initialCompanyId, onChanged }: {
  workspaceAdmin: boolean;
  initialCompanyId: number | null;
  onChanged: () => Promise<void>;
}) {
  type CompanyUser = {
    id: number; name: string; email: string; isCompanyAdmin: boolean;
    approvalStatus: "approved" | "pending" | "rejected"; disabledAt: string | null;
  };
  type JoinCode = { id: number; expiresAt: string | null; revokedAt: string | null; createdAt: string };
  const [companies, setCompanies] = useState<Array<Company & { userCount: number; pendingCount: number }>>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(initialCompanyId);
  const [companyName, setCompanyName] = useState("");
  const [companyDomain, setCompanyDomain] = useState("");
  const [firstAdminEmail, setFirstAdminEmail] = useState("");
  const [companyUsers, setCompanyUsers] = useState<CompanyUser[]>([]);
  const [invitations, setInvitations] = useState<Array<{ id: number; email: string; isCompanyAdmin: boolean; expiresAt: string }>>([]);
  const [joinCodes, setJoinCodes] = useState<JoinCode[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteAsAdmin, setInviteAsAdmin] = useState(false);
  const [createdJoinCode, setCreatedJoinCode] = useState("");
  const [invitationUrl, setInvitationUrl] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadCompanies = useCallback(async () => {
    if (!workspaceAdmin) return;
    const result = await api<{ companies: typeof companies }>("/admin/companies");
    setCompanies(result.companies);
    setSelectedCompanyId((current) => current && result.companies.some((company) => company.id === current)
      ? current : initialCompanyId || result.companies[0]?.id || null);
  }, [initialCompanyId, workspaceAdmin]);

  const loadCompanyUsers = useCallback(async () => {
    if (!selectedCompanyId) return;
    const result = await api<{
      users: CompanyUser[];
      invitations: typeof invitations;
      joinCodes: JoinCode[];
    }>(`/company/users?companyId=${selectedCompanyId}`);
    setCompanyUsers(result.users);
    setInvitations(result.invitations);
    setJoinCodes(result.joinCodes);
  }, [selectedCompanyId]);

  useEffect(() => { loadCompanies().catch((reason: Error) => setError(reason.message)); }, [loadCompanies]);
  useEffect(() => { loadCompanyUsers().catch((reason: Error) => setError(reason.message)); }, [loadCompanyUsers]);

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setInvitationUrl("");
    try {
      const result = await api<{ company: Company; invitation: { email: string; invitationUrl?: string } }>("/admin/companies", {
        method: "POST",
        body: JSON.stringify({ name: companyName, domain: companyDomain, adminEmail: firstAdminEmail }),
      });
      setSelectedCompanyId(result.company.id);
      setCompanyName("");
      setCompanyDomain("");
      setFirstAdminEmail("");
      setInvitationUrl(result.invitation.invitationUrl || "");
      setMessage(`Created ${result.company.name} and invited ${result.invitation.email} as company administrator.`);
      await loadCompanies();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create company."); }
  }

  async function inviteUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const result = await api<{ invitation: { email: string; invitationUrl?: string } }>("/company/invitations", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, isCompanyAdmin: inviteAsAdmin, companyId: selectedCompanyId }),
      });
      setInviteEmail("");
      setInviteAsAdmin(false);
      setInvitationUrl(result.invitation.invitationUrl || "");
      setMessage(`Invitation created for ${result.invitation.email}.`);
      await loadCompanyUsers();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not invite this user."); }
  }

  async function createJoinCode() {
    setError("");
    setMessage("");
    try {
      const result = await api<{ code: string }>("/company/join-codes", {
        method: "POST", body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      setCreatedJoinCode(result.code);
      setMessage("Share this 30-day code with your colleagues. It is only displayed once.");
      await loadCompanyUsers();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create invitation code."); }
  }

  async function updateUser(user: CompanyUser, changes: { approvalStatus?: "approved" | "rejected"; isCompanyAdmin?: boolean; disabled?: boolean }) {
    setError("");
    setMessage("");
    try {
      await api(`/company/users/${user.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      await Promise.all([loadCompanyUsers(), loadCompanies(), onChanged()]);
      setMessage(changes.approvalStatus === "approved" ? `${user.name} approved to join the company.`
        : changes.approvalStatus === "rejected" ? `${user.name}'s request was declined.`
          : changes.disabled !== undefined ? `${user.name} access updated.` : `${user.name}'s company role updated.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update client account."); }
  }

  async function revokeCode(code: JoinCode) {
    setError("");
    try {
      await api(`/company/join-codes/${code.id}`, { method: "DELETE" });
      await loadCompanyUsers();
      setMessage("Company invitation code revoked.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not revoke invitation code."); }
  }

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);
  return <section className="feature-page company-management">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />{workspaceAdmin ? "JISHNU INFOTECH ADMINISTRATION" : "COMPANY ADMINISTRATION"}</div><h1>{workspaceAdmin ? "Client companies" : "Company users"}</h1><p>{workspaceAdmin ? "Create isolated client workspaces and manage their access." : `Manage users and enrollment for ${companies.find((company) => company.id === selectedCompanyId)?.name || "your company"}.`}</p></div></div>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button onClick={() => setMessage("")}><X size={13} /></button></div>}
    {invitationUrl && <p className="development-link">Development invitation link: <a href={invitationUrl}>{invitationUrl}</a></p>}

    {workspaceAdmin && <section className="settings-card">
      <div className="settings-card-heading"><div><h2>Create a client company</h2><p>Each company has isolated client accounts and tickets. Its first administrator receives an invitation.</p></div><Plus size={18} /></div>
      <form className="company-create-form" onSubmit={createCompany}>
        <label>Company name<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} minLength={2} maxLength={120} required /></label>
        <label>Company email domain (optional)<input value={companyDomain} onChange={(event) => setCompanyDomain(event.target.value)} placeholder="client.example" /><span className="form-hint">Used to match inbound email; enter only a domain you have verified with the company.</span></label>
        <label>First company admin email<input type="email" value={firstAdminEmail} onChange={(event) => setFirstAdminEmail(event.target.value)} required /></label>
        <button className="button button-primary" type="submit"><Plus size={15} /> Create company</button>
      </form>
      <div className="company-list">
        {companies.map((company) => <button type="button" className={`company-select-row ${company.id === selectedCompanyId ? "selected" : ""}`} key={company.id} onClick={() => setSelectedCompanyId(company.id)}>
          <span><strong>{company.name}</strong><small>{company.domain || "No email domain mapped"} · {company.userCount} users · {company.pendingCount} pending</small></span><ArrowRight size={15} />
        </button>)}
      </div>
    </section>}

    {selectedCompanyId && <section className="settings-card">
      <div className="settings-card-heading"><div><h2>{selectedCompany?.name || "Team access"}</h2><p>Invite colleagues, generate reusable company codes, or review sign-up requests.</p></div><Users size={18} /></div>
      <form className="invite-form" onSubmit={inviteUser}>
        <label htmlFor="company-user-email">Invite a user</label>
        <div><input id="company-user-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="colleague@company.com" required />
          {workspaceAdmin && <label className="checkbox-label"><input type="checkbox" checked={inviteAsAdmin} onChange={(event) => setInviteAsAdmin(event.target.checked)} /> Company admin</label>}
          <button className="button button-primary" type="submit"><Plus size={15} /> Invite</button>
        </div>
      </form>

      {companyUsers.some((user) => user.approvalStatus === "pending") && <div className="company-users-section">
        <h3>Requests awaiting approval</h3>
        {companyUsers.filter((user) => user.approvalStatus === "pending").map((user) => <div className="admin-team-row" key={user.id}>
          <div className="directory-customer"><strong>{user.name}</strong><span>{user.email}</span></div>
          <button className="button button-primary" onClick={() => updateUser(user, { approvalStatus: "approved" })}>Approve</button>
          <button className="button button-quiet" onClick={() => updateUser(user, { approvalStatus: "rejected" })}>Decline</button>
        </div>)}
      </div>}

      <div className="company-users-section"><h3>Company members</h3>
        {companyUsers.filter((user) => user.approvalStatus !== "pending").map((user) => <div className="admin-team-row" key={user.id}>
          <div className="avatar customer-avatar">{initials(user.name)}</div>
          <div className="directory-customer"><strong>{user.name}{user.isCompanyAdmin && <span className="admin-badge">COMPANY ADMIN</span>}</strong><span>{user.email}</span></div>
          <span className={`team-state ${user.disabledAt || user.approvalStatus === "rejected" ? "team-disabled" : ""}`}>{user.approvalStatus === "rejected" ? "Declined" : user.disabledAt ? "Disabled" : "Active"}</span>
          {(workspaceAdmin || !user.isCompanyAdmin) && user.approvalStatus === "approved" && <button className="button button-quiet" onClick={() => updateUser(user, { isCompanyAdmin: !user.isCompanyAdmin })}>{user.isCompanyAdmin ? "Remove admin" : "Make admin"}</button>}
          <button className="button button-quiet" onClick={() => updateUser(user, { disabled: !user.disabledAt })}>{user.disabledAt ? "Enable" : "Disable"}</button>
        </div>)}
        {companyUsers.length === 0 && <p className="settings-hint">No client users have joined this company yet.</p>}
      </div>

      <div className="company-users-section">
        <div className="settings-card-heading"><div><h3>Company invitation codes</h3><p>Codes admit users directly to this company and expire after 30 days.</p></div><button className="button button-quiet" onClick={createJoinCode}>Generate code</button></div>
        {createdJoinCode && <div className="join-code-copy" role="status"><strong>New code</strong><code>{createdJoinCode}</code><span>Copy it now; it will not be shown again.</span></div>}
        {joinCodes.map((code) => <div className="join-code-row" key={code.id}><span>{code.revokedAt ? "Revoked" : "Active"} · {code.expiresAt ? `expires ${new Date(code.expiresAt).toLocaleDateString()}` : "no expiry"}</span>{!code.revokedAt && <button className="button button-quiet" onClick={() => revokeCode(code)}>Revoke</button>}</div>)}
      </div>

      {invitations.length > 0 && <div className="pending-invitations"><strong>Pending user invitations</strong>{invitations.map((invitation) => <div key={invitation.id}><span>{invitation.email}{invitation.isCompanyAdmin ? " · Company admin" : ""}</span><small>Expires {new Date(invitation.expiresAt).toLocaleString()}</small></div>)}</div>}
    </section>}
  </section>;
}

function NotificationCenter({ notifications, onOpen }: {
  notifications: Notification[];
  onOpen: (notification: Notification) => void;
}) {
  return <section className="feature-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />AGENT WORKSPACE</div><h1>Notifications</h1><p>Ticket replies and service-level alerts assigned to you.</p></div></div>
    <div className="directory-list">
      {notifications.length === 0
        ? <div className="empty-list"><Bell size={27} /><strong>You're all caught up</strong><span>New ticket alerts will show here.</span></div>
        : notifications.map((notification) => <button type="button" className={`notification-row ${notification.readAt ? "" : "notification-unread"}`} key={notification.id} onClick={() => onOpen(notification)}>
          <span className="notification-indicator" /><span className="notification-copy"><strong>{notification.message}</strong><small>Ticket #{notification.ticketId} · {timeAgo(notification.createdAt)}</small></span><ArrowRight size={16} />
        </button>)}
    </div>
  </section>;
}

function AdminSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const [agents, setAgents] = useState<Array<{ id: number; name: string; email: string; isAdmin: boolean; routingPriority: number; disabledAt: string | null }>>([]);
  const [invitations, setInvitations] = useState<Array<{ id: number; email: string; expiresAt: string }>>([]);
  const [sla, setSla] = useState({ firstResponseHours: 4, resolutionHours: 48 });
  const [emailStatus, setEmailStatus] = useState<{
    smtpConfigured: boolean; imapConfigured: boolean; smtpHost: string | null; inboundMailbox: string | null;
    outbox: Record<string, number>; recentFailures: Array<{ recipient: string; error: string; status: string; attempts: number; createdAt: string }>;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [invitationUrl, setInvitationUrl] = useState("");

  const load = useCallback(async () => {
    const [team, slaResult, emailResult] = await Promise.all([
      api<{ agents: typeof agents; invitations: typeof invitations }>("/admin/agents"),
      api<{ sla: typeof sla }>("/admin/sla-settings"),
      api<typeof emailStatus>("/admin/email-status"),
    ]);
    setAgents(team.agents);
    setInvitations(team.invitations);
    setSla(slaResult.sla);
    setEmailStatus(emailResult);
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    const form = new FormData(formElement);
    try {
      const result = await api<{ invitation: { email: string; emailSent: boolean; invitationUrl?: string } }>("/agent-invitations", {
        method: "POST", body: JSON.stringify({ email: form.get("email") }),
      });
      setMessage(result.invitation.emailSent ? `Invitation email sent to ${result.invitation.email}.` : `Invitation created for ${result.invitation.email}.`);
      setInvitationUrl(result.invitation.invitationUrl || "");
      formElement.reset();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not invite this agent."); }
  }

  async function saveSla(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const result = await api<{ sla: typeof sla }>("/admin/sla-settings", { method: "PUT", body: JSON.stringify(sla) });
      setSla(result.sla);
      setMessage("Service-level targets saved. Deadlines use elapsed hours, including weekends.");
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save service-level targets."); }
  }

  async function toggleAgent(agent: typeof agents[number]) {
    setError("");
    setMessage("");
    try {
      await api(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !agent.disabledAt }) });
      await load();
      await onChanged();
      setMessage(agent.disabledAt ? `${agent.name} re-enabled.` : `${agent.name} disabled and open assignments released.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update agent access."); }
  }

  async function moveAgent(agent: typeof agents[number], offset: number) {
    setError("");
    setMessage("");
    try {
      await api(`/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ routingPriority: agent.routingPriority + offset }),
      });
      await load();
      setMessage(`${agent.name} moved to ${agent.routingPriority + offset === 1 ? "Primary" : agent.routingPriority + offset === 2 ? "Secondary" : `priority ${agent.routingPriority + offset}`}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update agent routing priority."); }
  }

  return <section className="feature-page admin-settings">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />WORKSPACE ADMINISTRATION</div><h1>Settings</h1><p>Manage your support team, service targets, and mail connections.</p></div></div>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button onClick={() => setMessage("")}><X size={13} /></button></div>}

    <section className="settings-card">
      <div className="settings-card-heading"><div><h2>Support team</h2><p>Invite agents and control access to the workspace.</p></div><span>{agents.filter((agent) => !agent.disabledAt).length} active</span></div>
      <form className="invite-form" onSubmit={invite}><label htmlFor="invite-email">Agent email</label><div><input id="invite-email" name="email" type="email" placeholder="agent@company.com" required /><button className="button button-primary" type="submit"><Plus size={15} /> Invite agent</button></div></form>
      {invitationUrl && <p className="development-link">Development invitation link: <a href={invitationUrl}>{invitationUrl}</a></p>}
      <p className="settings-hint">Automatic tickets follow Primary-to-secondary priority; agents with the same priority are balanced by active unresolved workload. Use the arrows to change priority.</p>
      <div className="admin-team-list">
        {agents.map((agent) => <div className="admin-team-row" key={agent.id}><div className="avatar avatar-agent">{initials(agent.name)}</div><div className="directory-customer"><strong>{agent.name}{agent.isAdmin && <span className="admin-badge">ADMIN</span>}</strong><span>{agent.email}</span></div><span className="agent-routing-priority">{agent.routingPriority === 1 ? "Primary" : agent.routingPriority === 2 ? "Secondary" : `#${agent.routingPriority}`}</span><button className="button button-quiet" aria-label={`Move ${agent.name} up in routing priority`} disabled={Boolean(agent.disabledAt) || agent.routingPriority <= 1} onClick={() => moveAgent(agent, -1)}><ArrowUp size={13} /></button><button className="button button-quiet" aria-label={`Move ${agent.name} down in routing priority`} disabled={Boolean(agent.disabledAt) || agent.routingPriority >= agents.filter((item) => !item.disabledAt).length} onClick={() => moveAgent(agent, 1)}><ArrowDown size={13} /></button><span className={`team-state ${agent.disabledAt ? "team-disabled" : ""}`}>{agent.disabledAt ? "Disabled" : "Active"}</span><button className="button button-quiet" disabled={agent.isAdmin && !agent.disabledAt} onClick={() => toggleAgent(agent)}>{agent.disabledAt ? "Enable" : "Disable"}</button></div>)}
      </div>
      {invitations.length > 0 && <div className="pending-invitations"><strong>Pending invitations</strong>{invitations.map((invitation) => <div key={invitation.id}><span>{invitation.email}</span><small>Expires {new Date(invitation.expiresAt).toLocaleString()}</small></div>)}</div>}
    </section>

    <section className="settings-card">
      <div className="settings-card-heading"><div><h2>Service-level targets</h2><p>Elapsed time from ticket creation. Alerts appear in the assigned agent's notifications.</p></div><Clock3 size={18} /></div>
      <form className="sla-form" onSubmit={saveSla}>
        <label>First response target (hours)<input type="number" min="0.25" max="720" step="0.25" value={sla.firstResponseHours} onChange={(event) => setSla({ ...sla, firstResponseHours: Number(event.target.value) })} required /></label>
        <label>Resolution target (hours)<input type="number" min="0.5" max="2160" step="0.5" value={sla.resolutionHours} onChange={(event) => setSla({ ...sla, resolutionHours: Number(event.target.value) })} required /></label>
        <button className="button button-primary" type="submit">Save targets</button>
      </form>
    </section>

    <section className="settings-card">
      <div className="settings-card-heading"><div><h2>Email connections</h2><p>Outbound replies use SMTP; the inbound worker checks the configured IMAP mailbox every 30 seconds.</p></div><Mail size={18} /></div>
      <div className="email-connection-list">
        <div><span className={`connection-indicator ${emailStatus?.smtpConfigured ? "connection-ready" : ""}`} /><strong>Outbound SMTP</strong><span>{emailStatus?.smtpConfigured ? `Connected configuration · ${emailStatus.smtpHost}` : "Not configured"}</span></div>
        <div><span className={`connection-indicator ${emailStatus?.imapConfigured ? "connection-ready" : ""}`} /><strong>Inbound IMAP</strong><span>{emailStatus?.imapConfigured ? emailStatus.inboundMailbox : "Not configured"}</span></div>
        <p>Outbox · {emailStatus?.outbox?.pending || 0} pending · {emailStatus?.outbox?.sent || 0} sent · {emailStatus?.outbox?.failed || 0} failed</p>
        {emailStatus?.recentFailures?.map((failure, index) => <div className="mail-failure" key={`${failure.recipient}-${index}`}><strong>{failure.status === "failed" ? "Delivery failed" : `Retrying delivery · attempt ${failure.attempts}/5`} · {failure.recipient}</strong><span>{failure.error}</span></div>)}
      </div>
      {!emailStatus?.smtpConfigured && <p className="settings-hint">Add SMTP settings to the server's local <code>.env</code> file; never commit mailbox credentials.</p>}
    </section>
  </section>;
}

function InvitationOrResetScreen({ flow, token, notice, error, onComplete }: {
  flow: Exclude<AuthFlow, "portal">;
  token: string;
  notice: string;
  error: string;
  onComplete: (user: User | null) => Promise<void>;
}) {
  const [formError, setFormError] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (flow !== "invite" && flow !== "client-invite") return;
    const path = flow === "invite" ? "/auth/agent-invitations/validate" : "/auth/client-invitations/validate";
    api<{ email?: string; invitation?: { email: string; companyName: string; isCompanyAdmin: boolean } }>(`${path}?token=${encodeURIComponent(token)}`)
      .then((result) => {
        setEmail(result.email || result.invitation?.email || "");
        setCompanyName(result.invitation?.companyName || "");
      })
      .catch((reason: Error) => setFormError(reason.message));
  }, [flow, token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (flow === "invite" || flow === "client-invite") {
        const acceptPath = flow === "invite" ? "/auth/agent-invitations/accept" : "/auth/client-invitations/accept";
        const result = await api<{ user: User }>(acceptPath, {
          method: "POST", body: JSON.stringify({ token, name: form.get("name"), password: form.get("password") }),
        });
        window.history.replaceState({}, "", "/");
        await onComplete(result.user);
      } else {
        await api("/auth/password-reset/complete", {
          method: "POST", body: JSON.stringify({ token, password: form.get("password") }),
        });
        await onComplete(null);
      }
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : "Could not complete this account action."); }
    finally { setBusy(false); }
  }

  return <main className="login-screen"><div className="login-card">
    <div className="login-brand"><CompanyLogo className="company-logo-login" /></div>
    <div className="login-intro"><div className="eyebrow"><span className="eyebrow-live" />JISHNU INFOTECH SUPPORT</div>
      <h1>{flow === "invite" ? <>Join the support<br />team.</> : flow === "client-invite" ? <>Join your company<br />workspace.</> : <>Choose a new<br />password.</>}</h1>
      <p>{flow === "invite" ? "Set up your agent account to access the support workspace." : flow === "client-invite" ? "Complete your client account invitation." : "Create a new password for your client portal account."}</p>
    </div>
    {(formError || error) && <div className="inline-error" role="alert">{formError || error}</div>}
    {flow === "invite" && email && <p className="auth-notice">Invitation for <strong>{email}</strong></p>}
    {flow === "client-invite" && email && <p className="auth-notice">Invitation for <strong>{email}</strong> to join <strong>{companyName}</strong>.</p>}
    {notice && <p className="auth-notice">{notice}</p>}
    {!(formError || error) || flow === "reset" ? <form className="login-form" onSubmit={submit}>
      {(flow === "invite" || flow === "client-invite") && <label>Your name<input name="name" autoComplete="name" minLength={2} maxLength={100} required /></label>}
      <label>New password<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" placeholder="At least 12 characters" required /></label>
      <button className="button button-primary login-button" type="submit" disabled={busy}>{busy ? "Please wait…" : flow === "reset" ? "Reset password" : "Accept invitation"} <ArrowRight size={16} /></button>
    </form> : null}
    <a className="auth-back-link" href="/">Return to sign in</a>
  </div></main>;
}

function LoginScreen({ error, notice, portal, mode, onPortalChange, onModeChange, onSubmit, onRegister }: {
  error: string;
  notice: string;
  portal: Role;
  mode: PortalMode;
  onPortalChange: (role: Role) => void;
  onModeChange: (mode: PortalMode) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>, portal: Role) => void;
  onRegister: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [recoveryUrl, setRecoveryUrl] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  useEffect(() => {
    api<{ companies: Company[] }>("/companies/available")
      .then(({ companies: available }) => setCompanies(available))
      .catch((reason: Error) => setRecoveryError(reason.message));
  }, []);

  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoveryError("");
    setRecoveryNotice("");
    setRecoveryUrl("");
    setRecoveryBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ message: string; resetUrl?: string }>("/auth/password-reset", {
        method: "POST", body: JSON.stringify({ email: form.get("email") }),
      });
      setRecoveryNotice(result.message);
      setRecoveryUrl(result.resetUrl || "");
    } catch (reason) {
      setRecoveryError(reason instanceof Error ? reason.message : "Could not request a password reset.");
    } finally { setRecoveryBusy(false); }
  }

  return <main className="login-screen">
    <div className="login-decoration decoration-one" /><div className="login-decoration decoration-two" />
    <div className="login-card">
      <div className="login-brand"><CompanyLogo className="company-logo-login" /></div>
      <div className="login-intro"><div className="eyebrow"><span className="eyebrow-live" />JISHNU INFOTECH SUPPORT</div><h1>{portal === "customer" ? <>Client support,<br />made straightforward.</> : <>Your support team,<br />in one workspace.</>}</h1><p>{portal === "customer" ? "Open a service request, follow its progress, and continue the conversation with our team." : "Review the shared queue, respond to client requests, and keep every ticket moving."}</p></div>
      <div className="portal-tabs" role="tablist" aria-label="Choose your portal">
        <button type="button" className={portal === "customer" ? "selected" : ""} role="tab" aria-selected={portal === "customer"} onClick={() => onPortalChange("customer")}><Users size={14} /> Client portal</button>
        <button type="button" className={portal === "agent" ? "selected" : ""} role="tab" aria-selected={portal === "agent"} onClick={() => onPortalChange("agent")}><Inbox size={14} /> Agent portal</button>
      </div>
      {portal === "customer" && !showRecovery && <div className="auth-mode-tabs">
        <button type="button" className={mode === "login" ? "selected" : ""} onClick={() => onModeChange("login")}>Sign in</button>
        <button type="button" className={mode === "register" ? "selected" : ""} onClick={() => onModeChange("register")}>Create client account</button>
      </div>}
      {notice && !showRecovery && <div className="inline-success" role="status">{notice}</div>}
      {showRecovery && portal === "customer" ? <form className="login-form" onSubmit={requestPasswordReset}>
        <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@company.com" required /></label>
        {recoveryError && <div className="inline-error" role="alert">{recoveryError}</div>}
        {recoveryNotice && <div className="inline-success" role="status">{recoveryNotice}</div>}
        {recoveryUrl && <a className="auth-back-link" href={recoveryUrl}>Open development reset link</a>}
        <button className="button button-primary login-button" type="submit" disabled={recoveryBusy}>{recoveryBusy ? "Sending…" : "Send reset link"} <ArrowRight size={16} /></button>
        <button type="button" className="auth-back-link auth-back-button" onClick={() => setShowRecovery(false)}>Back to sign in</button>
      </form> : <form className="login-form" onSubmit={mode === "register" && portal === "customer" ? onRegister : (event) => onSubmit(event, portal)}>
        {mode === "register" && portal === "customer" && <>
          <label>Your name<input name="name" autoComplete="name" minLength={2} maxLength={100} placeholder="Full name" required /></label>
          <label>Company<select name="companyId" defaultValue=""><option value="">Choose your company</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select><span className="form-hint">New company requests need approval. An invitation code activates access immediately.</span></label>
          <label>Company invitation code (optional)<input name="joinCode" autoComplete="off" placeholder="Enter a code from your company admin" /></label>
        </>}
        <label>Email address<input name="email" type="email" autoComplete="username" placeholder="you@company.com" required /></label>
        <label>Password<div className="password-field"><input name="password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 12 : undefined} placeholder={mode === "register" ? "At least 12 characters" : "Enter your password"} required /></div></label>
        {error && <div className="inline-error">{error}</div>}
        <button className="button button-primary login-button" type="submit">{mode === "register" ? "Create account" : "Sign in"} <ArrowRight size={16} /></button>
      </form>}
      {!showRecovery && mode === "login" && portal === "customer" && <button type="button" className="forgot-password-link" onClick={() => { setShowRecovery(true); setRecoveryError(""); setRecoveryNotice(""); }}>Forgot password?</button>}
      <div className="login-help"><ShieldCheck size={15} /> Your support workspace, securely connected</div>
      {mode === "login" && !showRecovery && <div className="login-demo"><span>DEMO ACCESS</span><div><button type="button" onClick={() => { const email = document.querySelector<HTMLInputElement>('input[name="email"]'); const password = document.querySelector<HTMLInputElement>('input[name="password"]'); if (email && password) { email.value = portal === "agent" ? "alex@relaysupport.test" : "sam@northstar.test"; password.value = portal === "agent" ? "Support123!" : "Customer123!"; } }}>Fill {portal === "agent" ? "agent" : "client"} demo</button></div></div>}
    </div>
    <footer className="login-footer"><span>© 2026 Jishnu Infotech</span><span><CircleHelp size={13} /> Need help signing in?</span></footer>
  </main>;
}

function CustomerDirectory({ customers, tickets, onCreateTicket, onViewTickets }: {
  customers: Customer[];
  tickets: Ticket[];
  onCreateTicket: (customerId: number) => void;
  onViewTickets: (customerName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filteredCustomers = customers.filter((customer) =>
    `${customer.name} ${customer.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="feature-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />AGENT WORKSPACE</div><h1>Clients</h1><p>Review client accounts and their support history.</p></div></div>
    <div className="directory-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Search clients" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients…" /></div><span>{filteredCustomers.length} clients</span></div>
    <div className="directory-list">
      {filteredCustomers.length === 0
        ? <div className="empty-list"><Users size={27} /><strong>No clients found</strong><span>{customers.length ? "Try a different name or email." : "Client accounts will appear here when they register."}</span></div>
        : filteredCustomers.map((customer) => {
          const customerTickets = tickets.filter((ticket) => ticket.customer.id === customer.id);
          const activeCount = customerTickets.filter((ticket) => ticket.status !== "resolved").length;
          return <article className="directory-row" key={customer.id}>
            <div className="avatar customer-avatar">{initials(customer.name)}</div>
            <div className="directory-customer"><strong>{customer.name}</strong><span>{customer.email}</span></div>
            <div className="directory-stat"><strong>{customerTickets.length}</strong><span>Total tickets</span></div>
            <div className="directory-stat"><strong>{activeCount}</strong><span>Active</span></div>
            <button className="button button-quiet directory-action" onClick={() => onViewTickets(customer.name)}>View tickets</button>
            <button className="button button-primary directory-action" onClick={() => onCreateTicket(customer.id)}><Plus size={14} /> New ticket</button>
          </article>;
        })}
    </div>
  </section>;
}

function FeaturePlaceholder({ view }: { view: string }) {
  const isEmail = view === "email";
  const isSettings = view === "settings";
  const title = isEmail ? "Email channel" : isSettings ? "Workspace settings" : "Knowledge base";
  return <section className="feature-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />JISHNU INFOTECH WORKSPACE</div><h1>{title}</h1><p>{isEmail ? "Bring every customer conversation into one shared inbox." : "A calmer, more connected way to support your customers."}</p></div></div>
    <div className="integration-card">
      <div className="integration-illustration">{isEmail ? <Mail size={27} /> : isSettings ? <Settings2 size={27} /> : <CircleHelp size={27} />}</div>
      <span className="integration-status"><span />{isEmail ? "SMTP + IMAP" : "COMING SOON"}</span>
      <h2>{isEmail ? "Email is part of your ticket workflow" : isSettings ? "Workspace settings are administrator-only" : "Help customers help themselves"}</h2>
      <p>{isEmail ? "Agent replies are queued for delivery over SMTP. Incoming messages are checked over IMAP and matched to ticket conversations. Configure both connections in the server environment." : isSettings ? "Ask a workspace administrator to manage team access and service-level targets." : "The self-service knowledge base is planned for a later phase."}</p>
      {isEmail ? <button className="button button-quiet" disabled><Mail size={15} /> Manage connection in administrator settings</button> : <button className="button button-quiet" disabled><Check size={15} /> Planned for a future release</button>}
      <div className="integration-note"><ShieldCheck size={15} />{isEmail ? "SMTP delivery and IMAP intake remain inactive until valid mailbox credentials are configured." : "We are building this with your support workflow in mind."}</div>
    </div>
  </section>;
}

export default App;
