import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDown, ArrowDownUp, ArrowRight, ArrowUp, BarChart3, Bell, Check,
  CheckCheck, CircleHelp, Clock3, Inbox, LogOut, MessageCircle, Building2, ClipboardPlus,
  Download, Paperclip, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, UserRound, Users, X, BookOpen, Megaphone, Pencil,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";

type Role = "agent" | "customer";
type Status = "open" | "in_progress" | "waiting" | "resolved";
type Priority = "low" | "normal" | "high" | "urgent";
type TicketCategory = "Functional" | "Technical" | "Account access" | "Billing" | "Technical support" | "Feature request" | "Other";
type ConsultantSpecialty = "functional" | "technical" | "both";
type User = {
  id: number; name: string; username: string; email: string | null; role: Role; isAdmin?: boolean;
  isCompanyAdmin?: boolean; companyId?: number | null; companyName?: string | null; companySupportValidUntil?: string | null;
};
type CompanyMembership = { id: number; name: string; supportValidUntil?: string | null; isCompanyAdmin?: boolean };
type Company = { id: number; name: string; domain?: string | null; supportValidUntil?: string | null; isActive?: boolean | number };
type Ticket = {
  id: number; subject: string; description: string; status: Status; priority: Priority;
  category: TicketCategory; tags: string[]; customFields: Record<string, string>;
  source: "portal" | "email"; isHistoricalImport?: boolean; isManualEntry?: boolean;
  solution?: string | null; solutionConsultantName?: string | null; createdAt: string; updatedAt: string;
  customer: { id: number | null; name: string; email: string | null; contactNumber: string | null };
  company: Company | null;
  assignee: { id: number; name: string; email: string | null; contactNumber: string | null } | null;
  messageCount: number; lastMessage: string;
  firstResponseDueAt: string; resolutionDueAt: string;
  firstResponseAt: string | null; isFirstResponseOverdue: boolean; isResolutionOverdue: boolean;
  rating: { rating: number; comment: string; createdAt: string; customerId: number } | null;
};
type Message = { id: number; body: string; isInternal: boolean; createdAt: string; authorId: number | null; authorName: string; authorRole: Role };
type TicketAttachment = { id: number; name: string; mimeType: string; sizeBytes: number; createdAt: string; uploadedBy: number };
type TicketDetail = { ticket: Ticket; messages: Message[]; attachments: TicketAttachment[]; assignmentHistory: AssignmentEvent[]; categories: TicketCategory[]; canRate: boolean };
type Customer = {
  id: number; name: string; username?: string; email: string | null; companyId?: number; companyName?: string;
  routingPriority?: number; priorityLabel?: string; specialty?: ConsultantSpecialty;
};
type AssignmentEvent = {
  id: number; source: string; createdAt: string; agentId: number | null;
  agentName: string; assignedByName: string | null;
};
type Notification = {
  id: number; ticketId: number; kind: string; message: string; readAt: string | null; createdAt: string;
  subject?: string | null; description?: string | null; category?: string | null; priority?: Priority | null; customerName?: string | null;
};
type AnalyticsReport = {
  days: number; startDate: string; endDate: string;
  summary: { created: number; activeInPeriod: number; activeBacklog: number; waiting: number };
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
  customerActivity: Array<{ id: number; name: string; username?: string; email: string | null; companyName: string | null; raisedInPeriod: number; active: number; inProgress: number; resolvedInPeriod: number }>;
  scopeCompany: { id: number; name: string } | null;
};
type ReportTicket = { id: number; subject: string; status: Status; priority: Priority; updatedAt: string; companyId: number | null; customerId: number | null; consultantId: number | null; companyName: string | null; customerName: string; consultantName: string | null };
type ReportTicketDirectory = { companies: Array<{ id: number; name: string }>; customers: Array<{ id: number; name: string; email: string | null; companyName: string | null }>; consultants: Array<{ id: number; name: string }> };
type KnowledgeBaseTicket = { id: number; issue: string; description: string; reportedAt: string; solution: string; closedAt: string; solutionType: string; clientName: string; consultantName: string };
type InformationAttachment = { id: number; name: string; mimeType: string; sizeBytes: number; createdAt: string };
type InformationPost = { id: number; consultantId: number; consultantName: string; consultantMobile: string | null; information: string; allClients: boolean | number; postedAt: string; updatedAt: string; recipientIds?: number[]; recipientCompanyIds?: number[]; attachments?: InformationAttachment[] };
type InformationClient = { id: number; name: string; username: string; contactNumber: string | null; companyNames: string | null };
type InformationCompany = { id: number; name: string };
type InformationNotification = { id: number; informationId: number; createdAt: string; postedAt: string; consultantName: string; consultantMobile: string | null; information: string; attachments: InformationAttachment[] };
type UserManualEntry = { id: number; title: string; summary: string; content: string; mediaKind: "audio" | "video" | null; mediaName: string | null; mediaMimeType: string | null; mediaSizeBytes: number | null; isPublished: boolean | number; audienceType: "all" | "company" | "user"; audienceCompanyId: number | null; audienceCompanyName: string | null; audienceUserId: number | null; audienceUserName: string | null; audienceUserIds?: number[]; audienceUserNames?: string[]; createdAt: string; updatedAt: string };
type ManualAudienceUser = { id: number; name: string; username: string; role: Role };
type PortalMode = "login" | "register";
type ApiError = { error?: string };
type AuthFlow = "portal" | "invite" | "client-invite" | "reset";
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const LAST_ACTIVITY_STORAGE_KEY = "jishnuSupportLastActivityAt";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const requestOptions: RequestInit = {
    ...options,
    credentials: "include",
    headers: { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...options.headers },
  };
  const method = (options.method || "GET").toUpperCase();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, requestOptions);
  } catch {
    if (method !== "GET" || options.signal?.aborted) {
      throw new Error("The server could not be reached. Check your connection and try again.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    try {
      response = await fetch(`/api${path}`, requestOptions);
    } catch {
      throw new Error("The server is temporarily unreachable. Please check your connection and try again.");
    }
  }
  if (method === "GET" && [500, 502, 503, 504].includes(response.status)) {
    await response.body?.cancel();
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    try {
      response = await fetch(`/api${path}`, requestOptions);
    } catch {
      throw new Error("The server is temporarily unreachable. Please check your connection and try again.");
    }
  }
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(response.ok
      ? "The server returned an empty response. Please try again."
      : `The server returned an empty error response (${response.status}). Please try again.`);
  }
  let data: T & ApiError;
  try {
    data = JSON.parse(body) as T & ApiError;
  } catch {
    throw new Error(response.ok
      ? "The server returned an invalid response. Please try again."
      : `The server returned an invalid error response (${response.status}). Please try again.`);
  }
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

function ticketUpdatedLabel(date: string) {
  const updatedAt = new Date(date.replace(" ", "T") + "Z");
  if (Number.isNaN(updatedAt.getTime())) return timeAgo(date);
  if (Date.now() - updatedAt.getTime() <= 24 * 60 * 60 * 1000) return timeAgo(date);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(updatedAt);
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

function displayClientName(name: string) {
  return name.replace(/0$/, "");
}

function dateLabel(date: string) {
  const [year, month, day] = date.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : date;
}

function isContractExpired(date?: string | null) {
  return Boolean(date && new Date().toISOString().slice(0, 10) > date.slice(0, 10));
}

function consultantSupportsCategory(agent: Customer, category: string) {
  return !["Functional", "Technical"].includes(category)
    || agent.specialty === "both"
    || agent.specialty === category.toLowerCase();
}

function CompanyLogo({ className }: { className: string }) {
  return <img className={className} src="/jishnu-infotech-logo.webp" alt="Jishnu Infotech" />;
}

function StatusPill({ status }: { status: Status }) {
  const labels: Record<Status, string> = {
    open: "Open", in_progress: "In progress", waiting: "Waiting", resolved: "Closed",
  };
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{labels[status]}</span>;
}

function AssignmentHistorySection({ entries }: { entries: AssignmentEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleEntries = expanded ? entries : entries.slice(-2);
  return <section className="assignment-history" aria-label="Assignment history">
    <strong>Assignment history</strong>
    {visibleEntries.map((entry) => <span key={entry.id}>
      {entry.agentName}{entry.assignedByName ? ` · assigned by ${entry.assignedByName}` : " · automatic assignment"} · {timeAgo(entry.createdAt)}
    </span>)}
    {entries.length > 2 && <button type="button" className="assignment-history-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {expanded ? "Show less" : `Show all ${entries.length} assignments`}
    </button>}
  </section>;
}

function NewTicketPopup({ ticket, onDismiss, onOpen }: { ticket: Ticket; onDismiss: () => void; onOpen: () => void }) {
  return <div className="modal-scrim feedback-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}>
    <section className="create-modal feedback-modal new-ticket-modal" role="dialog" aria-modal="true" aria-labelledby="new-ticket-title">
      <div className="modal-heading">
        <div><div className="eyebrow">NEW TICKET · #{String(ticket.id).padStart(4, "0")}</div><h2 id="new-ticket-title">A ticket has been created for you</h2></div>
        <button type="button" className="icon-button" onClick={onDismiss} aria-label="Close ticket notice"><X size={18} /></button>
      </div>
      <div className="new-ticket-summary">
        <strong>{ticket.subject}</strong>
        <span>{ticket.category} · {ticket.priority[0].toUpperCase() + ticket.priority.slice(1)} priority · {ticket.assignee?.name || "Waiting for Consultant assignment"}</span>
        <p>{ticket.description}</p>
      </div>
      <div className="modal-footer"><button type="button" className="button button-quiet" onClick={onDismiss}>Later</button><button type="button" className="button button-primary" onClick={onOpen}>View ticket <ArrowRight size={14} /></button></div>
    </section>
  </div>;
}

function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === "urgent") return <span className="priority-icon urgent"><ArrowUp size={14} /> Urgent</span>;
  if (priority === "high") return <span className="priority-icon high"><ArrowUp size={14} /> High</span>;
  if (priority === "low") return <span className="priority-icon low"><ArrowDown size={14} /> Low</span>;
  return <span className="priority-icon normal"><ArrowDownUp size={14} /> Normal</span>;
}

function CompanySelectionScreen({ user, companies, error, onSelect, onSignOut }: {
  user: User; companies: CompanyMembership[]; error: string;
  onSelect: (companyId: number) => void; onSignOut: () => void;
}) {
  return <main className="company-picker-screen">
    <section className="company-picker-card">
      <CompanyLogo className="company-picker-logo" />
      <div className="eyebrow"><span className="eyebrow-live" />CLIENT WORKSPACES</div>
      <h1>Select a Company</h1>
      <p>Welcome, {displayClientName(user.name)}. Choose the company you want to access.</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="company-picker-list">{companies.map((company) => <button key={company.id} type="button" className="company-picker-option" onClick={() => onSelect(company.id)}>
        <span className="company-picker-icon"><Building2 size={18} /></span><span><strong>{company.name}</strong><small>Open company workspace</small></span><ArrowRight size={17} />
      </button>)}</div>
      <button type="button" className="button button-quiet company-picker-signout" onClick={onSignOut}><LogOut size={15} /> Sign out</button>
    </section>
  </main>;
}

