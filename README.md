# Data Master Tanah

Aplikasi web untuk menelusuri rekap berkas tanah dengan dokumen tidak lengkap
(sheet `tot_tdk_lengkap`, 2.791 baris x 27 kolom). Tampil seperti Excel: filter
tiap kolom, urut, pencarian cepat, dan tanda selesai per baris yang tersinkron
antar pengguna.

**Alamat aplikasi:** https://arierawan-app.github.io/data-master-tanah/

## Fitur

- Tiga kartu ringkasan: total baris, jumlah baris ditandai, dan persentase capaian.
- Filter per kolom gaya Excel: cari nilai, pilih beberapa nilai, atau "mengandung teks".
- Pagination 50 baris per halaman, plus pencarian cepat di seluruh kolom.
- Klik judul kolom untuk mengurutkan (angka, tanggal `dd/mm/yyyy`, dan teks).
- Kolom terakhir berisi kotak centang; baris yang ditandai berwarna hijau.
- Kotak centang di kepala kolom menandai semua baris pada halaman aktif.
- Export baris yang ditandai ke Excel (.xlsx) atau CSV.
- Tanda tersimpan di Supabase sehingga semua pengguna melihat tanda yang sama
  (pembaruan realtime). Bila koneksi gagal, tanda disimpan di browser dan
  dikirim ulang otomatis saat online.

## Menjalankan secara lokal

```bash
python3 -m http.server 8000
# buka http://localhost:8000
```

Tidak ada proses build; seluruh berkas statis.

## Memperbarui data

Jalankan ulang ekspor dari workbook sumber, lalu commit `data.json`:

```bash
python3 tools/export_data.py "/path/ke/rekap_tdk_lengkap.xlsx"
git add data.json && git commit -m "Perbarui data" && git push
```

Setiap baris memiliki `_id` stabil (hash dari satker, kode barang, no aset,
uraian, luas bidang, dan alamat aset), sehingga tanda tetap terkait dengan
baris yang sama ketika data diekspor ulang.

## Catatan teknis

- Situs statis di GitHub Pages (`index.html`, `styles.css`, `app.js`).
- `data.json` dihasilkan oleh `tools/export_data.py` (butuh `openpyxl`).
- `config.js` memuat URL dan publishable key Supabase; kunci ini memang untuk
  dipakai di sisi klien dan dibatasi oleh row level security tabel `ticks`.
- Paket CDN: supabase-js v2 (jsDelivr), SheetJS 0.20.3 (untuk export xlsx),
  Google Fonts (Public Sans). Bila supabase-js gagal dimuat, aplikasi tetap
  berjalan dengan penyimpanan lokal browser.
