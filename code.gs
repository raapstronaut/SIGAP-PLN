/**
 * =========================================================
 * DASHBOARD GANGGUAN 20 kV - ULP SRIBAWONO
 * Backend Google Apps Script
 * Versi 3.1 - Multi-Role + Enrichment + Alat Penahan Aktif
 * =========================================================
 *
 * CATATAN:
 * - Login membaca sheet USERS dengan password plaintext sesuai rancangan saat ini.
 * - Tidak memakai AUTH_SESSIONS / token.
 * - Frontend lama tetap kompatibel karena getDashboardData() dan
 *   getBinatangData() masih dipertahankan sementara.
 * - Endpoint baru yang sudah membatasi akses user:
 *     loginUser(username, password)
 *     getDashboardDataForUser(username, password)
 *     getBinatangDataForUser(username, password)
 *     getMasterPoskoForUser(username, password)
 * - Dashboard/ranking tetap global untuk ADMIN dan POSKO.
 * - Pembatasan wilayah hanya diterapkan pada Peta Jaringan saat mode
 *   "Area Posko" dipilih, berbasis MASTER_SECTION + MASTER_ASET.
 */

const SHEET_DB_DASHBOARD = 'DB_DASHBOARD';
const SHEET_BINATANG = 'BINATANG';
const SHEET_SETTINGS = 'SETTINGS';
const SHEET_POSKO_LEGACY = 'POSKO';
const SHEET_MASTER_POSKO = 'MASTER_POSKO';
const SHEET_MASTER_SECTION = 'MASTER_SECTION';
const SHEET_MASTER_KEYPOINT = 'MASTER_KEYPOINT';
const SHEET_USERS = 'USERS';
const SHEET_MASTER_ASET = 'MASTER_ASET';
const SHEET_MASTER_POHON = 'MASTER_POHON';
const SHEET_ALAT_PENAHAN = 'ALAT_PENAHAN';


/**
 * =========================================================
 * WEB APP
 * =========================================================
 */
function doGet() {
  const settings = getSettingsObject_();

  const namaSistem = settings.NAMA_SISTEM || 'DASHBOARD';
  const unit = settings.UNIT || 'ULP SRIBAWONO';

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(`${namaSistem} - ${unit}`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/**
 * =========================================================
 * LOGIN MULTI-ROLE
 * Sheet: USERS
 * Header:
 * USER_ID | USERNAME | PASSWORD | NAMA | ROLE | STATUS | POSKO_ID | POSKO
 * =========================================================
 */

/**
 * Dipanggil frontend saat user menekan Login.
 * Tidak mengembalikan password.
 */
function loginUser(username, password) {
  try {
    const user = authenticateUser_(username, password);

    return {
      success: true,
      message: 'Login berhasil.',
      user: user,
      defaultView: 'dashboard'
    };
  } catch (err) {
    return {
      success: false,
      message: err && err.message ? err.message : 'Login gagal.'
    };
  }
}


/**
 * Validasi ulang username + password.
 * Bisa dipakai frontend ketika website dibuka kembali dari localStorage.
 */
function validateLogin(username, password) {
  try {
    const user = authenticateUser_(username, password);

    return {
      success: true,
      user: user,
      defaultView: 'dashboard'
    };
  } catch (err) {
    return {
      success: false,
      message: err && err.message ? err.message : 'Login tidak valid.'
    };
  }
}


/**
 * Membaca USERS dan memverifikasi credential.
 * Password dibandingkan persis dengan nilai kolom PASSWORD.
 */
function authenticateUser_(username, password) {
  username = cleanText_(username).toLowerCase();
  password = String(password === null || password === undefined ? '' : password);

  if (!username || !password) {
    throw new Error('Username dan password wajib diisi.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_USERS);

  if (!sheet) {
    throw new Error('Sheet USERS tidak ditemukan.');
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    throw new Error('Data USERS masih kosong.');
  }

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);

  const wajib = [
    'USER_ID',
    'USERNAME',
    'PASSWORD',
    'NAMA',
    'ROLE',
    'STATUS',
    'POSKO_ID',
    'POSKO'
  ];

  wajib.forEach(nama => {
    if (col[nama] === undefined) {
      throw new Error(`Kolom ${nama} tidak ditemukan di USERS.`);
    }
  });

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowUsername = cleanText_(row[col.USERNAME]).toLowerCase();

    if (rowUsername !== username) continue;

    const rowPassword = String(
      row[col.PASSWORD] === null || row[col.PASSWORD] === undefined
        ? ''
        : row[col.PASSWORD]
    );

    if (rowPassword !== password) {
      throw new Error('Username atau password salah.');
    }

    const status = cleanText_(row[col.STATUS]).toUpperCase();
    if (status !== 'AKTIF') {
      throw new Error('Akun tidak aktif. Hubungi administrator.');
    }

    const role = cleanText_(row[col.ROLE]).toUpperCase();
    if (!['ADMIN', 'POSKO'].includes(role)) {
      throw new Error('Role user tidak valid.');
    }

    const poskoId = cleanText_(row[col.POSKO_ID]).toUpperCase();
    const posko = cleanText_(row[col.POSKO]).toUpperCase();

    if (role === 'POSKO' && (!poskoId || !posko)) {
      throw new Error('Akun POSKO belum memiliki POSKO_ID/POSKO.');
    }

    return {
      userId: cleanText_(row[col.USER_ID]),
      username: cleanText_(row[col.USERNAME]),
      nama: cleanText_(row[col.NAMA]),
      role: role,
      status: status,
      poskoId: poskoId,
      posko: posko
    };
  }

  throw new Error('Username atau password salah.');
}


/**
 * =========================================================
 * DATA DASHBOARD BERDASARKAN USER — V4 GLOBAL VIEW
 * =========================================================
 * ADMIN : semua data.
 * POSKO : semua data / semua penyulang, sama seperti ADMIN untuk area dashboard.
 *
 * Pembatasan wilayah POSKO sengaja TIDAK diterapkan di dashboard/ranking/analisis.
 * Scope Posko hanya diterapkan pada endpoint peta ketika mode "Area Posko"
 * dipilih. Mode "Seluruh Area" tetap dapat digunakan ADMIN maupun POSKO.
 */
function getDashboardDataForUser(username, password) {
  authenticateUser_(username, password);
  return getDashboardData();
}


function filterDashboardDataForUser_(data, user) {
  // Dipertahankan untuk kompatibilitas pemanggil lama, tetapi sekarang semua
  // akun terautentikasi melihat seluruh penyulang di area non-Alert.
  return Array.isArray(data) ? data : [];
}


/**
 * =========================================================
 * DATA BINATANG TERBATAS BERDASARKAN USER
 * =========================================================
 */
function getBinatangDataForUser(username, password) {
  authenticateUser_(username, password);
  return getBinatangData();
}


/**
 * =========================================================
 * MASTER POSKO BERDASARKAN USER
 * =========================================================
 */
function getMasterPoskoForUser(username, password) {
  authenticateUser_(username, password);
  return getMasterPosko_();
}


function getMasterPosko_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MASTER_POSKO);

  if (!sheet) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);

  const wajib = ['POSKO_ID', 'POSKO', 'STATUS'];
  wajib.forEach(nama => {
    if (col[nama] === undefined) {
      throw new Error(`Kolom ${nama} tidak ditemukan di MASTER_POSKO.`);
    }
  });

  const result = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const poskoId = cleanText_(row[col.POSKO_ID]).toUpperCase();
    const posko = cleanText_(row[col.POSKO]).toUpperCase();
    const status = cleanText_(row[col.STATUS]).toUpperCase();

    if (!poskoId && !posko) continue;

    result.push({
      poskoId: poskoId,
      posko: posko,
      status: status
    });
  }

  return result;
}


