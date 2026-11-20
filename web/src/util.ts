// Shared formatting helpers (Indonesian locale).
export const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const when = (iso: string) => new Date(iso).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
export const BULAN3 = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const BULAN_PANJANG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
