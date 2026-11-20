// The guided tour's steps (v2 1.2). Steps for optional features appear only
// when their data exists. Bump SEEN_KEY in tour.ts when they change materially.
import type { TourStep } from "./tour";
import type { Anomaly, Forecast, KecProps, Meta } from "./types";
import { esc } from "./util";
import type { Verification } from "./verify";

export interface TourCtx {
  meta: Meta;
  forecast: Forecast | null;
  anomaly: Anomaly | null;
  verification: Verification | null;
  top?: KecProps;
  /** Opens the top-ranked kecamatan (steps inside the detail panel). */
  openTop: () => void;
}

export function tourSteps({ meta, forecast, anomaly, verification, top, openTop }: TourCtx): TourStep[] {
  const q = (sel: string) => () => [document.querySelector(sel)];
  const section = (sel: string) => () => [document.querySelector(sel)?.closest("section") ?? null];
  return [
    {
      title: "Selamat datang di SIAGA-Padi",
      body: `Sistem respons kekeringan padi pada musim berjalan untuk penyuluh ${esc(meta.region.name)}: citra satelit diubah menjadi tindakan lapangan yang diprioritaskan, disetujui Dinas, dilacak, lalu dikoreksi oleh laporan lapangan. Tur singkat; bisa dijeda kapan saja.`,
    },
    {
      title: "Peta dan lapisan",
      body: `Warna kecamatan = status kekeringan. Lapisan lain berasal dari citra Landsat: kelas kekeringan (NDDI), kehijauan (NDVI), kelembapan (NDMI), dan fase tumbuh padi. Klik kecamatan di peta untuk melihat detailnya.${anomaly ? " <b>Anomali vs biasanya</b> membandingkan tiap desa dengan bulan yang sama 2013–2025: merah = lebih kering dari biasanya." : ""}`,
      target: q(".layers"),
    },
    {
      title: "Garis waktu",
      body: `Enam bulan terakhir; tinggi batang = ha padi tercekam kuat–ekstrem. Peta bulan berjalan memakai citra terakhir, jadi selalu tertinggal dari hari ini: kotak <b>Hari ini</b> menunjukkan umur citra itu${forecast ? "" : " dan kembali ke bulan berjalan bila diklik"}. ▶ memutar urutan bulan; tombol panah ← → juga bisa.`,
      target: q("#timeline"),
    },
    ...(forecast ? [{
      title: "Prakiraan 14 hari",
      body: "<b>Hari ini · model</b>, <b>+7h</b>, dan <b>+14h</b> adalah prakiraan pembelajaran mesin (dilatih pada citra Landsat sejak 2013 dan hujan harian): citra terakhir diproyeksikan ke depan dengan hujan teramati dan prakiraan. Peta dan peringkat berganti ke status prakiraan, ditandai <b>PRAKIRAAN</b> dan arsiran. Klik bulan mana pun untuk kembali ke data teramati.",
      target: () => [document.querySelector("#timeline .tl-now"), document.querySelector("#timeline .tl-fc")],
    }] : []),
    {
      title: "Ringkasan dan kesegaran data",
      body: `Luas padi aktif, luas tercekam, sawah yang tidak dihitung aktif (bera, panen, perlu cek), dan jumlah kecamatan per status: <b>Normal, Waspada, Siaga, Awas</b>. Titik hijau / kuning / merah di kanan menunjukkan umur citra, data hujan${forecast ? ", dan prakiraan model" : ""}${verification ? "; klik untuk halaman <b>Verifikasi</b>: semua uji metode, model, dan laporan, termasuk yang belum lolos" : ""}.`,
      target: () => [document.querySelector("#summary"), document.querySelector("#fresh")],
    },
    {
      title: "Prioritas tindakan",
      body: "Kecamatan diurutkan menurut ha padi berisiko (cekaman × kerentanan fase tumbuh), diredam oleh pangsa sawah irigasi. Tanda ⚠ = lahan yang turun seperti panen atau tidak pernah hijau: bisa puso atau gagal tanam, perlu cek lapangan.",
      target: q("#rank"),
    },
    {
      title: `Detail kecamatan: ${top ? esc(top.name) : ""}`,
      body: "Status peta dan alasannya, tren NDDI, hujan per dasarian, kapasitas air, sawah yang perlu verifikasi, dan rekomendasi untuk penyuluh. <b>Uji skenario</b> menunjukkan apa yang terjadi bila hujan berhenti sama sekali: uji tekanan, bukan prakiraan.",
      target: q("#detail"),
      before: openTop,
    },
    {
      title: "Dampak dan opsi tindakan",
      body: "Ha berisiko diterjemahkan menjadi <b>produksi terancam</b> (ton GKG) dan <b>nilai rupiah</b>, selalu sebagai rentang: produktivitas BPS Pati 2024 × harga HPP–pasar. Di bawahnya opsi tindakan dengan sasaran dan perkiraan efeknya: pompanisasi untuk sawah tadah hujan (jumlah pompa), gilir air untuk sawah irigasi, tunda tanam untuk lahan yang belum ditanam.",
      target: section("#detail .imp-kpi"),
      before: openTop,
    },
    ...(forecast ? [{
      title: "Kartu prakiraan dan tinjauan Dinas",
      body: "Per langkah: status prakiraan, kisaran P10–P90 (batang), dan keyakinan. <span class='tag model'>Model</span> dibandingkan dengan <span class='tag rule'>Aturan</span> (status peta), lalu tiga alasan utama. Dinas memilih <b>Terima</b> atau <b>Tolak</b>; pesan ke Gapoktan hanya memuat prakiraan bila keyakinannya tinggi atau sudah diterima. <b>Tentang model</b> menjelaskan data, hasil uji, dan batasannya.",
      target: section("#detail .fc-rows"),
      before: openTop,
    }] : []),
    {
      title: "Alur tindakan",
      body: "Penyuluh <b>mengusulkan</b>, Dinas <b>menyetujui</b>, penyuluh <b>mengirim</b> pesan WhatsApp ke Gapoktan dan menandai <b>selesai</b>. Setiap langkah dicatat dengan nama, peran, dan waktu.",
      target: section("#detail .stepper"),
      before: openTop,
    },
    {
      title: "Dasbor Dinas",
      body: "Ringkasan kabupaten untuk Dinas Pertanian: luas tercekam, kecamatan per status, nilai produksi terancam, tindakan yang menunggu persetujuan, dan prakiraan. Daftar <b>Perlu perhatian</b> menunjukkan pemilik tiap kasus, berapa lama menunggu, dan langkah berikutnya; usulan yang menunggu Dinas berada paling atas.",
      target: q("#cockpit-btn"),
    },
    {
      title: "Laporan lapangan dan identitas",
      body: "Hasil cek lapangan (sesuai, bukan padi, sudah panen, puso, gagal tanam) dibandingkan dengan peta dan mengoreksi masker padi pada pembaruan data berikutnya. Masuk sebagai penyuluh atau Dinas lewat tombol kanan atas; <b>Pemandu</b> membuka tur ini lagi.",
      target: () => [document.querySelector("#d-fb")?.closest("section") ?? null],
      before: openTop,
    },
  ];
}