/**
 * =========================================================
 * MASTER SECTION / SCOPE PETA POSKO
 * =========================================================
 * Aturan section yang dipakai:
 * - satu baris MASTER_SECTION = area mulai KEYPOINT_AWAL sampai sebelum
 *   KEYPOINT_AKHIR;
 * - PIC mengikuti PEMUTUS / KEYPOINT AWAL (downstream), bukan keypoint akhir.
 */
function getMasterSectionForUser(username, password) {
  // Semua role boleh membaca metadata section untuk mode "Seluruh Area".
  // Pembatasan user POSKO diterapkan di endpoint data peta ketika user memilih
  // "Area Posko", bukan saat mengambil daftar section.
  authenticateUser_(username, password);
  return getMasterSection_().filter(item => item.status === 'AKTIF');
}


function getMasterSection_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Tahap 3 sudah membangun MASTER_SECTION utama.
  const sheet = ss.getSheetByName(SHEET_MASTER_SECTION);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);
  const wajib = [
    'SECTION_ID','NAMA_SECTION','PENYULANG','URUTAN','POSKO_ID','POSKO',
    'KEYPOINT_AWAL_ID','KEYPOINT_AKHIR_ID','KETERANGAN','STATUS'
  ];
  wajib.forEach(nama => {
    if (col[nama] === undefined) throw new Error(`Kolom ${nama} tidak ditemukan di MASTER_SECTION.`);
  });

  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const sectionId = cleanText_(row[col.SECTION_ID]).toUpperCase();
    if (!sectionId) continue;

    result.push({
      sectionId: sectionId,
      namaSection: cleanText_(row[col.NAMA_SECTION]),
      penyulang: cleanText_(row[col.PENYULANG]).toUpperCase(),
      urutan: toNumber_(row[col.URUTAN]),
      poskoId: cleanText_(row[col.POSKO_ID]).toUpperCase(),
      posko: cleanText_(row[col.POSKO]).toUpperCase(),
      keypointAwalId: cleanText_(row[col.KEYPOINT_AWAL_ID]).toUpperCase(),
      keypointAkhirId: cleanText_(row[col.KEYPOINT_AKHIR_ID]).toUpperCase(),
      keterangan: cleanText_(row[col.KETERANGAN]),
      status: cleanText_(row[col.STATUS]).toUpperCase()
    });
  }
  return result;
}


function getSectionScopeContext_() {
  const sections = getMasterSection_().filter(item => item.status === 'AKTIF');
  const sectionById = {};
  const feederPoskoSets = {};
  const feederHasBlankPic = {};

  sections.forEach(item => {
    sectionById[item.sectionId] = item;
    const feeder = item.penyulang;
    if (!feederPoskoSets[feeder]) feederPoskoSets[feeder] = {};
    if (item.poskoId) feederPoskoSets[feeder][item.poskoId] = true;
    else feederHasBlankPic[feeder] = true;
  });

  const feederSinglePosko = {};
  Object.keys(feederPoskoSets).forEach(feeder => {
    const ids = Object.keys(feederPoskoSets[feeder]);
    if (ids.length === 1 && !feederHasBlankPic[feeder]) {
      feederSinglePosko[feeder] = ids[0];
    }
  });

  return { sections, sectionById, feederSinglePosko };
}


function buildMasterAsetScopeMap_(asetRows, ctx) {
  const result = {};
  (asetRows || []).forEach(item => {
    const scoped = deriveMapScopeForItem_(item, ctx);
    if (scoped.idAset) {
      result[cleanText_(scoped.idAset).toUpperCase()] = {
        sectionId: scoped.sectionId || '',
        poskoId: scoped.poskoId || ''
      };
    }
  });
  return result;
}




