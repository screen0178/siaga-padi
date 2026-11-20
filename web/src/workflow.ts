// Action workflow + field reports (human-in-the-loop, P13).
// Stage 3: shared through the backend (server/app.py) so Dinas Pertanian and
// every penyuluh see one log. Without a server (static hosting, preview) it
// falls back to this browser's storage and says so.

export const STEPS = [
  { id: "open", label: "Belum ditindak", who: "", role: null },
  { id: "proposed", label: "Diusulkan", who: "Penyuluh", role: "penyuluh" },
  { id: "approved", label: "Disetujui", who: "Dinas Pertanian", role: "dinas" },
  { id: "sent", label: "Dikirim ke Gapoktan", who: "Penyuluh", role: "penyuluh" },
  { id: "done", label: "Ditindaklanjuti", who: "Gapoktan (dicatat penyuluh)", role: "penyuluh" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];
export type Role = "penyuluh" | "dinas";
export const ROLE_LABEL: Record<Role, string> = { penyuluh: "Penyuluh", dinas: "Dinas Pertanian" };

export const FEEDBACK = [
  { id: "ok", label: "Sesuai: padi tercekam kering" },
  { id: "not_rice", label: "Bukan padi (jagung/tebu/singkong)" },
  { id: "harvested", label: "Sudah panen / bera" },
  { id: "irrigated", label: "Masih teririgasi baik" },
  { id: "puso", label: "Puso / gagal panen karena kering" },
] as const;

export const feedbackLabel = (id: string) => FEEDBACK.find((f) => f.id === id)?.label ?? id;
export const stepLabel = (id: string) => STEPS.find((s) => s.id === id)?.label ?? id;

export interface Actor { name: string; role: Role }

export interface LogEntry {
  at: string;
  kind: "step" | "reset";
  step: StepId;
  actor?: string;
  role?: Role;
  note?: string | null;
}

export interface Report {
  id?: number;
  created_at: string;
  period_id: string;
  kec_id: string;
  desa_id?: string | null;
  desa_name?: string | null;
  answer: string;
  note?: string | null;
  actor?: string;
  role?: Role;
}

export interface KecState { step: StepId; log: LogEntry[] }

export type Mode = "server" | "local";

const API = "./api";
let mode: Mode = "local";
let period = "";
let states: Record<string, KecState> = {};
let reports: Record<string, Report[]> = {};
let localKey = "siaga-padi";

// ---------------------------------------------------------------- identity
const ACTOR_KEY = "siaga-padi:actor";
export function getActor(): Actor | null {
  try {
    const a = JSON.parse(localStorage.getItem(ACTOR_KEY) || "null");
    return a && a.name && (a.role === "penyuluh" || a.role === "dinas") ? a : null;
  } catch {
    return null;
  }
}
export function setActor(a: Actor | null) {
  try {
    if (a) localStorage.setItem(ACTOR_KEY, JSON.stringify(a));
    else localStorage.removeItem(ACTOR_KEY);
  } catch { /* storage unavailable */ }
}

/** Who may take the next step, and may this actor reset? Mirrors server/app.py. */
export function canStep(next: StepId, a: Actor | null) {
  const need = STEPS.find((s) => s.id === next)?.role;
  return !!a && a.role === need;
}
export function canReset(cur: StepId, a: Actor | null) {
  return !!a && cur !== "open" && (a.role === "dinas" || cur === "proposed");
}

// ---------------------------------------------------------------- server I/O
export class ApiError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function call<T>(path: string, body?: unknown, timeoutMs = 10000): Promise<T> {
  // A hung server must never block the app: fail and fall back instead
  const signal = AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${API}${path}`, body === undefined ? { signal } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch { /* not JSON */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

interface StateResponse {
  period_id: string;
  current_period: string;
  kecamatan: Record<string, KecState>;
  reports: Record<string, Report[]>;
}

/** Load shared state; returns the mode actually in use. */
export async function initStore(periodId: string): Promise<Mode> {
  period = periodId;
  localKey = `siaga-padi:${periodId}`;
  try {
    const s = await call<StateResponse>(`/state?period_id=${encodeURIComponent(periodId)}`, undefined, 4000);
    states = s.kecamatan;
    reports = s.reports;
    mode = "server";
  } catch {
    mode = "local";
    try {
      const raw = JSON.parse(localStorage.getItem(localKey) || "{}");
      states = raw.states ?? {};
      reports = raw.reports ?? {};
    } catch {
      states = {};
      reports = {};
    }
  }
  return mode;
}

/** Pull changes made by others; true if anything changed. */
export async function sync(): Promise<boolean> {
  if (mode !== "server") return false;
  const s = await call<StateResponse>(`/state?period_id=${encodeURIComponent(period)}`);
  const changed = JSON.stringify([s.kecamatan, s.reports]) !== JSON.stringify([states, reports]);
  states = s.kecamatan;
  reports = s.reports;
  return changed;
}

export const getMode = () => mode;

function persistLocal() {
  try {
    localStorage.setItem(localKey, JSON.stringify({ states, reports }));
  } catch { /* storage unavailable: keep in memory */ }
}

export function getState(kecId: string): KecState {
  return states[kecId] ?? { step: "open", log: [] };
}

export function getReports(kecId: string): Report[] {
  return reports[kecId] ?? [];
}

export async function advance(kecId: string, actor: Actor): Promise<KecState> {
  const s = getState(kecId);
  const i = STEPS.findIndex((x) => x.id === s.step);
  const next = STEPS[i + 1];
  if (!next) return s;
  if (mode === "server") {
    try {
      states[kecId] = await call<KecState>("/actions", {
        period_id: period, kec_id: kecId, from_step: s.step, to_step: next.id, actor,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await sync().catch(() => {});
      throw e;
    }
  } else {
    states[kecId] = {
      step: next.id,
      log: [...s.log, { at: new Date().toISOString(), kind: "step", step: next.id, actor: actor.name, role: actor.role }],
    };
    persistLocal();
  }
  return states[kecId];
}

export async function resetStep(kecId: string, actor: Actor) {
  const s = getState(kecId);
  if (mode === "server") {
    states[kecId] = await call<KecState>("/actions/reset", { period_id: period, kec_id: kecId, actor });
  } else {
    states[kecId] = {
      step: "open",
      log: [...s.log, { at: new Date().toISOString(), kind: "reset", step: s.step, actor: actor.name, role: actor.role }],
    };
    persistLocal();
  }
}

export async function addReport(kecId: string, answer: string, note: string, desaId: string | null, actor: Actor) {
  let r: Report;
  if (mode === "server") {
    r = await call<Report>("/reports", { kec_id: kecId, answer, note: note || null, desa_id: desaId, actor });
  } else {
    r = { created_at: new Date().toISOString(), period_id: period, kec_id: kecId, desa_id: desaId,
          answer, note: note || null, actor: actor.name, role: actor.role };
  }
  reports[kecId] = [r, ...getReports(kecId)];
  if (mode === "local") persistLocal();
  return r;
}

// ---------------------------------------------------------------- data status
export interface JobStatus {
  label: string;
  enabled: boolean;
  interval_h: number;
  running: boolean;
  last: { status: string; started_at: string; finished_at: string | null; trigger: string; log_tail: string | null } | null;
  last_ok: string | null;
  next_due: string | null;
}
export interface ServerStatus {
  data: { meta: string | null; weather: string | null; scenario: string | null };
  current_period: string;
  scheduler: boolean;
  jobs: Record<string, JobStatus>;
}

export const serverStatus = () => call<ServerStatus>("/status");
export const requestRefresh = (job: "weather" | "full", actor: Actor) => call("/refresh", { job, actor });
