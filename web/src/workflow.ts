// Action workflow + field feedback (human-in-the-loop, P13).
// Stage 0 keeps this in the viewer's browser only. Stage 3 moves it to the
// backend so the agriculture office and every penyuluh share one log.

export const STEPS = [
  { id: "open", label: "Belum ditindak", who: "" },
  { id: "proposed", label: "Diusulkan", who: "Penyuluh" },
  { id: "approved", label: "Disetujui", who: "Dinas Pertanian" },
  { id: "sent", label: "Dikirim ke Gapoktan", who: "Penyuluh" },
  { id: "done", label: "Ditindaklanjuti", who: "Gapoktan" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export const FEEDBACK = [
  { id: "ok", label: "Sesuai: padi tercekam kering" },
  { id: "not_rice", label: "Bukan padi (jagung/tebu/singkong)" },
  { id: "harvested", label: "Sudah panen / bera" },
  { id: "irrigated", label: "Masih teririgasi baik" },
] as const;

export interface LogEntry {
  at: string;
  kind: "step" | "feedback";
  value: string;
  note?: string;
}

export interface KecState {
  step: StepId;
  log: LogEntry[];
}

type Store = Record<string, KecState>;

let store: Store = {};
let key = "siaga-padi";

function persist() {
  try {
    localStorage.setItem(key, JSON.stringify(store));
  } catch {
    /* storage unavailable: keep in memory */
  }
}

export function initStore(periodKey: string) {
  key = `siaga-padi:${periodKey}`;
  try {
    store = JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    store = {};
  }
}

export function getState(kecId: string): KecState {
  return store[kecId] ?? { step: "open", log: [] };
}

export function advance(kecId: string): KecState {
  const s = getState(kecId);
  const i = STEPS.findIndex((x) => x.id === s.step);
  if (i < STEPS.length - 1) {
    const next = STEPS[i + 1];
    s.step = next.id;
    s.log.push({ at: new Date().toISOString(), kind: "step", value: next.label });
    store[kecId] = s;
    persist();
  }
  return s;
}

export function resetStep(kecId: string) {
  delete store[kecId];
  persist();
}

export function addFeedback(kecId: string, value: string, note: string) {
  const s = getState(kecId);
  s.log.push({ at: new Date().toISOString(), kind: "feedback", value, note: note || undefined });
  store[kecId] = s;
  persist();
}