function deriveMapScopeForItem_(item, ctx, assetScopeMap) {
  const out = Object.assign({}, item || {});
  out.sectionId = cleanText_(out.sectionId).toUpperCase();
  out.poskoId = cleanText_(out.poskoId).toUpperCase();
  out.penyulang = cleanText_(out.penyulang).toUpperCase();

  if ((!out.sectionId || !out.poskoId) && assetScopeMap && out.idAset) {
    const inherited = assetScopeMap[cleanText_(out.idAset).toUpperCase()];
    if (inherited) {
      if (!out.sectionId) out.sectionId = inherited.sectionId || '';
      if (!out.poskoId) out.poskoId = inherited.poskoId || '';
    }
  }

  if (out.sectionId && !out.poskoId && ctx.sectionById[out.sectionId]) {
    out.poskoId = ctx.sectionById[out.sectionId].poskoId || '';
  }

  // Fallback AMAN hanya untuk feeder yang seluruh section-nya memiliki satu PIC.
  if (!out.poskoId && out.penyulang && ctx.feederSinglePosko[out.penyulang]) {
    out.poskoId = ctx.feederSinglePosko[out.penyulang];
  }

  return out;
}


function filterScopedMapRows_(data, user, penyulangFilter, poskoFilter, sectionFilter, ctx, assetScopeMap) {
  const feeder = cleanText_(penyulangFilter).toUpperCase();
  const requestedPosko = cleanText_(poskoFilter).toUpperCase();
  const section = cleanText_(sectionFilter).toUpperCase();
  const role = cleanText_(user && user.role).toUpperCase();
  const isGlobalScope = !requestedPosko || ['SEMUA','ALL'].includes(requestedPosko);

  // FINAL ACCESS RULE:
  // - ADMIN + POSKO boleh melihat SELURUH AREA saat poskoFilter = ALL.
  // - Saat memilih AREA POSKO, ADMIN boleh memilih Posko mana pun.
  // - Saat memilih AREA POSKO, user POSKO selalu dipaksa ke POSKO_ID miliknya
  //   walaupun request dimanipulasi dari browser.
  let targetPosko = '';
  if (!isGlobalScope) {
    targetPosko = role === 'POSKO'
      ? cleanText_(user.poskoId).toUpperCase()
      : requestedPosko;
  }

  return (Array.isArray(data) ? data : [])
    .map(item => deriveMapScopeForItem_(item, ctx, assetScopeMap))
    .filter(item => {
      if (feeder && !['SEMUA','ALL'].includes(feeder) && item.penyulang !== feeder) return false;
      if (section && !['SEMUA','ALL'].includes(section) && item.sectionId !== section) return false;
      if (targetPosko && !['SEMUA','ALL'].includes(targetPosko) && item.poskoId !== targetPosko) return false;
      return true;
    });
}


/**
 * =========================================================
 * PETA JARINGAN — SCOPE POSKO BERSIH
 * =========================================================
 * FINAL RULE:
 * - Filter AREA POSKO hanya berlaku untuk TIANG/GARDU dari MASTER_ASET
 *   dan KEYPOINT dari MASTER_KEYPOINT.
 * - GANGGUAN, ALAT_PENAHAN, dan VEGETASI/POHON tetap mengikuti perilaku lama:
 *   hanya mengikuti filter PENYULANG (dan penyebab di frontend), bukan POSKO/SECTION.
 * - ADMIN dan POSKO sama-sama boleh memilih SELURUH AREA.
 * - Saat user role POSKO memilih Area Posko, backend selalu mengunci ke POSKO_ID akun.
 */
function resolveMapTargetPosko_(user, poskoFilter) {
  const requested = cleanText_(poskoFilter).toUpperCase();
  if (!requested || ['SEMUA','ALL'].includes(requested)) return '';

  const role = cleanText_(user && user.role).toUpperCase();
  return role === 'POSKO'
    ? cleanText_(user && user.poskoId).toUpperCase()
    : requested;
}


function isPoskoMapAssetType_(jenisAset) {
  const jenis = cleanText_(jenisAset).toUpperCase();
  return jenis.includes('TIANG') || jenis.includes('GARDU');
}


function filterAsetForMapScope_(data, user, penyulangFilter, poskoFilter, sectionFilter) {
  const feeder = cleanText_(penyulangFilter).toUpperCase();
  const section = cleanText_(sectionFilter).toUpperCase();
  const targetPosko = resolveMapTargetPosko_(user, poskoFilter);

  return (Array.isArray(data) ? data : []).filter(item => {
    if (!isPoskoMapAssetType_(item.jenisAset)) return false;
    const itemFeeder = cleanText_(item.penyulang).toUpperCase();
    const itemSection = cleanText_(item.sectionId).toUpperCase();
    const itemPosko = cleanText_(item.poskoId).toUpperCase();

    if (feeder && !['SEMUA','ALL'].includes(feeder) && itemFeeder !== feeder) return false;
    if (section && !['SEMUA','ALL'].includes(section) && itemSection !== section) return false;
    if (targetPosko && itemPosko !== targetPosko) return false;
    return true;
  });
}


