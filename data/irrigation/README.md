# Data irigasi Pati (lapisan kapasitas)

Sumber: Dinas Pertanian Kab. Pati via opendata.patikab.go.id (CC-BY).

- `sawah_irigasi_2022_per_kecamatan.csv`: total luas sawah irigasi per kecamatan, 2022
  (diekstrak dari PDF; hanya kolom Jumlah yang dipakai karena perataan kolom
  rincian "ditanami padi 1x/2x/3x" rusak saat ekstraksi). Sementara, sebagai pembanding.
- `luas-penggunaan-lahan-sawah-{irigasi,tadah-hujan}-...-2024.xlsx`: tabel resmi 2024
  (diunduh pengguna lewat browser; portal menolak unduhan otomatis). Rincian per
  kecamatan: ditanami padi 1x / 2x / >= 3x, tanaman lain, tidak ditanami.
- `irigasi_2024_per_kecamatan.csv`: hasil `python pipeline/irrigation.py` dari kedua
  XLSX (nama kecamatan dinormalkan, mis. "Gunungwungkal" = "Gunung Wungkal").
  Jumlah dicek sama dengan baris "Jumlah 2024" (35.408,3 ha irigasi; 21.976,2 ha
  tadah hujan). Dipakai pipeline sebagai lapisan kapasitas.