function App() {
  const [authFlow, setAuthFlow] = useState<AuthFlow>(() => window.location.pathname === "/invite" ? "invite"
    : window.location.pathname === "/client-invite" ? "client-invite"
    : window.location.pathname === "/reset-password" ? "reset" : "portal");
  const authToken = useMemo(() => new URLSearchParams(window.location.search).get("token") || "", []);
  const [user, setUser] = useState<User | null>(null);
  const [availableCompanies, setAvailableCompanies] = useState<CompanyMembership[]>([]);
  const [showCompanySelection, setShowCompanySelection] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [agents, setAgents] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [activeView, setActiveView] = useState("inbox");
  const [filter, setFilter] = useState<Status | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [renewalPopup, setRenewalPopup] = useState(false);
  const [newTicketCategory, setNewTicketCategory] = useState<TicketCategory | "">("");
  const [feedbackTicketId, setFeedbackTicketId] = useState<number | null>(null);
  const [newTicketAlert, setNewTicketAlert] = useState<Ticket | null>(null);
  const [feedbackSubmittedId, setFeedbackSubmittedId] = useState<number | null>(null);
  const [dismissedFeedbackIds, setDismissedFeedbackIds] = useState<Set<number>>(() => new Set());
  const [prefillCustomerId, setPrefillCustomerId] = useState<number | null>(null);
  const [prefillCompanyId, setPrefillCompanyId] = useState<number | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginNotice, setLoginNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const [loginPortal, setLoginPortal] = useState<Role>("customer");
  const [portalMode, setPortalMode] = useState<PortalMode>("login");
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [newConsultantTicketAlerts, setNewConsultantTicketAlerts] = useState<Notification[]>([]);
  const [informationAlerts, setInformationAlerts] = useState<InformationNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [actionMessage, setActionMessage] = useState("");
  const [refreshingInbox, setRefreshingInbox] = useState(false);
  const [inboxRefreshError, setInboxRefreshError] = useState("");
  const [replyInternal, setReplyInternal] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const knownTicketIds = useRef<Set<number> | null>(null);
  const knownNotificationIds = useRef<Set<number> | null>(null);

  const refreshTickets = useCallback(async () => {
    const result = await api<{ tickets: Ticket[] }>("/tickets", { cache: "no-store" });
    if (user?.role === "customer") {
      const knownIds = knownTicketIds.current;
      if (knownIds) {
        const newlyCreated = result.tickets.filter((ticket) => ticket.customer.id === user.id && !knownIds.has(ticket.id));
        if (newlyCreated.length) setNewTicketAlert(newlyCreated[newlyCreated.length - 1]);
      }
      knownTicketIds.current = new Set(result.tickets.map((ticket) => ticket.id));
    }
    setTickets(result.tickets);
    setSelectedId((current) => current && result.tickets.some((ticket) => ticket.id === current)
      ? current : null);
  }, [user]);

  useEffect(() => {
    api<{ user: User; companies?: CompanyMembership[] }>("/auth/me")
      .then(({ user: currentUser, companies = [] }) => { setUser(currentUser); setAvailableCompanies(companies); return api<{ tickets: Ticket[] }>("/tickets"); })
      .then(({ tickets: loaded }) => { knownTicketIds.current = new Set(loaded.map((ticket) => ticket.id)); setTickets(loaded); setSelectedId(null); })
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
    if (user?.role !== "customer") {
      setFeedbackTicketId(null);
      setFeedbackSubmittedId(null);
      return;
    }
    setFeedbackTicketId((current) => {
      if (current !== null && (current === feedbackSubmittedId || tickets.some((ticket) =>
        ticket.id === current && ticket.customer.id === user.id && ticket.status === "resolved" && !ticket.rating))) {
        return current;
      }
      return tickets.find((ticket) => ticket.customer.id === user.id && ticket.status === "resolved"
        && !ticket.rating && !dismissedFeedbackIds.has(ticket.id))?.id ?? null;
    });
  }, [dismissedFeedbackIds, feedbackSubmittedId, tickets, user]);

  useEffect(() => {
    if (user?.role !== "agent") { setCustomers([]); return; }
    api<{ customers: Customer[] }>("/customers")
      .then(({ customers: loaded }) => setCustomers(loaded))
      .catch((error: Error) => setActionError(error.message));
  }, [user]);

  const refreshNotifications = useCallback(async () => {
    if (user?.role !== "agent") return;
    const result = await api<{ notifications: typeof notifications; unreadCount: number }>("/notifications", { cache: "no-store" });
    const knownIds = knownNotificationIds.current;
    if (knownIds) {
      const newTicketNotifications = result.notifications.filter((notification) =>
        notification.kind === "ticket_created" && !knownIds.has(notification.id));
      if (newTicketNotifications.length) setNewConsultantTicketAlerts((current) => [...current, ...newTicketNotifications]);
    }
    knownNotificationIds.current = new Set(result.notifications.map((notification) => notification.id));
    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
  }, [user]);

  async function refreshInboxNow() {
    if (refreshingInbox) return;
    setRefreshingInbox(true);
    setInboxRefreshError("");
    try {
      await refreshTickets();
      if (user?.role === "agent") await refreshNotifications();
    } catch (error) {
      setInboxRefreshError(error instanceof Error ? error.message : "Could not refresh the inbox.");
    } finally {
      setRefreshingInbox(false);
    }
  }

  useEffect(() => {
    if (!user || user.role !== "agent") return;
    refreshNotifications().catch((error: Error) => setActionError(error.message));
    const intervalId = window.setInterval(() => {
      refreshNotifications().catch((error: Error) => setActionError(error.message));
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [refreshNotifications, user]);

  useEffect(() => {
    if (!user || (user.role !== "customer" && user.role !== "agent")) { setInformationAlerts([]); return; }
    let active = true;
    const refreshInformationAlerts = () => {
      api<{ notifications: InformationNotification[] }>("/information-center/notifications", { cache: "no-store" })
        .then(({ notifications: incoming }) => {
          if (!active) return;
          setInformationAlerts((current) => {
            const existingIds = new Set(current.map((notification) => notification.id));
            return [...current, ...incoming.filter((notification) => !existingIds.has(notification.id))];
          });
        })
        .catch(() => {});
    };
    refreshInformationAlerts();
    const intervalId = window.setInterval(refreshInformationAlerts, 10000);
    return () => { active = false; window.clearInterval(intervalId); };
  }, [user]);

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

  const inboxCompanies = useMemo(() => [...new Map(tickets
    .filter((ticket) => ticket.company)
    .map((ticket) => [ticket.company!.id, { id: ticket.company!.id, name: ticket.company!.name }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name)), [tickets]);

  const filteredTickets = useMemo(() => tickets.filter((ticket) => {
    const matchStatus = filter === "all" || ticket.status === filter;
    const consultantInbox = user?.role === "agent" && activeView === "inbox";
    const matchPriority = consultantInbox || priorityFilter === "all" || ticket.priority === priorityFilter;
    const matchCompany = !consultantInbox || companyFilter === "all" || ticket.company?.id === Number(companyFilter);
    const query = search.trim().toLowerCase();
    const matchSearch = !query || `${ticket.subject} ${ticket.customer.name} ${ticket.lastMessage}`.toLowerCase().includes(query);
    const matchView = activeView !== "assigned" || (user?.role === "agent"
      ? ticket.assignee?.id === user.id
      : ticket.customer.id === user?.id);
    return matchStatus && matchPriority && matchCompany && matchSearch && matchView;
  }), [activeView, companyFilter, filter, priorityFilter, search, tickets, user]);

  const counts = useMemo(() => ({
    all: tickets.length,
    open: tickets.filter((ticket) => ticket.status === "open").length,
    in_progress: tickets.filter((ticket) => ticket.status === "in_progress").length,
    waiting: tickets.filter((ticket) => ticket.status === "waiting").length,
    resolved: tickets.filter((ticket) => ticket.status === "resolved").length,
  }), [tickets]);

  const myTicketCount = useMemo(
    () => tickets.filter((ticket) => ticket.customer.id === user?.id).length,
    [tickets, user?.id],
  );

  const inboxCounts = useMemo(() => {
    const scopedTickets = user?.role === "agent" && activeView === "assigned"
      ? tickets.filter((ticket) => ticket.assignee?.id === user.id)
      : user?.role === "agent" && activeView === "inbox" && companyFilter !== "all"
        ? tickets.filter((ticket) => ticket.company?.id === Number(companyFilter))
        : tickets;
    return {
      all: scopedTickets.length,
      open: scopedTickets.filter((ticket) => ticket.status === "open").length,
      in_progress: scopedTickets.filter((ticket) => ticket.status === "in_progress").length,
      waiting: scopedTickets.filter((ticket) => ticket.status === "waiting").length,
      resolved: scopedTickets.filter((ticket) => ticket.status === "resolved").length,
    };
  }, [activeView, companyFilter, tickets, user]);

  async function signIn(event: FormEvent<HTMLFormElement>, portal: Role) {
    event.preventDefault();
    setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: User; companies?: CompanyMembership[] }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: form.get("username"), password: form.get("password"), portal }),
      });
      if (result.user.role !== portal) {
        await api("/auth/logout", { method: "POST" });
        throw new Error(`This account is for the ${result.user.role === "agent" ? "Consultant" : "client"} portal. Choose the matching portal and try again.`);
      }
      localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
      setUser(result.user);
      knownNotificationIds.current = null;
      const companies = result.companies || [];
      setAvailableCompanies(companies);
      setActiveView("inbox");
      if (result.user.role === "customer" && companies.length > 1) {
        setShowCompanySelection(true);
        setTickets([]);
        setSelectedId(null);
        return;
      }
      const loaded = await api<{ tickets: Ticket[] }>("/tickets");
      knownTicketIds.current = new Set(loaded.tickets.map((ticket) => ticket.id));
      setTickets(loaded.tickets);
      setSelectedId(null);
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
          username: form.get("username"),
          email: form.get("email"),
          contactNumber: form.get("contactNumber"),
          password: form.get("password"),
          companyId: form.get("companyId"),
          joinCode: form.get("joinCode"),
        }),
      });
      if (result.pendingApproval) {
        setLoginNotice(result.message || "Your company administrator must approve this account before you can sign in.");
        setPortalMode("login");
      } else if (result.user) {
        localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
        setUser(result.user);
        setActiveView("inbox");
        knownTicketIds.current = new Set();
        setTickets([]);
        setSelectedId(null);
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Unable to create your account.");
    }
  }

  async function signOut(reason?: "inactive") {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* Clear the local session even if the server is unreachable. */ }
    localStorage.removeItem(LAST_ACTIVITY_STORAGE_KEY);
    setUser(null);
    setAvailableCompanies([]);
    setShowCompanySelection(false);
    setActiveView("inbox");
    knownTicketIds.current = null;
    knownNotificationIds.current = null;
    setNewTicketAlert(null);
    setNewConsultantTicketAlerts([]);
    setTickets([]);
    setSelectedId(null);
    setDetail(null);
    if (reason === "inactive") setLoginNotice("You were signed out after 30 minutes of inactivity.");
  }

  useEffect(() => {
    if (!user) return;
    let lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY));
    if (!Number.isFinite(lastActivity) || lastActivity <= 0) {
      lastActivity = Date.now();
      localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(lastActivity));
    }
    let timeoutId: number;
    let signedOut = false;
    const scheduleTimeout = () => {
      window.clearTimeout(timeoutId);
      const remaining = SESSION_IDLE_TIMEOUT_MS - (Date.now() - lastActivity);
      if (remaining <= 0) {
        signedOut = true;
        void signOut("inactive");
      } else {
        timeoutId = window.setTimeout(scheduleTimeout, remaining);
      }
    };
    const recordActivity = () => {
      lastActivity = Date.now();
      localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(lastActivity));
      scheduleTimeout();
    };
    const syncActivity = (event: StorageEvent) => {
      if (event.key !== LAST_ACTIVITY_STORAGE_KEY) return;
      if (event.newValue === null) {
        if (!signedOut) { signedOut = true; void signOut(); }
        return;
      }
      const remoteActivity = Number(event.newValue);
      if (Number.isFinite(remoteActivity) && remoteActivity > lastActivity) {
        lastActivity = remoteActivity;
        scheduleTimeout();
      }
    };
    const activityEvents: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
    window.addEventListener("storage", syncActivity);
    scheduleTimeout();
    return () => {
      window.clearTimeout(timeoutId);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
      window.removeEventListener("storage", syncActivity);
    };
  }, [user]);

  async function selectCompany(companyId: number) {
    setActionError("");
    try {
      const result = await api<{ user: User; companies: CompanyMembership[] }>("/auth/select-company", {
        method: "POST", body: JSON.stringify({ companyId }),
      });
      setUser(result.user);
      setAvailableCompanies(result.companies);
      setShowCompanySelection(false);
      setActiveView("inbox");
      setFilter("all");
      setSelectedId(null);
      const loaded = await api<{ tickets: Ticket[] }>("/tickets");
      knownTicketIds.current = new Set(loaded.tickets.map((ticket) => ticket.id));
      setTickets(loaded.tickets);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not open this company workspace.");
    }
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
      setNewTicketCategory("");
      await refreshTickets();
      setSelectedId(result.ticket.id);
      setActiveView("inbox");
      setFilter("all");
      setPrefillCustomerId(null);
      setPrefillCompanyId(null);
    } catch (error) {
      if (error instanceof Error && error.message === "Please Renewal Your Support Contract") {
        setShowCreate(false);
        setRenewalPopup(true);
      } else {
        setActionError(error instanceof Error ? error.message : "Could not create ticket.");
      }
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
        setActiveView("inbox");
        const loaded = await api<{ tickets: Ticket[] }>("/tickets");
        knownTicketIds.current = new Set(loaded.tickets.map((ticket) => ticket.id));
        setTickets(loaded.tickets);
        setSelectedId(null);
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

  if (user.role === "customer" && showCompanySelection && availableCompanies.length > 1) return <CompanySelectionScreen
    user={user} companies={availableCompanies} error={actionError} onSelect={selectCompany} onSignOut={signOut}
  />;

  const isAgent = user.role === "agent";
  const isSuperAdmin = isAgent && Boolean(user.isAdmin);
  const isCompanyAdmin = user.role === "customer" && Boolean(user.isCompanyAdmin);
  const selectedTicket = detail?.ticket;
  const canChangeAssignment = Boolean(selectedTicket && (
    isAgent && (isSuperAdmin || selectedTicket.assignee?.id === user.id)
  ));
  const heading = isAgent ? "Support inbox" : activeView === "assigned" ? "My tickets" : "Company inbox";
  async function openNewTicketForm() {
    if (!isAgent) {
      try {
        const result = await api<{ user: User }>("/auth/me");
        setUser(result.user);
        if (isContractExpired(result.user.companySupportValidUntil)) {
          setRenewalPopup(true);
          return;
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Could not verify your company support contract.");
        setShowCreate(true);
        return;
      }
    }
    setPrefillCustomerId(null);
    setPrefillCompanyId(null);
    setNewTicketCategory("");
    setActionError("");
    setShowCreate(true);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <CompanyLogo className="company-logo-sidebar" />
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button aria-label={isAgent ? "Inbox" : "Company inbox"} title={isAgent ? "Inbox" : "Company inbox"} className={`nav-item ${activeView === "inbox" ? "active" : ""}`} onClick={() => { setActiveView("inbox"); setFilter("all"); }}>
            <Inbox size={17} /><span>{isAgent ? "Inbox" : "Company inbox"}</span><span className="nav-count">{isAgent ? counts.open : counts.all}</span>
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
            <button aria-label="Knowledge Base" title="Knowledge Base" className={`nav-item ${activeView === "knowledge" ? "active" : ""}`} onClick={() => setActiveView("knowledge")}>
              <BookOpen size={17} /><span>Knowledge Base</span>
            </button>
            <button aria-label="Information Center" title="Information Center" className={`nav-item ${activeView === "information" ? "active" : ""}`} onClick={() => setActiveView("information")}>
              <Megaphone size={17} /><span>Information Center</span>
            </button>
          <button aria-label="User Manual" title="User Manual" className={`nav-item ${activeView === "user-manual" ? "active" : ""}`} onClick={() => setActiveView("user-manual")}>
            <BookOpen size={17} /><span>User Manual</span>
          </button>
          </>}
          {!isAgent && <button aria-label="My tickets" title="My tickets" className={`nav-item ${activeView === "assigned" ? "active" : ""}`} onClick={() => { setActiveView("assigned"); setFilter("all"); }}>
            <UserRound size={17} /><span>My tickets</span><span className="nav-count">{myTicketCount}</span>
          </button>}
          {!isAgent && <button aria-label="Information Center" title="Information Center" className={`nav-item ${activeView === "information" ? "active" : ""}`} onClick={() => setActiveView("information")}>
            <Megaphone size={17} /><span>Information Center</span>
          </button>}
          {!isAgent && <button aria-label="User Manual" title="User Manual" className={`nav-item ${activeView === "user-manual" ? "active" : ""}`} onClick={() => setActiveView("user-manual")}>
            <BookOpen size={17} /><span>User Manual</span>
          </button>}
          {isCompanyAdmin && <button aria-label="Company users" title="Company users" className={`nav-item ${activeView === "company-users" ? "active" : ""}`} onClick={() => setActiveView("company-users")}>
            <Users size={17} /><span>Company users</span>
          </button>}
          {isSuperAdmin && <button aria-label="Companies" title="Companies" className={`nav-item ${activeView === "companies" ? "active" : ""}`} onClick={() => setActiveView("companies")}>
            <Users size={17} /><span>Companies</span>
          </button>}
          {isSuperAdmin && <button aria-label="Raise Ticket Manually" title="Raise Ticket Manually" className={`nav-item ${activeView === "manual-ticket" ? "active" : ""}`} onClick={() => setActiveView("manual-ticket")}>
            <ClipboardPlus size={17} /><span>Raise Ticket Manually</span>
          </button>}
          {(isSuperAdmin || isCompanyAdmin) && <button aria-label="Reports" title="Reports" className={`nav-item ${activeView === "reports" ? "active" : ""}`} onClick={() => setActiveView("reports")}>
            <BarChart3 size={17} /><span>Reports</span>
          </button>}
          <div className="nav-divider" />
        </nav>
        <div className="sidebar-bottom">
          {isSuperAdmin && <button aria-label="Settings" title="Settings" className={`nav-item ${activeView === "settings" ? "active" : ""}`} onClick={() => setActiveView("settings")}><Settings2 size={17} /><span>Settings</span></button>}
          <div className="sidebar-profile">
            <div className={`avatar ${isAgent ? "avatar-agent" : ""}`}>{initials(user.name)}</div>
            <div className="profile-copy"><strong>{isAgent ? user.name : displayClientName(user.name)}</strong><span>@{user.username}</span><span>{isAgent ? (user.isAdmin ? "Super Admin" : "Consultant") : user.companyName || "Client"}{isCompanyAdmin ? " · Company Admin" : ""}</span></div>
            <button className="icon-button profile-menu" onClick={() => signOut()} title="Sign out"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{activeView === "inbox" || activeView === "assigned" ? heading : activeView === "knowledge" ? "Knowledge Base" : activeView === "information" ? "Information Center" : activeView === "user-manual" ? "User Manual" : activeView === "manual-ticket" ? "Raise Ticket Manually" : activeView[0].toUpperCase() + activeView.slice(1)}</strong></div>
          <div className="topbar-actions">
            {user.role === "customer" && availableCompanies.length > 1 && <button type="button" className="company-switcher" onClick={() => setShowCompanySelection(true)}><Building2 size={14} /><span>{user.companyName || "Select a company"}</span><ArrowDown size={13} /></button>}
            {(activeView === "inbox" || activeView === "assigned") && <div className="search-box"><Search size={15} /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tickets…" /><kbd>Ctrl K</kbd></div>}
            <div className="topbar-avatar">{initials(user.name)}</div>
          </div>
        </header>

        {activeView === "inbox" || activeView === "assigned" ? (
          <div className={`workbench ${selectedTicket ? "has-detail" : ""}`}>
            <section className="ticket-list-panel">
              <div className="page-heading">
                <div>
                  <div className="eyebrow"><span className="eyebrow-live" />{isAgent ? "YOUR TEAM, IN SYNC" : "WE'RE HERE TO HELP"}</div>
                  <h1>{activeView === "assigned" && isAgent ? "Assigned to me" : heading}</h1>
                  <p>{isAgent ? "Stay on top of every customer conversation." : activeView === "assigned" ? "Track the support tickets you opened." : "See support tickets opened by you and your teammates."}</p>
                </div>
                <button className="button button-primary" onClick={openNewTicketForm}><Plus size={16} /> New ticket</button>
              </div>

              {isAgent && <div className="metrics-row">
                <Metric icon={<Inbox size={15} />} label="Open tickets" value={inboxCounts.open} tone="blue" />
                <Metric icon={<Activity size={15} />} label="In progress" value={inboxCounts.in_progress} tone="violet" />
                <Metric icon={<Clock3 size={15} />} label="Waiting" value={inboxCounts.waiting} tone="amber" />
                <Metric icon={<CheckCheck size={15} />} label="Closed" value={inboxCounts.resolved} tone="green" />
              </div>}

              <div className="list-toolbar">
                <div className="filter-tabs">
                  {(["all", "open", "in_progress", "waiting", "resolved"] as const).map((value) => (
                    <button key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>
                      {value === "all" ? "All tickets" : value === "in_progress" ? "In progress" : value === "resolved" ? "Closed" : value[0].toUpperCase() + value.slice(1)}
                      {value === "all" && <span className="filter-count">{activeView === "assigned" ? (isAgent ? inboxCounts.all : myTicketCount) : inboxCounts.all}</span>}
                    </button>
                  ))}
                </div>
                {user.role === "agent" && activeView === "inbox"
                  ? <label className="priority-filter"><span>Customer</span><select aria-label="Filter by customer" value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)}><option value="all">All customers</option>{inboxCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
                  : <label className="priority-filter"><span>Priority</span><select aria-label="Filter by priority" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as Priority | "all")}><option value="all">All</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>}
              </div>

              <div className="ticket-list">
                {filteredTickets.length === 0 ? (
                  <div className="empty-list"><Inbox size={28} /><strong>No tickets found</strong><span>Try another filter or create a new ticket.</span></div>
                ) : filteredTickets.map((ticket) => (
                  <button key={ticket.id} className={`ticket-row ${selectedId === ticket.id ? "selected" : ""}`} onClick={() => setSelectedId(ticket.id)}>
                    <div className="ticket-row-top">
                      <span className="ticket-number">#{String(ticket.id).padStart(4, "0")}</span>
                      <span className="ticket-time">{ticketUpdatedLabel(ticket.updatedAt)}</span>
                    </div>
                    <div className="ticket-subject">{ticket.subject}</div>
                    <div className="ticket-row-taxonomy"><span>{ticket.category}</span>{ticket.tags.slice(0, 2).map((tag) => <span className="ticket-tag" key={tag}>{tag}</span>)}</div>
                    <div className="ticket-preview">{ticket.lastMessage}</div>
                    <div className="ticket-row-bottom">
                      <div className="ticket-person">
                        <span className={`tiny-avatar ${ticket.source === "email" ? "email-avatar" : ""}`}>{initials(ticket.customer.name)}</span>
                        <span>{displayClientName(ticket.customer.name)}</span>
                      </div>
                      <div className="ticket-row-meta"><PriorityIcon priority={ticket.priority} /><StatusPill status={ticket.status} /></div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="list-footer"><span>Showing <strong>{filteredTickets.length}</strong> of {activeView === "assigned" ? (isAgent ? inboxCounts.all : myTicketCount) : activeView === "inbox" && isAgent ? inboxCounts.all : tickets.length} tickets</span><span className="footer-refresh-wrap">{inboxRefreshError && <span className="footer-refresh-error" role="alert">{inboxRefreshError}</span>}<button type="button" className="footer-refresh" onClick={refreshInboxNow} disabled={refreshingInbox} aria-live="polite"><RefreshCw size={13} className={refreshingInbox ? "refresh-spinning" : ""} />{refreshingInbox ? "Refreshing…" : "Refresh"}</button></span></div>
            </section>

            {selectedTicket ? (
              <section className="detail-panel">
                <div className="detail-heading">
                  <div className="detail-title-wrap"><span className="ticket-number">#{String(selectedTicket.id).padStart(4, "0")}</span><h2>{selectedTicket.subject}</h2></div>
                  <div className="detail-actions"><button className="icon-button" aria-label="Close ticket detail" onClick={() => setSelectedId(null)}><X size={18} /></button></div>
                </div>
                <div className="detail-scroll-area">
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
                  {isAgent
                    ? <div className="detail-person"><div className="avatar customer-avatar">{initials(selectedTicket.customer.name)}</div><div><strong>Client · {displayClientName(selectedTicket.customer.name)}</strong><span>{selectedTicket.customer.email || "No email provided"}</span><span className="detail-contact-number">Contact: {selectedTicket.customer.contactNumber || "Unavailable"}</span></div></div>
                    : selectedTicket.assignee
                      ? <div className="detail-person"><div className="avatar avatar-agent">{initials(selectedTicket.assignee.name)}</div><div><strong>Consultant · {selectedTicket.assignee.name}</strong><span>{selectedTicket.assignee.email || "No email provided"}</span><span className="detail-contact-number">Contact: {selectedTicket.assignee.contactNumber || "Unavailable"}</span></div></div>
                      : <div className="detail-person"><div className="avatar avatar-agent"><UserRound size={14} /></div><div><strong>Consultant</strong><span>Unassigned</span></div></div>}
                  <div className="detail-info-item"><span>Created</span><strong>{timeAgo(selectedTicket.createdAt)}</strong></div>
                  {selectedTicket.company && <div className="detail-info-item"><span>Company</span><strong>{selectedTicket.company.name}</strong></div>}
                  <div className="detail-info-item"><span>Source</span><strong><span className={`source-icon ${selectedTicket.source}`} />{selectedTicket.isHistoricalImport ? "Imported record" : selectedTicket.isManualEntry ? "Manual entry" : selectedTicket.source === "email" ? "Email" : "Portal"}</strong></div>
                  {canChangeAssignment ? <label className="detail-assignee"><div className="assignee-avatar">{selectedTicket.assignee ? initials(selectedTicket.assignee.name) : <UserRound size={14} />}</div><select aria-label="Assign ticket to consultant" value={selectedTicket.assignee?.id ?? ""} onChange={(event) => updateTicket({ assigneeId: event.target.value ? Number(event.target.value) : null })}><option value="">Unassigned</option>{agents.filter((agent) => consultantSupportsCategory(agent, selectedTicket.category)).map((agent) => <option key={agent.id} value={agent.id}>{agent.priorityLabel} · {agent.name}</option>)}</select></label>
                    : <div className="detail-assignee"><div className="assignee-avatar">{selectedTicket.assignee ? initials(selectedTicket.assignee.name) : <UserRound size={14} />}</div><span>{selectedTicket.assignee?.name || "Unassigned"}</span></div>}
                </div>
                {(selectedTicket.isFirstResponseOverdue || selectedTicket.isResolutionOverdue) && <div className="detail-sla detail-sla-overdue" role="status">
                  <Clock3 size={14} /><strong>SLA overdue</strong>
                  {selectedTicket.isFirstResponseOverdue && <span>First response target missed</span>}
                  {selectedTicket.isResolutionOverdue && <span>Resolution target missed</span>}
                </div>}
                {!selectedTicket.isFirstResponseOverdue && !selectedTicket.isResolutionOverdue && selectedTicket.status !== "resolved" && <div className="detail-sla">
                  <Clock3 size={14} /><span>First response by {new Date(selectedTicket.firstResponseDueAt).toLocaleString()}</span><span>Resolve by {new Date(selectedTicket.resolutionDueAt).toLocaleString()}</span>
                </div>}
                {detail?.assignmentHistory.length ? <AssignmentHistorySection key={selectedTicket.id} entries={detail.assignmentHistory} /> : null}
                {selectedTicket.solution && <section className="ticket-solution"><strong>Consultant solution{selectedTicket.solutionConsultantName ? ` · ${selectedTicket.solutionConsultantName}` : ""}</strong><p>{selectedTicket.solution}</p></section>}
                {detail?.attachments.length ? <div className="attachment-list" aria-label="Ticket attachments">
                  <strong className="attachment-heading">Attachments</strong>
                  {detail.attachments.map((attachment) => <a key={attachment.id} className="ticket-attachment" href={`/api/tickets/${selectedTicket.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                    <span className="attachment-icon"><Paperclip size={14} /></span><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span><Download size={14} />
                  </a>)}
                </div> : null}
                <div className="conversation-heading"><span>Conversation</span><span>{detail?.messages.length ?? 0} messages</span></div>
                {isAgent && <div className="internal-note-notice"><ShieldCheck size={13} /><span>Internal notes are visible only to Consultants.</span></div>}
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
                </div>
                {isAgent || isCompanyAdmin || selectedTicket.customer.id === user.id ? <div className="reply-wrap">
                  {actionError && <div className="inline-error">{actionError}<button onClick={() => setActionError("")}><X size={13} /></button></div>}
                  {actionMessage && <div className="inline-success">{actionMessage}<button onClick={() => setActionMessage("")}><X size={13} /></button></div>}
                  {isAgent && <div className="reply-mode-toggle" role="group" aria-label="Reply type">
                    <button type="button" className={!replyInternal ? "selected" : ""} onClick={() => setReplyInternal(false)}>Reply to customer</button>
                    <button type="button" className={replyInternal ? "selected" : ""} onClick={() => setReplyInternal(true)}>Internal note</button>
                  </div>}
                  <form className="reply-composer" onSubmit={sendReply}>
                    <textarea name="reply" placeholder={isAgent ? (replyInternal ? "Write an internal note for the support team…" : "Write a reply to the customer…") : "Reply to this conversation…"} maxLength={5000} required />
                    <div className="composer-footer"><span>{replyInternal ? <><ShieldCheck size={14} /> Only Consultants can see this note</> : <><Sparkles size={14} /> Replies are visible to the customer</>}</span><button className="button button-primary send-button" type="submit">{replyInternal ? "Add note" : "Send reply"} <Send size={14} /></button></div>
                  </form>
                </div> : <div className="internal-note-notice"><ShieldCheck size={13} /><span>You can view this company ticket. Only its creator or a company administrator can reply.</span></div>}
              </section>
            ) : (
              <section className="detail-placeholder"><div className="placeholder-art"><MessageCircle size={30} /></div><strong>Select a ticket</strong><span>Choose a conversation to see the full story.</span></section>
            )}
          </div>
        ) : (
          activeView === "information"
            ? <InformationCenter isConsultant={isAgent} isSuperAdmin={isSuperAdmin} currentUserId={user.id} />
            : activeView === "user-manual"
              ? <UserManual isSuperAdmin={isSuperAdmin} />
            : activeView === "knowledge" && isAgent
            ? <KnowledgeBase companies={inboxCompanies} />
            : activeView === "customers" && isAgent
            ? <CustomerDirectory
              customers={customers}
              tickets={tickets}
              onCreateTicket={(customerId, companyId) => { setPrefillCustomerId(customerId); setPrefillCompanyId(companyId); setNewTicketCategory(""); setShowCreate(true); setActionError(""); }}
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
              : activeView === "reports" && (isSuperAdmin || isCompanyAdmin)
                ? <AnalyticsDashboard workspaceWide={isSuperAdmin} />
              : activeView === "manual-ticket" && isSuperAdmin
                ? <ManualTicketEntry onCreated={async (ticketId) => {
                  await refreshTickets();
                  setFilter("all");
                  setActiveView("inbox");
                  setSelectedId(ticketId);
                }} />
              : activeView === "settings" && isSuperAdmin
                ? <AdminSettings onChanged={async () => {
                  await refreshTickets();
                  const result = await api<{ agents: Customer[] }>("/agents");
                  setAgents(result.agents);
                }} />
              : (activeView === "companies" && isSuperAdmin) || (activeView === "company-users" && isCompanyAdmin)
                  ? <CompanyManagement
                    workspaceAdmin={isSuperAdmin}
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

      {showCreate && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowCreate(false); setPrefillCustomerId(null); setNewTicketCategory(""); } }}>
        <form className="create-modal" onSubmit={createTicket}>
          <div className="modal-heading"><div><div className="eyebrow">SUPPORT REQUEST</div><h2>Create a ticket</h2></div><button type="button" className="icon-button" onClick={() => { setShowCreate(false); setPrefillCustomerId(null); setNewTicketCategory(""); }} aria-label="Close"><X size={18} /></button></div>
          <label>Category<select name="category" required value={newTicketCategory} onChange={(event) => setNewTicketCategory(event.target.value as TicketCategory | "")}><option value="" disabled>Select Functional or Technical</option><option value="Functional">Functional</option><option value="Technical">Technical</option></select></label>
          {isAgent && <label>Customer<select name="customerSelection" required value={prefillCustomerId && prefillCompanyId ? `${prefillCompanyId}:${prefillCustomerId}` : ""} onChange={(event) => { const [companyId, customerId] = event.target.value.split(":").map(Number); setPrefillCompanyId(companyId || null); setPrefillCustomerId(customerId || null); }}><option value="" disabled>Select a customer</option>{customers.map((customer) => <option key={`${customer.companyId}:${customer.id}`} value={`${customer.companyId}:${customer.id}`}>{customer.companyName ? `${customer.companyName} · ` : ""}{customer.name} · {customer.username || customer.email || `Client ${customer.id}`}</option>)}</select><input type="hidden" name="customerId" value={prefillCustomerId ?? ""} /><input type="hidden" name="companyId" value={prefillCompanyId ?? ""} /></label>}
          <label>Subject<input name="subject" required minLength={4} maxLength={160} placeholder="What do you need help with?" autoFocus /></label>
          <label>Description<textarea name="description" required minLength={10} maxLength={5000} placeholder="Share a few details so we can help…" rows={5} /></label>
          <label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
          <label>Attachments<input name="attachments" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" /><span className="form-hint">Up to 5 PDF or image files, 10 MB each.</span></label>
          {actionError && <div className="inline-error">{actionError}</div>}
          <div className="modal-footer"><button type="button" className="button button-quiet" onClick={() => { setShowCreate(false); setPrefillCustomerId(null); setNewTicketCategory(""); }}>Cancel</button><button className="button button-primary" type="submit"><Plus size={15} /> Create ticket</button></div>
        </form>
      </div>}
      {renewalPopup && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenewalPopup(false); }}>
        <section className="create-modal contract-renewal-modal" role="dialog" aria-modal="true" aria-labelledby="contract-renewal-title">
          <div className="modal-heading"><div><div className="eyebrow">SUPPORT CONTRACT</div><h2 id="contract-renewal-title">Please Renewal Your Support Contract</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={() => setRenewalPopup(false)}><X size={18} /></button></div>
          <p>Your company’s support contract has expired. Please contact your company administrator or Jishnu Infotech to renew it before raising new tickets.</p>
          <div className="modal-footer"><button type="button" className="button button-primary" onClick={() => setRenewalPopup(false)}>Close</button></div>
        </section>
      </div>}
      {feedbackTicketId !== null && (() => {
        const feedbackTicket = tickets.find((ticket) => ticket.id === feedbackTicketId);
        if (!feedbackTicket) return null;
        return <CustomerRatingForm
          key={feedbackTicket.id}
          ticket={feedbackTicket}
          submitted={feedbackSubmittedId === feedbackTicket.id}
          onClose={() => {
            setDismissedFeedbackIds((current) => new Set(current).add(feedbackTicket.id));
            setFeedbackTicketId(null);
            setFeedbackSubmittedId(null);
          }}
          onSubmit={async (rating, comment) => {
            const result = await api<{ rating: NonNullable<Ticket["rating"]> }>(`/tickets/${feedbackTicket.id}/rating`, {
              method: "POST", body: JSON.stringify({ rating, comment }),
            });
            setTickets((current) => current.map((ticket) => ticket.id === feedbackTicket.id
              ? { ...ticket, rating: result.rating } : ticket));
            setDetail((current) => current?.ticket.id === feedbackTicket.id
              ? { ...current, ticket: { ...current.ticket, rating: result.rating } } : current);
            setFeedbackSubmittedId(feedbackTicket.id);
          }}
        />;
      })()}
      {newTicketAlert && user.role === "customer" && feedbackTicketId === null && !showCreate && <NewTicketPopup
        ticket={newTicketAlert}
        onDismiss={() => setNewTicketAlert(null)}
        onOpen={() => {
          setSelectedId(newTicketAlert.id);
          setActiveView("inbox");
          setFilter("all");
          setNewTicketAlert(null);
        }}
      />}
      {newConsultantTicketAlerts[0] && user.role === "agent" && <ConsultantNewTicketPopup
        notification={newConsultantTicketAlerts[0]}
        onDismiss={() => setNewConsultantTicketAlerts((current) => current.slice(1))}
        onOpen={async () => {
          const alert = newConsultantTicketAlerts[0];
          if (!alert) return;
          if (!alert.readAt) {
            await api("/notifications/read", { method: "POST", body: JSON.stringify({ id: alert.id }) });
            await refreshNotifications();
          }
          setSelectedId(alert.ticketId);
          setActiveView("inbox");
          setNewConsultantTicketAlerts((current) => current.slice(1));
        }}
      />}
      {informationAlerts[0] && (user.role === "customer" || user.role === "agent") && !showCreate && !renewalPopup && feedbackTicketId === null && !newTicketAlert && <InformationUpdatePopup
        notification={informationAlerts[0]}
        onDismiss={async () => {
          const notification = informationAlerts[0];
          if (!notification) return;
          try {
            await api("/information-center/notifications/read", { method: "POST", body: JSON.stringify({ id: notification.id }) });
            setInformationAlerts((current) => current.filter((item) => item.id !== notification.id));
          } catch (error) { setActionError(error instanceof Error ? error.message : "Could not dismiss this information notice."); }
        }}
        onOpen={async () => {
          const notification = informationAlerts[0];
          if (!notification) return;
          try {
            await api("/information-center/notifications/read", { method: "POST", body: JSON.stringify({ id: notification.id }) });
            setInformationAlerts((current) => current.filter((item) => item.id !== notification.id));
            setActiveView("information");
          } catch (error) { setActionError(error instanceof Error ? error.message : "Could not open this information notice."); }
        }}
      />}
    </div>
  );
}

function AnalyticsDashboard({ workspaceWide }: { workspaceWide: boolean }) {
  const [days, setDays] = useState(90);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [ticketFilters, setTicketFilters] = useState({ customerId: "", consultantId: "", dateFrom: "", dateTo: "", month: "" });
  const [ticketDirectory, setTicketDirectory] = useState<ReportTicketDirectory>({ companies: [], customers: [], consultants: [] });
  const [ticketRows, setTicketRows] = useState<ReportTicket[]>([]);
  const [ticketPage, setTicketPage] = useState(1);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [ticketError, setTicketError] = useState("");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoadingReport(true);
    setError("");
    setReport(null);
    const query = new URLSearchParams({ days: String(days) });
    if (selectedCompanyId) query.set("companyId", selectedCompanyId);
    api<AnalyticsReport>(`/reports?${query}`)
      .then((result) => { if (active) setReport(result); })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoadingReport(false); });
    return () => { active = false; };
  }, [days, selectedCompanyId]);

  useEffect(() => {
    let active = true;
    setLoadingTickets(true);
    setTicketError("");
    const query = new URLSearchParams({ page: String(ticketPage) });
    if (selectedCompanyId) query.set("companyId", selectedCompanyId);
    for (const [key, value] of Object.entries(ticketFilters)) if (value) query.set(key, value);
    api<{ tickets: ReportTicket[]; total: number; page: number; pageSize: number } & ReportTicketDirectory>(`/report-tickets?${query}`)
      .then((result) => {
        if (!active) return;
        setTicketRows(result.tickets);
        setTicketTotal(result.total);
        setTicketPage(result.page);
        setTicketDirectory({ companies: result.companies, customers: result.customers, consultants: result.consultants });
      })
      .catch((reason: Error) => { if (active) setTicketError(reason.message); })
      .finally(() => { if (active) setLoadingTickets(false); });
    return () => { active = false; };
  }, [selectedCompanyId, ticketFilters, ticketPage]);

  function updateTicketFilter(key: keyof typeof ticketFilters, value: string) {
    setTicketPage(1);
    setTicketFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === "month" && value ? { dateFrom: "", dateTo: "" } : {}),
      ...((key === "dateFrom" || key === "dateTo") && value ? { month: "" } : {}),
    }));
  }

  function resetTicketFilters() {
    setSelectedCompanyId("");
    setTicketFilters({ customerId: "", consultantId: "", dateFrom: "", dateTo: "", month: "" });
    setTicketPage(1);
  }

  function exportReport() {
    if (!report) return;
    const rows: Array<Array<string | number | null | undefined>> = [
      ["Jishnu Infotech Support Report", `${report.startDate} to ${report.endDate}`],
      ["Scope", workspaceWide ? report.scopeCompany?.name || "All client companies" : "Your company"],
      ["Tickets created", report.summary.created],
      ["Active", report.summary.activeBacklog],
      ["Waiting", report.summary.waiting],
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
      ["Consultant", "Active assigned tickets", "Assigned in period", "Closed in period"],
      ...report.agentWorkload.map((entry) => [entry.name, entry.active, entry.assignedInPeriod, entry.resolvedInPeriod]),
      [],
      ["Company", "Client user", "Email", "Tickets raised", "Active", "In progress", "Closed in period"],
      ...report.customerActivity.map((entry) => [entry.companyName || "", entry.name, entry.email, entry.raisedInPeriod, entry.active, entry.inProgress, entry.resolvedInPeriod]),
      [],
      ["Ticket", "Subject", "Company", "Client", "Status", "Priority", "Consultant", "Last updated"],
      ...ticketRows.map((ticket) => [ticket.id, ticket.subject, ticket.companyName || "", ticket.customerName, ticket.status, ticket.priority, ticket.consultantName || "Unassigned", ticket.updatedAt]),
      ...(workspaceWide && !report.scopeCompany ? [[], ["Company", "Tickets created in period"], ...report.companyVolume.map((entry) => [entry.name, entry.count])] : []),
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
        <ReportMetric icon={<Activity size={16} />} label="Active" value={report.summary.activeBacklog} tone="amber" caption="Open across this report's scope" />
        <ReportMetric icon={<CheckCheck size={16} />} label="Closed" value={resolvedInPeriod} tone="green" caption="Closed during this period" />
        <ReportMetric icon={<Clock3 size={16} />} label="Waiting" value={report.summary.waiting} tone="violet" caption="Currently waiting across this report's scope" />
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
        <section className="report-card report-wide-card">
          <div className="report-card-heading"><div><h2>Consultant workload &amp; closures</h2><p>Current backlog, tickets assigned, and tickets closed by each Consultant</p></div><Users size={16} /></div>
          {report.agentWorkload.length ? <div className="report-table-wrap"><table className="report-data-table"><thead><tr><th>Priority</th><th>Consultant</th><th>Active</th><th>Assigned</th><th>Closed</th></tr></thead><tbody>
            {report.agentWorkload.map((entry) => <tr key={entry.id}><td>{entry.routingPriority === 1 ? "Primary" : entry.routingPriority === 2 ? "Secondary" : `#${entry.routingPriority}`}</td><td>{entry.name}</td><td>{entry.active}</td><td>{entry.assignedInPeriod}</td><td>{entry.resolvedInPeriod}</td></tr>)}
          </tbody></table></div> : <p className="report-empty">No active Consultants to report.</p>}
        </section>
        {report.customerActivity.length > 0 && <section className="report-card report-wide-card">
          <div className="report-card-heading"><div><h2>Client ticket activity</h2><p>Ticket ownership and progress by client user in this report’s scope</p></div><Users size={16} /></div>
          <div className="report-table-wrap"><table className="report-data-table"><thead><tr><th>Company</th><th>Client user</th><th>Email</th><th>Raised</th><th>Active</th><th>In progress</th><th>Closed</th></tr></thead><tbody>
            {report.customerActivity.map((entry) => <tr key={entry.id}><td>{entry.companyName || "—"}</td><td>{entry.name}</td><td>{entry.email}</td><td>{entry.raisedInPeriod}</td><td>{entry.active}</td><td>{entry.inProgress}</td><td>{entry.resolvedInPeriod}</td></tr>)}
          </tbody></table></div>
        </section>}
        {workspaceWide && !report.scopeCompany && <section className="report-card">
          <div className="report-card-heading"><div><h2>Company volume</h2><p>Top companies by new tickets this period</p></div><Users size={16} /></div>
          {report.companyVolume.length ? <div className="report-ranked-list">{report.companyVolume.map((entry) => {
            const maxCount = Math.max(1, ...report.companyVolume.map((item) => item.count));
            return <div className="report-ranked-row" key={entry.name}>
              <span>{entry.name}</span><div className="report-rank-track"><i style={{ width: `${entry.count / maxCount * 100}%` }} /></div><strong>{entry.count}</strong>
            </div>;
          })}</div> : <p className="report-empty">No new tickets in this period.</p>}
        </section>}
        <section className="report-card report-wide-card">
          <div className="report-card-heading"><div><h2>Ticket details</h2><p>Filter by company, client user, Consultant, or creation date. {ticketTotal.toLocaleString()} matching tickets.</p></div><Inbox size={16} /></div>
          <div className="report-ticket-filters">
            {workspaceWide && <label>Company
              <select aria-label="Filter by company" value={selectedCompanyId} onChange={(event) => { setSelectedCompanyId(event.target.value); setTicketFilters((current) => ({ ...current, customerId: "" })); setTicketPage(1); }}>
                <option value="">All companies</option>
                {ticketDirectory.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>}
            <label>Client user
              <select aria-label="Filter by client user" value={ticketFilters.customerId} onChange={(event) => updateTicketFilter("customerId", event.target.value)}>
                <option value="">All client users</option>
                {ticketDirectory.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.companyName ? ` · ${customer.companyName}` : ""}</option>)}
              </select>
            </label>
            <label>Consultant
              <select aria-label="Filter by Consultant" value={ticketFilters.consultantId} onChange={(event) => updateTicketFilter("consultantId", event.target.value)}>
                <option value="">All Consultants</option>
                {ticketDirectory.consultants.map((consultant) => <option key={consultant.id} value={consultant.id}>{consultant.name}</option>)}
              </select>
            </label>
            <label>Created from<input aria-label="Filter created from date" type="date" value={ticketFilters.dateFrom} onChange={(event) => updateTicketFilter("dateFrom", event.target.value)} /></label>
            <label>Created to<input aria-label="Filter created to date" type="date" value={ticketFilters.dateTo} onChange={(event) => updateTicketFilter("dateTo", event.target.value)} /></label>
            <label>Created month<input aria-label="Filter by creation month" type="month" value={ticketFilters.month} onChange={(event) => updateTicketFilter("month", event.target.value)} /></label>
            <button className="button button-quiet" type="button" onClick={resetTicketFilters}>Clear filters</button>
          </div>
          {ticketError && <div className="inline-error" role="alert">{ticketError}</div>}
          {loadingTickets ? <p className="report-empty" role="status">Loading matching tickets…</p> : ticketRows.length ? <>
            <div className="report-table-wrap"><table className="report-data-table"><thead><tr><th>Ticket</th><th>Company</th><th>Client</th><th>Status</th><th>Priority</th><th>Consultant</th><th>Updated</th></tr></thead><tbody>
              {ticketRows.map((ticket) => <tr key={ticket.id}><td><strong>#{ticket.id}</strong><br />{ticket.subject}</td><td>{ticket.companyName || "—"}</td><td>{ticket.customerName}</td><td>{ticket.status === "in_progress" ? "In progress" : ticket.status === "resolved" ? "Closed" : ticket.status[0].toUpperCase() + ticket.status.slice(1)}</td><td>{ticket.priority[0].toUpperCase() + ticket.priority.slice(1)}</td><td>{ticket.consultantName || "Unassigned"}</td><td>{new Date(ticket.updatedAt).toLocaleString()}</td></tr>)}
            </tbody></table></div>
            <div className="report-ticket-pagination"><span>Page {ticketPage} of {Math.max(1, Math.ceil(ticketTotal / 50))}</span><div><button className="button button-quiet" type="button" disabled={ticketPage <= 1 || loadingTickets} onClick={() => setTicketPage((page) => page - 1)}>Previous</button><button className="button button-quiet" type="button" disabled={ticketPage >= Math.ceil(ticketTotal / 50) || loadingTickets} onClick={() => setTicketPage((page) => page + 1)}>Next</button></div></div>
          </> : <p className="report-empty">No tickets match the selected filters.</p>}
        </section>
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

function CustomerRatingForm({ ticket, submitted, onClose, onSubmit }: {
  ticket: Ticket;
  submitted: boolean;
  onClose: () => void;
  onSubmit: (rating: number, comment: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await onSubmit(selected, comment);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not submit your feedback.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="modal-scrim feedback-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="create-modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
      <div className="modal-heading">
        <div><div className="eyebrow">TICKET #{String(ticket.id).padStart(4, "0")}</div><h2 id="feedback-title">How was your support experience?</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close feedback" disabled={saving}><X size={18} /></button>
      </div>
      <p className="feedback-ticket-subject">Your ticket “{ticket.subject}” has been closed. Your feedback helps us improve.</p>
      {submitted ? <div className="feedback-thanks" role="status"><strong>Thank you for your feedback.</strong><button type="button" className="button button-primary" onClick={onClose}>Done</button></div>
        : <form onSubmit={submit}>
          <div className="rating-star-picker" role="radiogroup" aria-label="Rate your support experience">
            {[1, 2, 3, 4, 5].map((value) => <button type="button" role="radio" aria-checked={selected === value} aria-label={`${value} out of 5 stars`}
              className={selected >= value ? "selected" : ""} key={value} onClick={() => setSelected(value)}>★</button>)}
          </div>
          <label className="rating-comment-label">Comment (optional)<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} rows={3} placeholder="Tell us a little more…" /></label>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="feedback-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>Maybe later</button><button className="button button-primary" type="submit" disabled={!selected || saving}>{saving ? "Submitting…" : "Submit feedback"}</button></div>
        </form>}
    </section>
  </div>;
}

function Metric({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{String(value).padStart(2, "0")}</strong></div></div>;
}

function ManualTicketEntry({ onCreated }: { onCreated: (ticketId: number) => Promise<void> }) {
  type ManualCompany = { id: number; name: string; isActive?: boolean | number };
  type ManualClient = { id: number; name: string; username: string; contactNumber: string | null };
  type ManualConsultant = { id: number; name: string; priorityLabel?: string };
  const [companies, setCompanies] = useState<ManualCompany[]>([]);
  const [clients, setClients] = useState<ManualClient[]>([]);
  const [consultants, setConsultants] = useState<ManualConsultant[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [clientId, setClientId] = useState("");
  const [consultantId, setConsultantId] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [raisedDate, setRaisedDate] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10));
  const [closedDate, setClosedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selectedClient = clients.find((client) => String(client.id) === clientId);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ companies: ManualCompany[] }>("/admin/companies"),
      api<{ agents: ManualConsultant[] }>("/agents"),
    ]).then(([companyResult, consultantResult]) => {
      if (!active) return;
      const activeCompanies = companyResult.companies.filter((company) => Boolean(company.isActive));
      setCompanies(activeCompanies);
      setConsultants(consultantResult.agents);
      if (activeCompanies.length) setCompanyId(String(activeCompanies[0].id));
    }).catch((reason: Error) => setError(reason.message)).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!companyId) { setClients([]); setClientId(""); return; }
    let active = true;
    setClients([]);
    setClientId("");
    api<{ clients: ManualClient[] }>(`/admin/companies/${companyId}/ticket-clients`)
      .then((result) => { if (active) setClients(result.clients); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [companyId]);

  async function submitManualTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage(""); setSaving(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ ticket: { id: number } }>("/admin/manual-tickets", {
        method: "POST",
        body: JSON.stringify({
          companyId: Number(companyId), clientId: Number(clientId), consultantId: Number(consultantId),
          subject: form.get("subject"), description: form.get("description"), raisedDate,
          solution: form.get("solution"), status, closedDate: status === "resolved" ? closedDate : "",
        }),
      });
      setMessage("Ticket saved. Opening it in the inbox…");
      await onCreated(result.ticket.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this ticket.");
    } finally { setSaving(false); }
  }

  return <section className="feature-page manual-ticket-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />JISHNU INFOTECH ADMINISTRATION</div><h1>Raise Ticket Manually</h1><p>Record a ticket for a client and assign it to a Consultant.</p></div></div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button type="button" onClick={() => setMessage("")}><X size={13} /></button></div>}
    <section className="settings-card manual-ticket-card">
      <div className="settings-card-heading"><div><h2>Ticket details</h2><p>Saved tickets are linked to the selected company, client, and Consultant.</p></div><ClipboardPlus size={18} /></div>
      {loading ? <div className="report-loading" role="status">Loading companies and Consultants…</div> : <form className="manual-ticket-form" onSubmit={submitManualTicket}>
        <label>Company<select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required><option value="">Select a company</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label>Client name<select value={clientId} onChange={(event) => setClientId(event.target.value)} required disabled={!companyId || clients.length === 0}><option value="">{companyId ? "Select a client" : "Select a company first"}</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name} · {client.username}</option>)}</select></label>
        <label>Client mobile number<input value={selectedClient?.contactNumber || ""} placeholder="Fetched from client details" readOnly /></label>
        <label>Consultant name<select value={consultantId} onChange={(event) => setConsultantId(event.target.value)} required><option value="">Select a Consultant</option>{consultants.map((consultant) => <option key={consultant.id} value={consultant.id}>{consultant.name}</option>)}</select></label>
        <label>Ticket subject<input name="subject" minLength={4} maxLength={160} required /></label>
        <label>Ticket raised date<input type="date" value={raisedDate} onChange={(event) => setRaisedDate(event.target.value)} required /></label>
        <label className="manual-ticket-wide">Ticket description<textarea name="description" minLength={10} maxLength={5000} rows={5} required /></label>
        <label className="manual-ticket-wide">Consultant solution <span className="manual-ticket-optional">(optional while unresolved)</span><textarea name="solution" maxLength={5000} rows={4} /></label>
        <label>Status<select value={status} onChange={(event) => { const value = event.target.value as Status; setStatus(value); if (value !== "resolved") setClosedDate(""); }} required><option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="resolved">Closed</option></select></label>
        <label>Closed date{status !== "resolved" && <span className="manual-ticket-optional">(required when status is Closed)</span>}<input type="date" value={closedDate} onChange={(event) => setClosedDate(event.target.value)} required={status === "resolved"} disabled={status !== "resolved"} /></label>
        <div className="manual-ticket-actions"><button className="button button-primary" type="submit" disabled={saving || loading || !companies.length || !clients.length || !consultants.length}><ClipboardPlus size={15} />{saving ? "Saving ticket…" : "Save ticket"}</button></div>
      </form>}
      {!loading && companies.length === 0 && <p className="settings-hint">No active companies are available.</p>}
      {!loading && companyId && clients.length === 0 && <p className="settings-hint">No active client accounts were found in this company.</p>}
      {!loading && consultants.length === 0 && <p className="settings-hint">No active Consultants are available.</p>}
    </section>
  </section>;
}

function CompanyManagement({ workspaceAdmin, initialCompanyId, onChanged }: {
  workspaceAdmin: boolean;
  initialCompanyId: number | null;
  onChanged: () => Promise<void>;
}) {
  type CompanyUser = {
    id: number; name: string; username: string; email: string | null; contactNumber: string | null; isCompanyAdmin: boolean;
    approvalStatus: "approved" | "pending" | "rejected"; disabledAt: string | null;
  };
  type JoinCode = { id: number; expiresAt: string | null; revokedAt: string | null; createdAt: string };
  const [companies, setCompanies] = useState<Array<Company & { userCount: number; pendingCount: number }>>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(initialCompanyId);
  const [companyName, setCompanyName] = useState("");
  const [newCompanySupportValidUntil, setNewCompanySupportValidUntil] = useState("");
  const [companyDetailsDraft, setCompanyDetailsDraft] = useState({ name: "", domain: "", supportValidUntil: "" });
  const [companyUsers, setCompanyUsers] = useState<CompanyUser[]>([]);
  const [editingClientId, setEditingClientId] = useState<number | null>(null);
  const [clientDetailsDraft, setClientDetailsDraft] = useState({ name: "", contactNumber: "", email: "" });
  const [linkableClients, setLinkableClients] = useState<Array<{ id: number; name: string; username: string; email: string | null; companies: Array<{ id: number; name: string }> }>>([]);
  const [linkClientId, setLinkClientId] = useState("");
  const [invitations, setInvitations] = useState<Array<{ id: number; email: string; isCompanyAdmin: boolean; expiresAt: string }>>([]);
  const [joinCodes, setJoinCodes] = useState<JoinCode[]>([]);
  const [createdJoinCode, setCreatedJoinCode] = useState("");
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
  const loadLinkableClients = useCallback(async () => {
    if (!workspaceAdmin) return;
    const result = await api<{ clients: typeof linkableClients }>("/admin/client-accounts");
    setLinkableClients(result.clients);
  }, [workspaceAdmin]);
  useEffect(() => { loadLinkableClients().catch((reason: Error) => setError(reason.message)); }, [loadLinkableClients]);

  async function linkClientToCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCompanyId || !linkClientId) return;
    setError(""); setMessage("");
    try {
      const result = await api<{ message: string }>(`/admin/companies/${selectedCompanyId}/clients`, {
        method: "POST", body: JSON.stringify({ userId: Number(linkClientId) }),
      });
      setMessage(result.message);
      setLinkClientId("");
      await Promise.all([loadLinkableClients(), loadCompanyUsers(), loadCompanies()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not link this client."); }
  }

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    try {
      const form = new FormData(formElement);
      const result = await api<{ company: Company; administrator: { username: string } }>("/admin/companies", {
        method: "POST",
        body: JSON.stringify({
          name: companyName, adminName: form.get("adminName"), adminUsername: form.get("adminUsername"),
          adminEmail: form.get("adminEmail"), adminContactNumber: form.get("adminContactNumber"),
          adminPassword: form.get("adminPassword"), supportValidUntil: newCompanySupportValidUntil,
        }),
      });
      setSelectedCompanyId(result.company.id);
      setCompanyName("");
      setNewCompanySupportValidUntil("");
      formElement.reset();
      setMessage(`Created ${result.company.name}. The first administrator can sign in with username ${result.administrator.username}. Share the initial password securely.`);
      await loadCompanies();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create company."); }
  }

  async function createCompanyUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    try {
      const form = new FormData(formElement);
      const result = await api<{ user: CompanyUser; companyName: string }>("/company/users", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"), username: form.get("username"), email: form.get("email"),
          contactNumber: form.get("contactNumber"), password: form.get("password"),
        }),
      });
      formElement.reset();
      await Promise.all([loadCompanyUsers(), loadCompanies(), onChanged()]);
      setMessage(`${result.user.name} has been added to ${result.companyName} and can sign in now.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add this client."); }
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
      await api(`/company/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ ...changes, companyId: selectedCompanyId }) });
      await Promise.all([loadCompanyUsers(), loadCompanies(), onChanged()]);
      setMessage(changes.approvalStatus === "approved" ? `${user.name} approved to join the company.`
        : changes.approvalStatus === "rejected" ? `${user.name}'s request was declined.`
          : changes.disabled !== undefined ? `${user.name} access updated.` : `${user.name}'s company role updated.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update client account."); }
  }

  async function resetClientPassword(user: CompanyUser) {
    const password = window.prompt(`Enter a new password for ${user.name} (8 to 128 characters):`);
    if (password === null) return;
    if (password.length < 8 || password.length > 128) { setError("Password must be between 8 and 128 characters."); return; }
    setError(""); setMessage("");
    try {
      await api(`/company/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ password, companyId: selectedCompanyId }) });
      setMessage(`Password reset for ${user.username}. Share the new password securely.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not reset this password."); }
  }

  async function saveClientDetails(event: FormEvent<HTMLFormElement>, user: CompanyUser) {
    event.preventDefault();
    if (!selectedCompanyId) return;
    setError(""); setMessage("");
    try {
      await api(`/company/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...clientDetailsDraft, companyId: selectedCompanyId }),
      });
      setEditingClientId(null);
      await loadCompanyUsers();
      setMessage(`${user.username}'s details were updated.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update client details."); }
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
  useEffect(() => {
    setCompanyDetailsDraft({
      name: selectedCompany?.name || "",
      domain: selectedCompany?.domain || "",
      supportValidUntil: selectedCompany?.supportValidUntil?.slice(0, 10) || "",
    });
  }, [selectedCompany?.id, selectedCompany?.name, selectedCompany?.domain, selectedCompany?.supportValidUntil]);

  async function updateCompanyDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCompanyId) return;
    setError("");
    setMessage("");
    try {
      const result = await api<{ company: Company }>(`/admin/companies/${selectedCompanyId}`, {
        method: "PATCH", body: JSON.stringify(companyDetailsDraft),
      });
      setCompanies((current) => current.map((company) => company.id === result.company.id
        ? { ...company, ...result.company } : company));
      setMessage(`Company details updated for ${result.company.name}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update company details."); }
  }

  async function toggleCompanyStatus(company: Company) {
    const nextIsActive = !Boolean(company.isActive);
    const action = nextIsActive ? "enable" : "disable";
    if (!window.confirm(`${nextIsActive ? "Enable" : "Disable"} ${company.name}? ${nextIsActive ? "Its users will be able to sign in again." : "Users will be blocked from signing in to this company."}`)) return;
    setError("");
    setMessage("");
    try {
      const result = await api<{ company: Company; message: string }>(`/admin/companies/${company.id}/status`, {
        method: "PATCH", body: JSON.stringify({ isActive: nextIsActive }),
      });
      setCompanies((current) => current.map((company) => company.id === result.company.id
        ? { ...company, ...result.company } : company));
      setMessage(result.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${action} this company.`); }
  }

  return <section className="feature-page company-management">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />{workspaceAdmin ? "JISHNU INFOTECH ADMINISTRATION" : "COMPANY ADMINISTRATION"}</div><h1>{workspaceAdmin ? "Client companies" : "Company users"}</h1><p>{workspaceAdmin ? "Create isolated client workspaces and manage their access." : `Manage users and enrollment for ${companies.find((company) => company.id === selectedCompanyId)?.name || "your company"}.`}</p></div></div>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button onClick={() => setMessage("")}><X size={13} /></button></div>}
    {workspaceAdmin && <section className="settings-card company-create-section">
      <div className="settings-card-heading"><div><h2>Create a company</h2><p>Set up the workspace and create its first administrator login.</p></div><Plus size={18} /></div>
      <form className="company-create-form" onSubmit={createCompany}>
        <label>Company name<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} minLength={2} maxLength={120} required /></label>
        <label>Administrator name<input name="adminName" minLength={2} maxLength={100} required /></label>
        <label>Administrator username<input name="adminUsername" minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" autoComplete="username" autoCapitalize="none" spellCheck={false} required /></label>
        <label>Initial password<input name="adminPassword" type="password" minLength={8} maxLength={128} autoComplete="new-password" required /></label>
        <label>Administrator email (optional)<input name="adminEmail" type="email" maxLength={254} /></label>
        <label>Mobile number<input name="adminContactNumber" type="tel" autoComplete="tel" maxLength={25} placeholder="+91 98765 43210" required /></label>
        <label>Support valid until<input type="date" value={newCompanySupportValidUntil} onChange={(event) => setNewCompanySupportValidUntil(event.target.value)} required /></label>
        <button className="button button-primary" type="submit"><Plus size={15} /> Create company</button>
      </form>
    </section>}

    {workspaceAdmin && <section className="settings-card company-directory-section">
      <div className="settings-card-heading"><div><h2>Companies</h2><p>Select a company to manage its users, invitations, and support contract.</p></div><Building2 size={18} /></div>
      <div className="company-list">
        {companies.map((company) => <div className="company-directory-row" key={company.id}>
          <button type="button" className={`company-select-row ${company.id === selectedCompanyId ? "selected" : ""}`} onClick={() => setSelectedCompanyId(company.id)}>
            <span><strong>{company.name}{!Boolean(company.isActive) && <span className="team-state team-disabled">Disabled</span>}</strong><small>{company.domain || "No email domain mapped"} · {company.userCount} users · {company.pendingCount} pending · Support valid until {company.supportValidUntil ? dateLabel(company.supportValidUntil) : "Not set"}</small></span><ArrowRight size={15} />
          </button>
          <button type="button" className="button button-quiet company-list-status-button" onClick={() => toggleCompanyStatus(company)}>{Boolean(company.isActive) ? "Disable" : "Enable"}</button>
        </div>)}
        {companies.length === 0 && <p className="settings-hint">No companies yet. Create a company above to get started.</p>}
      </div>
    </section>}

    {selectedCompanyId && <section className="settings-card">
      <div className="settings-card-heading"><div><h2>{workspaceAdmin ? "Company details" : selectedCompany?.name || "Team access"}</h2><p>{workspaceAdmin ? `Edit the profile for ${selectedCompany?.name || "this company"}, then manage its users and invitations.` : "Invite colleagues, generate reusable company codes, or review sign-up requests."}</p></div><Users size={18} /></div>
      {workspaceAdmin && <form className="support-contract-form company-details-form" onSubmit={updateCompanyDetails}>
        <label>Company name<input value={companyDetailsDraft.name} onChange={(event) => setCompanyDetailsDraft((current) => ({ ...current, name: event.target.value }))} minLength={2} maxLength={120} required /></label>
        <label>Company email domain (optional)<input value={companyDetailsDraft.domain} onChange={(event) => setCompanyDetailsDraft((current) => ({ ...current, domain: event.target.value }))} maxLength={253} placeholder="example.com" autoCapitalize="none" /></label>
        <label>Support valid until (optional)<input type="date" value={companyDetailsDraft.supportValidUntil} onChange={(event) => setCompanyDetailsDraft((current) => ({ ...current, supportValidUntil: event.target.value }))} /></label>
        <span>Changes here update the company profile, email-domain mapping, and support contract.</span>
        <button className="button button-primary" type="submit" disabled={companyDetailsDraft.name.trim().length < 2}>Save company details</button>
      </form>}
      {workspaceAdmin && selectedCompany && <div className="company-status-control">
        <div><strong>Company access</strong><span>{Boolean(selectedCompany.isActive) ? "Active — company users can sign in." : "Disabled — company users cannot sign in."}</span></div>
        <button className="button button-quiet" type="button" onClick={() => toggleCompanyStatus(selectedCompany)}>{Boolean(selectedCompany.isActive) ? "Disable company" : "Enable company"}</button>
      </div>}
      {!workspaceAdmin && <div className="client-access-method">
        <h3>Create a Customer login</h3>
        <p className="settings-hint">Create an active login and share the username and initial password securely.</p>
        <form className="manual-client-form" onSubmit={createCompanyUser}>
          <label>Full name<input name="name" autoComplete="name" minLength={2} maxLength={100} required /></label>
          <label>Username<input name="username" minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" autoComplete="username" autoCapitalize="none" spellCheck={false} required /></label>
          <label>Email address (optional)<input name="email" type="email" autoComplete="email" maxLength={254} /></label>
          <label>Mobile number<input name="contactNumber" type="tel" autoComplete="tel" maxLength={25} placeholder="+91 98765 43210" required /></label>
          <label>Initial password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
          <button className="button button-primary" type="submit"><Plus size={15} /> Add customer</button>
        </form>
      </div>}
      {workspaceAdmin && <div className="client-access-method multi-company-link">
        <h3>Link an existing client account</h3>
        <p className="settings-hint">Give an existing client login access to this company. They will choose a company after signing in if they belong to more than one.</p>
        <form className="link-client-form" onSubmit={linkClientToCompany}>
          <label>Client account<select value={linkClientId} onChange={(event) => setLinkClientId(event.target.value)} required>
            <option value="">Select a client</option>
            {linkableClients.filter((client) => !client.companies.some((company) => company.id === selectedCompanyId)).map((client) => <option key={client.id} value={client.id}>{client.name} · {client.username}{client.email ? ` · ${client.email}` : ""}{client.companies.length ? ` · Also in ${client.companies.map((company) => company.name).join(", ")}` : ""}</option>)}
          </select></label>
          <button className="button button-primary" type="submit" disabled={!linkClientId}><Plus size={15} /> Link client</button>
        </form>
      </div>}
      {companyUsers.some((user) => user.approvalStatus === "pending") && <div className="company-users-section">
        <h3>Requests awaiting approval</h3>
        {companyUsers.filter((user) => user.approvalStatus === "pending").map((user) => <div className="admin-team-row" key={user.id}>
          <div className="directory-customer"><strong>{displayClientName(user.name)}</strong><span>{user.username}{user.email ? ` · ${user.email}` : ""}</span></div>
          <button className="button button-primary" onClick={() => updateUser(user, { approvalStatus: "approved" })}>Approve</button>
          <button className="button button-quiet" onClick={() => updateUser(user, { approvalStatus: "rejected" })}>Decline</button>
        </div>)}
      </div>}

      <div className="company-users-section"><h3>Company members</h3>
        {companyUsers.filter((user) => user.approvalStatus !== "pending").map((user) => <div className="admin-team-row" key={user.id}>
          <div className="avatar customer-avatar">{initials(user.name)}</div>
          {editingClientId === user.id ? <form className="client-user-edit-form" onSubmit={(event) => saveClientDetails(event, user)}>
            <label>Name<input value={clientDetailsDraft.name} onChange={(event) => setClientDetailsDraft((current) => ({ ...current, name: event.target.value }))} minLength={2} maxLength={100} required /></label>
            <label>Mobile number<input type="tel" value={clientDetailsDraft.contactNumber} onChange={(event) => setClientDetailsDraft((current) => ({ ...current, contactNumber: event.target.value }))} maxLength={25} required /></label>
            <label>Email (optional)<input type="email" value={clientDetailsDraft.email} onChange={(event) => setClientDetailsDraft((current) => ({ ...current, email: event.target.value }))} maxLength={254} /></label>
            <div className="client-user-edit-actions"><button className="button button-primary" type="submit">Save details</button><button className="button button-quiet" type="button" onClick={() => setEditingClientId(null)}>Cancel</button></div>
          </form> : <div className="directory-customer"><strong>{user.name}{Boolean(user.isCompanyAdmin) && <span className="admin-badge">COMPANY ADMIN</span>}</strong><span>{user.username}{user.email ? ` · ${user.email}` : ""}{user.contactNumber ? ` · ${user.contactNumber}` : ""}</span></div>}
          {editingClientId !== user.id && <button className="button button-quiet" onClick={() => { setEditingClientId(user.id); setClientDetailsDraft({ name: user.name, contactNumber: user.contactNumber || "", email: user.email || "" }); }}>Edit details</button>}
          {editingClientId !== user.id && <>
            {user.approvalStatus === "approved" && <button className="button button-quiet" onClick={() => resetClientPassword(user)}>Reset password</button>}
            <span className={`team-state ${user.disabledAt || user.approvalStatus === "rejected" ? "team-disabled" : ""}`}>{user.approvalStatus === "rejected" ? "Declined" : user.disabledAt ? "Disabled" : "Active"}</span>
            {(workspaceAdmin || !user.isCompanyAdmin) && user.approvalStatus === "approved" && <button className="button button-quiet" onClick={() => updateUser(user, { isCompanyAdmin: !user.isCompanyAdmin })}>{user.isCompanyAdmin ? "Remove admin" : "Make admin"}</button>}
            <button className="button button-quiet" onClick={() => updateUser(user, { disabled: !user.disabledAt })}>{user.disabledAt ? "Enable" : "Disable"}</button>
          </>}
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
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />CONSULTANT WORKSPACE</div><h1>Notifications</h1><p>Ticket replies and service-level alerts assigned to you.</p></div></div>
    <div className="directory-list">
      {notifications.length === 0
        ? <div className="empty-list"><Bell size={27} /><strong>You're all caught up</strong><span>New ticket alerts will show here.</span></div>
        : notifications.map((notification) => <button type="button" className={`notification-row ${notification.readAt ? "" : "notification-unread"}`} key={notification.id} onClick={() => onOpen(notification)}>
          <span className="notification-indicator" /><span className="notification-copy"><strong>{notification.message}</strong><small>Ticket #{notification.ticketId} · {timeAgo(notification.createdAt)}</small></span><ArrowRight size={16} />
        </button>)}
    </div>
  </section>;
}

function ConsultantNewTicketPopup({ notification, onDismiss, onOpen }: {
  notification: Notification; onDismiss: () => void; onOpen: () => void;
}) {
  return <div className="modal-scrim feedback-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}>
    <section className="create-modal feedback-modal new-ticket-modal" role="dialog" aria-modal="true" aria-labelledby="consultant-new-ticket-title">
      <div className="modal-heading">
        <div><div className="eyebrow">NEW TICKET · #{String(notification.ticketId).padStart(4, "0")}</div><h2 id="consultant-new-ticket-title">A ticket has been assigned to you</h2></div>
        <button type="button" className="icon-button" onClick={onDismiss} aria-label="Close ticket notice"><X size={18} /></button>
      </div>
      <div className="new-ticket-summary">
        <strong>{notification.subject || notification.message}</strong>
        {notification.customerName && <span>From {notification.customerName}{notification.category ? ` · ${notification.category}` : ""}{notification.priority ? ` · ${notification.priority} priority` : ""}</span>}
        {notification.description && <p>{notification.description}</p>}
        <span>Only you received this assignment alert.</span>
      </div>
      <div className="modal-footer"><button type="button" className="button button-quiet" onClick={onDismiss}>Later</button><button type="button" className="button button-primary" onClick={onOpen}>View ticket <ArrowRight size={14} /></button></div>
    </section>
  </div>;
}

function InformationUpdatePopup({ notification, onDismiss, onOpen }: {
  notification: InformationNotification;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const normalizedDate = notification.postedAt.includes("T") ? notification.postedAt : notification.postedAt.replace(" ", "T");
  const date = new Date(normalizedDate.endsWith("Z") ? normalizedDate : `${normalizedDate}Z`);
  const postedDate = Number.isNaN(date.getTime()) ? notification.postedAt : new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  }).format(date);
  return <div className="modal-scrim feedback-scrim information-alert-scrim" role="presentation">
    <section className="create-modal feedback-modal information-alert-modal" role="dialog" aria-modal="true" aria-labelledby="information-alert-title">
      <div className="modal-heading">
        <div><div className="eyebrow">NEW INFORMATION Â· {postedDate}</div><h2 id="information-alert-title">An information update was posted</h2></div>
        <button type="button" className="icon-button" onClick={onDismiss} aria-label="Dismiss information notice"><X size={18} /></button>
      </div>
      <div className="information-alert-author"><strong>{notification.consultantName}</strong><span>Consultant Â· {notification.consultantMobile || "Mobile number unavailable"}</span></div>
      <p className="information-alert-copy">{notification.information}</p>
      {notification.attachments.length > 0 && <div className="information-alert-files" aria-label="Information attachments">{notification.attachments.map((attachment) => <a key={attachment.id} href={`/api/information-center/${notification.informationId}/attachments/${attachment.id}`} target="_blank" rel="noreferrer"><Paperclip size={13} /><span>{attachment.name}</span><small>{formatBytes(attachment.sizeBytes)}</small></a>)}</div>}
      <div className="modal-footer"><button type="button" className="button button-quiet" onClick={onDismiss}>Dismiss</button><button type="button" className="button button-primary" onClick={onOpen}>Open Information Center <ArrowRight size={14} /></button></div>
    </section>
  </div>;
}

function AdminSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const [agents, setAgents] = useState<Array<{ id: number; name: string; username: string; email: string | null; contactNumber: string | null; isAdmin: boolean; routingPriority: number; specialty: ConsultantSpecialty; disabledAt: string | null }>>([]);
  const [sla, setSla] = useState({ firstResponseHours: 4, resolutionHours: 48 });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingSpecialty, setEditingSpecialty] = useState<number | null>(null);
  const [specialtyDraft, setSpecialtyDraft] = useState<ConsultantSpecialty>("both");
  const [editingAgentId, setEditingAgentId] = useState<number | null>(null);
  const [agentDetailsDraft, setAgentDetailsDraft] = useState({ name: "", username: "", email: "", contactNumber: "" });

  const load = useCallback(async () => {
    const [team, slaResult] = await Promise.all([
      api<{ agents: typeof agents }>("/admin/agents"),
      api<{ sla: typeof sla }>("/admin/sla-settings"),
    ]);
    setAgents(team.agents);
    setSla(slaResult.sla);
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function createConsultant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    const form = new FormData(formElement);
    try {
      const result = await api<{ agent: { name: string; username: string; isAdmin: boolean } }>("/admin/agents", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"), username: form.get("username"), email: form.get("email"), contactNumber: form.get("contactNumber"), password: form.get("password"),
          isAdmin: form.get("isAdmin") === "on", specialty: form.get("specialty"),
        }),
      });
      setMessage(`${result.agent.isAdmin ? "Super Admin" : "Consultant"} account created for ${result.agent.name}. Username: ${result.agent.username}. Share the initial password securely.`);
      formElement.reset();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create the account."); }
  }

  async function resetAgentPassword(agent: typeof agents[number]) {
    const password = window.prompt(`Enter a new password for ${agent.name} (8 to 128 characters):`);
    if (password === null) return;
    if (password.length < 8 || password.length > 128) { setError("Password must be between 8 and 128 characters."); return; }
    setError(""); setMessage("");
    try {
      await api(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setMessage(`Password reset for ${agent.username}. Share the new password securely.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not reset this password."); }
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
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update Consultant access."); }
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
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update Consultant routing priority."); }
  }

  async function saveSpecialty(agent: typeof agents[number]) {
    setError("");
    setMessage("");
    try {
      await api(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ specialty: specialtyDraft }) });
      await load();
      await onChanged();
      setEditingSpecialty(null);
      setMessage(`${agent.name}'s specialty updated.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update Consultant specialty."); }
  }

  async function saveAgentDetails(event: FormEvent<HTMLFormElement>, agent: typeof agents[number]) {
    event.preventDefault();
    setError(""); setMessage("");
    try {
      await api(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify(agentDetailsDraft) });
      await load();
      await onChanged();
      setEditingAgentId(null);
      setMessage(`${agent.username}'s details were updated.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update Consultant details."); }
  }

  return <section className="feature-page admin-settings">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />WORKSPACE ADMINISTRATION</div><h1>Settings</h1><p>Manage your support team and service targets.</p></div></div>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button onClick={() => setMessage("")}><X size={13} /></button></div>}

    <section className="settings-card">
      <div className="settings-card-heading"><div><h2>Consultant team</h2><p>Create username and password accounts directly, then control team access.</p></div><span>{agents.filter((agent) => !agent.disabledAt).length} active</span></div>
      <form className="team-create-form" onSubmit={createConsultant}>
        <label>Full name<input name="name" autoComplete="name" minLength={2} maxLength={120} required placeholder="Consultant name" /></label>
        <label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" required placeholder="consultant01" /></label>
        <label>Work email (optional)<input name="email" type="email" autoComplete="email" maxLength={254} placeholder="consultant@company.com" /></label>
        <label>Mobile number<input name="contactNumber" type="tel" autoComplete="tel" maxLength={25} placeholder="+91 98765 43210" required /></label>
        <label>Consultant type<select name="specialty" defaultValue="" required><option value="" disabled>Select specialty</option><option value="functional">Functional</option><option value="technical">Technical</option><option value="both">Both</option></select></label>
        <label>Initial password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required placeholder="At least 8 characters" /><small>Share this password with the new user through a secure channel.</small></label>
        <label className="team-admin-option"><input name="isAdmin" type="checkbox" /> Grant Super Admin permissions</label>
        <button className="button button-primary" type="submit"><Plus size={15} /> Create account</button>
      </form>
      <p className="settings-hint">Automatic tickets follow Primary-to-secondary priority; Consultants with the same priority are balanced by active unresolved workload. Use the arrows to change priority.</p>
      <div className="admin-team-list">
        {agents.map((agent) => <div className="admin-team-row" key={agent.id}>
          <div className="avatar avatar-agent">{initials(agent.name)}</div>
          {editingAgentId === agent.id ? <form className="consultant-profile-edit" onSubmit={(event) => saveAgentDetails(event, agent)}>
            <label>Full name<input value={agentDetailsDraft.name} onChange={(event) => setAgentDetailsDraft((current) => ({ ...current, name: event.target.value }))} minLength={2} maxLength={120} required /></label>
            <label>Username<input value={agentDetailsDraft.username} onChange={(event) => setAgentDetailsDraft((current) => ({ ...current, username: event.target.value }))} minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" autoCapitalize="none" spellCheck={false} required /></label>
            <label>Work email (optional)<input type="email" value={agentDetailsDraft.email} onChange={(event) => setAgentDetailsDraft((current) => ({ ...current, email: event.target.value }))} maxLength={254} /></label>
            <label>Mobile number<input type="tel" value={agentDetailsDraft.contactNumber} onChange={(event) => setAgentDetailsDraft((current) => ({ ...current, contactNumber: event.target.value }))} maxLength={25} required /></label>
            <div className="consultant-profile-actions"><button className="button button-primary" type="submit">Save details</button><button className="button button-quiet" type="button" onClick={() => setEditingAgentId(null)}>Cancel</button></div>
          </form> : <>
            <div className="directory-customer"><strong>{agent.name}{Boolean(agent.isAdmin) && <span className="admin-badge">SUPER ADMIN</span>}</strong><span>{agent.username}{agent.email ? ` · ${agent.email}` : ""}{agent.contactNumber ? ` · ${agent.contactNumber}` : ""}</span></div>
            {editingSpecialty === agent.id ? <><select aria-label={`Specialty for ${agent.name}`} className="consultant-specialty-edit" value={specialtyDraft} onChange={(event) => setSpecialtyDraft(event.target.value as ConsultantSpecialty)}><option value="functional">Functional</option><option value="technical">Technical</option><option value="both">Both</option></select><button className="button button-quiet" onClick={() => saveSpecialty(agent)}>Save</button><button className="button button-quiet" onClick={() => setEditingSpecialty(null)}>Cancel</button></> : <><span className="consultant-specialty-label">{agent.specialty === "both" ? "Functional + Technical" : agent.specialty[0].toUpperCase() + agent.specialty.slice(1)}</span><button className="button button-quiet" onClick={() => { setEditingSpecialty(agent.id); setSpecialtyDraft(agent.specialty); }}>Edit type</button></>}
            <button className="button button-quiet" onClick={() => { setEditingAgentId(agent.id); setAgentDetailsDraft({ name: agent.name, username: agent.username, email: agent.email || "", contactNumber: agent.contactNumber || "" }); }}>Edit details</button>
            <span className="agent-routing-priority">{agent.routingPriority === 1 ? "Primary" : agent.routingPriority === 2 ? "Secondary" : `#${agent.routingPriority}`}</span>
            <button className="button button-quiet" aria-label={`Move ${agent.name} up in routing priority`} disabled={Boolean(agent.disabledAt) || agent.routingPriority <= 1} onClick={() => moveAgent(agent, -1)}><ArrowUp size={13} /></button>
            <button className="button button-quiet" aria-label={`Move ${agent.name} down in routing priority`} disabled={Boolean(agent.disabledAt) || agent.routingPriority >= agents.filter((item) => !item.disabledAt).length} onClick={() => moveAgent(agent, 1)}><ArrowDown size={13} /></button>
            <span className={`team-state ${agent.disabledAt ? "team-disabled" : ""}`}>{agent.disabledAt ? "Disabled" : "Active"}</span>
            <button className="button button-quiet" onClick={() => resetAgentPassword(agent)}>Reset password</button>
            <button className="button button-quiet" disabled={Boolean(agent.isAdmin) && !agent.disabledAt} onClick={() => toggleAgent(agent)}>{agent.disabledAt ? "Enable" : "Disable"}</button>
          </>}
        </div>)}
      </div>
    </section>

    <section className="settings-card">
      <div className="settings-card-heading"><div><h2>Service-level targets</h2><p>Elapsed time from ticket creation. Alerts appear in the assigned Consultant's notifications.</p></div><Clock3 size={18} /></div>
      <form className="sla-form" onSubmit={saveSla}>
        <label>First response target (hours)<input type="number" min="0.25" max="720" step="0.25" value={sla.firstResponseHours} onChange={(event) => setSla({ ...sla, firstResponseHours: Number(event.target.value) })} required /></label>
        <label>Resolution target (hours)<input type="number" min="0.5" max="2160" step="0.5" value={sla.resolutionHours} onChange={(event) => setSla({ ...sla, resolutionHours: Number(event.target.value) })} required /></label>
        <button className="button button-primary" type="submit">Save targets</button>
      </form>
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
          method: "POST", body: JSON.stringify({ token, name: form.get("name"), contactNumber: form.get("contactNumber"), password: form.get("password") }),
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
      <p>{flow === "invite" ? "Set up your Consultant account to access the support workspace." : flow === "client-invite" ? "Complete your client account invitation." : "Create a new password for your client portal account."}</p>
    </div>
    {(formError || error) && <div className="inline-error" role="alert">{formError || error}</div>}
    {flow === "invite" && email && <p className="auth-notice">Invitation for <strong>{email}</strong></p>}
    {flow === "client-invite" && email && <p className="auth-notice">Invitation for <strong>{email}</strong> to join <strong>{companyName}</strong>.</p>}
    {notice && <p className="auth-notice">{notice}</p>}
    {!(formError || error) || flow === "reset" ? <form className="login-form" onSubmit={submit}>
      {(flow === "invite" || flow === "client-invite") && <>
        <label>Your name<input name="name" autoComplete="name" minLength={2} maxLength={100} required /></label>
        <label>Contact number<input name="contactNumber" type="tel" autoComplete="tel" maxLength={25} placeholder="+91 98765 43210" required /></label>
      </>}
      <label>New password<input name="password" type="password" minLength={8} maxLength={128} autoComplete="new-password" placeholder="At least 8 characters" required /></label>
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
  return <main className="login-screen">
    <div className="login-decoration decoration-one" /><div className="login-decoration decoration-two" />
    <div className="login-card">
      <div className="login-brand"><CompanyLogo className="company-logo-login" /></div>
      <div className="login-intro"><div className="eyebrow"><span className="eyebrow-live" />JISHNU INFOTECH SUPPORT</div><h1>{portal === "customer" ? "Customer Support Platform" : <>Your support team,<br />in one workspace.</>}</h1><p>{portal === "customer" ? "Open a service request, follow its progress, and continue the conversation with our team." : "Review the shared queue, respond to customer requests, and keep every ticket moving."}</p></div>
      <div className="portal-tabs" role="tablist" aria-label="Choose your portal">
        <button type="button" className={portal === "customer" ? "selected" : ""} role="tab" aria-selected={portal === "customer"} onClick={() => onPortalChange("customer")}><Users size={14} /> Customer portal</button>
        <button type="button" className={portal === "agent" ? "selected" : ""} role="tab" aria-selected={portal === "agent"} onClick={() => onPortalChange("agent")}><Inbox size={14} /> Consultant portal</button>
      </div>
      {portal === "customer" && <div className="auth-mode-tabs">
        <button type="button" className={mode === "login" ? "selected" : ""} onClick={() => onModeChange("login")}>Sign in</button>
        <button type="button" className={mode === "register" ? "selected" : ""} onClick={() => onModeChange("register")}>Create customer account</button>
      </div>}
      {notice && <div className="inline-success" role="status">{notice}</div>}
      <form className="login-form" onSubmit={mode === "register" && portal === "customer" ? onRegister : (event) => onSubmit(event, portal)}>
        {mode === "register" && portal === "customer" && <>
          <label>Your name<input name="name" autoComplete="name" minLength={2} maxLength={100} placeholder="Full name" required /></label>
          <label>Company invitation code<input name="joinCode" autoComplete="off" placeholder="Enter a code from your company admin" required /><span className="form-hint">Your invitation code identifies your company and activates your account.</span></label>
          <label>Mobile number<input name="contactNumber" type="tel" autoComplete="tel" maxLength={25} placeholder="+91 98765 43210" required /></label>
        </>}
        <label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={mode === "register" ? 3 : undefined} maxLength={32} pattern={mode === "register" ? "[A-Za-z0-9][A-Za-z0-9._-]{2,31}" : undefined} placeholder={mode === "register" ? "Choose a username" : "Enter your username"} required /></label>
        {mode === "register" && portal === "customer" && <label>Email address (optional)<input name="email" type="email" autoComplete="email" placeholder="you@company.com" /></label>}
        <label>Password<div className="password-field"><input name="password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 8 : undefined} maxLength={128} placeholder={mode === "register" ? "At least 8 characters" : "Enter your password"} required /></div></label>
        {error && <div className="inline-error">{error}</div>}
        <button className="button button-primary login-button" type="submit">{mode === "register" ? "Create account" : "Sign in"} <ArrowRight size={16} /></button>
      </form>
      {mode === "login" && <p className="form-hint">Usernames and passwords are case-sensitive. Need a password reset? Contact your account administrator.</p>}
      <div className="login-help"><ShieldCheck size={15} /> Your support workspace, securely connected</div>
    </div>
    <footer className="login-footer"><span>© 2026 Jishnu Infotech</span><span><CircleHelp size={13} /> Need help signing in?</span></footer>
  </main>;
}