function getMasterKeypoint_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MASTER_KEYPOINT);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);
  const wajib = [
    'KEYPOINT_ID','PENYULANG','URUTAN','NAMA_KEYPOINT','TIPE_KEYPOINT',
    'POSKO_ID','POSKO','LATITUDE','LONGITUDE','STATUS'
  ];
  wajib.forEach(nama => {
    if (col[nama] === undefined) throw new Error(`Kolom ${nama} tidak ditemukan di MASTER_KEYPOINT.`);
  });

  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const keypointId = cleanText_(row[col.KEYPOINT_ID]).toUpperCase();
    if (!keypointId) continue;

    result.push({
      keypointId,
      penyulang: cleanText_(row[col.PENYULANG]).toUpperCase(),
      urutan: toNumber_(row[col.URUTAN]),
      namaKeypoint: cleanText_(row[col.NAMA_KEYPOINT]),
      tipeKeypoint: cleanText_(row[col.TIPE_KEYPOINT]).toUpperCase(),
      poskoId: cleanText_(row[col.POSKO_ID]).toUpperCase(),
      posko: cleanText_(row[col.POSKO]).toUpperCase(),
      latitude: toNullableNumber_(row[col.LATITUDE]),
      longitude: toNullableNumber_(row[col.LONGITUDE]),
      status: cleanText_(row[col.STATUS]).toUpperCase()
    });
  }
  return result;
}


function filterKeypointForMapScope_(data, user, penyulangFilter, poskoFilter, sectionFilter) {
  const feeder = cleanText_(penyulangFilter).toUpperCase();
  const sectionId = cleanText_(sectionFilter).toUpperCase();
  const targetPosko = resolveMapTargetPosko_(user, poskoFilter);
  const isScoped = !!targetPosko || (sectionId && !['SEMUA','ALL'].includes(sectionId));

  const all = (Array.isArray(data) ? data : []).filter(kp => {
    if (kp.status && kp.status !== 'AKTIF') return false;
    if (feeder && !['SEMUA','ALL'].includes(feeder) && cleanText_(kp.penyulang).toUpperCase() !== feeder) return false;
    return true;
  });

  if (!isScoped) return all;

  let sections = getMasterSection_().filter(s => s.status === 'AKTIF');
  if (feeder && !['SEMUA','ALL'].includes(feeder)) {
    sections = sections.filter(s => s.penyulang === feeder);
  }
  if (sectionId && !['SEMUA','ALL'].includes(sectionId)) {
    sections = sections.filter(s => s.sectionId === sectionId);
  } else if (targetPosko) {
    sections = sections.filter(s => s.poskoId === targetPosko);
  }

  // KEYPOINT area Posko = batas-batas section Posko tersebut.
  // Akhir sebuah section ikut ditampilkan walau PIC keypoint berikutnya berbeda,
  // supaya batas area tetap terlihat di peta.
  const allowedIds = {};
  sections.forEach(s => {
    if (s.keypointAwalId) allowedIds[s.keypointAwalId] = true;
    if (s.keypointAkhirId) allowedIds[s.keypointAkhirId] = true;
  });

  return all.filter(kp => !!allowedIds[kp.keypointId]);
}


function filterFeederOnly_(data, penyulangFilter) {
  const feeder = cleanText_(penyulangFilter).toUpperCase();
  return (Array.isArray(data) ? data : []).filter(item => {
    if (!feeder || ['SEMUA','ALL'].includes(feeder)) return true;
    return cleanText_(item.penyulang).toUpperCase() === feeder;
  });
}


/**
 * Endpoint utama peta. Tetap SATU Leaflet.
 * Posko/Section hanya mengubah TIANG + GARDU + KEYPOINT.
 */
function getNetworkMapBundleForUser(username, password, penyulangFilter, poskoFilter, sectionFilter) {
  const user = authenticateUser_(username, password);

  const aset = filterAsetForMapScope_(
    getMasterAset_(), user, penyulangFilter, poskoFilter, sectionFilter
  ).filter(item => item.latitude !== null && item.longitude !== null);

  const keypoint = filterKeypointForMapScope_(
    getMasterKeypoint_(), user, penyulangFilter, poskoFilter, sectionFilter
  ).filter(item => item.latitude !== null && item.longitude !== null);

  // Layer lama TIDAK ikut Area Posko.
  const alat = filterFeederOnly_(getAlatPenahanAktif_(), penyulangFilter)
    .filter(item => item.latitude !== null && item.longitude !== null);

  return {
    aset,
    keypoint,
    alat,
    pohon: [],
    gangguan: []
  };
}


function getMasterAsetForUser(username, password, penyulangFilter, poskoFilter, sectionFilter) {
  const user = authenticateUser_(username, password);
  return filterAsetForMapScope_(
    getMasterAset_(), user, penyulangFilter, poskoFilter, sectionFilter
  ).filter(item => item.latitude !== null && item.longitude !== null);
}


function getMasterKeypointForUser(username, password, penyulangFilter, poskoFilter, sectionFilter) {
  const user = authenticateUser_(username, password);
  return filterKeypointForMapScope_(
    getMasterKeypoint_(), user, penyulangFilter, poskoFilter, sectionFilter
  ).filter(item => item.latitude !== null && item.longitude !== null);
}


function getMasterPohonForUser(username, password, penyulangFilter) {
  authenticateUser_(username, password);
  // VEGETASI: perilaku lama, hanya mengikuti penyulang. Tidak ikut Area Posko.
  return filterFeederOnly_(getMasterPohon_(), penyulangFilter)
    .filter(item => item.latitude !== null && item.longitude !== null);
}


function getAlatPenahanForUser(username, password, penyulangFilter) {
  authenticateUser_(username, password);
  // ALAT PENAHAN: perilaku lama, hanya mengikuti penyulang. Tidak ikut Area Posko.
  return filterFeederOnly_(getAlatPenahanAktif_(), penyulangFilter)
    .filter(item => item.latitude !== null && item.longitude !== null);
}


function getGangguanMapForUser(username, password, penyulangFilter) {
  authenticateUser_(username, password);
  // GANGGUAN: perilaku lama, hanya mengikuti penyulang. Penyebab difilter frontend.
  return filterFeederOnly_(
    getDashboardData().filter(item => item.latitude !== null && item.longitude !== null),
    penyulangFilter
  );
}


