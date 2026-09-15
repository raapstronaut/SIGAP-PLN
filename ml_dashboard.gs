/**
 * =====================================================================
 * ML ENGINE V2.5 - DASHBOARD PLN ULP SRIBHAWONO
 * =====================================================================
 * Filosofi diadaptasi dari ML SIGAP, lalu digeneralisasi ke SEMUA penyebab.
 * Fokus perbaikan V2:
 * 1) dataset full-grid, termasuk bulan 0 gangguan;
 * 2) training walk-forward (tidak melihat masa depan);
 * 3) fitur 3 bulan benar: bulan analisis + 1 dan 2 bulan sebelumnya;
 * 4) KWh/durasi 3 bulan, baseline as-of;
 * 5) penyebab dimodelkan sebagai MULTI-LABEL RISK per kategori, bukan dipaksa satu kelas;
 * 6) prediksi waktu mengikuti weighted-KNN ala SIGAP;
 * 7) alat penahan dan vegetasi dibaca AS-OF periode analisis;
 * 8) ranking aset CAUSE-AWARE (PETIR != BINATANG != ROW-POHON, dst.);
 * 9) rekomendasi WO dipilih berdasarkan bukti aset, bukan menempelkan rule
 *    yang sama ke ranking aset universal;
 * 10) endpoint membaca sheet hasil rebuild, jadi modal tidak melatih ulang model.
 *
 * FILE INI menggantikan ml_dashboard.gs / ml_dashboard_cached.gs.
 * code.gs tidak perlu diganti. Tambahkan ml_action_alert_v1.gs dan gunakan index.html V20.
 * V2.5.1 tidak mengubah model/angka prediksi; hanya menambahkan ACTION MEMORY.
 * =====================================================================
 */

const MLD_VERSION = 'V2.5-BALANCED-ACTION-WATCH';
const ML_SHEET_DATASET_OUT  = 'Dataset_ML_Dashboard';
const ML_SHEET_PREDIKSI_OUT = 'Prediksi_ML_Dashboard';
const ML_SHEET_TINDAK_LANJUT = 'TINDAK_LANJUT';

const MLD_CACHE_TTL_SECONDS = 1800;
const MLD_CACHE_VERSION_PROPERTY = 'MLD_CACHE_VERSION';

const ML_KATEGORI_PENYEBAB = [
  'BINATANG', 'PETIR', 'ROW-POHON', 'MATERIAL', 'KONDUKTOR',
  'LAYANG-LAYANG', 'EKSTERNAL', 'JOINTING/SIKUAN', 'KONSTRUKSI',
  'TIDAK DITEMUKAN', 'LAIN LAIN'
];

const ML_CONFIG = {
  MIN_TRAINING_TOTAL: 20,
  RIDGE_LAMBDA: 60,
  KNN_K_MAX: 18,
  // V2.5: raw multi-cause risk tetap sama seperti V2.3. Yang dikalibrasi adalah
  // keputusan operasionalnya dengan aturan RELATIF terhadap risk utama, bukan
  // threshold berbeda-beda yang mudah overfit pada cause dengan sampel sedikit.
  CAUSE_RISK_KNN_WEIGHT: 0.46,
  CAUSE_RISK_RECENT_WEIGHT: 0.30,
  CAUSE_RISK_HISTORY_WEIGHT: 0.16,
  CAUSE_RISK_BASE_WEIGHT: 0.08,
  CAUSE_RISK_PRIOR_STRENGTH: 2.5,

  // ACTION = cukup kuat untuk menghasilkan WO.
  CAUSE_ACTION_PRIMARY_MIN_RISK: 0.20,
  CAUSE_ACTION_PRIMARY_HIST_SHARE: 0.10,
  CAUSE_ACTION_PRIMARY_LIFT: 0.05,
  CAUSE_ACTION_SECONDARY_MIN_RISK: 0.05,
  CAUSE_ACTION_SECONDARY_RATIO: 0.60,
  CAUSE_ACTION_MAX_ACTIVE: 2,

  // PANTAU = sinyal model nyata, tetapi belum cukup untuk WO spesifik.
  // Secondary harus cukup dekat dengan primary; tertiary harus punya bukti lokal 3 bulan.
  CAUSE_WATCH_SECONDARY_MIN_RISK: 0.05,
  CAUSE_WATCH_SECONDARY_RATIO: 0.60,
  CAUSE_WATCH_TERTIARY_MIN_RISK: 0.05,
  CAUSE_WATCH_TERTIARY_RATIO: 0.30,
  CAUSE_WATCH_MAX_TOTAL: 3,
  MAX_REKOMENDASI: 4,
  ASSET_MIN_SAMPLES: 30,
  ASSET_MIN_POSITIVES: 4,
  ASSET_LOGISTIC_LAMBDA: 0.10,
  ASSET_LOGISTIC_LR: 0.07,
  ASSET_LOGISTIC_EPOCHS: 100
};

// ---------------------------------------------------------------------
// V2.5 BALANCED ACTION / WATCH DECISION
// ---------------------------------------------------------------------
// Kalibrasi ini dipilih dari backtest walk-forward 112 periode target pada data
// Dashboard saat ini. Prinsipnya sederhana dan stabil:
// - raw risk TIDAK diubah/diakali supaya distribusi terlihat beragam;
// - ACTION memakai risk relatif + bukti model/lokal, maksimal 2 cause;
// - PANTAU menahan sinyal sekunder/tersier agar tidak hilang, tanpa otomatis membuat WO.
function mld_applyCauseDecision_(risks) {
  const rows=(risks||[]).slice().sort((a,b)=>b.risk-a.risk);
  rows.forEach(r=>{
    r.active=false; r.watch=false; r.status='RENDAH';
    r.lift=Number(r.knnProbability||0)-Number(r.basePrevalence||0);
  });
  if(!rows.length) return {active:[],watch:[],detected:[]};

  const primary=rows[0];
  const primaryEvidence = Number(primary.recentCount3||0)>0 ||
    Number(primary.historicalShare||0)>=ML_CONFIG.CAUSE_ACTION_PRIMARY_HIST_SHARE ||
    Number(primary.lift||0)>=ML_CONFIG.CAUSE_ACTION_PRIMARY_LIFT ||
    Number(primary.basePrevalence||0)>=0.30;
  if(Number(primary.risk||0)>=ML_CONFIG.CAUSE_ACTION_PRIMARY_MIN_RISK && primaryEvidence){
    primary.active=true; primary.status='AKTIF'; primary.evidenceOk=true;
  } else if(Number(primary.risk||0)>=ML_CONFIG.CAUSE_WATCH_SECONDARY_MIN_RISK){
    primary.watch=true; primary.status='PANTAU'; primary.evidenceOk=primaryEvidence;
  }

  if(rows.length>1){
    const r=rows[1];
    const closeEnough=Number(r.risk||0)>=ML_CONFIG.CAUSE_ACTION_SECONDARY_MIN_RISK &&
      Number(r.risk||0)>=ML_CONFIG.CAUSE_ACTION_SECONDARY_RATIO*Math.max(1e-9,Number(primary.risk||0));
    const modelNotBelowBaseline=Number(r.lift||0)>=0;
    if(closeEnough && modelNotBelowBaseline){
      r.active=true; r.status='AKTIF'; r.evidenceOk=true;
    } else if(Number(r.risk||0)>=ML_CONFIG.CAUSE_WATCH_SECONDARY_MIN_RISK &&
      Number(r.risk||0)>=ML_CONFIG.CAUSE_WATCH_SECONDARY_RATIO*Math.max(1e-9,Number(primary.risk||0))){
      r.watch=true; r.status='PANTAU'; r.evidenceOk=Number(r.recentCount3||0)>0 || modelNotBelowBaseline;
    }
  }

  if(rows.length>2){
    const r=rows[2];
    const watchOk=Number(r.risk||0)>=ML_CONFIG.CAUSE_WATCH_TERTIARY_MIN_RISK &&
      Number(r.risk||0)>=ML_CONFIG.CAUSE_WATCH_TERTIARY_RATIO*Math.max(1e-9,Number(primary.risk||0)) &&
      Number(r.recentCount3||0)>0;
    if(watchOk){r.watch=true;r.status='PANTAU';r.evidenceOk=true;}
  }

  // Maksimum dua ACTION. Kalau lebih, sisanya turun menjadi PANTAU supaya tidak
  // membuat terlalu banyak WO dalam satu penyulang/periode.
  const activeAll=rows.filter(r=>r.active);
  activeAll.slice(ML_CONFIG.CAUSE_ACTION_MAX_ACTIVE).forEach(r=>{
    r.active=false;r.watch=true;r.status='PANTAU';
  });

  let active=rows.filter(r=>r.active).slice(0,ML_CONFIG.CAUSE_ACTION_MAX_ACTIVE);
  let watch=rows.filter(r=>r.watch && !r.active);
  const detected=[];
  rows.forEach(r=>{if(r.active||r.watch)detected.push(r);});
  // Maksimum total 3 cause yang ditonjolkan (ACTION + PANTAU).
  const allowed=new Set(detected.slice(0,ML_CONFIG.CAUSE_WATCH_MAX_TOTAL).map(r=>r.kategori));
  rows.forEach(r=>{
    if((r.active||r.watch) && !allowed.has(r.kategori)){
      r.active=false;r.watch=false;r.status='RENDAH';
    }
  });
  active=rows.filter(r=>r.active);
  watch=rows.filter(r=>r.watch && !r.active);
  return {active:active,watch:watch,detected:rows.filter(r=>r.active||r.watch)};
}

// Fitur penuh disimpan di Dataset_ML_Dashboard.
const ML_FEATURE_NAMES = [
  'm0', 'm1', 'm2', 'avg3', 'diff', 'pctChange', 'riskScore',
  'logKwh3', 'logDurasi3',
  ...ML_KATEGORI_PENYEBAB.map(k => 'kat_' + k + '_3BLN'),
  'titikBerulang3', 'sinBulan', 'cosBulan', 'baselineAsOf'
];

// Total gangguan sengaja memakai subset yang lebih kecil agar pooled Ridge
// tidak overfit pada histori 8 bulan. Cause-count tetap dipakai KNN penyebab.
const MLD_TOTAL_FEATURE_INDEXES = [0, 1, 2, 4, 5, 23, 21, 22];

