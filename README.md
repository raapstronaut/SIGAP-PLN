# SIGAP PLN

**SIGAP (Sistem Informasi Gangguan Akibat Perhewanan)** adalah dashboard berbasis Google Apps Script untuk membantu monitoring gangguan jaringan distribusi.

## Status repository

Repository ini **public untuk source code**, sedangkan **data operasional tetap private/internal** dan tidak disimpan di GitHub.

### Yang dipublikasikan

- `code.gs` — backend Google Apps Script dan akses data runtime.
- `index.html` — antarmuka dashboard.
- `ml_dashboard.gs` — logika analisis/ML dashboard.
- `ml_action_alert.gs` — logika alert dan tindak lanjut.

### Yang tidak dipublikasikan

- Spreadsheet operasional (`DASHBOARD.xlsx` / Google Spreadsheet produksi).
- Riwayat gangguan dan data aset aktual.
- Data section, keypoint, koordinat, vegetasi, dan data lapangan mentah.
- Username, password, alamat email penerima, credential, token, atau konfigurasi rahasia lainnya.

## Arsitektur singkat

```text
GitHub (PUBLIC)
  └─ source code
        │
        │ runtime
        ▼
Google Apps Script
        │
        ▼
Google Spreadsheet (PRIVATE / INTERNAL)
  ├─ data gangguan
  ├─ master aset
  ├─ master section / keypoint
  ├─ data posko
  ├─ user / akses
  └─ data operasional lainnya
```

## Catatan keamanan

Repository public ini tidak dimaksudkan sebagai tempat penyimpanan data operasional. Jangan commit file spreadsheet produksi, export CSV, credential, token, atau konfigurasi privat. File `.gitignore` disediakan sebagai perlindungan tambahan, tetapi pemeriksaan manual sebelum commit tetap diperlukan.

Versi aplikasi saat ini masih menggunakan autentikasi berbasis sheet `USERS`, dengan password yang dibandingkan di backend dan sesi frontend yang disimpan di browser. Mekanisme tersebut merupakan bagian dari rancangan aplikasi saat ini dan **bukan tempat untuk menyimpan credential produksi di repository**. Untuk deployment yang lebih sensitif, autentikasi sebaiknya diperkuat sebelum digunakan sebagai kontrol keamanan utama.

## Teknologi

- Google Apps Script
- HTML / CSS / JavaScript
- Chart.js
- Leaflet
- Google Spreadsheet

## Disclaimer

Repository ini merupakan source code aplikasi. Data dan konfigurasi lingkungan produksi dikelola secara terpisah dan tidak termasuk dalam repository public.