// Kompatibilitas fungsi lama: hanya filter penyulang.
function filterMapRowsForUser_(data, user, penyulangFilter) {
  return filterFeederOnly_(data, penyulangFilter);
}


function getMasterAset_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MASTER_ASET);
  if (!sheet) throw new Error('Sheet MASTER_ASET tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);
  const wajib = [
    'ID_ASET','NAMA_ASET','JENIS_ASET','PENYULANG','SECTION_ID','POSKO_ID',
    'LATITUDE','LONGITUDE','FOTO_URL','STATUS'
  ];
  wajib.forEach(nama => {
    if (col[nama] === undefined) throw new Error(`Kolom ${nama} tidak ditemukan di MASTER_ASET.`);
  });

  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const idAset = cleanText_(row[col.ID_ASET]);
    const namaAset = cleanText_(row[col.NAMA_ASET]);
    if (!idAset && !namaAset) continue;

    result.push({
      idAset: idAset,
      namaAset: namaAset,
      jenisAset: cleanText_(row[col.JENIS_ASET]).toUpperCase(),
      penyulang: cleanText_(row[col.PENYULANG]).toUpperCase(),
      sectionId: cleanText_(row[col.SECTION_ID]).toUpperCase(),
      poskoId: cleanText_(row[col.POSKO_ID]).toUpperCase(),
      latitude: toNullableNumber_(row[col.LATITUDE]),
      longitude: toNullableNumber_(row[col.LONGITUDE]),
      fotoUrl: cleanText_(row[col.FOTO_URL]),
      status: cleanText_(row[col.STATUS]).toUpperCase()
    });
  }
  return result;
}


function getMasterPohon_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MASTER_POHON);
  if (!sheet) throw new Error('Sheet MASTER_POHON tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);
  const wajib = [
    'ID_POHON','NAMA_POHON','PENYULANG','ID_ASET','NAMA_TIANG','JENIS_POHON',
    'LATITUDE','LONGITUDE','JARAK_POHON','KONDISI','TANGGAL_SURVEY',
    'SECTION_ID','KETERANGAN','STATUS'
  ];
  wajib.forEach(nama => {
    if (col[nama] === undefined) throw new Error(`Kolom ${nama} tidak ditemukan di MASTER_POHON.`);
  });

  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const idPohon = cleanText_(row[col.ID_POHON]);
    if (!idPohon) continue;

    result.push({
      idPohon: idPohon,
      namaPohon: cleanText_(row[col.NAMA_POHON]),
      penyulang: cleanText_(row[col.PENYULANG]).toUpperCase(),
      idAset: cleanText_(row[col.ID_ASET]),
      namaTiang: cleanText_(row[col.NAMA_TIANG]),
      jenisPohon: cleanText_(row[col.JENIS_POHON]).toUpperCase(),
      latitude: toNullableNumber_(row[col.LATITUDE]),
      longitude: toNullableNumber_(row[col.LONGITUDE]),
      jarakPohon: toNullableNumber_(row[col.JARAK_POHON]),
      kondisi: cleanText_(row[col.KONDISI]).toUpperCase(),
      tanggalSurvey: formatDateForWeb_(row[col.TANGGAL_SURVEY]),
      sectionId: cleanText_(row[col.SECTION_ID]).toUpperCase(),
      poskoId: '',
      keterangan: cleanText_(row[col.KETERANGAN]),
      status: cleanText_(row[col.STATUS]).toUpperCase()
    });
  }
  return result;
}


function getAlatPenahan_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_ALAT_PENAHAN);
  if (!sheet) throw new Error('Sheet ALAT_PENAHAN tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => cleanText_(h).toUpperCase());
  const col = getColumnMap_(headers);
  const wajib = [
    'ID_APUK','TANGGAL','PETUGAS','PENYULANG','SECTION_RAW','ID_ASET','NAMA_ASET',
    'NAIK_DARI','TERPASANG_BH','KURANG_BH','STATUS_PEKERJAAN','LATITUDE','LONGITUDE',
    'FOTO_REF','STATUS_DATA'
  ];
  wajib.forEach(nama => {
    if (col[nama] === undefined) throw new Error(`Kolom ${nama} tidak ditemukan di ALAT_PENAHAN.`);
  });

  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const idApuk = cleanText_(row[col.ID_APUK]);
    if (!idApuk) continue;

    result.push({
      idApuk: idApuk,
      tanggal: formatDateForWeb_(row[col.TANGGAL]),
      petugas: cleanText_(row[col.PETUGAS]),
      penyulang: cleanText_(row[col.PENYULANG]).toUpperCase(),
      sectionRaw: cleanText_(row[col.SECTION_RAW]),
      sectionId: '',
      poskoId: '',
      idAset: cleanText_(row[col.ID_ASET]),
      namaAset: cleanText_(row[col.NAMA_ASET]),
      naikDari: cleanText_(row[col.NAIK_DARI]),
      terpasangBh: toNumber_(row[col.TERPASANG_BH]),
      kurangBh: toNumber_(row[col.KURANG_BH]),
      statusPekerjaan: cleanText_(row[col.STATUS_PEKERJAAN]).toUpperCase(),
      latitude: toNullableNumber_(row[col.LATITUDE]),
      longitude: toNullableNumber_(row[col.LONGITUDE]),
      fotoRef: cleanText_(row[col.FOTO_REF]),
      statusData: cleanText_(row[col.STATUS_DATA]).toUpperCase()
    });
  }
  return result;
}


