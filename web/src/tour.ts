// v2 1.2: guided tour ("Pemandu"). Highlights one part of the screen at a
// time with a short explanation. Remembered as seen in localStorage.

export interface TourStep {
  title: string;
  body: string;
  /** Elements to highlight (their union); none = centred card. */
  target?: () => (Element | null)[];
  /** Runs before the step is shown, e.g. open a detail panel. */
  before?: () => void | Promise<void>;
}

// Bump when the steps change materially, so returning users see the new tour once
const SEEN_KEY = "siaga.tour.v3";

export function tourSeen() {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; } // no storage: never auto-start
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* sandboxed */ }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAD = 6, GAP = 12, M = 12;

let active: (() => void) | null = null;

export function startTour(steps: TourStep[], onEnd?: () => void) {
  active?.();
  let i = 0;
  let token = 0;
  const shield = document.createElement("div");
  shield.className = "tour-shield";
  const hole = document.createElement("div");
  hole.className = "tour-hole";
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  document.body.append(shield, hole, card);

  const targets = () => (steps[i].target?.() ?? []).filter((e): e is Element => !!e && (e as HTMLElement).offsetParent !== null);

  function place() {
    const els = targets();
    const vw = innerWidth, vh = innerHeight;
    if (!els.length) {
      hole.classList.add("none");
      card.style.left = `${Math.max(M, (vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(M, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    hole.classList.remove("none");
    const rs = els.map((e) => e.getBoundingClientRect());
    const r = {
      left: Math.max(4, Math.min(...rs.map((x) => x.left)) - PAD),
      top: Math.max(4, Math.min(...rs.map((x) => x.top)) - PAD),
      right: Math.min(vw - 4, Math.max(...rs.map((x) => x.right)) + PAD),
      bottom: Math.min(vh - 4, Math.max(...rs.map((x) => x.bottom)) + PAD),
    };
    Object.assign(hole.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    if (vw <= 700) return; // CSS docks the card at the bottom on phones
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const clampX = (x: number) => Math.max(M, Math.min(vw - cw - M, x));
    const clampY = (y: number) => Math.max(M, Math.min(vh - ch - M, y));
    // Beside the target if there is room, else above or below it
    let x: number, y: number;
    if (vw - r.right - GAP >= cw + M) { x = r.right + GAP; y = clampY(r.top); }
    else if (r.left - GAP >= cw + M) { x = r.left - GAP - cw; y = clampY(r.top); }
    else if (r.top - GAP >= ch + M) { x = clampX(r.left); y = r.top - GAP - ch; }
    else if (vh - r.bottom - GAP >= ch + M) { x = clampX(r.left); y = r.bottom + GAP; }
    else { x = clampX((vw - cw) / 2); y = vh - ch - M; }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  async function show(n: number) {
    const my = ++token;
    i = Math.max(0, Math.min(steps.length - 1, n));
    const s = steps[i];
    card.classList.add("busy");
    if (s.before) {
      await s.before();
      await wait(320); // let panels slide in
      if (my !== token) return; // user clicked on meanwhile
    }
    targets()[0]?.scrollIntoView({ block: "nearest" });
    const last = i === steps.length - 1;
    card.innerHTML = `
      <div class="tour-k">Pemandu · ${i + 1} dari ${steps.length}</div>
      <h3>${s.title}</h3>
      <p>${s.body}</p>
      <div class="tour-dots">${steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="tour-row">
        <button class="ghost" data-t="stop">${last ? "Tutup" : "Jeda"}</button>
        <span></span>
        ${i > 0 ? `<button class="ghost" data-t="prev">Sebelumnya</button>` : ""}
        <button class="primary" data-t="next">${last ? "Selesai" : "Lanjut"}</button>
      </div>`;
    card.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => {
      b.onclick = () => (b.dataset.t === "prev" ? show(i - 1) : b.dataset.t === "next" && !last ? show(i + 1) : end());
    });
    card.classList.remove("busy");
    place();
    card.querySelector<HTMLButtonElement>("[data-t=next]")!.focus({ preventScroll: true });
  }

  const onKey = (e: KeyboardEvent) => {
    // Capture phase: arrows move the tour, not the month strip
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") void show(i + 1);
    else if (e.key === "ArrowLeft") void show(i - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onResize = () => place();

  function end() {
    token++;
    markSeen();
    shield.remove(); hole.remove(); card.remove();
    removeEventListener("keydown", onKey, true);
    removeEventListener("resize", onResize);
    active = null;
    onEnd?.();
  }

  addEventListener("keydown", onKey, true);
  addEventListener("resize", onResize);
  active = end;
  void show(0);
}