// =====================================================================
// 0. CACHE + UTIL DASAR
// =====================================================================
function mld_getCacheVersion_() {
  return PropertiesService.getScriptProperties().getProperty(MLD_CACHE_VERSION_PROPERTY) || '0';
}
function mld_bumpCacheVersion_() {
  const version = String(Date.now());
  PropertiesService.getScriptProperties().setProperty(MLD_CACHE_VERSION_PROPERTY, version);
  return version;
}
function mld_resultCacheKey_(feederName, options) {
  const feeder = mld_norm_(feederName);
  const tahun = options && options.tahun ? String(options.tahun) : 'LATEST';
  const bulan = options && options.bulan ? String(options.bulan) : 'LATEST';
  return ['MLD2', mld_getCacheVersion_(), feeder, tahun, bulan].join(':').slice(0, 240);
}
function mld_text_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}
function mld_norm_(value) {
  return mld_text_(value).toUpperCase();
}
function mld_num_(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}
function mld_clamp_(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}
function mld_parseTanggal_(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
function mld_monthIndex_(date, baseYear) {
  return (date.getFullYear() - baseYear) * 12 + date.getMonth();
}
function mld_monthKeyFromIndex_(baseYear, monthIndex) {
  const d = new Date(baseYear, monthIndex, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function mld_normalizeCause_(value) {
  let c = mld_norm_(value);
  if (!c || c === '-' || c === 'N/A' || c === 'NA') return 'TIDAK DITEMUKAN';
  c = c.replace(/\s+/g, ' ');
  if (c === 'LAIN-LAIN' || c === 'LAINNYA') return 'LAIN LAIN';
  if (c === 'ROW POHON' || c === 'ROW/POHON' || c === 'POHON' || c === 'VEGETASI') return 'ROW-POHON';
  if (c === 'JOINTING' || c === 'SIKUAN' || c === 'JOINTING SIKUAN') return 'JOINTING/SIKUAN';
  if (c === 'TIDAK DIKETAHUI' || c === 'TIDAK DITEMUKAN PENYEBAB') return 'TIDAK DITEMUKAN';
  return ML_KATEGORI_PENYEBAB.includes(c) ? c : 'LAIN LAIN';
}
function mld_addCount_(map, key, amount) {
  if (!key) return;
  map[key] = (map[key] || 0) + (amount === undefined ? 1 : amount);
}
function mld_hash_(value) {
  const text = mld_text_(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
}
function mld_isValidCoord_(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
}
function mld_parseOptionsMonthIndex_(ctx, options) {
  if (!options || !options.bulan || !options.tahun) return ctx.maxMonthIndex;
  const namaBulan = ['JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI','JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER'];
  let bulan0 = namaBulan.indexOf(mld_norm_(options.bulan));
  if (bulan0 < 0) {
    const n = parseInt(options.bulan, 10);
    if (n >= 1 && n <= 12) bulan0 = n - 1;
  }
  if (bulan0 < 0) return ctx.maxMonthIndex;
  return mld_monthIndex_(new Date(Number(options.tahun), bulan0, 1), ctx.baseYear);
}

// =====================================================================
// 1. CONTEXT BUILDER - SEMUA DATA DIUBAH KE BENTUK AS-OF
// =====================================================================
function mld_getTindakLanjut_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ML_SHEET_TINDAK_LANJUT);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => mld_norm_(h));
  const col = getColumnMap_(headers);
  if (col.ID_GANGGUAN === undefined || col.STATUS_TL === undefined) return [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const id = mld_text_(values[i][col.ID_GANGGUAN]);
    if (!id) continue;
    rows.push({
      idGangguan: id,
      statusTL: mld_norm_(values[i][col.STATUS_TL]),
      updatedAt: col.UPDATED_AT !== undefined ? values[i][col.UPDATED_AT] : null
    });
  }
  return rows;
}

function mld_buildContext_() {
  const gangguanRaw = getDashboardData();
  const asetRaw = getMasterAset_();
  const pohonRaw = getMasterPohon_();
  const alatRaw = typeof getAlatPenahan_ === 'function' ? getAlatPenahan_() : [];
  const tlRaw = mld_getTindakLanjut_();

  const gangguan = gangguanRaw.map((g, idx) => {
    const tanggal = mld_parseTanggal_(g.tanggal);
    return {
      rowIndex: idx,
      idGangguan: mld_text_(g.idGangguan),
      penyulang: mld_norm_(g.penyulang),
      idAset: mld_norm_(g.idAset),
      namaAset: mld_text_(g.peralatan),
      penyebab: mld_normalizeCause_(g.penyebab),
      tanggal: tanggal,
      jam: tanggal ? tanggal.getHours() : null,
      kwh: mld_num_(g.ens),
      durasi: mld_num_(g.lamaPadam),
      latitude: g.latitude,
      longitude: g.longitude,
      statusTL: mld_norm_(g.statusTL)
    };
  }).filter(g => g.penyulang && g.tanggal);

  if (!gangguan.length) throw new Error('Tidak ada data gangguan valid di DB_DASHBOARD.');

  let minDate = gangguan[0].tanggal;
  let maxDate = gangguan[0].tanggal;
  gangguan.forEach(g => {
    if (g.tanggal < minDate) minDate = g.tanggal;
    if (g.tanggal > maxDate) maxDate = g.tanggal;
  });
  const baseYear = minDate.getFullYear();
  const minMonthIndex = mld_monthIndex_(new Date(minDate.getFullYear(), minDate.getMonth(), 1), baseYear);
  const maxMonthIndex = mld_monthIndex_(new Date(maxDate.getFullYear(), maxDate.getMonth(), 1), baseYear);

  const riskCube = {};
  const assetMonthCube = {};
  const feederEventAssets = {};
  const timeSamples = [];

  function ensureCell(feeder, mi) {
    if (!riskCube[feeder]) riskCube[feeder] = {};
    if (!riskCube[feeder][mi]) {
      riskCube[feeder][mi] = {
        total: 0, perKategori: {}, jamList: [], kwhSum: 0, durasiSum: 0, asetList: {}, asetPerKategori: {}
      };
    }
    return riskCube[feeder][mi];
  }

  gangguan.forEach(g => {
    const mi = mld_monthIndex_(g.tanggal, baseYear);
    const cell = ensureCell(g.penyulang, mi);
    cell.total++;
    mld_addCount_(cell.perKategori, g.penyebab, 1);
    if (g.jam !== null) cell.jamList.push(g.jam);
    cell.kwhSum += g.kwh;
    cell.durasiSum += g.durasi;
    if (g.idAset) {
      mld_addCount_(cell.asetList, g.idAset, 1);
      if (!cell.asetPerKategori[g.penyebab]) cell.asetPerKategori[g.penyebab] = {};
      mld_addCount_(cell.asetPerKategori[g.penyebab], g.idAset, 1);

      if (!assetMonthCube[g.idAset]) assetMonthCube[g.idAset] = {};
      if (!assetMonthCube[g.idAset][mi]) assetMonthCube[g.idAset][mi] = { total: 0, perKategori: {} };
      assetMonthCube[g.idAset][mi].total++;
      mld_addCount_(assetMonthCube[g.idAset][mi].perKategori, g.penyebab, 1);
    }
    if (g.jam !== null) {
      timeSamples.push({
        feeder: g.penyulang,
        cause: g.penyebab,
        period: mi,
        month: ((mi % 12) + 12) % 12 + 1,
        zona: g.jam >= 6 && g.jam < 18 ? 'SIANG' : 'MALAM'
      });
    }
  });

  const assetById = {};
  const asetPerPenyulang = {};
  asetRaw.forEach(a => {
    const id = mld_norm_(a.idAset);
    const feeder = mld_norm_(a.penyulang);
    if (!id || !feeder) return;
    const obj = {
      idAset: id,
      namaAset: mld_text_(a.namaAset) || id,
      jenisAset: mld_norm_(a.jenisAset),
      penyulang: feeder,
      latitude: a.latitude,
      longitude: a.longitude,
      status: mld_norm_(a.status)
    };
    assetById[id] = obj;
    if (!asetPerPenyulang[feeder]) asetPerPenyulang[feeder] = [];
    asetPerPenyulang[feeder].push(id);
  });

  const treeHistoryByAsset = {};
  pohonRaw.forEach((p, idx) => {
    const id = mld_norm_(p.idAset);
    if (!id) return;
    const d = mld_parseTanggal_(p.tanggalSurvey);
    const period = d ? mld_monthIndex_(d, baseYear) : null;
    if (!treeHistoryByAsset[id]) treeHistoryByAsset[id] = [];
    treeHistoryByAsset[id].push({
      idPohon: mld_text_(p.idPohon),
      period: period,
      rowIndex: idx,
      jenis: mld_norm_(p.jenisPohon),
      jarak: p.jarakPohon,
      kondisi: mld_norm_(p.kondisi),
      status: mld_norm_(p.status)
    });
  });

  const toolHistoryByAsset = {};
  alatRaw.forEach((a, idx) => {
    const id = mld_norm_(a.idAset);
    if (!id) return;
    const d = mld_parseTanggal_(a.tanggal);
    const period = d ? mld_monthIndex_(d, baseYear) : null;
    if (!toolHistoryByAsset[id]) toolHistoryByAsset[id] = [];
    toolHistoryByAsset[id].push({
      period: period,
      dateMs: d ? d.getTime() : 0,
      rowIndex: idx,
      count: Math.max(0, mld_num_(a.terpasangBh)),
      statusPekerjaan: mld_norm_(a.statusPekerjaan),
      statusData: mld_norm_(a.statusData)
    });
  });
  Object.keys(toolHistoryByAsset).forEach(id => {
    toolHistoryByAsset[id].sort((a,b) => (a.dateMs - b.dateMs) || (a.rowIndex - b.rowIndex));
  });

  const tlByIdGangguan = {};
  tlRaw.forEach(t => { tlByIdGangguan[t.idGangguan] = t.statusTL; });

  const penyulangSet = {};
  gangguan.forEach(g => { penyulangSet[g.penyulang] = true; });
  Object.keys(asetPerPenyulang).forEach(f => { penyulangSet[f] = true; });
  const penyulangList = Object.keys(penyulangSet).sort();

  return {
    baseYear,
    minMonthIndex,
    maxMonthIndex,
    riskCube,
    gangguan,
    penyulangList,
    assetMonthCube,
    assetById,
    asetPerPenyulang,
    treeHistoryByAsset,
    toolHistoryByAsset,
    timeSamples,
    tlByIdGangguan
  };
}

function mld_getCell_(ctx, feeder, mi) {
  const c = ctx.riskCube[feeder] && ctx.riskCube[feeder][mi];
  return c || { total:0, perKategori:{}, jamList:[], kwhSum:0, durasiSum:0, asetList:{}, asetPerKategori:{} };
}
function mld_getAssetCell_(ctx, idAset, mi) {
  const c = ctx.assetMonthCube[idAset] && ctx.assetMonthCube[idAset][mi];
  return c || { total:0, perKategori:{} };
}
function mld_getAssetTotalAt_(ctx, idAset, mi) {
  return mld_getAssetCell_(ctx, idAset, mi).total || 0;
}
function mld_getAssetCauseAt_(ctx, idAset, cause, mi) {
  return (mld_getAssetCell_(ctx, idAset, mi).perKategori[cause] || 0);
}
function mld_getAssetCauseUpTo_(ctx, idAset, cause, mi) {
  let total = 0;
  const cube = ctx.assetMonthCube[idAset] || {};
  Object.keys(cube).forEach(k => {
    if (Number(k) <= mi) total += cube[k].perKategori[cause] || 0;
  });
  return total;
}
function mld_treeProfileAsOf_(ctx, idAset, mi) {
  const rows = ctx.treeHistoryByAsset[idAset] || [];
  const usable = rows.filter(r => r.period !== null ? r.period <= mi : mi >= ctx.maxMonthIndex);
  const types = {};
  usable.forEach(r => mld_addCount_(types, r.jenis || 'LAINNYA', 1));
  const dominant = Object.keys(types).sort((a,b) => types[b] - types[a])[0] || '-';
  return { count: usable.length, dominant: dominant };
}
function mld_toolProfileAsOf_(ctx, idAset, mi) {
  const rows = ctx.toolHistoryByAsset[idAset] || [];
  let latest = null;
  rows.forEach(r => {
    const usable = r.period !== null ? r.period <= mi : mi >= ctx.maxMonthIndex;
    if (usable) latest = r;
  });
  if (!latest) return { hasTool:false, count:0, status:'BELUM ADA' };
  const active = latest.count > 0 && ['SELESAI','KURANG'].includes(latest.statusPekerjaan) && latest.statusData !== 'BATAL';
  return { hasTool:active, count:active ? latest.count : 0, status:latest.statusPekerjaan || '-' };
}

// =====================================================================
// 2. FEEDER FEATURE - MENIRU STRUKTUR SIGAP, TAPI MULTI-CAUSE
// =====================================================================
function mld_feederBaselineAsOf_(ctx, feeder, mi) {
  if (mi < ctx.minMonthIndex) return 0;
  let sum = 0, n = 0;
  for (let p = ctx.minMonthIndex; p <= mi; p++) {
    sum += mld_getCell_(ctx, feeder, p).total;
    n++;
  }
  return n ? sum / n : 0;
}

function mld_buildFeatureVector_(ctx, feeder, mi) {
  const c0 = mld_getCell_(ctx, feeder, mi);
  const c1 = mld_getCell_(ctx, feeder, mi - 1);
  const c2 = mld_getCell_(ctx, feeder, mi - 2);
  const counts = [c0.total, c1.total, c2.total];
  const avg3 = (counts[0] + counts[1] + counts[2]) / 3;
  const diff = counts[0] - counts[1];
  let pct = counts[1] > 0 ? diff / counts[1] : (counts[0] > 0 ? 3 : 0);
  pct = mld_clamp_(pct, -3, 3);
  const riskScore = 0.5 * counts[0] + 0.3 * counts[1] + 0.2 * counts[2];

  let kwh3 = 0, durasi3 = 0;
  const cat3 = {};
  const aset3 = {};
  for (let offset = 0; offset < 3; offset++) {
    const c = mld_getCell_(ctx, feeder, mi - offset);
    kwh3 += c.kwhSum;
    durasi3 += c.durasiSum;
    Object.keys(c.perKategori).forEach(k => mld_addCount_(cat3, k, c.perKategori[k]));
    Object.keys(c.asetList).forEach(id => mld_addCount_(aset3, id, c.asetList[id]));
  }
  const repeated = Object.keys(aset3).filter(id => aset3[id] >= 2).length;
  const month0 = ((mi % 12) + 12) % 12;
  const angle = 2 * Math.PI * month0 / 12;

  return [
    counts[0], counts[1], counts[2], avg3, diff, pct, riskScore,
    Math.log1p(Math.max(0, kwh3)), Math.log1p(Math.max(0, durasi3)),
    ...ML_KATEGORI_PENYEBAB.map(k => cat3[k] || 0),
    repeated, Math.sin(angle), Math.cos(angle), mld_feederBaselineAsOf_(ctx, feeder, mi)
  ];
}

function mld_buildDatasetSamples_(ctx) {
  const samples = [];
  ctx.penyulangList.forEach(feeder => {
    for (let mi = ctx.minMonthIndex; mi <= ctx.maxMonthIndex; mi++) {
      const x = mld_buildFeatureVector_(ctx, feeder, mi);
      const targetAvailable = mi < ctx.maxMonthIndex;
      const targetCell = targetAvailable ? mld_getCell_(ctx, feeder, mi + 1) : null;
      const targetCauseCounts = {};
      let targetCause = '';
      if (targetCell) {
        ML_KATEGORI_PENYEBAB.forEach(cause => {
          const n = Number(targetCell.perKategori[cause] || 0);
          if (n > 0) targetCauseCounts[cause] = n;
        });
        if (targetCell.total > 0) {
          const entries = Object.entries(targetCauseCounts).sort((a,b) => b[1] - a[1]);
          targetCause = entries.length ? entries[0][0] : '';
        }
      }
      samples.push({
        feeder: feeder,
        period: mi,
        targetPeriod: mi + 1,
        x: x,
        y: targetAvailable ? targetCell.total : null,
        targetCause: targetCause,
        targetCauseCounts: targetCauseCounts,
        // Multi-label memakai bulan target 0 gangguan sebagai negative sample
        // untuk SEMUA kategori, bukan membuang bulan tersebut.
        targetCauseAvailable: !!targetAvailable
      });
    }
  });
  return samples;
}

// =====================================================================
// 3. MATEMATIKA MODEL
// =====================================================================
function mld_meanStd_(matrix) {
  if (!matrix.length) return {means:[], stds:[]};
  const cols = matrix[0].length;
  const means = new Array(cols).fill(0);
  const stds = new Array(cols).fill(0);
  matrix.forEach(row => { for (let i=0;i<cols;i++) means[i] += row[i]; });
  for (let i=0;i<cols;i++) means[i] /= matrix.length;
  matrix.forEach(row => { for (let i=0;i<cols;i++){ const d=row[i]-means[i]; stds[i]+=d*d; } });
  for (let i=0;i<cols;i++){ stds[i]=Math.sqrt(stds[i]/matrix.length); if(stds[i]<1e-8) stds[i]=1; }
  return {means,stds};
}
function mld_standardizeRow_(row, means, stds) {
  return row.map((v,i) => (v-means[i])/stds[i]);
}
function mld_solveLinear_(matrix, vector) {
  const n = matrix.length;
  const aug = matrix.map((row,i) => row.slice().concat([vector[i]]));
  for (let col=0; col<n; col++) {
    let pivot=col;
    for(let r=col+1;r<n;r++) if(Math.abs(aug[r][col])>Math.abs(aug[pivot][col])) pivot=r;
    if(Math.abs(aug[pivot][col])<1e-10) aug[pivot][col]=1e-8;
    if(pivot!==col){ const t=aug[col]; aug[col]=aug[pivot]; aug[pivot]=t; }
    const div=aug[col][col];
    for(let j=col;j<=n;j++) aug[col][j]/=div;
    for(let r=0;r<n;r++){
      if(r===col) continue;
      const factor=aug[r][col];
      for(let j=col;j<=n;j++) aug[r][j]-=factor*aug[col][j];
    }
  }
  return aug.map(row => row[n]);
}
function mld_pick_(row, indexes) {
  return indexes.map(i => row[i]);
}

function mld_trainRidge_(trainingSamples) {
  const valid = (trainingSamples || []).filter(s => s.y !== null && isFinite(s.y));
  if (valid.length < ML_CONFIG.MIN_TRAINING_TOTAL) {
    return {trained:false, count:valid.length, name:'FALLBACK_TREN_DATA_TERBATAS', mae:0, rmse:0};
  }
  const rawX = valid.map(s => mld_pick_(s.x, MLD_TOTAL_FEATURE_INDEXES));
  const stats = mld_meanStd_(rawX);
  const X = rawX.map(row => [1].concat(mld_standardizeRow_(row, stats.means, stats.stds)));
  const y = valid.map(s => Math.log1p(Math.max(0,s.y)));
  const dim = X[0].length;
  const xtx = Array.from({length:dim},()=>new Array(dim).fill(0));
  const xty = new Array(dim).fill(0);
  X.forEach((row,ri)=>{
    for(let i=0;i<dim;i++){
      xty[i]+=row[i]*y[ri];
      for(let j=0;j<dim;j++) xtx[i][j]+=row[i]*row[j];
    }
  });
  for(let i=1;i<dim;i++) xtx[i][i]+=ML_CONFIG.RIDGE_LAMBDA;
  const beta=mld_solveLinear_(xtx,xty);
  const residuals=[];
  valid.forEach(s=>{
    const p=mld_predictRidge_({trained:true,means:stats.means,stds:stats.stds,beta:beta},s.x);
    residuals.push(s.y-p);
  });
  const mae=residuals.reduce((sum,v)=>sum+Math.abs(v),0)/residuals.length;
  const rmse=Math.sqrt(residuals.reduce((sum,v)=>sum+v*v,0)/residuals.length);
  return {trained:true,count:valid.length,name:'RIDGE_REGRESSION_POOLED_WALK_FORWARD',means:stats.means,stds:stats.stds,beta,mae,rmse};
}
function mld_predictRidge_(model, featureFull) {
  if (!model || !model.trained) {
    const g0=featureFull[0],g1=featureFull[1],g2=featureFull[2],trend=g0-g1;
    return Math.max(0,0.55*g0+0.30*g1+0.15*g2+0.35*trend);
  }
  const x=mld_pick_(featureFull,MLD_TOTAL_FEATURE_INDEXES);
  const z=[1].concat(mld_standardizeRow_(x,model.means,model.stds));
  let logp=0;
  for(let i=0;i<model.beta.length;i++) logp+=model.beta[i]*z[i];
  return Math.max(0,Math.expm1(logp));
}
function mld_confidenceFromModel_(model) {
  if (!model || !model.trained) return 'RENDAH';
  if (model.count >= 80 && model.rmse <= 3.0) return 'TINGGI';
  if (model.count >= 45 && model.rmse <= 4.5) return 'SEDANG';
  return 'CUKUP';
}

// =====================================================================
// 4. MULTI-CAUSE RISK V2.3
// ---------------------------------------------------------------------
// Bukan lagi klasifikasi "satu bulan = satu penyebab". Untuk setiap cause,
// model menghitung probabilitas/risk terpisah bahwa cause tersebut muncul
// pada bulan berikutnya. Dengan begitu PETIR/MATERIAL/ROW tidak dibuang hanya
// karena BINATANG kebetulan menjadi cause terbanyak pada bulan yang sama.
// =====================================================================
function mld_recentCauseEvidence_(ctx, feeder, cause, mi) {
  let weightedCause = 0, weightedTotal = 0, rawCause = 0;
  for (let offset=0; offset<3; offset++) {
    const weight = 3 - offset;
    const c = mld_getCell_(ctx, feeder, mi-offset);
    const n = Number(c.perKategori[cause] || 0);
    weightedCause += n * weight;
    weightedTotal += Number(c.total || 0) * weight;
    rawCause += n;
  }
  const share = weightedTotal > 0 ? weightedCause / weightedTotal : 0;
  // Saturating presence: 1 event ~=39%, 2 ~=63%, 3 ~=78%.
  const presence = 1 - Math.exp(-rawCause / 2);
  return {rawCount3:rawCause, weightedCount:weightedCause, weightedShare:share, presence:presence};
}
function mld_feederCauseHistory_(ctx, feeder, cause, mi) {
  let causeCount=0,total=0;
  for(let p=ctx.minMonthIndex;p<=mi;p++){
    const c=mld_getCell_(ctx,feeder,p);
    causeCount += Number(c.perKategori[cause]||0);
    total += Number(c.total||0);
  }
  return {causeCount:causeCount,total:total,share:total>0?causeCount/total:0};
}
function mld_causeRiskConfidence_(risk, status, positiveSupport) {
  const s=String(status||'RENDAH');
  if(s==='AKTIF'){
    if(risk>=0.62 && positiveSupport>=8) return 'TINGGI';
    if(risk>=0.38 && positiveSupport>=4) return 'SEDANG';
    return 'CUKUP';
  }
  if(s==='PANTAU') return 'PANTAU';
  return 'RENDAH';
}
function mld_predictCauseRisks_(ctx, trainingSamples, feeder, mi, currentFeature) {
  const valid=(trainingSamples||[]).filter(s=>s.targetCauseAvailable && s.y!==null && isFinite(s.y));
  let risks=[];

  if(valid.length<4){
    risks=ML_KATEGORI_PENYEBAB.map(cause=>{
      const local=mld_recentCauseEvidence_(ctx,feeder,cause,mi);
      const hist=mld_feederCauseHistory_(ctx,feeder,cause,mi);
      const risk=mld_clamp_(0.65*local.presence+0.35*hist.share,0,1);
      return {
        kategori:cause,risk:risk,threshold:0,active:false,watch:false,status:'RENDAH',confidence:'RENDAH',
        knnProbability:0,basePrevalence:0,recentCount3:local.rawCount3,recentShare:local.weightedShare,
        historicalShare:hist.share,positiveSupport:0,lift:0,evidenceOk:false,calibrationMode:'BALANCED_RANK_RELATIVE'
      };
    }).sort((a,b)=>b.risk-a.risk);
  } else {
    const selected=[0,1,2,3,4,5]
      .concat(ML_KATEGORI_PENYEBAB.map((_,i)=>9+i))
      .concat([20,21,22,23]);
    const matrix=valid.map(s=>mld_pick_(s.x,selected));
    const stats=mld_meanStd_(matrix);
    const target=mld_standardizeRow_(mld_pick_(currentFeature,selected),stats.means,stats.stds);
    const rows=valid.map((sample,idx)=>{
      const v=mld_standardizeRow_(matrix[idx],stats.means,stats.stds);
      let sum=0;
      for(let i=0;i<v.length;i++){const d=v[i]-target[i];sum+=d*d;}
      const age=Math.max(0,mi-sample.targetPeriod);
      return {sample:sample,distance:Math.sqrt(sum),age:age};
    }).sort((a,b)=>a.distance-b.distance);
    const k=Math.min(ML_CONFIG.KNN_K_MAX,rows.length);
    const neighbours=rows.slice(0,k);

    risks=ML_KATEGORI_PENYEBAB.map(cause=>{
      let positiveSupport=0;
      valid.forEach(s=>{if(Number((s.targetCauseCounts||{})[cause]||0)>0)positiveSupport++;});
      const basePrev=positiveSupport/Math.max(1,valid.length);
      let posWeight=0,totalWeight=0;
      neighbours.forEach(item=>{
        const recency=1/(1+Math.min(18,item.age)/18);
        const w=recency/(0.30+item.distance);
        totalWeight+=w;
        if(Number((item.sample.targetCauseCounts||{})[cause]||0)>0)posWeight+=w;
      });
      const prior=ML_CONFIG.CAUSE_RISK_PRIOR_STRENGTH;
      const knnProb=(posWeight+prior*basePrev)/Math.max(1e-9,totalWeight+prior);
      const local=mld_recentCauseEvidence_(ctx,feeder,cause,mi);
      const hist=mld_feederCauseHistory_(ctx,feeder,cause,mi);
      const risk=mld_clamp_(
        ML_CONFIG.CAUSE_RISK_KNN_WEIGHT*knnProb+
        ML_CONFIG.CAUSE_RISK_RECENT_WEIGHT*local.presence+
        ML_CONFIG.CAUSE_RISK_HISTORY_WEIGHT*hist.share+
        ML_CONFIG.CAUSE_RISK_BASE_WEIGHT*basePrev,
        0,1
      );
      return {
        kategori:cause,risk:risk,threshold:0,active:false,watch:false,status:'RENDAH',confidence:'RENDAH',
        knnProbability:knnProb,basePrevalence:basePrev,recentCount3:local.rawCount3,recentShare:local.weightedShare,
        historicalShare:hist.share,positiveSupport:positiveSupport,lift:knnProb-basePrev,evidenceOk:false,
        calibrationMode:'BALANCED_RANK_RELATIVE'
      };
    }).sort((a,b)=>b.risk-a.risk);
  }

  const decision=mld_applyCauseDecision_(risks);
  risks.forEach(r=>{r.confidence=mld_causeRiskConfidence_(r.risk,r.status,r.positiveSupport);});
  const primary=decision.active[0]||risks[0]||{kategori:'TIDAK DITEMUKAN',risk:0,confidence:'RENDAH'};
  const second=risks.find(r=>r.kategori!==primary.kategori)||{risk:0};
  return {
    kategori:primary.kategori,
    mode:'MULTI_CAUSE_BALANCED_ACTION_WATCH',
    confidence:primary.confidence,
    risk:primary.risk,
    riskMargin:Math.max(0,primary.risk-second.risk),
    risks:risks,
    active:decision.active,
    watch:decision.watch,
    detected:decision.detected,
    k:Math.min(ML_CONFIG.KNN_K_MAX,valid.length)
  };
}

// =====================================================================
// 5. PREDIKSI WAKTU - ADAPTASI LANGSUNG FILOSOFI SIGAP
// =====================================================================
function mld_timeMonthDistance_(a,b){ const d=Math.abs(Number(a)-Number(b)); return Math.min(d,12-d); }
function mld_predictTime_(ctx, feeder, cause, analysisMi) {
  const targetMonth=((analysisMi+1)%12+12)%12+1;
  const candidates=ctx.timeSamples.filter(s=>s.period<=analysisMi).map(s=>{
    const feederPenalty=s.feeder===feeder?0:3.5;
    const causePenalty=s.cause===cause?0:2.5;
    const monthPenalty=mld_timeMonthDistance_(s.month,targetMonth)/6;
    const age=Math.max(0,analysisMi-s.period);
    const recencyPenalty=Math.min(age,24)/24;
    return {sample:s,distance:feederPenalty+causePenalty+monthPenalty+recencyPenalty};
  }).sort((a,b)=>a.distance-b.distance);
  if(!candidates.length) return {tersedia:false,zona:'-',persentaseSiang:0,persentaseMalam:0,mode:'DATA_WAKTU_TIDAK_TERSEDIA'};
  const neighbours=candidates.slice(0,Math.min(15,candidates.length));
  let siang=0,malam=0;
  neighbours.forEach(item=>{
    const w=1/(0.35+item.distance);
    if(item.sample.zona==='SIANG') siang+=w; else malam+=w;
  });
  const total=siang+malam;
  if(total<=0) return {tersedia:false,zona:'-',persentaseSiang:0,persentaseMalam:0,mode:'DATA_WAKTU_TIDAK_TERSEDIA'};
  const ps=Math.round(siang/total*100), pm=100-ps;
  return {tersedia:true,zona:pm>ps?'MALAM':'SIANG',persentaseSiang:ps,persentaseMalam:pm,mode:'WEIGHTED_KNN_SIANG_MALAM'};
}

// =====================================================================
// 6. ASSET MODEL CAUSE-AWARE
// =====================================================================
function mld_assetFeatureForCause_(ctx,idAset,cause,mi){
  const asset=ctx.assetById[idAset]||{idAset:idAset,namaAset:idAset,penyulang:'',latitude:null,longitude:null};
  const e0=mld_getAssetCauseAt_(ctx,idAset,cause,mi);
  const e1=mld_getAssetCauseAt_(ctx,idAset,cause,mi-1);
  const e2=mld_getAssetCauseAt_(ctx,idAset,cause,mi-2);
  const cause3=e0+e1+e2;
  const all3=mld_getAssetTotalAt_(ctx,idAset,mi)+mld_getAssetTotalAt_(ctx,idAset,mi-1)+mld_getAssetTotalAt_(ctx,idAset,mi-2);
  const histCause=mld_getAssetCauseUpTo_(ctx,idAset,cause,mi);
  const repeated=cause3>=2?1:0;
  const veg=mld_treeProfileAsOf_(ctx,idAset,mi);
  const tool=mld_toolProfileAsOf_(ctx,idAset,mi);
  const feeder=asset.penyulang;
  const f0=mld_getCell_(ctx,feeder,mi);
  const f1=mld_getCell_(ctx,feeder,mi-1);
  let feederCause3=0;
  for(let o=0;o<3;o++) feederCause3+=mld_getCell_(ctx,feeder,mi-o).perKategori[cause]||0;
  const month0=((mi%12)+12)%12,angle=2*Math.PI*month0/12;
  let values=[
    e0,e1,e2,cause3,all3,Math.log1p(histCause),repeated,
    Math.log1p(veg.count),tool.hasTool?1:0,Math.log1p(tool.count),
    f0.perKategori[cause]||0,feederCause3,f0.total,f0.total-f1.total,
    mld_isValidCoord_(asset.latitude,asset.longitude)?1:0,Math.sin(angle),Math.cos(angle)
  ];
  // Hindari memasukkan fitur yang tidak relevan terhadap sebab tertentu.
  if(!['BINATANG','ROW-POHON'].includes(cause)) values[7]=0;
  if(cause!=='BINATANG'){ values[8]=0; values[9]=0; }
  return {
    values:values,asset:asset,e0:e0,e1:e1,e2:e2,cause3:cause3,total3:all3,histCause:histCause,repeated:!!repeated,
    vegetation:veg,tools:tool,validCoord:mld_isValidCoord_(asset.latitude,asset.longitude)
  };
}
function mld_sigmoid_(z){ z=mld_clamp_(z,-30,30); return 1/(1+Math.exp(-z)); }
function mld_trainLogistic_(samples){
  const valid=samples||[];
  const positives=valid.filter(s=>s.y===1).length;
  if(valid.length<ML_CONFIG.ASSET_MIN_SAMPLES||positives<ML_CONFIG.ASSET_MIN_POSITIVES){
    return {trained:false,name:'FALLBACK_CAUSE_AWARE_SCORE',count:valid.length,positives:positives};
  }
  const matrix=valid.map(s=>s.x),stats=mld_meanStd_(matrix);
  const X=matrix.map(r=>[1].concat(mld_standardizeRow_(r,stats.means,stats.stds)));
  const dim=X[0].length,weights=new Array(dim).fill(0);
  const negatives=valid.length-positives,posWeight=mld_clamp_(negatives/Math.max(1,positives),1,20);
  for(let epoch=0;epoch<ML_CONFIG.ASSET_LOGISTIC_EPOCHS;epoch++){
    const grad=new Array(dim).fill(0);
    valid.forEach((s,i)=>{
      let z=0;for(let j=0;j<dim;j++)z+=weights[j]*X[i][j];
      const p=mld_sigmoid_(z),rw=s.y===1?posWeight:1,err=(p-s.y)*rw;
      for(let j=0;j<dim;j++)grad[j]+=err*X[i][j];
    });
    for(let j=0;j<dim;j++){
      const penalty=j===0?0:ML_CONFIG.ASSET_LOGISTIC_LAMBDA*weights[j];
      weights[j]-=ML_CONFIG.ASSET_LOGISTIC_LR*(grad[j]/valid.length+penalty);
    }
  }
  return {trained:true,name:'LOGISTIC_REGRESSION_CAUSE_AWARE',count:valid.length,positives:positives,means:stats.means,stds:stats.stds,weights:weights};
}
function mld_buildAssetTrainingSamplesForCause_(ctx,cutoffMi,cause){
  const samples=[];
  for(let period=ctx.minMonthIndex;period<cutoffMi;period++){
    ctx.penyulangList.forEach(feeder=>{
      const assets=ctx.asetPerPenyulang[feeder]||[];
      if(!assets.length)return;
      const target=mld_getCell_(ctx,feeder,period+1);
      const positiveSet={};
      const positiveMap=target.asetPerKategori[cause]||{};
      Object.keys(positiveMap).forEach(id=>{positiveSet[id]=true;});
      const candidateSet={};
      Object.keys(positiveSet).forEach(id=>candidateSet[id]=true);
      // Aset dengan histori sebab terkait tiga bulan terakhir selalu masuk kandidat.
      assets.forEach(id=>{
        const c3=mld_getAssetCauseAt_(ctx,id,cause,period)+mld_getAssetCauseAt_(ctx,id,cause,period-1)+mld_getAssetCauseAt_(ctx,id,cause,period-2);
        if(c3>0) candidateSet[id]=true;
      });
      const positiveCount=Object.keys(positiveSet).length;
      const negativeLimit=Math.max(10,positiveCount*6+8);
      assets.filter(id=>!candidateSet[id]).map(id=>({id:id,hash:mld_hash_(id+'|'+period+'|'+cause)}))
        .sort((a,b)=>a.hash-b.hash).slice(0,negativeLimit).forEach(x=>candidateSet[x.id]=true);
      Object.keys(candidateSet).forEach(id=>{
        if(!ctx.assetById[id])return;
        const f=mld_assetFeatureForCause_(ctx,id,cause,period);
        samples.push({x:f.values,y:positiveSet[id]?1:0});
      });
    });
  }
  return samples;
}
function mld_predictAssetProbability_(model,profile,cause){
  if(model&&model.trained){
    const zrow=[1].concat(mld_standardizeRow_(profile.values,model.means,model.stds));
    let z=0;for(let i=0;i<model.weights.length;i++)z+=model.weights[i]*zrow[i];
    return mld_sigmoid_(z);
  }
  let z=-3.0+1.15*profile.cause3+0.45*Math.log1p(profile.histCause)+(profile.repeated?0.8:0)+0.22*Math.log1p(profile.total3);
  if(cause==='BINATANG'){
    z+=0.20*Math.log1p(profile.vegetation.count);
    if(profile.tools.hasTool)z-=0.15;
  }
  if(cause==='ROW-POHON')z+=0.32*Math.log1p(profile.vegetation.count);
  return mld_sigmoid_(z);
}
function mld_isMeaningfulAsset_(profile,cause){
  if(profile.cause3>0||profile.histCause>0)return true;
  if(cause==='BINATANG'&&(profile.vegetation.count>0||profile.tools.hasTool))return true;
  if(cause==='ROW-POHON'&&profile.vegetation.count>0)return true;
  if(['TIDAK DITEMUKAN','LAIN LAIN'].includes(cause)&&profile.total3>0)return true;
  return false;
}
function mld_rankAssetsForCause_(ctx,feeder,mi,cause,assetModel){
  const ids=ctx.asetPerPenyulang[feeder]||[];
  const rows=ids.map(id=>{
    const p=mld_assetFeatureForCause_(ctx,id,cause,mi);
    const probability=mld_predictAssetProbability_(assetModel,p,cause);
    return {
      idAset:p.asset.idAset,
      namaAset:p.asset.namaAset,
      skor:probability,
      cause3:p.cause3,
      total3:p.total3,
      histCause:p.histCause,
      jmlPohon:p.vegetation.count,
      alatAktif:p.tools.count,
      hasTool:p.tools.hasTool,
      repeated:p.repeated,
      validCoord:p.validCoord,
      meaningful:mld_isMeaningfulAsset_(p,cause)
    };
  });
  rows.sort((a,b)=>{
    if(a.meaningful!==b.meaningful)return a.meaningful?-1:1;
    if(b.skor!==a.skor)return b.skor-a.skor;
    if(b.cause3!==a.cause3)return b.cause3-a.cause3;
    return b.histCause-a.histCause;
  });
  return rows;
}

// =====================================================================
// 7. REKOMENDASI CAUSE-AWARE
// =====================================================================
function mld_reasonParts_(p,cause){
  const r=[];
  if(p.cause3>0)r.push(p.cause3+' gangguan '+cause+' dalam 3 bulan terakhir');
  if(p.repeated)r.push('gangguan berulang pada aset yang sama');
  if(p.histCause>p.cause3)r.push(p.histCause+' gangguan '+cause+' tercatat sepanjang histori');
  if(p.jmlPohon>0)r.push(p.jmlPohon+' vegetasi terinventarisasi hingga periode analisis');
  if(p.hasTool)r.push(p.alatAktif+' alat penahan aktif hingga periode analisis');
  else if(cause==='BINATANG')r.push('belum ada alat penahan aktif pada periode analisis');
  return r;
}
function mld_buildRecommendations_(ctx,feeder,mi,cause,ranking,prediction,causePrediction){
  const meaningful=ranking.filter(r=>r.meaningful);
  const recs=[],used={};
  function add(kodeWO,p,text,reason){
    if(recs.length>=ML_CONFIG.MAX_REKOMENDASI)return false;
    const id=p&&p.idAset?p.idAset:'';
    const key=kodeWO+'|'+id;
    if(used[key])return false;
    used[key]=true;
    recs.push({
      idAset:id,
      namaAset:p&&p.namaAset?p.namaAset:'',
      kodeWO:kodeWO,
      skorPrioritas:p&&isFinite(p.skor)?p.skor:null,
      kategori:cause,
      tindakan:text||'',
      alasan:reason||'',
      // V2.1 evidence payload: setiap WO membawa bukti asetnya sendiri.
      // Frontend tidak lagi menebak data dari Top-5 ranking aset.
      cause3:p&&isFinite(p.cause3)?Number(p.cause3):0,
      total3:p&&isFinite(p.total3)?Number(p.total3):0,
      histCause:p&&isFinite(p.histCause)?Number(p.histCause):0,
      jmlPohon:p&&isFinite(p.jmlPohon)?Number(p.jmlPohon):0,
      alatAktif:p&&isFinite(p.alatAktif)?Number(p.alatAktif):0,
      hasTool:!!(p&&p.hasTool),
      repeated:!!(p&&p.repeated),
      validCoord:!!(p&&p.validCoord),
      causeRisk:causePrediction&&isFinite(causePrediction.risk)?Number(causePrediction.risk):(causePrediction&&isFinite(causePrediction.voteShare)?Number(causePrediction.voteShare):0),
      calibrationMode:causePrediction&&causePrediction.calibrationMode?String(causePrediction.calibrationMode):'',
      modelVersion:MLD_VERSION
    });
    return true;
  }
  function top(filter){return meaningful.find(filter||(()=>true));}

  // Jika classifier belum punya sinyal penyebab yang cukup kuat, jangan langsung
  // mengeluarkan WO spesifik/mahal. Sistem memilih monitoring terarah dulu.
  const causeShare=causePrediction&&isFinite(causePrediction.voteShare)?Number(causePrediction.voteShare):0;
  if(causePrediction && causePrediction.confidence==='CUKUP' && causeShare<ML_CONFIG.CAUSE_LOW_SIGNAL_THRESHOLD){
    const a=meaningful[0]||null;
    const pct=Math.round(causeShare*100);
    const evidence=a?mld_reasonParts_(a,cause).join('; '):'';
    const reason=['confidence penyebab masih CUKUP ('+pct+'% risk model)',evidence].filter(Boolean).join('; ');
    add('MONITORING_TERARAH',a,'Lakukan monitoring terarah pada penyulang '+feeder+' sebelum menetapkan tindakan spesifik.',reason);
    return recs.slice(0,ML_CONFIG.MAX_REKOMENDASI);
  }
  const repeated=top(p=>p.cause3>=2);
  if(repeated) add('EVALUASI_TITIK_BERULANG',repeated,'Evaluasi titik gangguan berulang pada '+repeated.namaAset+'.',mld_reasonParts_(repeated,cause).join('; '));

  if(cause==='BINATANG'){
    const vegVals=meaningful.map(p=>p.jmlPohon).filter(v=>v>0).sort((a,b)=>a-b);
    const vegThreshold=vegVals.length?vegVals[Math.floor((vegVals.length-1)*0.75)]:0;
    const install=top(p=>!p.hasTool&&(p.cause3>0||p.jmlPohon>=Math.max(1,vegThreshold)));
    if(install) add('PASANG_ATAU_TAMBAH_ALAT',install,'Pasang atau tambah alat penahan pada '+install.namaAset+'.',mld_reasonParts_(install,cause).join('; '));
    const inspect=top(p=>p.hasTool&&p.cause3>0);
    if(inspect) add('INSPEKSI_ALAT',inspect,'Inspeksi efektivitas alat penahan pada '+inspect.namaAset+'.',mld_reasonParts_(inspect,cause).join('; '));
    const veg=top(p=>p.jmlPohon>0&&(p.cause3>0||prediction.point>=0.75));
    if(veg) add('PANGKAS_VEGETASI',veg,'Tangani vegetasi di sekitar '+veg.namaAset+' yang dapat menjadi jalur masuk hewan.',mld_reasonParts_(veg,cause).join('; '));
  } else if(cause==='PETIR'){
    const a=top(p=>p.cause3>0||p.histCause>0);
    if(a) add('EVALUASI_ARRESTER',a,'Evaluasi lightning arrester pada '+a.namaAset+'.',mld_reasonParts_(a,cause).join('; '));
    const b=meaningful.find(p=>p!==a&&(p.cause3>0||p.histCause>0))||a;
    if(b) add('PERIKSA_GROUNDING',b,'Periksa sistem grounding pada '+b.namaAset+'.',mld_reasonParts_(b,cause).join('; '));
  } else if(cause==='ROW-POHON'){
    const veg=top(p=>p.jmlPohon>0);
    if(veg) add('PANGKAS_VEGETASI',veg,'Lakukan pemangkasan ROW/vegetasi pada '+veg.namaAset+'.',mld_reasonParts_(veg,cause).join('; '));
    const survey=top(p=>p.cause3>0&&p.jmlPohon===0);
    if(survey) add('SURVEI_ULANG_VEGETASI',survey,'Survei ulang vegetasi di sekitar '+survey.namaAset+'.',mld_reasonParts_(survey,cause).join('; '));
  } else if(cause==='MATERIAL'){
    const a=top(); if(a)add('INSPEKSI_MATERIAL',a,'Inspeksi material/komponen pada '+a.namaAset+'.',mld_reasonParts_(a,cause).join('; '));
    const b=top(p=>p.cause3>=2||p.histCause>=2); if(b)add('PENGGANTIAN_KOMPONEN',b,'Evaluasi kebutuhan penggantian komponen pada '+b.namaAset+'.',mld_reasonParts_(b,cause).join('; '));
  } else if(cause==='KONDUKTOR'){
    const a=top(); if(a)add('INSPEKSI_KONDUKTOR',a,'Inspeksi konduktor dan sambungan pada '+a.namaAset+'.',mld_reasonParts_(a,cause).join('; '));
    const b=top(p=>p.cause3>=2||p.histCause>=2); if(b)add('PENGENCANGAN_KONEKSI',b,'Periksa dan kencangkan koneksi pada '+b.namaAset+'.',mld_reasonParts_(b,cause).join('; '));
  } else if(cause==='JOINTING/SIKUAN'){
    const a=top(); if(a)add('INSPEKSI_JOINTING',a,'Inspeksi jointing/sikuan pada '+a.namaAset+'.',mld_reasonParts_(a,cause).join('; '));
    const b=top(p=>p.cause3>=2||p.histCause>=2); if(b)add('PERBAIKAN_SIKUAN',b,'Evaluasi perbaikan sikuan/jointing pada '+b.namaAset+'.',mld_reasonParts_(b,cause).join('; '));
  } else if(cause==='KONSTRUKSI'){
    const a=top(); if(a)add('EVALUASI_KONSTRUKSI',a,'Evaluasi konstruksi pada '+a.namaAset+'.',mld_reasonParts_(a,cause).join('; '));
    const b=top(p=>p.cause3>=2||p.histCause>=2); if(b)add('PERBAIKAN_KONSTRUKSI',b,'Lakukan tindakan korektif konstruksi pada '+b.namaAset+'.',mld_reasonParts_(b,cause).join('; '));
  } else if(cause==='LAYANG-LAYANG'){
    const a=top();
    add('SOSIALISASI_MASYARAKAT',a||null,'Lakukan sosialisasi pada wilayah rawan layang-layang di penyulang '+feeder+'.',a?mld_reasonParts_(a,cause).join('; '):'rekomendasi tingkat penyulang karena titik aset spesifik belum cukup kuat');
    add('PEMASANGAN_RAMBU',a||null,'Pasang rambu/peringatan pada area rawan di penyulang '+feeder+'.',a?mld_reasonParts_(a,cause).join('; '):'rekomendasi tingkat penyulang');
  } else if(cause==='EKSTERNAL'){
    const a=top();
    add('KOORDINASI_PIHAK_EKSTERNAL',a||null,'Koordinasikan penanganan sumber gangguan eksternal pada penyulang '+feeder+'.',a?mld_reasonParts_(a,cause).join('; '):'rekomendasi tingkat penyulang');
  } else {
    const a=top(p=>p.total3>0)||top();
    add('SURVEI_ULANG',a||null,'Lakukan survei ulang untuk memastikan akar penyebab pada penyulang '+feeder+'.',a?mld_reasonParts_(a,cause).join('; '):'penyebab belum teridentifikasi kuat pada aset tertentu');
  }
  if(recs.length===0){
    const a=meaningful[0]||null;
    add('MONITORING_TERARAH',a,'Lakukan monitoring terarah pada penyulang '+feeder+' untuk periode berikutnya.',a?mld_reasonParts_(a,cause).join('; '):'belum ada aset dengan bukti cukup kuat untuk rekomendasi spesifik');
  }
  return recs.slice(0,ML_CONFIG.MAX_REKOMENDASI);
}

// =====================================================================
// 8. ORKESTRATOR PER PREDICTION PERIOD
// =====================================================================
function mld_trainingUpTo_(datasetSamples, analysisMi){
  return datasetSamples.filter(s=>s.y!==null&&s.targetPeriod<=analysisMi);
}
function mld_buildMultiCauseRecommendations_(ctx,feeder,mi,causeRisk,prediction,assetModelCache){
  const selected=(causeRisk.active||[]).slice(0,ML_CONFIG.CAUSE_ACTION_MAX_ACTIVE);
  const bundles=[];
  const allRankings={};
  const allModels={};

  // Jika tidak ada cause melewati ambang, tetap bangun ranking primary untuk
  // monitoring terarah, tetapi jangan memaksakan WO spesifik.
  const causesToBuild=selected.length?selected:[causeRisk.risks[0]];
  causesToBuild.filter(Boolean).forEach(cr=>{
    const cause=cr.kategori;
    const assetKey=mi+'|'+cause;
    if(!assetModelCache[assetKey]){
      const assetSamples=mld_buildAssetTrainingSamplesForCause_(ctx,mi,cause);
      assetModelCache[assetKey]=mld_trainLogistic_(assetSamples);
    }
    const model=assetModelCache[assetKey];
    const ranking=mld_rankAssetsForCause_(ctx,feeder,mi,cause,model);
    allRankings[cause]=ranking;
    allModels[cause]=model;
    const predContract={
      confidence:selected.length?cr.confidence:'CUKUP',
      voteShare:selected.length?cr.risk:0,
      risk:selected.length?cr.risk:0,
      calibrationMode:cr.calibrationMode||'',
      threshold:cr.threshold||0
    };
    const recs=mld_buildRecommendations_(ctx,feeder,mi,cause,ranking,prediction,predContract);
    bundles.push({cause:cause,risk:cr.risk||0,recs:recs});
  });

  // Multi-cause: ambil minimal satu tindakan dari setiap cause aktif dulu,
  // lalu isi slot tersisa round-robin. Maksimal 4 card agar UI tetap ringkas.
  const out=[],used={};
  function push(rec){
    if(!rec||out.length>=ML_CONFIG.MAX_REKOMENDASI)return;
    const key=String(rec.kodeWO||'')+'|'+String(rec.idAset||'')+'|'+String(rec.kategori||'');
    if(used[key])return;
    used[key]=true;out.push(rec);
  }
  bundles.forEach(b=>push(b.recs[0]));
  let idx=1;
  while(out.length<ML_CONFIG.MAX_REKOMENDASI && idx<ML_CONFIG.MAX_REKOMENDASI){
    let added=false;
    bundles.forEach(b=>{
      const before=out.length;push(b.recs[idx]);if(out.length>before)added=true;
    });
    if(!added)break;
    idx++;
  }
  return {recommendations:out,rankings:allRankings,models:allModels};
}

function mld_runPrediction_(ctx,datasetSamples,feeder,mi,modelCache,assetModelCache){
  const currentFeature=mld_buildFeatureVector_(ctx,feeder,mi);
  const training=mld_trainingUpTo_(datasetSamples,mi);
  const ridgeKey='RIDGE|'+mi;
  if(!modelCache[ridgeKey])modelCache[ridgeKey]=mld_trainRidge_(training);
  const ridge=modelCache[ridgeKey];
  const point=mld_predictRidge_(ridge,currentFeature);
  const volatility=Math.max(1,ridge.trained?ridge.rmse:Math.abs(currentFeature[0]-currentFeature[1])+1);
  const lower=Math.max(0,Math.floor(point-volatility));
  const upper=Math.max(lower,Math.ceil(point+volatility));

  const causeRisk=mld_predictCauseRisks_(ctx,training,feeder,mi,currentFeature);
  const primaryCause=causeRisk.kategori;
  const timePred=mld_predictTime_(ctx,feeder,primaryCause,mi);
  const prediction={point:point,lower:lower,upper:upper};
  const multi=mld_buildMultiCauseRecommendations_(ctx,feeder,mi,causeRisk,prediction,assetModelCache);
  const primaryRanking=(multi.rankings[primaryCause]||[]).filter(r=>r.meaningful).slice(0,5);
  const primaryModel=multi.models[primaryCause]||{name:'FALLBACK_CAUSE_AWARE_SCORE'};

  return {
    point:Math.round(point*10)/10,
    lower:lower,
    upper:upper,
    totalModel:ridge,
    cause:{
      kategori:primaryCause,
      mode:causeRisk.mode,
      confidence:causeRisk.confidence,
      voteShare:causeRisk.risk,
      voteMargin:causeRisk.riskMargin,
      risk:causeRisk.risk
    },
    causeRisks:causeRisk.risks,
    activeCauses:causeRisk.active,
    watchCauses:causeRisk.watch,
    time:timePred,
    assetModel:primaryModel,
    ranking:primaryRanking,
    recommendations:multi.recommendations
  };
}

// =====================================================================
// 9. REBUILD
// =====================================================================
function rebuildMLDashboard(){
  const ctx=mld_buildContext_();
  const dataset=mld_buildDatasetSamples_(ctx);
  const modelCache={},assetModelCache={};
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const shDataset=ss.getSheetByName(ML_SHEET_DATASET_OUT)||ss.insertSheet(ML_SHEET_DATASET_OUT);
  const shPred=ss.getSheetByName(ML_SHEET_PREDIKSI_OUT)||ss.insertSheet(ML_SHEET_PREDIKSI_OUT);
  shDataset.clearContents(); shPred.clearContents();

  const datasetHeader=['PENYULANG','BULAN_INDEX','PERIODE_ANALISIS','PERIODE_TARGET',...ML_FEATURE_NAMES,'TARGET_GANGGUAN_BULAN_BERIKUTNYA','TARGET_PENYEBAB_DOMINAN','TARGET_CAUSES_JSON','TARGET_TERSEDIA','MODEL_VERSION'];
  const datasetRows=[datasetHeader];
  dataset.forEach(s=>{
    datasetRows.push([
      s.feeder,s.period,mld_monthKeyFromIndex_(ctx.baseYear,s.period),mld_monthKeyFromIndex_(ctx.baseYear,s.targetPeriod),...s.x,
      s.y===null?'':s.y,s.targetCause||'',JSON.stringify(s.targetCauseCounts||{}),s.y===null?'TIDAK':'YA',MLD_VERSION
    ]);
  });

  const predHeader=[
    'PENYULANG','BULAN_INDEX','PERIODE_ANALISIS','PERIODE_PREDIKSI',
    'PREDIKSI_TOTAL_GANGGUAN','PREDIKSI_BAWAH','PREDIKSI_ATAS','MODE_PREDIKSI','CONFIDENCE',
    'PENYEBAB_DOMINAN','MODE_PENYEBAB','CONFIDENCE_PENYEBAB','VOTE_SHARE_PENYEBAB','VOTE_MARGIN_PENYEBAB',
    'CAUSE_RISK_JSON','CAUSE_AKTIF_JSON','JUMLAH_CAUSE_AKTIF','CAUSE_PANTAU_JSON','JUMLAH_CAUSE_PANTAU',
    'ZONA_WAKTU_DOMINAN','PERSENTASE_SIANG','PERSENTASE_MALAM','MODE_WAKTU',
    'ASET_TERBERISIKO_1','ASET_TERBERISIKO_2','ASET_TERBERISIKO_3',
    'REKOMENDASI_WO','ASET_TERBERISIKO_JSON','REKOMENDASI_JSON',
    'MODEL_ASET','JUMLAH_TRAINING_TOTAL','MAE_MODEL','RMSE_MODEL','MODEL_VERSION','IS_TERBARU','TANGGAL_DIHITUNG'
  ];
  const predRows=[predHeader];
  const now=new Date();

  ctx.penyulangList.forEach(feeder=>{
    for(let mi=ctx.minMonthIndex;mi<=ctx.maxMonthIndex;mi++){
      const r=mld_runPrediction_(ctx,dataset,feeder,mi,modelCache,assetModelCache);
      const top=r.ranking.map(x=>x.idAset);
      const recString=r.recommendations.map(x=>x.kodeWO+(x.idAset?' ('+x.idAset+')':'')).join(' | ');
      const active=r.activeCauses||[];
      const watch=r.watchCauses||[];
      predRows.push([
        feeder,mi,mld_monthKeyFromIndex_(ctx.baseYear,mi),mld_monthKeyFromIndex_(ctx.baseYear,mi+1),
        r.point,r.lower,r.upper,r.totalModel.name,mld_confidenceFromModel_(r.totalModel),
        r.cause.kategori,r.cause.mode,r.cause.confidence,Math.round((r.cause.risk||0)*1000)/1000,Math.round((r.cause.voteMargin||0)*1000)/1000,
        JSON.stringify(r.causeRisks||[]),JSON.stringify(active),active.length,JSON.stringify(watch),watch.length,
        r.time.zona,r.time.persentaseSiang,r.time.persentaseMalam,r.time.mode,
        top[0]||'',top[1]||'',top[2]||'',recString,
        JSON.stringify(r.ranking),JSON.stringify(r.recommendations),
        r.assetModel.name,r.totalModel.count||0,Math.round((r.totalModel.mae||0)*1000)/1000,Math.round((r.totalModel.rmse||0)*1000)/1000,
        MLD_VERSION,mi===ctx.maxMonthIndex?'YA':'TIDAK',now
      ]);
    }
  });

  if(datasetRows.length>1)shDataset.getRange(1,1,datasetRows.length,datasetRows[0].length).setValues(datasetRows);
  if(predRows.length>1)shPred.getRange(1,1,predRows.length,predRows[0].length).setValues(predRows);
  shDataset.setFrozenRows(1); shPred.setFrozenRows(1);
  mld_bumpCacheVersion_();

  const summary={
    success:true,version:MLD_VERSION,penyulang:ctx.penyulangList.length,
    datasetRows:datasetRows.length-1,predictionRows:predRows.length-1,
    minPeriod:mld_monthKeyFromIndex_(ctx.baseYear,ctx.minMonthIndex),
    maxPeriod:mld_monthKeyFromIndex_(ctx.baseYear,ctx.maxMonthIndex)
  };
  // Jika lapisan Alert Aktif sudah dipasang, setiap rebuild otomatis menyinkronkan
  // rekomendasi periode terbaru. Gagal sync alert tidak menggagalkan rebuild ML.
  try{
    if(typeof mlaa_syncLatestInternal_==='function') summary.actionAlertSync=mlaa_syncLatestInternal_();
  }catch(alertErr){
    summary.actionAlertSync={error:true,message:String(alertErr&&alertErr.message?alertErr.message:alertErr)};
  }
  Logger.log(JSON.stringify(summary));
  return summary;
}

// =====================================================================
// 10. GETTER - MEMBACA HASIL REBUILD, TIDAK MELATIH ULANG
// =====================================================================
function mld_readPredictionObjects_(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName(ML_SHEET_PREDIKSI_OUT);
  if(!sh)return [];
  const values=sh.getDataRange().getValues();
  if(values.length<2)return [];
  const headers=values[0].map(h=>mld_norm_(h));
  return values.slice(1).map(row=>{
    const o={}; headers.forEach((h,i)=>{if(h)o[h]=row[i];}); return o;
  }).filter(o=>o.PENYULANG);
}
function mld_safeJsonArray_(value){
  if(Array.isArray(value))return value;
  try{const x=JSON.parse(String(value||'[]'));return Array.isArray(x)?x:[];}catch(e){return [];}
}
function mld_rowToContract_(row){
  if(!row)return {error:true,message:'Prediksi ML belum tersedia. Jalankan rebuildMLDashboard().'};
  if(mld_text_(row.MODEL_VERSION)!==MLD_VERSION){
    return {error:true,message:'Sheet prediksi masih versi lama. Jalankan rebuildMLDashboard() sekali setelah mengganti file ML.'};
  }
  const ranking=mld_safeJsonArray_(row.ASET_TERBERISIKO_JSON);
  const recs=mld_safeJsonArray_(row.REKOMENDASI_JSON);
  // ACTION MEMORY: raw prediction sheet tetap utuh, tetapi rekomendasi yang
  // sudah ditandai SELESAI tidak ditampilkan ulang selama cooldown.
  const actionMemory = (typeof mlaa_filterRecommendationsForContract_ === 'function')
    ? mlaa_filterRecommendationsForContract_(mld_norm_(row.PENYULANG),mld_text_(row.PERIODE_ANALISIS),mld_text_(row.PERIODE_PREDIKSI),recs)
    : {shown:recs,suppressed:[]};
  const visibleRecs=Array.isArray(actionMemory.shown)?actionMemory.shown:recs;
  const suppressedRecs=Array.isArray(actionMemory.suppressed)?actionMemory.suppressed:[];
  const causeRisks=mld_safeJsonArray_(row.CAUSE_RISK_JSON);
  const activeCauses=mld_safeJsonArray_(row.CAUSE_AKTIF_JSON);
  const watchCauses=mld_safeJsonArray_(row.CAUSE_PANTAU_JSON);
  return {
    error:false,
    penyulang:mld_norm_(row.PENYULANG),
    periodeAnalisis:mld_text_(row.PERIODE_ANALISIS),
    periodePrediksi:mld_text_(row.PERIODE_PREDIKSI),
    statusModel:mld_text_(row.MODE_PREDIKSI),
    prediksiRisiko:mld_num_(row.PREDIKSI_TOTAL_GANGGUAN),
    prediksiBawah:mld_num_(row.PREDIKSI_BAWAH),
    prediksiAtas:mld_num_(row.PREDIKSI_ATAS),
    confidence:mld_text_(row.CONFIDENCE_PENYEBAB)||mld_text_(row.CONFIDENCE)||'-',
    confidenceTotal:mld_text_(row.CONFIDENCE)||'-',
    penyebabDominan:mld_text_(row.PENYEBAB_DOMINAN)||'TIDAK DITEMUKAN',
    modePenyebab:mld_text_(row.MODE_PENYEBAB),
    risikoPenyebabUtama:mld_num_(row.VOTE_SHARE_PENYEBAB),
    voteSharePenyebab:mld_num_(row.VOTE_SHARE_PENYEBAB),
    voteMarginPenyebab:mld_num_(row.VOTE_MARGIN_PENYEBAB),
    causeRisks:causeRisks,
    activeCauses:activeCauses,
    jumlahCauseAktif:mld_num_(row.JUMLAH_CAUSE_AKTIF),
    watchCauses:watchCauses,
    jumlahCausePantau:mld_num_(row.JUMLAH_CAUSE_PANTAU),
    zonaWaktuDominan:mld_text_(row.ZONA_WAKTU_DOMINAN)||'-',
    persentaseSiang:mld_num_(row.PERSENTASE_SIANG),
    persentaseMalam:mld_num_(row.PERSENTASE_MALAM),
    waktuTersedia:!!mld_text_(row.ZONA_WAKTU_DOMINAN)&&mld_text_(row.ZONA_WAKTU_DOMINAN)!=='-',
    asetTerberisiko:ranking,
    rekomendasi:visibleRecs,
    rekomendasiTertahan:suppressedRecs,
    jumlahRekomendasiTertahan:suppressedRecs.length,
    modelAset:mld_text_(row.MODEL_ASET),
    maeModel:mld_num_(row.MAE_MODEL),
    rmseModel:mld_num_(row.RMSE_MODEL),
    modelVersion:mld_text_(row.MODEL_VERSION)
  };
}
function getMLDashboardRecommendation_(feederName,options){
  const feeder=mld_norm_(feederName);
  const rows=mld_readPredictionObjects_().filter(r=>mld_norm_(r.PENYULANG)===feeder);
  if(!rows.length)return {error:true,message:'Tidak ada prediksi ML untuk penyulang ini. Jalankan rebuildMLDashboard().'};
  let selected=null;
  if(options&&options.bulan&&options.tahun){
    const nama=['JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI','JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER'];
    let b=nama.indexOf(mld_norm_(options.bulan));
    if(b<0){const n=parseInt(options.bulan,10);if(n>=1&&n<=12)b=n-1;}
    if(b>=0){
      const key=Number(options.tahun)+'-'+String(b+1).padStart(2,'0');
      selected=rows.find(r=>mld_text_(r.PERIODE_ANALISIS)===key)||null;
    }
  }
  if(!selected){
    selected=rows.find(r=>mld_norm_(r.IS_TERBARU)==='YA')||rows.sort((a,b)=>mld_num_(b.BULAN_INDEX)-mld_num_(a.BULAN_INDEX))[0];
  }
  return mld_rowToContract_(selected);
}
function getMLDashboardRecommendationForUser(username,password,feederName,options){
  // Semua akun terautentikasi (ADMIN/POSKO) boleh membaca ML seluruh penyulang.
  // Alert Aktif tetap dikunci ADMIN di backend alert terpisah.
  authenticateUser_(username,password);
  const cache=CacheService.getScriptCache();
  const key=mld_resultCacheKey_(feederName,options);
  try{const cached=cache.get(key);if(cached)return JSON.parse(cached);}catch(e){}
  const result=getMLDashboardRecommendation_(feederName,options);
  if(result&&!result.error){try{cache.put(key,JSON.stringify(result),MLD_CACHE_TTL_SECONDS);}catch(e){}}
  return result;
}


// =====================================================================
// 10B. BATCH PREFETCH - SATU BACA SHEET UNTUK SEMUA PENYULANG
// Dipakai frontend agar ML sudah tersedia sebelum modal pertama dibuka.
// =====================================================================
function getMLDashboardPeriodBatchForUser(username,password,year,month){
  authenticateUser_(username,password);
  const y=parseInt(year,10), m=parseInt(month,10);
  if(!isFinite(y)||!isFinite(m)||m<1||m>12){
    return {error:true,message:'Periode ML tidak valid.'};
  }
  const periodKey=y+'-'+String(m).padStart(2,'0');
  const scope='ALL_AUTH';
  const cacheVersion=mld_getCacheVersion_();
  const cacheKey=['MLD2BATCH',cacheVersion,scope,periodKey].join(':').slice(0,240);
  const cache=CacheService.getScriptCache();
  try{
    const cached=cache.get(cacheKey);
    if(cached)return JSON.parse(cached);
  }catch(e){}

  let rows=mld_readPredictionObjects_().filter(r=>mld_text_(r.PERIODE_ANALISIS)===periodKey);
  const items=rows.map(mld_rowToContract_).filter(x=>x&&!x.error);
  const result={
    error:false,
    cacheVersion:cacheVersion,
    modelVersion:MLD_VERSION,
    periodeAnalisis:periodKey,
    count:items.length,
    items:items
  };
  try{cache.put(cacheKey,JSON.stringify(result),600);}catch(e){}
  return result;
}

// =====================================================================
// 11. TEST CEPAT SETELAH REBUILD
// =====================================================================
function testMLDashboardV2(){
  const rows=mld_readPredictionObjects_();
  const latest=rows.filter(r=>mld_norm_(r.IS_TERBARU)==='YA');
  const summary={
    version:MLD_VERSION,
    totalRows:rows.length,
    latestRows:latest.length,
    feeders:latest.map(r=>r.PENYULANG),
    sample:latest.slice(0,5).map(r=>({
      penyulang:r.PENYULANG,
      prediksi:r.PREDIKSI_TOTAL_GANGGUAN,
      penyebabUtama:r.PENYEBAB_DOMINAN,
      riskUtama:r.VOTE_SHARE_PENYEBAB,
      confidence:r.CONFIDENCE_PENYEBAB,
      causeAktif:mld_safeJsonArray_(r.CAUSE_AKTIF_JSON).map(x=>x.kategori),
      causePantau:mld_safeJsonArray_(r.CAUSE_PANTAU_JSON).map(x=>x.kategori),
      aset1:r.ASET_TERBERISIKO_1,
      wo:r.REKOMENDASI_WO
    }))
  };
  Logger.log(JSON.stringify(summary));
  return summary;
}

// =====================================================================
// 12. AUDIT MULTI-CAUSE V2.5
// Dua metrik dipisahkan:
// - ACTION: cause yang boleh menghasilkan WO (lebih presisi / konservatif)
// - DETECTION: ACTION + PANTAU (mengukur kemampuan model menangkap sinyal cause)
// =====================================================================
function testCauseRiskV25(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const shD=ss.getSheetByName(ML_SHEET_DATASET_OUT);
  const shP=ss.getSheetByName(ML_SHEET_PREDIKSI_OUT);
  if(!shD||!shP) throw new Error('Jalankan rebuildMLDashboard() terlebih dahulu.');
  function objects(sh){
    const v=sh.getDataRange().getValues();if(v.length<2)return [];
    const h=v[0].map(x=>mld_norm_(x));
    return v.slice(1).map(row=>{const o={};h.forEach((k,i)=>{if(k)o[k]=row[i];});return o;});
  }
  function makeStat(){const s={};ML_KATEGORI_PENYEBAB.forEach(c=>s[c]={tp:0,fp:0,fn:0,tn:0});return s;}
  function addPeriod(stat,actualSet,predSet){
    ML_KATEGORI_PENYEBAB.forEach(c=>{
      const a=!!actualSet[c],p=!!predSet[c],z=stat[c];
      if(a&&p)z.tp++;else if(!a&&p)z.fp++;else if(a&&!p)z.fn++;else z.tn++;
    });
  }
  function summarize(stat,periods,totalPred,totalActual){
    const perCause={};let macroP=0,macroR=0,macroF=0,nCause=0,microTp=0,microFp=0,microFn=0;
    ML_KATEGORI_PENYEBAB.forEach(c=>{
      const z=stat[c];microTp+=z.tp;microFp+=z.fp;microFn+=z.fn;
      const p=z.tp+z.fp?z.tp/(z.tp+z.fp):0,r=z.tp+z.fn?z.tp/(z.tp+z.fn):0,f=p+r?2*p*r/(p+r):0,support=z.tp+z.fn;
      perCause[c]={support:support,precision:Math.round(p*1000)/1000,recall:Math.round(r*1000)/1000,f1:Math.round(f*1000)/1000,tp:z.tp,fp:z.fp,fn:z.fn};
      if(support>0){macroP+=p;macroR+=r;macroF+=f;nCause++;}
    });
    const p=microTp+microFp?microTp/(microTp+microFp):0,r=microTp+microFn?microTp/(microTp+microFn):0,f=p+r?2*p*r/(p+r):0;
    return {
      microPrecision:Math.round(p*1000)/1000,microRecall:Math.round(r*1000)/1000,microF1:Math.round(f*1000)/1000,
      macroPrecision:nCause?Math.round(macroP/nCause*1000)/1000:0,macroRecall:nCause?Math.round(macroR/nCause*1000)/1000:0,macroF1:nCause?Math.round(macroF/nCause*1000)/1000:0,
      avgPredicted:periods?Math.round(totalPred/periods*1000)/1000:0,avgActual:periods?Math.round(totalActual/periods*1000)/1000:0,perCause:perCause
    };
  }

  const ds=objects(shD),pred=objects(shP),targetMap={};
  ds.forEach(r=>{
    if(mld_norm_(r.TARGET_TERSEDIA)!=='YA')return;
    let counts={};try{counts=JSON.parse(String(r.TARGET_CAUSES_JSON||'{}'))||{};}catch(e){counts={};}
    targetMap[mld_norm_(r.PENYULANG)+'|'+mld_text_(r.PERIODE_ANALISIS)]={counts:counts};
  });
  const actionStat=makeStat(),detectStat=makeStat();
  let periods=0,totalAction=0,totalDetected=0,totalActual=0;
  pred.forEach(r=>{
    const target=targetMap[mld_norm_(r.PENYULANG)+'|'+mld_text_(r.PERIODE_ANALISIS)];if(!target)return;
    periods++;
    const actualSet={};Object.keys(target.counts||{}).forEach(c=>{if(Number(target.counts[c]||0)>0)actualSet[mld_norm_(c)]=true;});
    const actionSet={},detectSet={};
    mld_safeJsonArray_(r.CAUSE_AKTIF_JSON).forEach(x=>{const k=mld_norm_(x.kategori);if(k){actionSet[k]=true;detectSet[k]=true;}});
    mld_safeJsonArray_(r.CAUSE_PANTAU_JSON).forEach(x=>{const k=mld_norm_(x.kategori);if(k)detectSet[k]=true;});
    totalAction+=Object.keys(actionSet).length;totalDetected+=Object.keys(detectSet).length;totalActual+=Object.keys(actualSet).length;
    addPeriod(actionStat,actualSet,actionSet);addPeriod(detectStat,actualSet,detectSet);
  });

  const latest=pred.filter(r=>mld_norm_(r.IS_TERBARU)==='YA');
  const latestActionDistribution={},latestWatchDistribution={};
  latest.forEach(r=>{
    mld_safeJsonArray_(r.CAUSE_AKTIF_JSON).forEach(x=>{const k=mld_norm_(x.kategori);if(k)latestActionDistribution[k]=(latestActionDistribution[k]||0)+1;});
    mld_safeJsonArray_(r.CAUSE_PANTAU_JSON).forEach(x=>{const k=mld_norm_(x.kategori);if(k)latestWatchDistribution[k]=(latestWatchDistribution[k]||0)+1;});
  });
  const action=summarize(actionStat,periods,totalAction,totalActual);
  const detection=summarize(detectStat,periods,totalDetected,totalActual);
  const out={
    version:MLD_VERSION,evaluatedPeriods:periods,
    action:action,detection:detection,
    latestActionDistribution:latestActionDistribution,latestWatchDistribution:latestWatchDistribution,
    decision:{
      primaryActionMinRisk:ML_CONFIG.CAUSE_ACTION_PRIMARY_MIN_RISK,
      secondaryActionRatio:ML_CONFIG.CAUSE_ACTION_SECONDARY_RATIO,
      secondaryWatchRatio:ML_CONFIG.CAUSE_WATCH_SECONDARY_RATIO,
      tertiaryWatchRatio:ML_CONFIG.CAUSE_WATCH_TERTIARY_RATIO,
      maxActions:ML_CONFIG.CAUSE_ACTION_MAX_ACTIVE,maxTotalSignals:ML_CONFIG.CAUSE_WATCH_MAX_TOTAL
    }
  };
  Logger.log(JSON.stringify(out));return out;
}

function testCauseRiskV24(){ return testCauseRiskV25(); }
function testCauseRiskV23(){ return testCauseRiskV25(); }
function testCauseClassifierV22(){ return testCauseRiskV25(); }