/**
 * Menghasilkan kondisi TERKINI alat penahan untuk kebutuhan peta.
 *
 * Aturan:
 * 1. Kelompokkan seluruh histori berdasarkan ID_ASET.
 * 2. Ambil record dengan TANGGAL paling baru.
 * 3. Jika tanggal sama, baris yang lebih bawah di sheet dianggap update terakhir.
 * 4. Hanya tampilkan record terbaru dengan TERPASANG_BH > 0.
 * 5. STATUS_PEKERJAAN harus SELESAI atau KURANG. BELUM EKSEKUSI tidak dianggap
 *    sebagai alat yang sudah fix terpasang walaupun ada angka yang tidak konsisten.
 *
 * Histori tidak dihapus; field historiCount dikirim ke frontend untuk popup.
 */
function getAlatPenahanAktif_() {
  const histori = getAlatPenahan_();
  const latestByAsset = {};
  const historyCount = {};

  histori.forEach((item, index) => {
    const idAset = cleanText_(item.idAset);
    if (!idAset) return;

    historyCount[idAset] = (historyCount[idAset] || 0) + 1;

    const sortTime = parseDateSortValue_(item.tanggal);
    const current = latestByAsset[idAset];

    if (
      !current ||
      sortTime > current.__sortTime ||
      (sortTime === current.__sortTime && index > current.__sortIndex)
    ) {
      latestByAsset[idAset] = Object.assign({}, item, {
        __sortTime: sortTime,
        __sortIndex: index
      });
    }
  });

  return Object.keys(latestByAsset)
    .map(idAset => {
      const item = latestByAsset[idAset];
      const output = Object.assign({}, item, {
        historiCount: historyCount[idAset] || 1
      });
      delete output.__sortTime;
      delete output.__sortIndex;
      return output;
    })
    .filter(item => {
      const status = cleanText_(item.statusPekerjaan).toUpperCase();
      return item.terpasangBh > 0 && ['SELESAI', 'KURANG'].includes(status);
    });
}


/**
 * Nilai pembanding tanggal yang toleran terhadap Date object, ISO yyyy-MM-dd,
 * maupun teks dd/MM/yyyy. Dipakai hanya untuk menentukan record terbaru.
 */
function parseDateSortValue_(value) {
  if (!value) return 0;

  if (value instanceof Date) {
    const t = value.getTime();
    return isNaN(t) ? 0 : t;
  }

  const str = String(value).trim();
  if (!str) return 0;

  // yyyy-MM-dd / yyyy-MM-ddTHH:mm:ss
  let match = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    return new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)
    ).getTime();
  }

  // dd/MM/yyyy / dd-MM-yyyy
  match = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    return new Date(
      Number(match[3]), Number(match[2]) - 1, Number(match[1]),
      Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)
    ).getTime();
  }

  const parsed = new Date(str).getTime();
  return isNaN(parsed) ? 0 : parsed;
}


/**
 * =========================================================
 * DATA UTAMA DASHBOARD
 * Sheet: DB_DASHBOARD
 * =========================================================
 * Endpoint lama masih dipertahankan agar frontend v7 tidak rusak.
 * Setelah frontend login baru aktif, pemanggilan sebaiknya dialihkan ke
 * getDashboardDataForUser().
 */
function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_DB_DASHBOARD);

  if (!sheet) {
    throw new Error('Sheet DB_DASHBOARD tidak ditemukan.');
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(h =>
    String(h).trim().toUpperCase()
  );

  const col = getColumnMap_(headers);

  const wajib = [
    'ID_GANGGUAN',
    'PENYULANG',
    'PERALATAN',
    'ULP',
    'TANGGAL_KEJADIAN',
    'KODE_GANGGUAN',
    'URAIAN_PENYEBAB',
    'PENYEBAB',
    'LEPAS',
    'MASUK',
    'BEBAN_AMP',
    'RELE_KERJA',
    'ARUS_GANGGUAN_AMP',
    'LAMA_PADAM_MENIT',
    'ENS_KWH',
    'SIFAT_GANGGUAN'
  ];

  wajib.forEach(nama => {
    if (col[nama] === undefined) {
      throw new Error(`Kolom ${nama} tidak ditemukan di DB_DASHBOARD.`);
    }
  });

  const poskoMap = getPoskoMap_();
  const result = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const idGangguan = cleanText_(row[col.ID_GANGGUAN]);
    const penyulang = cleanText_(row[col.PENYULANG]);

    if (!idGangguan && !penyulang) continue;

    const tanggalRaw = row[col.TANGGAL_KEJADIAN];
    const daftarPosko = poskoMap[penyulang.toUpperCase()] || [];

    result.push({
      idGangguan: idGangguan,
      penyulang: penyulang,
      poskoList: daftarPosko,
      posko: daftarPosko.length
        ? daftarPosko.join(' • ')
        : 'BELUM DIPETAKAN',

      peralatan: cleanText_(row[col.PERALATAN]),
      ulp: cleanText_(row[col.ULP]),
      tanggal: formatDateForWeb_(tanggalRaw),
      kode: cleanText_(row[col.KODE_GANGGUAN]),
      uraian: cleanText_(row[col.URAIAN_PENYEBAB]),
      penyebab: cleanText_(row[col.PENYEBAB]),
      lepas: formatTimeForWeb_(row[col.LEPAS]),
      masuk: formatTimeForWeb_(row[col.MASUK]),
      beban: toNumber_(row[col.BEBAN_AMP]),
      rele: cleanText_(row[col.RELE_KERJA]),
      arus: toNumber_(row[col.ARUS_GANGGUAN_AMP]),
      lamaPadam: toNumber_(row[col.LAMA_PADAM_MENIT]),
      ens: toNumber_(row[col.ENS_KWH]),
      kategori: cleanText_(row[col.SIFAT_GANGGUAN]).toUpperCase(),

      // Kolom enrichment DB_DASHBOARD Q:X.
      idAset: col.ID_ASET !== undefined ? cleanText_(row[col.ID_ASET]) : '',
      sectionId: col.SECTION_ID !== undefined ? cleanText_(row[col.SECTION_ID]).toUpperCase() : '',
      poskoId: col.POSKO_ID !== undefined ? cleanText_(row[col.POSKO_ID]).toUpperCase() : '',
      latitude: col.LATITUDE !== undefined ? toNullableNumber_(row[col.LATITUDE]) : null,
      longitude: col.LONGITUDE !== undefined ? toNullableNumber_(row[col.LONGITUDE]) : null,
      jenisHewan: col.JENIS_HEWAN !== undefined ? cleanText_(row[col.JENIS_HEWAN]).toUpperCase() : '',
      fotoRef: col.FOTO_REF !== undefined ? cleanText_(row[col.FOTO_REF]) : '',
      sumberData: col.SUMBER_DATA !== undefined ? cleanText_(row[col.SUMBER_DATA]).toUpperCase() : '',

      // STATUS_TL tidak lagi wajib karena workflow tindak lanjut sudah dihentikan.
      // Tetap dikirim untuk kompatibilitas frontend lama jika kolomnya masih ada.
      statusTL: col.STATUS_TL !== undefined
        ? (cleanText_(row[col.STATUS_TL]) || 'selesai')
        : 'selesai',

      rowNumber: i + 1
    });
  }

  return result;
}


