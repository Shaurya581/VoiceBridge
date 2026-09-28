import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowRight, Bell, Check, ChevronRight, CircleHelp, Clock3, FileAudio2, LayoutDashboard, ListChecks, LoaderCircle, LogOut, Mic, Pause, Play, Plus, Search, ShieldCheck, Users, X } from 'lucide-react';

type Role = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
type User = { id: string; name: string; email: string; role: Role; department: string | null };
type Incident = { id: string; incidentNumber: string; title: string; description: string; location: string | null; priority: string; status: string; deadline: string; createdAt: string; reporter?: { name: string }; tasks: Task[] };
type Task = { id: string; title: string; status: string; deadline: string; assignee: { id: string; name: string; email: string }; incident: Pick<Incident, 'id' | 'incidentNumber' | 'title' | 'location' | 'priority' | 'status'> };
type Employee = { id: string; name: string; email: string; role: Role; department?: { name: string } | null };
type Extraction = { title: string; description: string; abnormality: string | null; asset: string | null; location: string | null; responsibleDepartment: string | null; responsiblePerson: string | null; priority: string; deadline: string; requestedAction: string; confidence: number; missingInformation: string[]; requiresConfirmation: boolean };
type Page = 'dashboard' | 'report' | 'reports' | 'tasks' | 'team' | 'audit';

interface RecognitionEvent { results: ArrayLike<ArrayLike<{ transcript: string }>> }
interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
interface BrowserWindow extends Window { SpeechRecognition?: new () => BrowserRecognition; webkitSpeechRecognition?: new () => BrowserRecognition }

