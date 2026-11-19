import type { KecProps, Meta } from "./types";

const fmt = (n: number) => Math.round(n).toLocaleString("id-ID");

/** WhatsApp-ready message from penyuluh to Gapoktan (pillar 3: dissemination). */
export function composeMessage(p: KecProps, meta: Meta): string {
  const strong = (p.class_ha["4"] ?? 0) + (p.class_ha["5"] ?? 0);
  const lines = [
    `*Peringatan Kekeringan Padi: Kec. ${p.name}*`,
    `Status: *${p.status.toUpperCase()}* (${meta.period.label})`,
    "",
    `Pantauan satelit menunjukkan ±${fmt(strong)} ha padi aktif di Kec. ${p.name} mengalami cekaman kering kuat.`,
  ];
  if (p.action) {
    lines.push("", `*${p.action.headline}* (${p.action.urgency}):`);
    p.action.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  lines.push(
    "",
    "Mohon balas jika kondisi di lapangan berbeda (misal: bukan padi, sudah panen, atau air masih cukup).",
    "_Informasi pendukung keputusan, bukan pengganti pengamatan lapangan._",
  );
  return lines.join("\n");
}