/**
 * =========================================================
 * DATA BINATANG
 * Sheet: BINATANG
 * =========================================================
 * Dipertahankan sementara sampai migrasi data SIGAP selesai.
 */
function getBinatangData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_BINATANG);

  if (!sheet) {
    return [];
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(h =>
    String(h).trim().toUpperCase()
  );

  const col = getColumnMap_(headers);

  const wajib = [
    'ID_GANGGUAN',
    'PENYULANG',
    'TANGGAL_KEJADIAN',
    'JENIS_BINATANG',
    'URAIAN_PENYEBAB'
  ];

  wajib.forEach(nama => {
    if (col[nama] === undefined) {
      throw new Error(`Kolom ${nama} tidak ditemukan di BINATANG.`);
    }
  });

  const result = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const idGangguan = cleanText_(row[col.ID_GANGGUAN]);
    const penyulang = cleanText_(row[col.PENYULANG]);

    if (!idGangguan && !penyulang) continue;

    result.push({
      idGangguan: idGangguan,
      penyulang: penyulang,
      tanggal: formatDateForWeb_(row[col.TANGGAL_KEJADIAN]),
      jenisBinatang: cleanText_(row[col.JENIS_BINATANG]).toUpperCase(),
      uraian: cleanText_(row[col.URAIAN_PENYEBAB])
    });
  }

  return result;
}


/**
 * =========================================================
 * SETTINGS
 * Sheet: SETTINGS
 * =========================================================
 */
function getSettings() {
  return getSettingsObject_();
}


function getSettingsObject_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SETTINGS);

  const result = {};

  if (!sheet) {
    return result;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return result;
  }

  const data = sheet
    .getRange(2, 1, lastRow - 1, 2)
    .getValues();

  data.forEach(row => {
    const key = cleanText_(row[0]).toUpperCase();

    if (!key) return;

    result[key] = row[1];
  });

  return result;
}


/**
 * =========================================================
 * MAPPING PENYULANG -> POSKO (LEGACY / SEMENTARA)
 * Sheet: POSKO
 * =========================================================
 * Dipakai sampai MASTER_SECTION sudah memiliki pembagian section real.
 */
function getPoskoMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_POSKO_LEGACY);

  const result = {};

  if (!sheet) {
    return result;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return result;
  }

  const data = sheet
    .getRange(2, 1, lastRow - 1, 2)
    .getValues();

  data.forEach(row => {
    const penyulang = cleanText_(row[0]).toUpperCase();
    const posko = cleanText_(row[1]).toUpperCase();

    if (!penyulang || !posko) return;

    if (!result[penyulang]) {
      result[penyulang] = [];
    }

    if (!result[penyulang].includes(posko)) {
      result[penyulang].push(posko);
    }
  });

  return result;
}


/**
 * =========================================================
 * HELPER
 * =========================================================
 */
function getColumnMap_(headers) {
  const result = {};

  headers.forEach((header, index) => {
    if (header) {
      result[header] = index;
    }
  });

  return result;
}


function cleanText_(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value).trim();
}


function toNumber_(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return 0;
  }

  if (typeof value === 'number') {
    return value;
  }

  let str = String(value)
    .trim()
    .replace(/\s/g, '');

  // Format Indonesia
  if (
    str.includes(',') &&
    !str.includes('.')
  ) {
    str = str.replace(',', '.');
  }

  const num = Number(str);

  return isNaN(num) ? 0 : num;
}


function toNullableNumber_(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }

  let str = String(value).trim().replace(/\s/g, '');
  if (!str) return null;

  // Locale Indonesia: -5,12345 -> -5.12345
  if (str.includes(',') && !str.includes('.')) {
    str = str.replace(',', '.');
  }

  const num = Number(str);
  return isNaN(num) ? null : num;
}


function formatDateForWeb_(value) {
  if (!value) return '';

  const timezone =
    Session.getScriptTimeZone() ||
    'Asia/Jakarta';

  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      timezone,
      "yyyy-MM-dd'T'HH:mm:ss"
    );
  }

  return String(value).trim();
}