function InformationCenter({ isConsultant, isSuperAdmin, currentUserId }: {
  isConsultant: boolean;
  isSuperAdmin: boolean;
  currentUserId: number;
}) {
  const [posts, setPosts] = useState<InformationPost[]>([]);
  const [clients, setClients] = useState<InformationClient[]>([]);
  const [companies, setCompanies] = useState<InformationCompany[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [information, setInformation] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [audience, setAudience] = useState<"all" | "clients" | "company">("all");
  const [companyId, setCompanyId] = useState("");
  const [clientIds, setClientIds] = useState<number[]>([]);
  const [clientSearch, setClientSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<{ posts: InformationPost[]; total: number; clients?: InformationClient[]; companies?: InformationCompany[] }>(`/information-center?search=${encodeURIComponent(query.trim())}`)
      .then((result) => {
        if (!active) return;
        setPosts(result.posts);
        setTotal(result.total);
        if (result.clients) setClients(result.clients);
        if (result.companies) setCompanies(result.companies);
      })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, refreshKey]);

  function startNewPost() {
    setEditingId(null);
    setInformation("");
    setFiles([]);
    setAudience("all");
    setCompanyId("");
    setClientIds([]);
    setClientSearch("");
    setMessage("");
    setError("");
    setShowEditor(true);
  }

  function startEditing(post: InformationPost) {
    setEditingId(post.id);
    setInformation(post.information);
    setFiles([]);
    const postCompanyIds = post.recipientCompanyIds || [];
    setAudience(Boolean(post.allClients) ? "all" : postCompanyIds.length ? "company" : "clients");
    setCompanyId(postCompanyIds[0] ? String(postCompanyIds[0]) : "");
    setClientIds(post.recipientIds || []);
    setClientSearch("");
    setMessage("");
    setError("");
    setShowEditor(true);
  }

  async function savePost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const body = new FormData();
      body.append("information", information);
      body.append("audience", audience);
      body.append("allClients", audience === "all" ? "true" : "false");
      body.append("clientIds", JSON.stringify(audience === "clients" ? clientIds : []));
      body.append("companyId", audience === "company" ? companyId : "");
      files.forEach((file) => body.append("attachments", file));
      await api(`/information-center${editingId ? `/${editingId}` : ""}`, {
        method: editingId ? "PATCH" : "POST",
        body,
      });
      setShowEditor(false);
      setFiles([]);
      setMessage(editingId ? "Information updated." : "Information posted to the selected audience.");
      setRefreshKey((key) => key + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this information.");
    } finally { setSaving(false); }
  }

  const dateLabel = (value: string) => {
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
  };
  const visibleClients = clients.filter((client) =>
    `${client.name} ${client.username} ${client.companyNames || ""}`.toLowerCase().includes(clientSearch.trim().toLowerCase()));

  return <section className="feature-page information-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />{isConsultant ? "CONSULTANT WORKSPACE" : "CLIENT WORKSPACE"}</div><h1>Information Center</h1><p>Important updates shared by the support team.</p></div>{isConsultant && <button className="button button-primary" type="button" onClick={startNewPost}><Plus size={15} /> Add information</button>}</div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button type="button" onClick={() => setMessage("")}><X size={13} /></button></div>}
    <div className="directory-toolbar information-toolbar">
      <div className="search-box"><Search size={15} /><input aria-label="Search information" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search information or Consultant…" /></div>
      <span className="knowledge-total-card">{total} {total === 1 ? "Information post" : "Information posts"}</span>
    </div>
    {showEditor && <section className="settings-card information-editor">
        <div className="settings-card-heading"><div><h2>{editingId ? "Edit information" : "Post information"}</h2><p>Choose whether this update is shared with everyone, a company, or selected clients.</p></div><Megaphone size={18} /></div>
      <form onSubmit={savePost}>
        <label className="information-body-label">Information<textarea value={information} onChange={(event) => setInformation(event.target.value)} minLength={5} maxLength={10000} rows={5} required placeholder="Write the information you want to share…" /></label>
        <label className="information-body-label">Attachments<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setFiles(Array.from(event.target.files || []))} /><small>Up to 5 PDF or image files per post, 10 MB each.</small></label>
        {files.length > 0 && <div className="information-pending-files">{files.map((file) => <span key={`${file.name}-${file.size}`}>{file.name} Â· {formatBytes(file.size)}</span>)}</div>}
        <fieldset className="information-audience"><legend>Audience</legend>
          <label><input type="radio" name="information-audience" checked={audience === "all"} onChange={() => setAudience("all")} /> All clients</label>
          <label><input type="radio" name="information-audience" checked={audience === "company"} onChange={() => setAudience("company")} /> Specific company</label>
          <label><input type="radio" name="information-audience" checked={audience === "clients"} onChange={() => setAudience("clients")} /> Specific clients</label>
        </fieldset>
        {audience === "company" && <label className="information-company-picker">Company<select aria-label="Select company audience" value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
          <option value="">Select a company</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>}
        {audience === "clients" && <div className="information-client-picker">
          <div className="search-box"><Search size={14} /><input aria-label="Search clients to notify" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Find clients…" /></div>
          <div className="information-client-list">{visibleClients.map((client) => <label key={client.id}>
            <input type="checkbox" checked={clientIds.includes(client.id)} onChange={(event) => setClientIds((current) => event.target.checked ? [...current, client.id] : current.filter((id) => id !== client.id))} />
            <span><strong>{client.name}</strong><small>{client.companyNames || `@${client.username}`}</small></span>
          </label>)}{visibleClients.length === 0 && <p className="settings-hint">No active clients match this search.</p>}</div>
          <small>{clientIds.length} clients selected</small>
        </div>}
        <div className="information-editor-actions"><button className="button button-quiet" type="button" onClick={() => setShowEditor(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !information.trim() || (audience === "clients" && clientIds.length === 0) || (audience === "company" && !companyId)}>{saving ? "Saving…" : editingId ? "Save changes" : "Post information"}</button></div>
      </form>
    </section>}
    {loading ? <div className="report-empty" role="status">Loading information…</div> : posts.length === 0
      ? <div className="empty-list"><Megaphone size={27} /><strong>No information posted yet</strong><span>{query ? "Try a different search." : "Updates from Consultants will appear here."}</span></div>
      : <div className="information-list">{posts.map((post) => {
        const canEdit = isConsultant && (isSuperAdmin || Number(post.consultantId) === currentUserId);
        const audienceLabel = Boolean(post.allClients) ? "All clients" : post.recipientCompanyIds?.length
          ? companies.find((company) => company.id === post.recipientCompanyIds?.[0])?.name || "Selected company"
          : (post.recipientIds || []).map((id) => clients.find((client) => client.id === id)?.name).filter(Boolean).join(", ") || "Selected clients";
        return <article className="information-card" key={post.id}>
          <div className="information-card-top"><span className="information-posted-date">Posted {dateLabel(post.postedAt)}</span>{canEdit && <button className="button button-quiet" type="button" onClick={() => startEditing(post)}><Pencil size={13} /> Edit</button>}</div>
          <p className="information-copy">{post.information}</p>
          {(post.attachments || []).length > 0 && <div className="information-card-files" aria-label="Information attachments">{post.attachments?.map((attachment) => <a key={attachment.id} href={`/api/information-center/${post.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer"><Paperclip size={13} /><span>{attachment.name}</span><small>{formatBytes(attachment.sizeBytes)}</small></a>)}</div>}
          <div className="information-card-footer"><span><strong>{post.consultantName}</strong><small>Consultant</small></span><span><strong>{post.consultantMobile || "Not provided"}</strong><small>Mobile number</small></span>{isConsultant && <span><strong>{audienceLabel}</strong><small>Audience</small></span>}</div>
        </article>;
      })}</div>}
  </section>;
}

function UserManual({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [manuals, setManuals] = useState<UserManualEntry[]>([]);
  const [audienceCompanies, setAudienceCompanies] = useState<InformationCompany[]>([]);
  const [audienceUsers, setAudienceUsers] = useState<ManualAudienceUser[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [media, setMedia] = useState<File | null>(null);
  const [removeMedia, setRemoveMedia] = useState(false);
  const [isPublished, setIsPublished] = useState(true);
  const [audienceType, setAudienceType] = useState<"all" | "company" | "user">("all");
  const [audienceCompanyId, setAudienceCompanyId] = useState("");
  const [audienceUserIds, setAudienceUserIds] = useState<number[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadManuals = useCallback(async () => {
    const result = await api<{ manuals: UserManualEntry[] }>("/user-manuals", { cache: "no-store" });
    setManuals(result.manuals);
  }, []);
  const loadAudienceOptions = useCallback(async () => {
    if (!isSuperAdmin) return;
    const result = await api<{ companies: InformationCompany[]; users: ManualAudienceUser[] }>("/user-manual-audience", { cache: "no-store" });
    setAudienceCompanies(result.companies);
    setAudienceUsers(result.users);
  }, [isSuperAdmin]);
  useEffect(() => {
    Promise.all([loadManuals(), loadAudienceOptions()]).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, [loadManuals, loadAudienceOptions]);

  function startNewManual() {
    setEditingId(null);
    setTitle(""); setSummary(""); setContent(""); setMedia(null); setRemoveMedia(false); setIsPublished(true);
    setAudienceType("all"); setAudienceCompanyId(""); setAudienceUserIds([]);
    setError(""); setMessage(""); setShowEditor(true);
  }

  function startEditing(manual: UserManualEntry) {
    setEditingId(manual.id);
    setTitle(manual.title); setSummary(manual.summary); setContent(manual.content); setMedia(null); setRemoveMedia(false);
    setIsPublished(Boolean(manual.isPublished)); setAudienceType(manual.audienceType || "all");
    setAudienceCompanyId(manual.audienceCompanyId ? String(manual.audienceCompanyId) : "");
    setAudienceUserIds((manual.audienceUserIds || (manual.audienceUserId ? [manual.audienceUserId] : [])).map(Number));
    setError(""); setMessage(""); setShowEditor(true);
  }

  async function saveManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError(""); setMessage("");
    try {
      const body = new FormData();
      body.append("title", title); body.append("summary", summary); body.append("content", content);
      body.append("isPublished", String(isPublished)); body.append("removeMedia", String(removeMedia));
      body.append("audienceType", audienceType);
      if (audienceType === "company") body.append("audienceCompanyId", audienceCompanyId);
      if (audienceType === "user") body.append("audienceUserIds", JSON.stringify(audienceUserIds));
      if (media) body.append("media", media);
      await api(`/user-manuals${editingId ? `/${editingId}` : ""}`, { method: editingId ? "PATCH" : "POST", body });
      await loadManuals();
      setShowEditor(false);
      const audienceLabel = audienceType === "all" ? "all users" : audienceType === "company"
        ? audienceCompanies.find((company) => String(company.id) === audienceCompanyId)?.name || "the selected company"
        : audienceUserIds.map((id) => audienceUsers.find((user) => user.id === id)?.name).filter(Boolean).join(", ") || "the selected users";
      setMessage(editingId ? "User manual updated." : isPublished ? `User manual published to ${audienceLabel}.` : "User manual saved as a draft.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save this user manual."); }
    finally { setSaving(false); }
  }

  async function deleteManual(manual: UserManualEntry) {
    if (!window.confirm(`Delete “${manual.title}” and its uploaded media?`)) return;
    setError(""); setMessage("");
    try {
      await api(`/user-manuals/${manual.id}`, { method: "DELETE" });
      await loadManuals();
      setMessage("User manual deleted.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete this user manual."); }
  }

  const visibleManuals = manuals.filter((manual) =>
    `${manual.title} ${manual.summary} ${manual.content}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <section className="feature-page user-manual-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />{isSuperAdmin ? "CONSULTANT WORKSPACE" : "CUSTOMER WORKSPACE"}</div><h1>User Manual</h1><p>Guides and tutorials for using the support portal.</p></div>{isSuperAdmin && <button className="button button-primary" type="button" onClick={startNewManual}><Plus size={15} /> Add guide</button>}</div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
    {message && <div className="inline-success" role="status">{message}<button type="button" onClick={() => setMessage("")}><X size={13} /></button></div>}
    <div className="directory-toolbar information-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Search user manuals" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guides…" /></div><span className="knowledge-total-card">{manuals.filter((manual) => isSuperAdmin || Boolean(manual.isPublished)).length} guides</span></div>
    {showEditor && isSuperAdmin && <section className="settings-card manual-editor">
        <div className="settings-card-heading"><div><h2>{editingId ? "Edit guide" : "Add a user guide"}</h2><p>Write instructions or upload an audio/video tutorial, then choose who can view it.</p></div><BookOpen size={18} /></div>
      <form onSubmit={saveManual}>
        <label>Guide title<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={160} required placeholder="For example: How to raise a support ticket" /></label>
        <label>Short description (optional)<input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={500} placeholder="A short overview of this guide" /></label>
        <label>Written instructions (optional)<textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={20000} rows={8} placeholder="Write step-by-step instructions here…" /></label>
        <label>Audio or video file (optional)<input type="file" accept="audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/ogg,video/mp4,video/webm,.mp3,.m4a,.wav,.ogg,.mp4,.webm" onChange={(event) => { setMedia(event.target.files?.[0] || null); if (event.target.files?.[0]) setRemoveMedia(false); }} /><small>MP3, M4A, WAV, OGG, MP4, or WebM; up to 200 MB.</small></label>
        {media && <div className="manual-file-selected"><Paperclip size={13} />{media.name} · {formatBytes(media.size)}</div>}
        {editingId && manuals.find((manual) => manual.id === editingId)?.mediaName && !media && <div className="manual-current-media"><span>Current file: {manuals.find((manual) => manual.id === editingId)?.mediaName}</span><label><input type="checkbox" checked={removeMedia} onChange={(event) => setRemoveMedia(event.target.checked)} /> Remove current file</label></div>}
        <label>Publish to<select value={audienceType} onChange={(event) => { setAudienceType(event.target.value as "all" | "company" | "user"); setAudienceCompanyId(""); setAudienceUserIds([]); }}><option value="all">All users</option><option value="company">Specific company</option><option value="user">Specific users</option></select></label>
        {audienceType === "company" && <label>Select company<select value={audienceCompanyId} onChange={(event) => setAudienceCompanyId(event.target.value)} required><option value="">Choose a company</option>{audienceCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>}
        {audienceType === "user" && <div className="manual-user-picker"><strong>Select users</strong><small>Choose one or more customers or consultants.</small><div className="manual-user-options">{audienceUsers.map((user) => <label className="manual-user-option" key={user.id}><input type="checkbox" checked={audienceUserIds.includes(user.id)} onChange={(event) => setAudienceUserIds((current) => event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id))} /><span>{user.name} ({user.username})</span><small>{user.role === "customer" ? "Customer" : "Consultant"}</small></label>)}</div></div>}
        <label className="manual-publish-toggle"><input type="checkbox" checked={isPublished} onChange={(event) => setIsPublished(event.target.checked)} /> Publish this guide now</label>
        <div className="information-editor-actions"><button className="button button-quiet" type="button" onClick={() => setShowEditor(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || title.trim().length < 3 || (audienceType === "company" && !audienceCompanyId) || (audienceType === "user" && !audienceUserIds.length) || (!summary.trim() && !content.trim() && !media && !(editingId && manuals.find((manual) => manual.id === editingId)?.mediaName && !removeMedia))}>{saving ? "Saving…" : editingId ? "Save guide" : isPublished ? "Publish guide" : "Save draft"}</button></div>
      </form>
    </section>}
    {loading ? <div className="report-empty" role="status">Loading user guides…</div> : visibleManuals.length === 0
      ? <div className="empty-list"><BookOpen size={27} /><strong>No user guides yet</strong><span>{query ? "Try another search." : "Published instructions and tutorials will appear here."}</span></div>
      : <div className="manual-list">{visibleManuals.map((manual) => <article className="manual-card" key={manual.id}>
        <div className="manual-card-heading"><div><h2>{manual.title}</h2>{manual.summary && <p>{manual.summary}</p>}{isSuperAdmin && <small className="manual-audience-label">Audience: {manual.audienceType === "company" ? manual.audienceCompanyName || "Selected company" : manual.audienceType === "user" ? (manual.audienceUserNames || (manual.audienceUserName ? [manual.audienceUserName] : [])).join(", ") || "Selected users" : "All users"}</small>}</div>{isSuperAdmin && <div className="manual-card-actions"><span className={`team-state ${Boolean(manual.isPublished) ? "" : "team-disabled"}`}>{Boolean(manual.isPublished) ? "Published" : "Draft"}</span><button type="button" className="button button-quiet" onClick={() => startEditing(manual)}><Pencil size={13} /> Edit</button><button type="button" className="button button-quiet" onClick={() => deleteManual(manual)}>Delete</button></div>}</div>
        {manual.content && <div className="manual-content">{manual.content}</div>}
        {manual.mediaName && manual.mediaKind === "audio" && <div className="manual-media"><div><strong>{manual.mediaName}</strong><small>Audio guide{manual.mediaSizeBytes ? ` · ${formatBytes(manual.mediaSizeBytes)}` : ""}</small></div><audio controls preload="metadata" src={`/api/user-manuals/${manual.id}/media`} /></div>}
        {manual.mediaName && manual.mediaKind === "video" && <div className="manual-video"><video controls preload="metadata" src={`/api/user-manuals/${manual.id}/media`} /><span>{manual.mediaName}{manual.mediaSizeBytes ? ` · ${formatBytes(manual.mediaSizeBytes)}` : ""}</span></div>}
      </article>)}</div>}
  </section>;
}

function KnowledgeBase({ companies }: { companies: Array<{ id: number; name: string }> }) {
  const [tickets, setTickets] = useState<KnowledgeBaseTicket[]>([]);
  const [openTicket, setOpenTicket] = useState<TicketDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pageSize = 50;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const companyQuery = companyFilter === "all" ? "" : `&companyId=${encodeURIComponent(companyFilter)}`;
    api<{ tickets: KnowledgeBaseTicket[]; total: number }>(`/knowledge-base?page=${page}&search=${encodeURIComponent(search)}${companyQuery}`)
      .then((result) => {
        if (!active) return;
        setTickets(result.tickets);
        setTotal(result.total);
      })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyFilter, page, search]);

  const formatDate = (value: string) => {
    const date = new Date(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"));
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(date);
  };

  async function showConversation(ticketId: number) {
    setOpenTicket(null);
    setDetailError("");
    setLoadingDetail(true);
    try {
      setOpenTicket(await api<TicketDetail>(`/tickets/${ticketId}`));
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : "Could not load this ticket conversation.");
    } finally {
      setLoadingDetail(false);
    }
  }

  return <section className="feature-page knowledge-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />CONSULTANT WORKSPACE</div><h1>Knowledge Base</h1><p>Resolved tickets and the solutions shared with clients.</p></div></div>
    <form className="directory-toolbar" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query.trim()); }}>
      <div className="search-box"><Search size={15} /><input aria-label="Search resolved tickets" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tickets, clients, Consultants, or solutions…" /><button className="button button-quiet" type="submit">Search</button></div>
      <span className="knowledge-total-card">{total} Resolved {total === 1 ? "Ticket" : "Tickets"}</span>
      <label className="priority-filter"><span>Customer</span><select aria-label="Filter Knowledge Base by customer" value={companyFilter} onChange={(event) => { setCompanyFilter(event.target.value); setPage(1); }}><option value="all">All customers</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
    </form>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading ? <div className="report-empty" role="status">Loading resolved tickets…</div> : tickets.length === 0
      ? <div className="empty-list"><BookOpen size={27} /><strong>No resolved tickets found</strong><span>{search ? "Try a different search." : "Resolved tickets will appear here with their recorded solutions."}</span></div>
      : <div className="knowledge-list">{tickets.map((ticket) => <article className="knowledge-card" key={ticket.id}>
        <div className="knowledge-card-heading"><div><span className="knowledge-ticket-id">Ticket #{ticket.id}</span><h2>{ticket.issue}</h2></div><span className="knowledge-type">{ticket.solutionType}</span></div>
        <div className="knowledge-meta"><div><span>Reported</span><strong>{formatDate(ticket.reportedAt)}</strong></div><div><span>Closed</span><strong>{formatDate(ticket.closedAt)}</strong></div><div><span>Client</span><strong>{displayClientName(ticket.clientName)}</strong></div><div><span>Handled by</span><strong>{ticket.consultantName}</strong></div></div>
        <div className="knowledge-content"><div><h3>Ticket Description</h3><p>{ticket.description}</p></div><div><h3>Solution Provided</h3><p>{ticket.solution}</p></div></div>
        <button className="button button-quiet knowledge-conversation-button" type="button" onClick={() => showConversation(ticket.id)}><MessageCircle size={14} /> View full conversation</button>
      </article>)}</div>}
    {!loading && total > pageSize && <div className="report-ticket-pagination"><span>Page {page} of {Math.ceil(total / pageSize)}</span><div><button className="button button-quiet" type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><button className="button button-quiet" type="button" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>}
    {(loadingDetail || detailError) && <div className="modal-scrim knowledge-modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !loadingDetail) setDetailError(""); }}>
      <section className="knowledge-conversation-modal" role="dialog" aria-modal="true" aria-label="Ticket conversation">
        <div className="modal-heading"><div><div className="eyebrow">TICKET CONVERSATION</div><h2>{loadingDetail ? "Loading conversation…" : "Could not load conversation"}</h2></div>{!loadingDetail && <button type="button" className="icon-button" aria-label="Close" onClick={() => setDetailError("")}><X size={18} /></button>}</div>
        {!loadingDetail && <div className="inline-error" role="alert">{detailError}</div>}
      </section>
    </div>}
    {openTicket && <div className="modal-scrim knowledge-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenTicket(null); }}>
      <section className="knowledge-conversation-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-conversation-title">
        <header className="knowledge-conversation-header"><div><div className="eyebrow">TICKET #{String(openTicket.ticket.id).padStart(4, "0")} · FULL HISTORY</div><h2 id="knowledge-conversation-title">{openTicket.ticket.subject}</h2></div><button type="button" className="icon-button" aria-label="Close conversation" onClick={() => setOpenTicket(null)}><X size={18} /></button></header>
        <div className="knowledge-conversation-scroll">
          <div className="knowledge-conversation-summary"><StatusPill status={openTicket.ticket.status} /><span>Reported {formatDate(openTicket.ticket.createdAt)}</span><span>Client: {displayClientName(openTicket.ticket.customer.name)}</span><span>Handled by: {openTicket.ticket.assignee?.name || "Unassigned"}</span></div>
          <article className="knowledge-original-request"><strong>Original ticket description</strong><p>{openTicket.ticket.description}</p></article>
          {openTicket.assignmentHistory.length > 0 && <AssignmentHistorySection entries={openTicket.assignmentHistory} />}
          {openTicket.attachments.length > 0 && <div className="attachment-list" aria-label="Ticket attachments"><strong className="attachment-heading">Attachments</strong>{openTicket.attachments.map((attachment) => <a key={attachment.id} className="ticket-attachment" href={`/api/tickets/${openTicket.ticket.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer"><span className="attachment-icon"><Paperclip size={14} /></span><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span><Download size={14} /></a>)}</div>}
          <div className="conversation-heading"><span>Conversation</span><span>{openTicket.messages.length} messages</span></div>
          {openTicket.messages.length ? <div className="conversation">{openTicket.messages.map((message, index) => {
            const fromConsultant = message.authorRole === "agent";
            return <article key={message.id} className={`message ${fromConsultant ? "message-agent" : ""} ${message.isInternal ? "message-internal" : ""}`}>
              <div className={`message-avatar ${fromConsultant ? "agent-message-avatar" : ""}`}>{initials(message.authorName)}</div><div className="message-content"><div className="message-meta"><strong>{message.authorName}</strong>{message.isInternal ? <span className="internal-note-badge">INTERNAL NOTE</span> : fromConsultant && <span className="agent-badge">CONSULTANT</span>}<time>{timeAgo(message.createdAt)}</time>{index === 0 && !message.isInternal && <span className="original-label">Original request</span>}</div><p>{message.body}</p></div>
            </article>;
          })}</div> : <p className="knowledge-no-messages">No conversation messages were recorded for this ticket.</p>}
        </div>
      </section>
    </div>}
  </section>;
}

function CustomerDirectory({ customers, tickets, onCreateTicket, onViewTickets }: {
  customers: Customer[];
  tickets: Ticket[];
  onCreateTicket: (customerId: number, companyId: number) => void;
  onViewTickets: (customerName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filteredCustomers = customers.filter((customer) =>
    `${customer.companyName || "Unassigned company"} ${customer.name} ${customer.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const customersByCompany = new Map<string, Customer[]>();
  for (const customer of filteredCustomers) {
    const companyName = customer.companyName || "Unassigned company";
    customersByCompany.set(companyName, [...(customersByCompany.get(companyName) || []), customer]);
  }
  const companyGroups = [...customersByCompany.entries()].sort(([a], [b]) => a.localeCompare(b));
  return <section className="feature-page customer-directory-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />CONSULTANT WORKSPACE</div><h1>Clients</h1><p>Review client accounts and their support history.</p></div></div>
    <div className="directory-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Search clients" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients…" /></div><span>{filteredCustomers.length} clients · {companyGroups.length} companies</span></div>
      {filteredCustomers.length === 0
        ? <div className="empty-list"><Users size={27} /><strong>No clients found</strong><span>{customers.length ? "Try a different name or email." : "Client accounts will appear here when they register."}</span></div>
        : companyGroups.map(([companyName, companyCustomers]) => {
          const companyCustomerIds = new Set(companyCustomers.map((customer) => customer.id));
          const companyTickets = tickets.filter((ticket) => ticket.company?.name === companyName
            || (ticket.customer.id !== null && companyCustomerIds.has(ticket.customer.id)));
          const activeCompanyTickets = companyTickets.filter((ticket) => ticket.status !== "resolved").length;
          return <section className="directory-company-group" key={companyName}>
            <div className="directory-company-heading"><div><Building2 size={16} /><strong>{companyName}</strong></div><span>{companyCustomers.length} {companyCustomers.length === 1 ? "client" : "clients"} · {companyTickets.length} tickets · {activeCompanyTickets} active</span></div>
            <div className="directory-list">
              {companyCustomers.map((customer) => {
                const customerTickets = tickets.filter((ticket) => ticket.customer.id === customer.id
                  || (!ticket.customer.id && ticket.company?.name === companyName && ticket.customer.name === customer.name));
                const activeCount = customerTickets.filter((ticket) => ticket.status !== "resolved").length;
                return <article className="directory-row" key={customer.id}>
                  <div className="avatar customer-avatar">{initials(customer.name)}</div>
                  <div className="directory-customer"><strong>{displayClientName(customer.name)}</strong><span>{customer.email}</span></div>
                  <div className="directory-stat"><strong>{customerTickets.length}</strong><span>Total tickets</span></div>
                  <div className="directory-stat"><strong>{activeCount}</strong><span>Active</span></div>
                  <button className="button button-quiet directory-action" onClick={() => onViewTickets(customer.name)}>View tickets</button>
                  <button className="button button-primary directory-action" onClick={() => onCreateTicket(customer.id, customer.companyId || 0)}><Plus size={14} /> New ticket</button>
                </article>;
              })}
            </div>
          </section>;
        })}
  </section>;
}

function FeaturePlaceholder({ view }: { view: string }) {
  const isSettings = view === "settings";
  const title = isSettings ? "Workspace settings" : "Knowledge base";
  return <section className="feature-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-live" />JISHNU INFOTECH WORKSPACE</div><h1>{title}</h1><p>A calmer, more connected way to support your customers.</p></div></div>
    <div className="integration-card">
      <div className="integration-illustration">{isSettings ? <Settings2 size={27} /> : <CircleHelp size={27} />}</div>
      <span className="integration-status"><span />COMING SOON</span>
      <h2>{isSettings ? "Workspace settings are administrator-only" : "Help customers help themselves"}</h2>
      <p>{isSettings ? "Ask your Super Admin to manage team access and service-level targets." : "The self-service knowledge base is planned for a later phase."}</p>
      <button className="button button-quiet" disabled><Check size={15} /> Planned for a future release</button>
      <div className="integration-note"><ShieldCheck size={15} />We are building this with your support workflow in mind.</div>
    </div>
  </section>;
}

export default App;
