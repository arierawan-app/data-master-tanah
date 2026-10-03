# Data Master Tanah

Aplikasi web untuk menelusuri atribut data tanah (sheet `dps` dari
`mstrasset_011026.xlsx`, 3.609 baris x 15 kolom). Baris yang lengkap pada 5
kolom terakhir dibuang saat ekspor, jadi aplikasi hanya memuat baris yang
bermasalah. Tampil seperti Excel: filter tiap kolom, urut, pencarian cepat, dan
tanda selesai per baris yang tersinkron antar pengguna.

**Alamat aplikasi:** https://arierawan-app.github.io/data-master-tanah/

## Fitur

- Tiga kartu ringkasan: total baris, jumlah baris ditandai, dan persentase capaian.
- Filter per kolom gaya Excel: cari nilai, pilih beberapa nilai, atau "mengandung teks".
- Pagination 50 baris per halaman, plus pencarian cepat di seluruh kolom.
- Klik judul kolom untuk mengurutkan (angka, tanggal `dd/mm/yyyy`, dan teks).
- Lebar kolom bisa diubah: tarik tepi kanan judul kolom, klik dua kali untuk
  kembali ke lebar awal, atau fokuskan pegangan lalu pakai tombol panah.
  Lebar tersimpan di browser dan kolom beku ikut menyesuaikan.
- Kolom terakhir berisi kotak centang; baris yang ditandai berwarna hijau.
- Kotak centang di kepala kolom tanda menandai semua baris yang sedang tampil
  di halaman aktif.
- Lima kartu ringkasan untuk 5 kolom terakhir: jumlah baris yang kosong/`0`/
  `0,0` pada hasil filter yang sedang aktif — dihitung dari seluruh baris hasil,
  bukan hanya halaman yang tampil. Klik satu atau beberapa kartu untuk menyaring
  baris; beberapa kartu digabung dengan AND. "Reset filter" ikut membersihkan
  pilihan kartu.
- Halaman pivot sederhana (`pivot.html`, tombol "Pivot" di header): tabel
  pivot dengan kolom tetap No, `kode_satker`, dan `nama_satker`; ukuran (jumlah
  baris, Σ luas, hitung kosong/`0` untuk 5 kolom terakhir), saring baris dengan
  pencarian, urutkan tiap kolom, tanpa pagination, dan export hasil pivot ke
  Excel/CSV. Pengaturan tersimpan di browser (`dmt.pivot.v1`).
- Tombol "Hanya ditandai" (di sebelah Export) menyaring tabel sehingga hanya
  baris yang sudah ditandai yang tampil; bisa digabung dengan filter kolom dan
  pencarian cepat, dan ikut dibersihkan oleh "Reset filter".
- Export baris yang ditandai ke Excel (.xlsx) atau CSV.
- Tanda tersimpan di Supabase sehingga semua pengguna melihat tanda yang sama
  (pembaruan realtime). Bila koneksi gagal, tanda disimpan di browser dan
  dikirim ulang otomatis saat online. Aplikasi hanya menambah/mengubah tanda —
  tidak pernah menghapus.

## Menjalankan secara lokal

```bash
python3 -m http.server 8000
# buka http://localhost:8000
```

Tidak ada proses build; seluruh berkas statis.

## Tampilan kolom

- Kolom `kode_satker` sampai `luas` (kolom J) dibekukan (sticky) sehingga tetap
  terlihat saat tabel digeser ke kanan.
- Lebar kolom diatur pengguna dan disimpan di `localStorage`
  (`dmt.widths.v1`); semua kolom memakai lebar awal dari `DEFAULT_WIDTHS` yang
  ringkas agar kolom K–O tetap terlihat, dan teks yang terpotong menampilkan
  tooltip. Tarikan lebar presisi 1:1 di semua ukuran layar: saat mulai
  menyesuaikan, lebar tampilan tiap kolom dibekukan dan tabel mengikuti jumlah
  lebar kolom. Tabel memakai lebar penuh layar bila ruang mencukupi dan dapat
  digeser horizontal (scrollbar selalu tampil) bila tidak.
- Pengaturan ada di `app.js`: `FROZEN_COLUMNS` (kolom beku) dan
  `HIDDEN_COLUMNS` (kolom yang disembunyikan). Di layar sempit (<= 1100px)
  pembekuan horizontal otomatis dinonaktifkan; ubah lebar kolom tetap bisa.

## Memperbarui data

Jalankan ulang ekspor dari workbook sumber, lalu commit `data.json`:

```bash
python3 tools/export_data.py "/path/ke/mstrasset_011026.xlsx"
git add data.json && git commit -m "Perbarui data" && git push
```

Setiap baris memiliki `_id` stabil (hash dari satker, id aset, id aset bidang,
kode barang, NUP, luas, dan alamat bidang), sehingga tanda tetap terkait dengan
baris yang sama ketika data diekspor ulang. Ekspor membuang baris yang lengkap
pada 5 kolom terakhir (tidak ada blank, `0`, maupun `0,0`).

## Catatan teknis

- Situs statis di GitHub Pages (`index.html`, `styles.css`, `app.js`).
- Setiap kali mengubah `styles.css` atau `app.js`, naikkan versi di tiga tempat:
  `APP_VERSION` di `app.js`, query `?v=` di `index.html`, dan `version.json`.
  Aplikasi memeriksa `version.json` dan memuat ulang sendiri saat ada versi
  baru, sehingga pengguna tidak perlu hard-refresh.
- `data.json` dihasilkan oleh `tools/export_data.py` (butuh `openpyxl`).
- `config.js` memuat URL dan publishable key Supabase; kunci ini memang untuk
  dipakai di sisi klien dan dibatasi oleh row level security tabel `ticks`.
- Paket CDN: supabase-js v2 (jsDelivr), SheetJS 0.20.3 (untuk export xlsx),
  Google Fonts (Public Sans). Bila supabase-js gagal dimuat, aplikasi tetap
  berjalan dengan penyimpanan lokal browser.