function formatTimeForWeb_(value) {
  if (!value) return '';

  const timezone =
    Session.getScriptTimeZone() ||
    'Asia/Jakarta';

  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      timezone,
      'HH:mm:ss'
    );
  }

  return String(value).trim();
}


/**
 * =========================================================
 * TEST BACKEND
 * Jalankan manual dari Apps Script
 * =========================================================
 */
function testBackend() {
  const dashboard = getDashboardData();
  const binatang = getBinatangData();
  const settings = getSettings();

  console.log('Jumlah DB_DASHBOARD: ' + dashboard.length);
  console.log('Jumlah BINATANG: ' + binatang.length);
  console.log('SETTINGS: ' + JSON.stringify(settings));

  if (dashboard.length > 0) {
    console.log('CONTOH DATA: ' + JSON.stringify(dashboard[0]));
  }
}


function testLoginAdmin() {
  const hasil = loginUser('YOUR_USERNAME', 'YOUR_PASSWORD');
  console.log(JSON.stringify(hasil));
}


function testLoginPosko() {
  const hasil = loginUser('YOUR_POSKO_USERNAME', 'YOUR_POSKO_PASSWORD');
  console.log(JSON.stringify(hasil));
}


function testDataAdmin() {
  const data = getDashboardDataForUser('YOUR_USERNAME', 'YOUR_PASSWORD');
  console.log('TOTAL ADMIN: ' + data.length);
  if (data.length) console.log(JSON.stringify(data[0]));
}


function testDataPosko() {
  const data = getDashboardDataForUser('YOUR_POSKO_USERNAME', 'YOUR_POSKO_PASSWORD');
  console.log('TOTAL POSKO (sementara level penyulang): ' + data.length);
  if (data.length) console.log(JSON.stringify(data[0]));
}


function testIdGangguan() {
  const data = getDashboardData();

  const map = {};
  const kosong = [];
  const duplikat = [];

  data.forEach((item, index) => {
    const id = String(item.idGangguan || '').trim();

    if (!id) {
      kosong.push(index + 2);
      return;
    }

    if (!map[id]) {
      map[id] = 1;
    } else {
      map[id]++;

      if (map[id] === 2) {
        duplikat.push(id);
      }
    }
  });

  console.log('TOTAL DATA: ' + data.length);
  console.log('ID KOSONG: ' + kosong.length);
  console.log('ID DUPLIKAT: ' + duplikat.length);

  if (kosong.length > 0) {
    console.log('BARIS ID KOSONG: ' + JSON.stringify(kosong));
  }

  if (duplikat.length > 0) {
    console.log('ID DUPLIKAT: ' + JSON.stringify(duplikat));
  }

  if (
    kosong.length === 0 &&
    duplikat.length === 0
  ) {
    console.log('✅ SEMUA ID_GANGGUAN VALID & UNIK');
  }
}


function testEnrichmentDashboard() {
  const data = getDashboardData();
  const total = data.length;
  const denganAset = data.filter(x => !!x.idAset).length;
  const denganKoordinat = data.filter(x => x.latitude !== null && x.longitude !== null).length;
  const denganHewan = data.filter(x => !!x.jenisHewan).length;

  console.log('TOTAL GANGGUAN: ' + total);
  console.log('DENGAN ID_ASET: ' + denganAset);
  console.log('DENGAN KOORDINAT: ' + denganKoordinat);
  console.log('DENGAN JENIS_HEWAN: ' + denganHewan);

  const contoh = data.find(x => x.idAset || x.jenisHewan || (x.latitude !== null && x.longitude !== null));
  if (contoh) console.log('CONTOH ENRICHMENT: ' + JSON.stringify(contoh));
}


function testMapDataAdmin() {
  const aset = getMasterAsetForUser('YOUR_USERNAME', 'YOUR_PASSWORD', 'FEEDER_CONTOH');
  const pohon = getMasterPohonForUser('YOUR_USERNAME', 'YOUR_PASSWORD', 'FEEDER_CONTOH');
  const alat = getAlatPenahanForUser('YOUR_USERNAME', 'YOUR_PASSWORD', 'FEEDER_CONTOH');
  const gangguan = getGangguanMapForUser('YOUR_USERNAME', 'YOUR_PASSWORD', 'FEEDER_CONTOH');

  console.log('GAMBYONG - ASET: ' + aset.length);
  console.log('GAMBYONG - POHON: ' + pohon.length);
  console.log('GAMBYONG - ALAT PENAHAN: ' + alat.length);
  console.log('GAMBYONG - GANGGUAN BERKOORDINAT: ' + gangguan.length);
}

/**
 * TEST ALAT PENAHAN AKTIF
 * Jalankan setelah mengganti Code.gs ke v3.1.
 */
function testAlatPenahanAktif() {
  const semuaAktif = getAlatPenahanAktif_();
  const reog = semuaAktif.filter(x => cleanText_(x.penyulang).toUpperCase() === 'REOG');
  const baung = semuaAktif.filter(x => cleanText_(x.penyulang).toUpperCase() === 'BAUNG 2');

  console.log('TOTAL TITIK ALAT PENAHAN AKTIF: ' + semuaAktif.length);
  console.log('REOG - ALAT PENAHAN AKTIF: ' + reog.length);
  console.log('BAUNG 2 - ALAT PENAHAN AKTIF: ' + baung.length);

  const tidakValid = semuaAktif.filter(x =>
    !(x.terpasangBh > 0) ||
    !['SELESAI', 'KURANG'].includes(cleanText_(x.statusPekerjaan).toUpperCase())
  );
  console.log('RECORD TIDAK VALID YANG LOLOS: ' + tidakValid.length);

  const contoh = reog[0] || semuaAktif[0];
  if (contoh) console.log('CONTOH ALAT AKTIF: ' + JSON.stringify(contoh));
}