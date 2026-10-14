import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowRight, Bell, Check, ChevronRight, CircleHelp, Clock3, FileAudio2, LayoutDashboard, ListChecks, LoaderCircle, LogOut, Mic, Pause, PhoneCall, Play, Plus, RotateCcw, Search, ShieldCheck, Users, X } from 'lucide-react';

type Role = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
type User = { id: string; name: string; email: string; role: Role; department: string | null; authProvider?: string };
type Incident = { id: string; incidentNumber: string; title: string; description: string; location: string | null; priority: string; status: string; deadline: string; createdAt: string; reporterId?: string; reporter?: { id?: string; name: string }; tasks: Task[]; closureVerifications?: Array<{ id: string; status: string; prompt: string; attemptNumber: number }> };
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

const labels: Record<Page, string> = { dashboard: 'Overview', report: 'Report an issue', reports: 'Incidents', tasks: 'Tasks', team: 'Team', audit: 'Audit log' };
const recognitionLang: Record<string, string> = { hi: 'hi-IN', hinglish: 'hi-IN', ta: 'ta-IN', en: 'en-IN' };
const languageLabels: Record<string, { name: string; script: string; example: string }> = {
  hi: { name: 'Hindi', script: 'Devanagari', example: 'हिन्दी' },
  hinglish: { name: 'Hinglish', script: 'Roman/Latin', example: 'Hindi in English script' },
  ta: { name: 'Tamil', script: 'Tamil', example: 'தமிழ்' },
  en: { name: 'English', script: 'English', example: 'English' },
};
function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/* Lightweight Devanagari → Latin transliteration for Hinglish display */
const _C: Record<string, string> = {'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'n','ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n','प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh','स':'s','ह':'h','क़':'q','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f'};
const _V: Record<string, string> = {'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au'};
const _M: Record<string, string> = {'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','ः':'h','ँ':'n'};
const _W: Record<string, string> = {'के':'ke','का':'ka','की':'ki','है':'hai','हैं':'hain','में':'mein','से':'se','पर':'par','को':'ko','और':'aur','कृपया':'kripya','भी':'bhi','नहीं':'nahi','बहुत':'bahut','तेज':'tez','अजीब':'ajeeb','आवाज':'awaaz','आवाज़':'awaaz','शोर':'shor','मशीन':'machine','पैकेजिंग':'packaging','लाइन':'line','सर्वर':'server','रूम':'room','कंप्यूटर':'computer','नेटवर्क':'network','मोटर':'motor','कन्वेयर':'conveyor','पानी':'paani','रिसाव':'risaav','लाइट':'light','एसी':'AC','कैफेटेरिया':'cafeteria','गोदाम':'godaam','वेयरहाउस':'warehouse','बॉयलर':'boiler','लोडिंग':'loading','बे':'bay','असेंबली':'assembly','प्रोडक्शन':'production','रही':'rahi','रहा':'raha','हो':'ho','कर':'kar','चेक':'check','मेंटेनेंस':'maintenance','जांचें':'jaanchein','देखें':'dekhein','बताएं':'bataein','ठीक':'theek','करें':'karein','आ':'aa','प्लीज':'please','दरवाज़ा':'darwaza'};
function _tw(w: string): string {
  if (/^[\x00-\x7F]+$/u.test(w)) return w;
  if (_W[w]) return _W[w];
  let r = ''; const c = [...w]; let i = 0;
  while (i < c.length) {
    const ch = c[i]!;
    if (_V[ch]) { r += _V[ch]; i++; continue; }
    if (_C[ch]) { const b = _C[ch]!; i++; if (c[i]==='\u094D') { r += b; i++; } else if (c[i] && _M[c[i]!]) { r += b + _M[c[i]!]; i++; } else { r += (i >= c.length ? b : b + 'a'); } continue; }
    if (_M[ch]) { r += _M[ch]; i++; continue; }
    if (ch === '\u094D') { i++; continue; }
    const dd = '०१२३४५६७८९'.indexOf(ch); if (dd >= 0) { r += String(dd); i++; continue; }
    r += ch; i++;
  }
  return r;
}
function translitHinglish(text: string): string {
  if (!/[\u0900-\u097F]/u.test(text)) return text;
  let p = text; for (const [h, e] of Object.entries(_W)) { if (h.includes(' ') && p.includes(h)) p = p.replaceAll(h, e); }
  return p.split(/(\s+)/u).map(s => /^\s+$/u.test(s) ? s : _tw(s)).join('');
}

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
  const norm = value === 'COMPLETED_BY_ASSIGNEE' ? 'completed' : value.toLowerCase().replaceAll('_', '-');
  return `status status-${norm}`;
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
  const [showGoogleModal, setShowGoogleModal] = useState(false);
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

  async function signInWithGoogle(googleData?: { credential?: string; email?: string; name?: string }) {
    setError(''); setLoading(true); setShowGoogleModal(false);
    try {
      const payload = googleData ?? { email: 'employee@voicebridge.local', name: 'Sam Reporter' };
      const result = await request<{ token: string; user: User }>('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      localStorage.setItem('voicebridge.token', result.token);
      localStorage.setItem('voicebridge.user', JSON.stringify(result.user));
      setToken(result.token);
      setUser(result.user);
      setNotice(`Signed in with Google as ${result.user.name}.`);
      await refreshData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Google sign-in failed.');
    } finally {
      setLoading(false);
    }
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
        recognition.continuous = true; recognition.interimResults = true; recognition.lang = recognitionLang[reportLanguage] ?? 'hi-IN';
        recognition.onresult = (event) => {
          const words: string[] = [];
          for (let index = 0; index < event.results.length; index += 1) words.push(event.results[index]?.[0]?.transcript ?? '');
          const raw = words.join(' ').trim();
          setTranscript(reportLanguage === 'hinglish' ? translitHinglish(raw) : raw);
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

  async function completeTask(task: Task) {
    setLoading(true); setError('');
    try {
      const result = await request<{ task: Task; incidentStatus?: string; verification?: { id: string } }>(`/api/tasks/${task.id}/complete`, { method: 'POST' });
      if (result.task) {
        setTasks((prev) => prev.map((t) => t.id === result.task.id ? { ...t, ...result.task } : t));
        setIncidents((prev) => prev.map((inc) => inc.id === task.incident.id ? {
          ...inc,
          status: result.incidentStatus || 'REPORTER_VERIFICATION_PENDING',
          tasks: inc.tasks.map((t) => t.id === result.task.id ? { ...t, ...result.task } : t)
        } : inc));
      }
      setNotice(result.incidentStatus === 'CLOSED'
        ? 'Reporter confirmed the fix. Incident closed.'
        : result.incidentStatus === 'REOPENED'
        ? 'Reporter said the issue remains. Incident reopened.'
        : 'Task marked complete. Spoken reporter verification is pending.');
      await refreshData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The task could not be completed.');
    } finally {
      setLoading(false);
    }
  }

  async function updateTask(task: Task, status: string) {
    if (status === 'COMPLETED') {
      return completeTask(task);
    }
    setLoading(true); setError('');
    try {
      const result = await request<{ task?: Task; incidentStatus?: string }>(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      if (result.task) {
        setTasks((prev) => prev.map((t) => t.id === result.task!.id ? { ...t, ...result.task! } : t));
      }
      setNotice('Task status updated.');
      await refreshData();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The task could not be updated.'); }
    finally { setLoading(false); }
  }

  async function verifyClosure(incident: Incident, responseChoice: '1' | '2') {
    setLoading(true); setError('');
    try {
      let verificationId = incident.closureVerifications?.[0]?.id;
      if (!verificationId) {
        const fresh = await request<{ incident: Incident }>(`/api/incidents/${incident.id}`);
        verificationId = fresh.incident.closureVerifications?.[0]?.id;
      }
      if (!verificationId) throw new Error('No pending closure verification found for this incident.');
      const result = await request<{ status: string }>(`/api/incidents/${incident.id}/verify-closure`, {
        method: 'POST',
        body: JSON.stringify({ verificationId, response: responseChoice })
      });
      setNotice(result.status === 'CLOSED'
        ? 'Reporter confirmed the fix. Incident closed.'
        : 'Reporter said the issue remains. Incident reopened.');
      await refreshData();
      setSelectedIncident(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Closure verification could not be recorded.');
    } finally {
      setLoading(false);
    }
  }

  if (!token || !user) {
    return (
      <>
        <Login
          email={loginEmail}
          password={loginPassword}
          setEmail={setLoginEmail}
          setPassword={setLoginPassword}
          onSubmit={signIn}
          onGoogleLogin={() => setShowGoogleModal(true)}
          loading={loading}
          error={error}
        />
        <GoogleAuthModal
          isOpen={showGoogleModal}
          onClose={() => setShowGoogleModal(false)}
          onSelectAccount={signInWithGoogle}
          loading={loading}
        />
      </>
    );
  }

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
        <div className="header-right">
          <button
            type="button"
            className="google-badge-pill"
            onClick={() => setShowGoogleModal(true)}
            title="Google Workspace Single Sign-On"
            id="header-google-pill"
          >
            <GoogleIcon size={14} />
            <span>{user.authProvider === 'google' ? user.email : 'Google Login'}</span>
          </button>
          <span className="live-indicator"><i /> System ready</span>
          <span className="header-date">{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span>
          <button className="icon-button" aria-label="Notifications" onClick={() => setNotice('You are up to date.') }><Bell size={17} /></button>
        </div>
      </header>
      <div className="content-wrap">
        {error && <div className="alert error-alert"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {notice && <div className="alert notice-alert"><Check size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {loading && <div className="loading-line"><LoaderCircle size={15} className="spin" /> Updating your workspace…</div>}
        {page === 'dashboard' && (
          <Dashboard
            user={user}
            incidents={incidents}
            tasks={tasks}
            openCount={openCount}
            overdueCount={overdueCount}
            completedCount={completedCount}
            onReport={() => setPage('report')}
            onOpenIncident={setSelectedIncident}
            onViewTasks={() => setPage('tasks')}
            onGoogleLogin={() => setShowGoogleModal(true)}
          />
        )}
        {page === 'report' && <ReportPage recording={isRecording} elapsed={elapsed} transcript={transcript} setTranscript={setTranscript} language={reportLanguage} setLanguage={setReportLanguage} audioUrl={audioUrl} listeningSupported={listeningSupported} pending={pendingReport} edited={editedExtraction} setEdited={setEditedExtraction} employees={employees} assigneeId={assigneeId} setAssigneeId={setAssigneeId} onStart={() => void startRecording()} onStop={stopRecording} onSubmit={submitReport} onConfirm={confirmReport} onRetry={() => { setTranscript(''); setAudioBlob(null); setAudioUrl(''); setPendingReport(null); }} loading={loading} />}
        {page === 'reports' && <IncidentsPage incidents={filteredIncidents} search={search} setSearch={setSearch} onOpen={setSelectedIncident} />}
        {page === 'tasks' && <TasksPage tasks={tasks} onComplete={completeTask} onUpdate={updateTask} onOpenIncident={(id) => { const incident = incidents.find((item) => item.id === id); if (incident) setSelectedIncident(incident); }} loading={loading} />}
        {page === 'team' && <TeamPage employees={employees} />}
        {page === 'audit' && <AuditPage events={auditEvents} />}
      </div>
    </main>
    {selectedIncident && (
      <IncidentDrawer
        incident={selectedIncident}
        currentUser={user}
        onCompleteTask={completeTask}
        onVerifyClosure={verifyClosure}
        onClose={() => setSelectedIncident(null)}
        loading={loading}
      />
    )}
    <GoogleAuthModal
      isOpen={showGoogleModal}
      onClose={() => setShowGoogleModal(false)}
      onSelectAccount={signInWithGoogle}
      loading={loading}
    />
  </div>;
}

function NavItem({ active, icon, onClick, children }: { active: boolean; icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{children}</span>{active && <i />}</button>;
}

function GoogleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
    </svg>
  );
}

function GoogleAuthModal({
  isOpen,
  onClose,
  onSelectAccount,
  loading
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelectAccount: (data: { email: string; name: string }) => void;
  loading: boolean;
}) {
  const [customEmail, setCustomEmail] = useState('');
  const [customName, setCustomName] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  if (!isOpen) return null;

  const demoAccounts = [
    { name: 'Sam Reporter', email: 'employee@voicebridge.local', role: 'Employee · Maintenance', avatar: 'SR' },
    { name: 'Operations Lead', email: 'operations.manager@voicebridge.local', role: 'Manager · Operations', avatar: 'OL' },
    { name: 'Avery Admin', email: 'admin@voicebridge.local', role: 'Administrator · System', avatar: 'AA' },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="google-modal-title">
      <div className="google-modal" onClick={(e) => e.stopPropagation()}>
        <div className="google-modal-header">
          <GoogleIcon size={32} />
          <h2 id="google-modal-title">Sign in with Google</h2>
          <p>Choose an account to continue to <strong>VoiceBridge</strong></p>
        </div>

        <div className="google-account-list">
          {demoAccounts.map((account) => (
            <button
              key={account.email}
              type="button"
              className="google-account-item"
              disabled={loading}
              onClick={() => onSelectAccount({ email: account.email, name: account.name })}
            >
              <span className="google-acc-avatar">{account.avatar}</span>
              <div className="google-acc-info">
                <strong>{account.name}</strong>
                <span>{account.email}</span>
                <small>{account.role}</small>
              </div>
              <ChevronRight size={16} className="google-acc-arrow" />
            </button>
          ))}
        </div>

        {!showCustom ? (
          <button
            type="button"
            className="google-custom-btn"
            onClick={() => setShowCustom(true)}
          >
            + Use another Google Workspace account
          </button>
        ) : (
          <form
            className="google-custom-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (customEmail.trim()) {
                onSelectAccount({ email: customEmail.trim(), name: customName.trim() || customEmail.trim().split('@')[0] || 'Google User' });
              }
            }}
          >
            <label>
              Google Account Email
              <input
                type="email"
                placeholder="user@workspace.com"
                value={customEmail}
                onChange={(e) => setCustomEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label>
              Display Name (Optional)
              <input
                type="text"
                placeholder="Full Name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
            </label>
            <div className="google-custom-actions">
              <button type="button" className="secondary-button small" onClick={() => setShowCustom(false)}>Cancel</button>
              <button type="submit" className="primary-button small" disabled={loading}>Continue with Google</button>
            </div>
          </form>
        )}

        <div className="google-modal-footer">
          <small>To continue, Google will share your name, email address, and language preference with VoiceBridge.</small>
          <button type="button" className="google-cancel-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Login({ email, password, setEmail, setPassword, onSubmit, onGoogleLogin, loading, error }: {
  email: string; password: string; setEmail: (value: string) => void; setPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; onGoogleLogin: () => void; loading: boolean; error: string;
}) {
  return <div className="login-screen">
    <div className="login-brand"><span className="brand-mark"><Activity size={19} /></span>VoiceBridge</div>
    <div className="login-card">
      <p className="eyebrow">OPERATIONAL WORKFLOW</p><h1>Welcome back</h1><p className="login-intro">Sign in to report an issue or follow up on active work.</p>
      {error && <div className="alert error-alert"><AlertTriangle size={16} />{error}</div>}
      <button type="button" className="google-button wide" onClick={onGoogleLogin} disabled={loading} id="google-login-button">
        <GoogleIcon size={18} />
        <span>Sign in with Google</span>
      </button>

      <div className="auth-divider"><span>or continue with email</span></div>

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

function Dashboard({
  user, incidents, tasks, openCount, overdueCount, completedCount, onReport, onOpenIncident, onViewTasks, onGoogleLogin
}: {
  user: User; incidents: Incident[]; tasks: Task[]; openCount: number; overdueCount: number; completedCount: number;
  onReport: () => void; onOpenIncident: (incident: Incident) => void; onViewTasks: () => void; onGoogleLogin: () => void;
}) {
  const recent = incidents.slice(0, 5);
  const isGoogle = user.authProvider === 'google';

  return <>
    <div className="welcome-row">
      <div>
        <p className="eyebrow">YOUR OPERATIONS AT A GLANCE</p>
        <h1>{timeGreeting()}, {user.name.split(' ')[0]}</h1>
        <p className="subheading">Reports, ownership, and follow-through in one place.</p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button type="button" className="google-badge-pill" onClick={onGoogleLogin} title="Google Workspace Single Sign-On" id="dashboard-google-pill">
          <GoogleIcon size={14} />
          <span>{isGoogle ? 'Google: ' + user.email : 'Google Login'}</span>
        </button>
        <button className="primary-button" onClick={onReport}><Plus size={17} /> Report an issue</button>
      </div>
    </div>

    <div className="metric-grid">
      <Metric title="Open incidents" value={openCount} icon={<Activity size={18} />} accent="blue" note="Active" />
      <Metric title="Overdue / escalated" value={overdueCount} icon={<AlertTriangle size={18} />} accent="rose" note={overdueCount > 0 ? 'Needs attention' : 'None'} />
      <Metric title="Resolved" value={completedCount} icon={<Check size={18} />} accent="green" note="Closed" />
      <Metric title="Active tasks" value={tasks.filter((task) => !['COMPLETED', 'COMPLETED_BY_ASSIGNEE', 'CLOSED'].includes(task.status)).length} icon={<ListChecks size={18} />} accent="violet" note="Assigned to you" />
    </div>
    <div className="dashboard-grid">
      <section className="panel incidents-panel">
        <div className="panel-heading"><div><h2>Recent incidents</h2><p>Most recent reports in your workspace</p></div><button className="text-button" onClick={onViewTasks}>Open tasks <ArrowRight size={14} /></button></div>
        {recent.length ? <div className="table-wrap"><table><thead><tr><th>Issue</th><th>Location</th><th>Priority</th><th>Owner</th><th>Status</th></tr></thead><tbody>{recent.map((incident) => <tr key={incident.id} onClick={() => onOpenIncident(incident)}><td><strong>{incident.title}</strong><small>{incident.incidentNumber}</small></td><td className="cell-location">{incident.location || '—'}</td><td><Priority value={incident.priority} /></td><td className="cell-assignee">{incident.tasks[0]?.assignee?.name ?? 'Awaiting owner'}</td><td><span className={statusStyle(incident.status)}>{prettyStatus(incident.status)}</span></td></tr>)}</tbody></table></div> : <EmptyState title="No reports yet" body="Your submitted reports and assigned work will appear here." action="Report an issue" onClick={onReport} />}
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
    <div className="page-title-row"><div><p className="eyebrow">QUICK REPORT</p><h1>Report an issue</h1><p className="subheading">Describe what happened in your own words. We'll route the follow-up.</p></div><span className="step-pill"><span>1</span> Record <i/> <span>2</span> Review <i/> <span>3</span> Submit</span></div>
    {props.pending && props.edited ? <section className="panel review-panel">
      <div className="review-head"><span className="review-icon"><CircleHelp size={20}/></span><div><h2>Review before we assign</h2><p>{props.pending.clarification}</p></div></div>
      <div className="transcript-quote"><span>WHAT WE HEARD</span><p>"{props.transcript}"</p></div>
      {props.edited.missingInformation.length > 0 && <div className="alert error-alert" style={{ marginBottom: 12 }}><AlertTriangle size={15}/><span>Missing information: {props.edited.missingInformation.join(', ')}. Please fill in the fields below.</span></div>}
      {props.edited.priority === 'CRITICAL' && <div className="alert error-alert" style={{ marginBottom: 12, fontWeight: 600 }}><AlertTriangle size={15}/><span>This will be flagged as a critical/emergency incident.</span></div>}
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
          <label className="language-select">Report language<select value={props.language} onChange={(event) => props.setLanguage(event.target.value)} disabled={props.recording}><option value="hi">Hindi — Devanagari (हिन्दी)</option><option value="hinglish">Hinglish — Roman script</option><option value="ta">Tamil — Tamil script (தமிழ்)</option><option value="en">English</option></select></label>
          {languageLabels[props.language] && <div className="inline-hint" style={{ background: 'var(--accent-subtle)', borderColor: '#c8dce2', color: 'var(--accent-text)' }}><span>Transcript will appear in <strong>{languageLabels[props.language]!.script}</strong> script{props.language === 'hinglish' ? ' (Devanagari automatically converted to Roman letters)' : ''}</span></div>}
          <div className={`recorder ${props.recording ? 'recording' : ''}`}>
            <div className="record-wave"><span/><span/><span/><span/><span/><span/><span/></div>
            <button type="button" className="record-button" onClick={props.recording ? props.onStop : props.onStart} aria-label={props.recording ? 'Stop recording' : 'Start recording'}>{props.recording ? <Pause size={22} fill="currentColor"/> : <Mic size={23}/>}</button>
            <strong>{props.recording ? 'Listening — speak now…' : props.audioUrl ? 'Recording ready — review below' : 'Press to start recording'}</strong>
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
      {incidents.length ? <div className="table-wrap"><table><thead><tr><th>Incident</th><th>Location</th><th>Priority</th><th>Assigned to</th><th>Deadline</th><th>Status</th></tr></thead><tbody>{incidents.map((incident) => <tr key={incident.id} onClick={() => onOpen(incident)}><td><strong>{incident.title}</strong><small>{incident.incidentNumber}</small></td><td className="cell-location">{incident.location || 'Not specified'}</td><td><Priority value={incident.priority}/></td><td className="cell-assignee">{incident.tasks?.[0]?.assignee?.name ?? 'Awaiting confirmation'}</td><td className="cell-deadline">{dateLabel(incident.deadline)}</td><td><span className={statusStyle(incident.status)}>{prettyStatus(incident.status)}</span></td></tr>)}</tbody></table></div> : <EmptyState title="No matching incidents" body="Try a different search or submit a new report."/>}
    </section>
  </>;
}

function TasksPage({ tasks, onComplete, onUpdate, onOpenIncident, loading }: { tasks: Task[]; onComplete: (task: Task) => void; onUpdate: (task: Task, status: string) => void; onOpenIncident: (id: string) => void; loading?: boolean }) {
  const completableStatuses = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'OVERDUE', 'ESCALATED', 'REOPENED', 'EMERGENCY'];

  return <>
    <div className="page-title-row">
      <div>
        <p className="eyebrow">CLEAR OWNERSHIP</p>
        <h1>Tasks</h1>
        <p className="subheading">The actions assigned to you and your team.</p>
      </div>
    </div>
    <section className="panel list-panel">
      {tasks.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Assigned To</th>
                <th>Deadline</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const isCompletable = completableStatuses.includes(task.status);
                return (
                  <tr key={task.id}>
                    <td onClick={() => onOpenIncident(task.incident.id)} style={{ cursor: 'pointer' }}>
                      <strong>{task.title}</strong>
                      <small>{task.incident.incidentNumber} · {task.incident.location ?? 'No location'}</small>
                    </td>
                    <td>{task.assignee.name}</td>
                    <td>{dateLabel(task.deadline)}</td>
                    <td>
                      <span className={statusStyle(task.status)}>{prettyStatus(task.status)}</span>
                    </td>
                    <td>
                      {isCompletable ? (
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          {task.status !== 'IN_PROGRESS' && (
                            <button
                              type="button"
                              className="secondary-button small"
                              onClick={() => onUpdate(task, 'IN_PROGRESS')}
                              disabled={loading}
                              title="Start task"
                            >
                              <Play size={13} /> Start
                            </button>
                          )}
                          <button
                            type="button"
                            className="primary-button small"
                            onClick={() => onComplete(task)}
                            disabled={loading}
                          >
                            <Check size={14} /> Complete Task
                          </button>
                        </div>
                      ) : task.status === 'COMPLETED_BY_ASSIGNEE' ? (
                        <span className="action-tag verification-pending">
                          <Clock3 size={13} /> Verification Pending
                        </span>
                      ) : (
                        <span className="action-tag verified-closed">
                          <Check size={13} /> Closed
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No tasks assigned" body="When a report creates work for you, it will show up here." />
      )}
    </section>
  </>;
}

function TeamPage({ employees }: { employees: Employee[] }) {
  const grouped = employees.reduce<Record<string, Employee[]>>((result, employee) => { const key = employee.department?.name ?? 'Other'; (result[key] ??= []).push(employee); return result; }, {});
  return <><div className="page-title-row"><div><p className="eyebrow">PEOPLE & OWNERSHIP</p><h1>Team directory</h1><p className="subheading">Active owners available for incident assignment.</p></div></div><div className="team-grid">{Object.entries(grouped).map(([department, team]) => <section className="panel team-panel" key={department}><div className="panel-heading"><div><h2>{department}</h2><p>{team.length} active {team.length === 1 ? 'person' : 'people'}</p></div><Users size={17} className="muted-icon"/></div>{team.map((employee) => <div className="team-person" key={employee.id}><span className="avatar">{employee.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><div><strong>{employee.name}</strong><small>{employee.email}</small></div><span className="role-tag">{employee.role.toLowerCase()}</span></div>)}</section>)}</div></>;
}

function AuditPage({ events }: { events: Array<{ id: string; action: string; reason: string | null; createdAt: string; actor?: { name: string } | null; incident?: { incidentNumber: string; title: string } | null }> }) {
  return <><div className="page-title-row"><div><p className="eyebrow">WHO · WHAT · WHEN · WHY</p><h1>Audit log</h1><p className="subheading">A readable record of workflow actions and decisions.</p></div></div><section className="panel audit-panel">{events.map((event) => <div className="audit-row" key={event.id}><span className="timeline-dot"/><div className="audit-copy"><strong>{prettyStatus(event.action)}</strong><span>{event.reason ?? 'Recorded workflow event.'}</span><small>{event.incident?.incidentNumber ?? 'System event'} · {event.actor?.name ?? 'VoiceBridge'}</small></div><time>{dateLabel(event.createdAt)}</time></div>)}{!events.length && <EmptyState title="No audit events" body="Workflow activity will be recorded here."/>}</section></>;
}

function IncidentDrawer({ incident, currentUser, onCompleteTask, onVerifyClosure, onClose, loading }: { incident: Incident; currentUser: User | null; onCompleteTask: (task: Task) => void; onVerifyClosure: (incident: Incident, response: '1' | '2') => void; onClose: () => void; loading?: boolean }) {
  const task = incident.tasks?.[0];
  const isCompletable = task && ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'OVERDUE', 'ESCALATED', 'REOPENED', 'EMERGENCY'].includes(task.status);
  const isReporter = currentUser && (incident.reporterId === currentUser.id || incident.reporter?.id === currentUser.id || currentUser.role === 'ADMIN');
  const isPendingVerification = incident.status === 'REPORTER_VERIFICATION_PENDING';

  return <div className="drawer-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="incident-drawer">
    <div className="drawer-top"><span className="eyebrow">{incident.incidentNumber}</span><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <h2>{incident.title}</h2>
    <p className="drawer-description">{incident.description}</p>
    <div className="drawer-badges"><Priority value={incident.priority}/><span className={statusStyle(incident.status)}>{prettyStatus(incident.status)}</span></div>
    <div className="detail-grid">
      <Detail label="Location" value={incident.location ?? 'Not specified'}/>
      <Detail label="Deadline" value={dateLabel(incident.deadline)}/>
      <Detail label="Reported" value={dateLabel(incident.createdAt)}/>
      <Detail label="Assigned to" value={incident.tasks?.[0]?.assignee?.name ?? 'Awaiting confirmation'}/>
    </div>
    <div className="drawer-task">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span className="eyebrow" style={{ margin: 0 }}>REQUESTED ACTION</span>
        {task && <span className={statusStyle(task.status)}>{prettyStatus(task.status)}</span>}
      </div>
      <strong>{task?.title ?? 'No task created yet'}</strong>
      <small>{task?.assignee?.name ? `${task.assignee.name} (${task.assignee.email})` : 'This report is awaiting confirmation.'}</small>
      {isCompletable && (
        <div style={{ marginTop: '12px' }}>
          <button type="button" className="primary-button small" onClick={() => onCompleteTask(task)} disabled={loading}>
            <Check size={14}/> Complete Task
          </button>
        </div>
      )}
      {task?.status === 'COMPLETED_BY_ASSIGNEE' && (
        <div style={{ marginTop: '10px' }}>
          <span className="action-tag verification-pending"><Clock3 size={13}/> Verification Pending</span>
        </div>
      )}
    </div>
    {isPendingVerification && (
      <div className="drawer-verification-banner">
        <div className="verification-banner-header">
          <PhoneCall size={15}/>
          <span>Spoken Verification Pending (IVR Simulation)</span>
        </div>
        <p className="verification-prompt-text">{incident.closureVerifications?.[0]?.prompt || 'Work has been marked complete. Does the issue persist?'}</p>
        {isReporter ? (
          <div className="verification-banner-actions">
            <button type="button" className="primary-button small" onClick={() => onVerifyClosure(incident, '1')} disabled={loading}>
              <Check size={14}/> Press 1 — Confirm & Close
            </button>
            <button type="button" className="secondary-button small" onClick={() => onVerifyClosure(incident, '2')} disabled={loading}>
              <RotateCcw size={14}/> Press 2 — Issue Remains (Reopen)
            </button>
          </div>
        ) : (
          <small style={{ color: '#8c7b6c' }}>Awaiting closure verification from the original reporter.</small>
        )}
      </div>
    )}
    <div className="drawer-footer"><ShieldCheck size={16}/> Activity and notifications are stored in the audit timeline.</div>
  </aside></div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Priority({ value }: { value: string }) { return <span className={`priority priority-${value.toLowerCase()}`}><i/>{value.toLowerCase()}</span>; }
function prettyStatus(status: string) {
  if (status === 'COMPLETED_BY_ASSIGNEE') return 'Completed';
  if (status === 'REPORTER_VERIFICATION_PENDING') return 'Verification Pending';
  return status.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function EmptyState({ title, body, action, onClick }: { title: string; body: string; action?: string; onClick?: () => void }) { return <div className="empty-state"><span><FileAudio2 size={19}/></span><strong>{title}</strong><p>{body}</p>{action && <button className="text-button" onClick={onClick}>{action} <ArrowRight size={14}/></button>}</div>; }