const labels: Record<Page, string> = { dashboard: 'Overview', report: 'Report an issue', reports: 'My reports', tasks: 'Tasks', team: 'Team', audit: 'Audit log' };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = localStorage.getItem('voicebridge.token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? 'Something went wrong. Please try again.');
  return payload as T;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'No deadline' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusStyle(value: string) {
  return `status status-${value.toLowerCase().replaceAll('_', '-')}`;
}

function dateInput(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('voicebridge.token'));
  const [user, setUser] = useState<User | null>(() => {
    try { const value = localStorage.getItem('voicebridge.user'); return value ? JSON.parse(value) as User : null; } catch { return null; }
  });
  const [page, setPage] = useState<Page>('dashboard');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [auditEvents, setAuditEvents] = useState<Array<{ id: string; action: string; reason: string | null; createdAt: string; actor?: { name: string } | null; incident?: { incidentNumber: string; title: string } | null }>>([]);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [loginEmail, setLoginEmail] = useState('employee@voicebridge.local');
  const [loginPassword, setLoginPassword] = useState('VoiceBridgeDemo2026!');
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [reportLanguage, setReportLanguage] = useState('hi');
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [listeningSupported, setListeningSupported] = useState(true);
  const [pendingReport, setPendingReport] = useState<{ voiceReportId: string; extraction: Extraction; clarification: string; options: Employee[] } | null>(null);
  const [editedExtraction, setEditedExtraction] = useState<Extraction | null>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN';

  async function refreshData() {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const [incidentResult, taskResult, employeeResult] = await Promise.all([
        request<{ incidents: Incident[] }>('/api/incidents'),
        request<{ tasks: Task[] }>('/api/tasks'),
        request<{ employees: Employee[] }>('/api/employees')
      ]);
      setIncidents(incidentResult.incidents);
      setTasks(taskResult.tasks);
      setEmployees(employeeResult.employees);
      if (user?.role === 'ADMIN') {
        const audit = await request<{ events: typeof auditEvents }>('/api/audit');
        setAuditEvents(audit.events);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not load your workspace.';
      if (message.toLowerCase().includes('session') || message.toLowerCase().includes('authentication')) logout();
      else setError(message);
    } finally { setLoading(false); }
  }

  useEffect(() => { void refreshData(); }, [token, user?.role]);
  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);
  useEffect(() => {
    if (isRecording && elapsed >= 30) stopRecording();
  }, [isRecording, elapsed]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  function logout() {
    localStorage.removeItem('voicebridge.token');
    localStorage.removeItem('voicebridge.user');
    setToken(null); setUser(null); setPage('dashboard'); setIncidents([]); setTasks([]);
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setLoading(true);
    try {
      const result = await request<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: loginEmail, password: loginPassword }) });
      localStorage.setItem('voicebridge.token', result.token); localStorage.setItem('voicebridge.user', JSON.stringify(result.user));
      setToken(result.token); setUser(result.user); setNotice(`Welcome back, ${result.user.name.split(' ')[0]}.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Sign in failed.'); }
    finally { setLoading(false); }
  }

  async function startRecording() {
    setError(''); setNotice(''); setTranscript(''); setElapsed(0); setAudioBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setAudioBlob(blob); setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((track) => track.stop());
        setIsRecording(false);
      };
      recorder.start(); recorderRef.current = recorder;
      const browserWindow = window as BrowserWindow;
      const Recognition = browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
      if (Recognition) {
        const recognition = new Recognition();
        recognition.continuous = true; recognition.interimResults = true; recognition.lang = reportLanguage === 'ta' ? 'ta-IN' : 'hi-IN';
        recognition.onresult = (event) => {
          const words: string[] = [];
          for (let index = 0; index < event.results.length; index += 1) words.push(event.results[index]?.[0]?.transcript ?? '');
          setTranscript(words.join(' ').trim());
        };
        recognition.onerror = () => setListeningSupported(false);
        recognitionRef.current = recognition; recognition.start();
      } else setListeningSupported(false);
      setIsRecording(true);
    } catch {
      setError('Microphone access is unavailable. You can still type what you would have reported.');
      setListeningSupported(false);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }

  async function submitReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transcript.trim() && !audioBlob) { setError('Add a transcript or record your report before submitting.'); return; }
    setLoading(true); setError(''); setNotice('Understanding your report…');
    try {
      const form = new FormData();
      form.set('transcript', transcript.trim()); form.set('durationSeconds', String(elapsed)); form.set('language', reportLanguage);
      if (audioBlob) form.set('audio', audioBlob, `report.${audioBlob.type.includes('ogg') ? 'ogg' : audioBlob.type.includes('mp4') ? 'm4a' : 'webm'}`);
      const result = await request<{ voiceReportId: string; transcript?: string; extraction?: Extraction; requiresConfirmation?: boolean; retryRequired?: boolean; duplicate?: boolean; duplicateReviewPending?: boolean; message?: string; clarification?: string; options?: Employee[]; incident?: Incident }>('/api/voice/upload', { method: 'POST', body: form });
      if (result.transcript) setTranscript(result.transcript);
      if (result.retryRequired) {
        setNotice(result.message ?? 'The recording was unclear. Please record again.');
      } else if (result.requiresConfirmation && result.extraction) {
        setPendingReport({ voiceReportId: result.voiceReportId, extraction: result.extraction, clarification: result.clarification ?? 'Please review the information before creating the incident.', options: result.options ?? [] });
        setEditedExtraction(result.extraction); setAssigneeId(result.options?.[0]?.id ?? '');
        setNotice('Review the details before we create the incident.');
      } else {
        setNotice(result.duplicateReviewPending ? 'Possible duplicate queued for manager review.' : result.duplicate ? 'Your report was added to an existing incident.' : `Report received${result.incident?.incidentNumber ? ` as ${result.incident.incidentNumber}` : ''}. Spoken acknowledgement simulated.`);
        setTranscript(''); setAudioBlob(null); setAudioUrl(''); await refreshData(); setPage('reports');
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Your report could not be submitted.'); setNotice(''); }
    finally { setLoading(false); }
  }

  async function confirmReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingReport || !editedExtraction) return;
    setLoading(true); setError('');
    try {
      const result = await request<{ incident: Incident }>('/api/voice/' + pendingReport.voiceReportId + '/confirm', {
        method: 'POST', body: JSON.stringify({ extraction: editedExtraction, ...(assigneeId ? { assignedEmployeeId: assigneeId } : {}) })
      });
      setPendingReport(null); setEditedExtraction(null); setNotice(`Confirmed as ${result.incident.incidentNumber} and added to the task queue.`);
      setTranscript(''); setAudioBlob(null); setAudioUrl(''); await refreshData(); setPage('reports');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Please check the report details.'); }
    finally { setLoading(false); }
  }

  async function updateTask(task: Task, status: string) {
    setLoading(true); setError('');
    try {
      const result = await request<{ incidentStatus?: string }>(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setNotice(status === 'COMPLETED'
        ? result.incidentStatus === 'CLOSED' ? 'Reporter confirmed the fix. Incident closed.' : result.incidentStatus === 'REOPENED' ? 'Reporter said the issue remains. Incident reopened.' : 'Work marked complete. Reporter verification is pending.'
        : 'Task status updated.');
      await refreshData();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The task could not be updated.'); }
    finally { setLoading(false); }
  }

  if (!token || !user) return <Login email={loginEmail} password={loginPassword} setEmail={setLoginEmail} setPassword={setLoginPassword} onSubmit={signIn} loading={loading} error={error} />;

  const filteredIncidents = incidents.filter((incident) => `${incident.incidentNumber} ${incident.title} ${incident.location ?? ''} ${incident.status}`.toLowerCase().includes(search.toLowerCase()));
  const openCount = incidents.filter((item) => ['OPEN', 'IN_PROGRESS', 'EMERGENCY', 'REOPENED', 'REPORTER_VERIFICATION_PENDING', 'AWAITING_CONFIRMATION'].includes(item.status)).length;
  const overdueCount = incidents.filter((item) => ['OVERDUE', 'ESCALATED'].includes(item.status)).length;
  const completedCount = incidents.filter((item) => item.status === 'CLOSED').length;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Activity size={18} /></span><span>VoiceBridge</span></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="nav-list" aria-label="Main navigation">
        <NavItem active={page === 'dashboard'} icon={<LayoutDashboard size={18} />} onClick={() => setPage('dashboard')}>Overview</NavItem>
        <NavItem active={page === 'report'} icon={<Mic size={18} />} onClick={() => { setPendingReport(null); setPage('report'); }}>Report an issue</NavItem>
        <NavItem active={page === 'reports'} icon={<FileAudio2 size={18} />} onClick={() => setPage('reports')}>Incidents</NavItem>
        <NavItem active={page === 'tasks'} icon={<ListChecks size={18} />} onClick={() => setPage('tasks')}>Tasks <span className="nav-count">{tasks.filter((task) => !['COMPLETED', 'COMPLETED_BY_ASSIGNEE', 'CLOSED'].includes(task.status)).length}</span></NavItem>
        {isManager && <NavItem active={page === 'team'} icon={<Users size={18} />} onClick={() => setPage('team')}>Team</NavItem>}
        {user.role === 'ADMIN' && <NavItem active={page === 'audit'} icon={<ShieldCheck size={18} />} onClick={() => setPage('audit')}>Audit log</NavItem>}
      </nav>
      <div className="sidebar-bottom">
        <div className="secure-note"><ShieldCheck size={15} /><span>Activity is recorded for accountability.</span></div>
        <button className="user-card" onClick={logout} title="Sign out">
          <span className="avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
          <span className="user-copy"><strong>{user.name}</strong><small>{user.department ?? user.role.toLowerCase()}</small></span>
          <LogOut size={16} className="logout-icon" />
        </button>
      </div>
    </aside>

    <main className="main-area">
      <header className="page-header">
        <div className="breadcrumb">VoiceBridge <ChevronRight size={14} /> <span>{labels[page]}</span></div>
        <div className="header-right"><span className="live-indicator"><i /> System ready</span><span className="header-date">{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span><button className="icon-button" aria-label="Notifications" onClick={() => setNotice('You are up to date.') }><Bell size={17} /></button></div>
      </header>
      <div className="content-wrap">
        {error && <div className="alert error-alert"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {notice && <div className="alert notice-alert"><Check size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {loading && <div className="loading-line"><LoaderCircle size={15} className="spin" /> Updating your workspace…</div>}
        {page === 'dashboard' && <Dashboard user={user} incidents={incidents} tasks={tasks} openCount={openCount} overdueCount={overdueCount} completedCount={completedCount} onReport={() => setPage('report')} onOpenIncident={setSelectedIncident} onViewTasks={() => setPage('tasks')} />}
        {page === 'report' && <ReportPage recording={isRecording} elapsed={elapsed} transcript={transcript} setTranscript={setTranscript} language={reportLanguage} setLanguage={setReportLanguage} audioUrl={audioUrl} listeningSupported={listeningSupported} pending={pendingReport} edited={editedExtraction} setEdited={setEditedExtraction} employees={employees} assigneeId={assigneeId} setAssigneeId={setAssigneeId} onStart={() => void startRecording()} onStop={stopRecording} onSubmit={submitReport} onConfirm={confirmReport} onRetry={() => { setTranscript(''); setAudioBlob(null); setAudioUrl(''); setPendingReport(null); }} loading={loading} />}
        {page === 'reports' && <IncidentsPage incidents={filteredIncidents} search={search} setSearch={setSearch} onOpen={setSelectedIncident} />}
        {page === 'tasks' && <TasksPage tasks={tasks} onUpdate={updateTask} onOpenIncident={(id) => { const incident = incidents.find((item) => item.id === id); if (incident) setSelectedIncident(incident); }} />}
        {page === 'team' && <TeamPage employees={employees} />}
        {page === 'audit' && <AuditPage events={auditEvents} />}
      </div>
    </main>
    {selectedIncident && <IncidentDrawer incident={selectedIncident} onClose={() => setSelectedIncident(null)} />}
  </div>;
}

function NavItem({ active, icon, onClick, children }: { active: boolean; icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{children}</span>{active && <i />}</button>;
}

function Login({ email, password, setEmail, setPassword, onSubmit, loading, error }: { email: string; password: string; setEmail: (value: string) => void; setPassword: (value: string) => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; loading: boolean; error: string }) {
  return <div className="login-screen">
    <div className="login-brand"><span className="brand-mark"><Activity size={19} /></span>VoiceBridge</div>
    <div className="login-card">
      <p className="eyebrow">OPERATIONAL WORKFLOW</p><h1>Welcome back</h1><p className="login-intro">Sign in to report an issue or follow up on active work.</p>
      {error && <div className="alert error-alert"><AlertTriangle size={16} />{error}</div>}
      <form onSubmit={onSubmit} className="login-form">
        <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label>
        <button className="primary-button wide" disabled={loading}>{loading ? <LoaderCircle size={17} className="spin" /> : null} Sign in <ArrowRight size={16} /></button>
      </form>
      <div className="demo-box"><strong>Local demo account</strong><span>employee@voicebridge.local</span><span>VoiceBridgeDemo2026!</span></div>
      <p className="login-foot"><ShieldCheck size={14} /> Workflows are traceable and role-protected.</p>
    </div>
    <div className="login-background" aria-hidden="true"><div className="orb orb-one"/><div className="orb orb-two"/><div className="grid-pattern"/></div>
  </div>;
}

function Dashboard({ user, incidents, tasks, openCount, overdueCount, completedCount, onReport, onOpenIncident, onViewTasks }: { user: User; incidents: Incident[]; tasks: Task[]; openCount: number; overdueCount: number; completedCount: number; onReport: () => void; onOpenIncident: (incident: Incident) => void; onViewTasks: () => void }) {
  const recent = incidents.slice(0, 5);
  return <>
    <div className="welcome-row"><div><p className="eyebrow">YOUR OPERATIONS AT A GLANCE</p><h1>Good day, {user.name.split(' ')[0]}</h1><p className="subheading">Reports, ownership, and follow-through in one place.</p></div><button className="primary-button" onClick={onReport}><Plus size={17} /> Report an issue</button></div>
    <div className="metric-grid">
      <Metric title="Open incidents" value={openCount} icon={<Activity size={18} />} accent="blue" note="Needs active follow-up" />
      <Metric title="Overdue or escalated" value={overdueCount} icon={<AlertTriangle size={18} />} accent="rose" note="Requires attention" />
      <Metric title="Resolved" value={completedCount} icon={<Check size={18} />} accent="green" note="Closed the loop" />
      <Metric title="My active tasks" value={tasks.filter((task) => !['COMPLETED', 'COMPLETED_BY_ASSIGNEE', 'CLOSED'].includes(task.status)).length} icon={<ListChecks size={18} />} accent="violet" note="Assigned to you" />
    </div>
    <div className="dashboard-grid">
      <section className="panel incidents-panel">
        <div className="panel-heading"><div><h2>Recent incidents</h2><p>Most recent reports in your workspace</p></div><button className="text-button" onClick={onViewTasks}>Open tasks <ArrowRight size={14} /></button></div>
        {recent.length ? <div className="table-wrap"><table><thead><tr><th>Issue</th><th>Location</th><th>Priority</th><th>Owner</th><th>Status</th></tr></thead><tbody>{recent.map((incident) => <tr key={incident.id} onClick={() => onOpenIncident(incident)}><td><strong>{incident.title}</strong><small>{incident.incidentNumber}</small></td><td>{incident.location || '—'}</td><td><Priority value={incident.priority} /></td><td>{incident.tasks[0]?.assignee?.name ?? 'Awaiting owner'}</td><td><span className={statusStyle(incident.status)}>{prettyStatus(incident.status)}</span></td></tr>)}</tbody></table></div> : <EmptyState title="No reports yet" body="Your submitted reports and assigned work will appear here." action="Report an issue" onClick={onReport} />}
      </section>
      <section className="panel focus-panel"><div className="panel-heading"><div><h2>Needs your attention</h2><p>Tasks that are due or past due</p></div><span className="attention-icon"><AlertTriangle size={16} /></span></div>
        {tasks.filter((task) => !['COMPLETED', 'COMPLETED_BY_ASSIGNEE', 'CLOSED'].includes(task.status)).slice(0, 4).map((task) => <button className="focus-task" key={task.id} onClick={() => onOpenIncident(incidents.find((item) => item.id === task.incident.id) ?? { ...task.incident, description: '', createdAt: '', deadline: task.deadline, tasks: [] })}><span className="focus-dot"/><span className="focus-copy"><strong>{task.title}</strong><small>{task.incident.incidentNumber} · {task.assignee.name}</small></span><span className={statusStyle(task.status)}>{prettyStatus(task.status)}</span></button>)}
        {!tasks.filter((task) => !['COMPLETED', 'COMPLETED_BY_ASSIGNEE', 'CLOSED'].includes(task.status)).length && <div className="clear-state"><span><Check size={18}/></span><strong>All caught up</strong><small>No active tasks need attention.</small></div>}
      </section>
    </div>
    <div className="workflow-ribbon"><div className="ribbon-icon"><Mic size={18}/></div><div><strong>One report. A clear owner. A closed loop.</strong><p>VoiceBridge keeps the original report connected to its resolution.</p></div><button className="ribbon-link" onClick={onReport}>Start a report <ArrowRight size={15}/></button></div>
  </>;
}

function Metric({ title, value, icon, accent, note }: { title: string; value: number; icon: React.ReactNode; accent: string; note: string }) {
  return <article className="metric-card"><div className={`metric-icon ${accent}`}>{icon}</div><span className="metric-note">{note}</span><strong className="metric-value">{value}</strong><span className="metric-title">{title}</span><ArrowDownRight size={14} className="metric-arrow" /></article>;
}

function ReportPage(props: {
  recording: boolean; elapsed: number; transcript: string; setTranscript: (value: string) => void; language: string; setLanguage: (value: string) => void; audioUrl: string; listeningSupported: boolean;
  pending: { voiceReportId: string; extraction: Extraction; clarification: string; options: Employee[] } | null;
  edited: Extraction | null; setEdited: (value: Extraction | null) => void; employees: Employee[]; assigneeId: string; setAssigneeId: (value: string) => void;
  onStart: () => void; onStop: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; onConfirm: (event: React.FormEvent<HTMLFormElement>) => void; onRetry: () => void; loading: boolean;
}) {
  const mm = String(Math.floor(props.elapsed / 60)).padStart(2, '0'); const ss = String(props.elapsed % 60).padStart(2, '0');
  return <>
    <div className="page-title-row"><div><p className="eyebrow">QUICK REPORT</p><h1>Report an issue</h1><p className="subheading">Say what happened in your own words. We’ll help route the follow-up.</p></div><span className="step-pill"><span>1</span> Speak <i/> <span>2</span> Review <i/> <span>3</span> Submit</span></div>
    {props.pending && props.edited ? <section className="panel review-panel">
      <div className="review-head"><span className="review-icon"><CircleHelp size={20}/></span><div><h2>Review before we assign</h2><p>{props.pending.clarification}</p></div></div>
      <div className="transcript-quote"><span>WHAT WE HEARD</span><p>“{props.transcript}”</p></div>
      <form onSubmit={props.onConfirm} className="extraction-form">
        <label>Issue title<input value={props.edited.title} onChange={(event) => props.setEdited({ ...props.edited!, title: event.target.value })} required /></label>
        <label>Department<input value={props.edited.responsibleDepartment ?? ''} onChange={(event) => props.setEdited({ ...props.edited!, responsibleDepartment: event.target.value || null })} placeholder="e.g. Maintenance" required /></label>
        <label>Location<input value={props.edited.location ?? ''} onChange={(event) => props.setEdited({ ...props.edited!, location: event.target.value || null })} placeholder="Where is the issue?" /></label>
        <label>Priority<select value={props.edited.priority} onChange={(event) => props.setEdited({ ...props.edited!, priority: event.target.value })}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></label>
        <label>Deadline<input type="datetime-local" value={dateInput(props.edited.deadline)} onChange={(event) => props.setEdited({ ...props.edited!, deadline: new Date(event.target.value).toISOString() })} required /></label>
        <label>Assign to<select value={props.assigneeId} onChange={(event) => props.setAssigneeId(event.target.value)}><option value="">Use configured department lead</option>{props.employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.department?.name ?? employee.role}</option>)}</select></label>
        <label className="wide-field">Required action<textarea rows={2} value={props.edited.requestedAction} onChange={(event) => props.setEdited({ ...props.edited!, requestedAction: event.target.value })} required /></label>
        <div className="confirmation-actions"><button type="button" className="secondary-button" onClick={props.onRetry}>Record again</button><button className="primary-button" disabled={props.loading}><Check size={16}/> Confirm and create task</button></div>
      </form>
    </section> : <div className="report-layout">
      <section className="panel recorder-panel"><div className="panel-heading"><div><h2>Tell us what happened</h2><p>Record up to 30 seconds. A short, clear description is all you need.</p></div><span className="required-label">REQUIRED</span></div>
        <form onSubmit={props.onSubmit}>
          <label className="language-select">Report language<select value={props.language} onChange={(event) => props.setLanguage(event.target.value)} disabled={props.recording}><option value="hi">Hindi</option><option value="hinglish">Hinglish</option><option value="ta">Tamil</option></select></label>
          <div className={`recorder ${props.recording ? 'recording' : ''}`}>
            <div className="record-wave"><span/><span/><span/><span/><span/><span/><span/></div>
            <button type="button" className="record-button" onClick={props.recording ? props.onStop : props.onStart} aria-label={props.recording ? 'Stop recording' : 'Start recording'}>{props.recording ? <Pause size={22} fill="currentColor"/> : <Mic size={23}/>}</button>
            <strong>{props.recording ? 'Listening…' : props.audioUrl ? 'Recording ready' : 'Tap to start recording'}</strong>
            <span className="record-timer">{mm}:{ss}</span>
            {props.recording && <span className="recording-tag"><i/> RECORDING</span>}
          </div>
          {!props.listeningSupported && <div className="inline-hint"><CircleHelp size={15}/> Speech-to-text is unavailable in this browser. Type the transcript below.</div>}
          {props.audioUrl && <div className="playback"><FileAudio2 size={17}/><audio controls src={props.audioUrl}/><button type="button" className="icon-button" onClick={props.onRetry} aria-label="Retry recording"><X size={16}/></button></div>}
          <label className="transcript-label">Transcript <span>Review or edit what was heard</span><textarea value={props.transcript} onChange={(event) => props.setTranscript(event.target.value)} rows={5} placeholder="Example: Machine 4 is making a strange noise near the packaging line. Please inform maintenance before the night shift." required /></label>
          <div className="report-helper"><ShieldCheck size={15}/><span>Unclear details will be checked with you before we assign work.</span></div>
          <button className="primary-button submit-report" disabled={props.loading || props.recording}>{props.loading ? <LoaderCircle size={17} className="spin"/> : <ArrowRight size={17}/>} Submit report</button>
        </form>
      </section>
      <aside className="panel what-happens"><div className="panel-heading"><div><h2>What happens next</h2><p>Your report starts a traceable workflow.</p></div></div>
        <div className="next-step"><span className="next-number">01</span><div><strong>We understand it</strong><p>Your words become a clear incident summary.</p></div></div>
        <div className="next-connector"/><div className="next-step"><span className="next-number">02</span><div><strong>It gets an owner</strong><p>The responsible team receives a task and deadline.</p></div></div>
        <div className="next-connector"/><div className="next-step"><span className="next-number">03</span><div><strong>You get an update</strong><p>Track reminders, progress, and resolution.</p></div></div>
        <div className="confidence-note"><ShieldCheck size={17}/><p><strong>You stay in control.</strong> We ask when details need your confirmation.</p></div>
      </aside>
    </div>}
  </>;
}

function IncidentsPage({ incidents, search, setSearch, onOpen }: { incidents: Incident[]; search: string; setSearch: (value: string) => void; onOpen: (incident: Incident) => void }) {
  return <><div className="page-title-row"><div><p className="eyebrow">TRACEABLE REPORTS</p><h1>Incidents</h1><p className="subheading">View what was reported, who owns it, and what happens next.</p></div></div>
    <section className="panel list-panel"><div className="list-tools"><div className="search-box"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search issue, location, ID…"/></div><span className="result-count">{incidents.length} {incidents.length === 1 ? 'incident' : 'incidents'}</span></div>
      {incidents.length ? <div className="table-wrap"><table><thead><tr><th>Incident</th><th>Location</th><th>Priority</th><th>Assigned to</th><th>Deadline</th><th>Status</th></tr></thead><tbody>{incidents.map((incident) => <tr key={incident.id} onClick={() => onOpen(incident)}><td><strong>{incident.title}</strong><small>{incident.incidentNumber}</small></td><td>{incident.location || 'Not specified'}</td><td><Priority value={incident.priority}/></td><td>{incident.tasks?.[0]?.assignee?.name ?? 'Awaiting confirmation'}</td><td>{dateLabel(incident.deadline)}</td><td><span className={statusStyle(incident.status)}>{prettyStatus(incident.status)}</span></td></tr>)}</tbody></table></div> : <EmptyState title="No matching incidents" body="Try a different search or submit a new report."/>}
    </section>
  </>;
}

function TasksPage({ tasks, onUpdate, onOpenIncident }: { tasks: Task[]; onUpdate: (task: Task, status: string) => void; onOpenIncident: (id: string) => void }) {
  return <><div className="page-title-row"><div><p className="eyebrow">CLEAR OWNERSHIP</p><h1>Tasks</h1><p className="subheading">The actions assigned to you and your team.</p></div></div>
    <section className="task-list">{tasks.map((task) => <article className="task-card" key={task.id}><div className="task-priority-line"><Priority value={task.incident.priority}/><span className={statusStyle(task.status)}>{prettyStatus(task.status)}</span></div><button className="task-title" onClick={() => onOpenIncident(task.incident.id)}>{task.title}<ChevronRight size={17}/></button><p className="task-parent">{task.incident.incidentNumber} · {task.incident.location ?? 'No location'}</p><div className="task-meta"><span><Clock3 size={14}/> Due {dateLabel(task.deadline)}</span><span className="task-owner"><span className="avatar tiny">{task.assignee.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>{task.assignee.name}</span></div>
      {!['COMPLETED', 'COMPLETED_BY_ASSIGNEE', 'CLOSED'].includes(task.status) && <div className="task-actions">{task.status !== 'IN_PROGRESS' && <button className="secondary-button" onClick={() => onUpdate(task, 'IN_PROGRESS')}><Play size={14}/> Start task</button>}<button className="primary-button small" onClick={() => onUpdate(task, 'COMPLETED')}><Check size={15}/> Mark complete</button></div>}
    </article>)}{!tasks.length && <div className="panel"><EmptyState title="No tasks assigned" body="When a report creates work for you, it will show up here."/></div>}</section>
  </>;
}

function TeamPage({ employees }: { employees: Employee[] }) {
  const grouped = employees.reduce<Record<string, Employee[]>>((result, employee) => { const key = employee.department?.name ?? 'Other'; (result[key] ??= []).push(employee); return result; }, {});
  return <><div className="page-title-row"><div><p className="eyebrow">PEOPLE & OWNERSHIP</p><h1>Team directory</h1><p className="subheading">Active owners available for incident assignment.</p></div></div><div className="team-grid">{Object.entries(grouped).map(([department, team]) => <section className="panel team-panel" key={department}><div className="panel-heading"><div><h2>{department}</h2><p>{team.length} active {team.length === 1 ? 'person' : 'people'}</p></div><Users size={17} className="muted-icon"/></div>{team.map((employee) => <div className="team-person" key={employee.id}><span className="avatar">{employee.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><div><strong>{employee.name}</strong><small>{employee.email}</small></div><span className="role-tag">{employee.role.toLowerCase()}</span></div>)}</section>)}</div></>;
}

function AuditPage({ events }: { events: Array<{ id: string; action: string; reason: string | null; createdAt: string; actor?: { name: string } | null; incident?: { incidentNumber: string; title: string } | null }> }) {
  return <><div className="page-title-row"><div><p className="eyebrow">WHO · WHAT · WHEN · WHY</p><h1>Audit log</h1><p className="subheading">A readable record of workflow actions and decisions.</p></div></div><section className="panel audit-panel">{events.map((event) => <div className="audit-row" key={event.id}><span className="timeline-dot"/><div className="audit-copy"><strong>{prettyStatus(event.action)}</strong><span>{event.reason ?? 'Recorded workflow event.'}</span><small>{event.incident?.incidentNumber ?? 'System event'} · {event.actor?.name ?? 'VoiceBridge'}</small></div><time>{dateLabel(event.createdAt)}</time></div>)}{!events.length && <EmptyState title="No audit events" body="Workflow activity will be recorded here."/>}</section></>;
}

function IncidentDrawer({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  return <div className="drawer-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="incident-drawer"><div className="drawer-top"><span className="eyebrow">{incident.incidentNumber}</span><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button></div><h2>{incident.title}</h2><p className="drawer-description">{incident.description}</p><div className="drawer-badges"><Priority value={incident.priority}/><span className={statusStyle(incident.status)}>{prettyStatus(incident.status)}</span></div><div className="detail-grid"><Detail label="Location" value={incident.location ?? 'Not specified'}/><Detail label="Deadline" value={dateLabel(incident.deadline)}/><Detail label="Reported" value={dateLabel(incident.createdAt)}/><Detail label="Assigned to" value={incident.tasks?.[0]?.assignee?.name ?? 'Awaiting confirmation'}/></div><div className="drawer-task"><span className="eyebrow">REQUESTED ACTION</span><strong>{incident.tasks?.[0]?.title ?? 'No task created yet'}</strong><small>{incident.tasks?.[0]?.assignee?.email ?? 'This report is awaiting confirmation.'}</small></div><div className="drawer-footer"><ShieldCheck size={16}/> Activity and notifications are stored in the audit timeline.</div></aside></div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Priority({ value }: { value: string }) { return <span className={`priority priority-${value.toLowerCase()}`}><i/>{value.toLowerCase()}</span>; }
function prettyStatus(status: string) { return status.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function EmptyState({ title, body, action, onClick }: { title: string; body: string; action?: string; onClick?: () => void }) { return <div className="empty-state"><span><FileAudio2 size={19}/></span><strong>{title}</strong><p>{body}</p>{action && <button className="text-button" onClick={onClick}>{action} <ArrowRight size={14}/></button>}</div>; }
