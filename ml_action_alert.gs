/**
 * =====================================================================
 * DASHBOARD SRIBAWONO — ALERT AKTIF ALA SIGAP V2
 * =====================================================================
 * Tujuan:
 * 1) Alert feeder dibuat HANYA ketika realisasi bulanan masuk level SAKIT/KRONIS
 *    (0 Sempurna, 1-3 Sehat, 4-6 Sakit, 7+ Kronis), persis aturan SIGAP.
 * 2) Satu alert = satu PENYULANG + satu PERIODE, bukan satu alert per rekomendasi.
 * 3) Rekomendasi ML V2.5 menjadi action plan/checklist di dalam alert.
 * 4) Email awal saat alert masuk SAKIT/KRONIS + reminder berkala sampai selesai.
 * 5) Email bulanan per penyulang pada akhir bulan, dibanding bulan sebelumnya.
 * 6) Action Memory tetap kompatibel dengan ml_dashboard_V2_5_1_action_memory.gs.
 * 7) Halaman Alert hanya READ data; sinkronisasi tidak memblokir saat halaman dibuka.
 *
 * Ganti file ml_action_alert.gs lama dengan file ini.
 * code.gs dan ml_dashboard.gs tidak perlu diubah.
 * =====================================================================
 */

const DBA_VERSION = 'DASHBOARD-SIGAP-ALERT-V2.2-ADMIN-MANUAL';
const DBA_ALERT_SHEET = 'Alert_Log';
const DBA_ACTION_SHEET = 'Risk_Action_Plan';
const DBA_EMAIL_LOG_SHEET = 'Email_Log';
const DBA_RECIPIENT_SHEET = 'Alert_Recipients';
const DBA_CONFIG_SHEET = 'Dashboard_Alert_Config';

const DBA_ALERT_HEADERS = [
  'ID_ALERT','TIMESTAMP','UPDATED_AT','PENYULANG','BULAN','TAHUN','PERIODE',
  'JENIS_ALERT','LEVEL_ALERT','RISK_SCORE','RISK_LEVEL','TOTAL_GANGGUAN',
  'PENYEBAB_DOMINAN','TOTAL_DURASI','TOTAL_ENS','PESAN_ALERT','STATUS_KIRIM',
  'EMAIL_TUJUAN','STATUS_TINDAK_LANJUT','SIKLUS_AKTIF',
  'TOTAL_GANGGUAN_SAAT_MONITORING','MODEL_VERSION','PERIODE_PREDIKSI'
];
const DBA_ACTION_HEADERS = [
  'ID_ACTION','ID_ALERT','TANGGAL','PENYULANG','JENIS_ALERT','TEMUAN','TINDAKAN',
  'PIC','STATUS','TANGGAL_SELESAI','CATATAN','SIKLUS','POIN','KODE_AKSI',
  'ID_ASET','NAMA_ASET','KATEGORI','RISK_ML','SUMBER_REKOMENDASI','MODEL_VERSION',
  'ALASAN_REKOMENDASI','AKTIF_REKOMENDASI','PERIODE_ANALISIS','PERIODE_PREDIKSI',
  'COOLDOWN_BULAN','FOLLOW_UP_OF'
];
const DBA_EMAIL_HEADERS = [
  'ID_EMAIL','TIMESTAMP','JENIS_EMAIL','PENYULANG','BULAN','TAHUN','LEVEL',
  'EMAIL_TUJUAN','SUBJECT','STATUS_KIRIM','PESAN_ERROR','ID_ALERT','SIKLUS_ALERT'
];
const DBA_RECIPIENT_HEADERS = ['NAMA','EMAIL','ROLE','STATUS'];
const DBA_CONFIG_HEADERS = ['KEY','VALUE','KETERANGAN'];

const DBA_MONTHS = ['JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI','JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER'];
const DBA_RISK_EMAIL_INITIAL = 'ALERT_RISK_INITIAL';
const DBA_RISK_EMAIL_REMINDER = 'ALERT_RISK_REMINDER';
const DBA_MONTHLY_EMAIL_TYPE = 'LAPORAN_BULANAN';
const DBA_RISK_TRIGGER_HANDLER = 'runDashboardRiskAlertEmailScheduler';
const DBA_MONTHLY_TRIGGER_HANDLER = 'runDashboardMonthlyEmailScheduler';
const DBA_MONTHLY_WORKER_HANDLER = 'runDashboardMonthlyEmailQueueWorker';
const DBA_MONTHLY_QUEUE_PROPERTY = 'DASHBOARD_MONTHLY_EMAIL_QUEUE_V1';

var DBA_RUNTIME_ALERTS = null;
var DBA_RUNTIME_ACTIONS = null;
var DBA_RUNTIME_GANGGUAN = null;

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function dba_text_(v){ return String(v === null || v === undefined ? '' : v).trim(); }
function dba_norm_(v){ return dba_text_(v).toUpperCase(); }
function dba_num_(v){ const n=Number(v); return isFinite(n)?n:0; }
function dba_uuid_(prefix){ return (prefix||'DBA')+'-'+Utilities.getUuid().replace(/-/g,'').substring(0,16).toUpperCase(); }
function dba_tz_(){ return Session.getScriptTimeZone() || 'Asia/Jakarta'; }
function dba_formatDateTime_(v){
  if(!v)return '';
  const d=v instanceof Date?v:new Date(v);
  if(isNaN(d.getTime()))return dba_text_(v);
  return Utilities.formatDate(d,dba_tz_(),'yyyy-MM-dd HH:mm');
}
function dba_escapeHtml_(value){
  return dba_text_(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function dba_formatNumber_(v,digits){
  const n=dba_num_(v); const d=Math.max(0,Number(digits||0));
  return n.toLocaleString ? n.toLocaleString('id-ID',{maximumFractionDigits:d}) : String(Math.round(n*Math.pow(10,d))/Math.pow(10,d));
}
function dba_monthName_(month){ const m=Number(month); return m>=1&&m<=12?DBA_MONTHS[m-1]:'-'; }
function dba_periodKey_(year,month){
  const y=Number(year),m=Number(month); if(!isFinite(y)||!isFinite(m)||m<1||m>12)return '';
  return String(y)+'-'+String(m).padStart(2,'0');
}
function dba_periodCanonical_(value){
  if(value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value,dba_tz_(),'yyyy-MM');
  const raw=dba_text_(value); if(!raw)return '';
  let m=raw.match(/^(\d{4})-(\d{1,2})(?:$|[-T\s])/);
  if(m)return dba_periodKey_(Number(m[1]),Number(m[2]));
  const d=new Date(value); if(!isNaN(d.getTime()))return Utilities.formatDate(d,dba_tz_(),'yyyy-MM');
  return '';
}
function dba_parsePeriod_(period){
  const key=dba_periodCanonical_(period); if(!key)return {year:0,month:0,key:''};
  const m=key.match(/^(\d{4})-(\d{2})$/); return {year:Number(m[1]),month:Number(m[2]),key:key};
}
function dba_periodSerial_(period){ const p=dba_parsePeriod_(period); return p.year&&p.month?p.year*12+(p.month-1):0; }
function dba_previousPeriod_(year,month){ let y=Number(year),m=Number(month)-1; if(m<1){m=12;y--;} return {year:y,month:m,key:dba_periodKey_(y,m)}; }
function dba_riskLevel_(score){ const s=dba_num_(score); if(s<=0)return 'Sempurna'; if(s<=3)return 'Sehat'; if(s<=6)return 'Sakit'; return 'Kronis'; }
function dba_riskEligible_(score){ return dba_num_(score)>=4; }
function dba_statusPriority_(code){ return ({REPROCESS:0,PENDING:1,PROCESSING:2,COMPLETED:3,CANCELLED:4})[dba_norm_(code)] ?? 9; }
function dba_actionCooldown_(code){
  const map={
    PASANG_ATAU_TAMBAH_ALAT:12,PENGGANTIAN_KOMPONEN:12,PERBAIKAN_SIKUAN:12,PERBAIKAN_KONSTRUKSI:12,
    PEMASANGAN_RAMBU:6,PENGENCANGAN_KONEKSI:6,PANGKAS_VEGETASI:3,EVALUASI_ARRESTER:3,PERIKSA_GROUNDING:3,
    SOSIALISASI_MASYARAKAT:3,INSPEKSI_ALAT:2,EVALUASI_TITIK_BERULANG:2,SURVEI_ULANG_VEGETASI:2,
    INSPEKSI_MATERIAL:2,INSPEKSI_KONDUKTOR:2,INSPEKSI_JOINTING:2,EVALUASI_KONSTRUKSI:2,
    KOORDINASI_PIHAK_EKSTERNAL:1,SURVEI_ULANG:1,MONITORING_TERARAH:1,VERIFIKASI_EFEKTIVITAS_TINDAKAN:1
  };
  return map[dba_norm_(code)]||2;
}
function dba_userCanFeeder_(user,feeder){
  if(!user)return false; if(dba_norm_(user.role)==='ADMIN')return true;
  try{
    const map=getPoskoMap_();
    const allowed=(map[dba_norm_(feeder)]||[]).map(dba_norm_);
    return allowed.includes(dba_norm_(user.posko));
  }catch(e){return false;}
}
function dba_requireAdmin_(user){
  if(!user || dba_norm_(user.role)!=='ADMIN') throw new Error('Akses ditolak. Fitur Alert Aktif hanya untuk akun ADMIN. Akun teknis dapat memantau risiko melalui menu Ranking.');
  return user;
}
function dba_nextPeriodKey_(period){
  const p=dba_parsePeriod_(period); if(!p.key)return '';
  let y=p.year,m=p.month+1; if(m>12){m=1;y++;}
  return dba_periodKey_(y,m);
}

// ---------------------------------------------------------------------
// SHEET / CONFIG SETUP
// ---------------------------------------------------------------------
function dba_ensureSheet_(name,headers){
  const ss=SpreadsheetApp.getActiveSpreadsheet(); let sh=ss.getSheetByName(name);
  if(!sh){ sh=ss.insertSheet(name); sh.getRange(1,1,1,headers.length).setValues([headers]); sh.setFrozenRows(1); }
  const lastCol=Math.max(1,sh.getLastColumn());
  let current=sh.getRange(1,1,1,lastCol).getValues()[0].map(dba_text_);
  headers.forEach(h=>{ if(!current.map(dba_norm_).includes(dba_norm_(h))){ sh.getRange(1,sh.getLastColumn()+1).setValue(h); current.push(h); } });
  try{ sh.getRange(1,1,1,sh.getLastColumn()).setFontWeight('bold').setBackground('#17392B').setFontColor('#FFFFFF'); }catch(e){}
  return sh;
}
function dba_headers_(sh){
  const headers=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(dba_norm_); const map={}; headers.forEach((h,i)=>{if(h)map[h]=i;}); return {headers,map};
}
function dba_rows_(name,headers,force){
  if(name===DBA_ALERT_SHEET&&!force&&Array.isArray(DBA_RUNTIME_ALERTS))return DBA_RUNTIME_ALERTS;
  if(name===DBA_ACTION_SHEET&&!force&&Array.isArray(DBA_RUNTIME_ACTIONS))return DBA_RUNTIME_ACTIONS;
  const sh=dba_ensureSheet_(name,headers); const values=sh.getDataRange().getValues();
  if(values.length<2)return [];
  const hs=values[0].map(dba_norm_);
  const rows=values.slice(1).map((row,idx)=>{const o={_row:idx+2};hs.forEach((h,i)=>{if(h)o[h]=row[i];});return o;}).filter(o=>Object.keys(o).some(k=>k!=='_row'&&dba_text_(o[k])));
  if(name===DBA_ALERT_SHEET)DBA_RUNTIME_ALERTS=rows;
  if(name===DBA_ACTION_SHEET)DBA_RUNTIME_ACTIONS=rows;
  return rows;
}
function dba_resetRuntime_(){ DBA_RUNTIME_ALERTS=null; DBA_RUNTIME_ACTIONS=null; DBA_RUNTIME_GANGGUAN=null; }
function dba_setRow_(sh,rowNo,obj){ const hm=dba_headers_(sh); const vals=sh.getRange(rowNo,1,1,hm.headers.length).getValues()[0]; Object.keys(obj||{}).forEach(k=>{const key=dba_norm_(k);if(hm.map[key]!==undefined)vals[hm.map[key]]=obj[k];}); sh.getRange(rowNo,1,1,vals.length).setValues([vals]); }
function dba_append_(sh,obj){ const hm=dba_headers_(sh); const vals=new Array(hm.headers.length).fill(''); Object.keys(obj||{}).forEach(k=>{const key=dba_norm_(k);if(hm.map[key]!==undefined)vals[hm.map[key]]=obj[k];}); sh.appendRow(vals); }

function dba_forcePeriodTextColumns_(){
  const specs=[
    {name:DBA_ALERT_SHEET,headers:DBA_ALERT_HEADERS,cols:['PERIODE','PERIODE_PREDIKSI']},
    {name:DBA_ACTION_SHEET,headers:DBA_ACTION_HEADERS,cols:['PERIODE_ANALISIS','PERIODE_PREDIKSI']}
  ];
  specs.forEach(spec=>{
    const sh=dba_ensureSheet_(spec.name,spec.headers),hm=dba_headers_(sh),last=Math.max(2,sh.getLastRow());
    spec.cols.forEach(col=>{
      const idx=hm.map[dba_norm_(col)]; if(idx===undefined)return;
      const rg=sh.getRange(2,idx+1,Math.max(1,last-1),1); const vals=rg.getValues();
      let changed=false; vals.forEach((r,i)=>{const c=dba_periodCanonical_(r[0]); if(c && dba_text_(r[0])!==c){r[0]=c;changed=true;} });
      rg.setNumberFormat('@'); if(changed)rg.setValues(vals);
    });
  });
  dba_resetRuntime_();
}
function dba_alertMergeRank_(row,allActions){
  const p=dba_progress_(row,allActions); const status=({COMPLETED:5,REPROCESS:4,PROCESSING:3,PENDING:2,CANCELLED:1})[p.statusCode]||0;
  const updated=row.UPDATED_AT instanceof Date?row.UPDATED_AT.getTime():(new Date(row.UPDATED_AT||0).getTime()||0);
  return status*1e15+updated;
}
function dba_repairDuplicateAlerts_(){
  dba_forcePeriodTextColumns_();
  let alerts=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true),actions=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true);
  const groups={}; alerts.forEach(r=>{
    const period=dba_periodCanonical_(r.PERIODE); if(!period)return;
    const key=[dba_norm_(r.PENYULANG),period,dba_norm_(r.JENIS_ALERT||'RISK_BULANAN')].join('|');
    (groups[key]||(groups[key]=[])).push(r);
  });
  const ash=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS),xsh=dba_ensureSheet_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS);
  let duplicatesRemoved=0,actionsRemoved=0,actionsMerged=0;
  const alertRowsToDelete=[],actionRowsToDelete=[];
  Object.values(groups).forEach(group=>{
    if(group.length<2)return;
    group.sort((a,b)=>dba_alertMergeRank_(b,actions)-dba_alertMergeRank_(a,actions)||a._row-b._row);
    const keep=group[0],dups=group.slice(1),keepId=dba_text_(keep.ID_ALERT),cycle=Math.max(1,dba_num_(keep.SIKLUS_AKTIF)||1);
    const keepActions=actions.filter(a=>dba_text_(a.ID_ALERT)===keepId&&Math.max(1,dba_num_(a.SIKLUS)||1)===cycle);
    dups.forEach(dup=>{
      const dupId=dba_text_(dup.ID_ALERT),dupActions=actions.filter(a=>dba_text_(a.ID_ALERT)===dupId);
      dupActions.forEach(da=>{
        const target=keepActions.find(ka=>dba_norm_(ka.KODE_AKSI)===dba_norm_(da.KODE_AKSI)&&dba_text_(ka.ID_ASET)===dba_text_(da.ID_ASET)&&Math.max(1,dba_num_(ka.SIKLUS)||1)===Math.max(1,dba_num_(da.SIKLUS)||1));
        if(target && dba_norm_(da.STATUS)==='SELESAI' && dba_norm_(target.STATUS)!=='SELESAI'){
          dba_setRow_(xsh,target._row,{STATUS:'SELESAI',TANGGAL_SELESAI:da.TANGGAL_SELESAI,PIC:da.PIC,CATATAN:da.CATATAN}); actionsMerged++;
        }
        actionRowsToDelete.push(da._row);
      });
      alertRowsToDelete.push(dup._row); duplicatesRemoved++;
    });
  });
  [...new Set(actionRowsToDelete)].sort((a,b)=>b-a).forEach(r=>{xsh.deleteRow(r);actionsRemoved++;});
  [...new Set(alertRowsToDelete)].sort((a,b)=>b-a).forEach(r=>ash.deleteRow(r));
  dba_resetRuntime_(); dba_forcePeriodTextColumns_();
  return {duplicatesRemoved,actionsRemoved,actionsMerged};
}
function dba_ensureConfig_(){
  const sh=dba_ensureSheet_(DBA_CONFIG_SHEET,DBA_CONFIG_HEADERS); const existing=dba_rows_(DBA_CONFIG_SHEET,DBA_CONFIG_HEADERS,true); const keys={}; existing.forEach(r=>keys[dba_norm_(r.KEY)]=true);
  const defaults=[
    ['ALERT_ENABLED','TRUE','Buat Alert ketika Risk Score >= 4 (SAKIT/KRONIS).'],
    ['ALERT_SEND_EMAIL','FALSE','Kirim email alert awal/reminder. Aktifkan setelah Alert_Recipients terisi.'],
    ['ALERT_COOLDOWN_DAYS','7','Jeda reminder email alert yang belum selesai.'],
    ['ALERT_DAILY_HOUR','8','Jam trigger pengecekan alert harian.'],
    ['MONTHLY_EMAIL_ENABLED','FALSE','Kirim laporan bulanan per penyulang.'],
    ['MONTHLY_DAILY_HOUR','20','Jam scheduler bulanan; email hanya mulai pada hari terakhir bulan.'],
    ['MONTHLY_QUEUE_DELAY_MINUTES','5','Jeda kirim email bulanan antar penyulang.']
  ];
  defaults.forEach(r=>{if(!keys[r[0]])sh.appendRow(r);});
  return sh;
}
function dba_config_(key,fallback){
  dba_ensureConfig_(); const rows=dba_rows_(DBA_CONFIG_SHEET,DBA_CONFIG_HEADERS,true); const found=rows.find(r=>dba_norm_(r.KEY)===dba_norm_(key)); return found?found.VALUE:fallback;
}
function dba_setConfig_(key,value){
  const sh=dba_ensureConfig_(); const rows=dba_rows_(DBA_CONFIG_SHEET,DBA_CONFIG_HEADERS,true); const found=rows.find(r=>dba_norm_(r.KEY)===dba_norm_(key));
  if(found)dba_setRow_(sh,found._row,{VALUE:value}); else dba_append_(sh,{KEY:key,VALUE:value,KETERANGAN:''});
}
function dba_boolConfig_(key,fallback){ return ['TRUE','1','YA','YES','AKTIF'].includes(dba_norm_(dba_config_(key,fallback?'TRUE':'FALSE'))); }
function dba_getRecipients_(){
  const rows=dba_rows_(DBA_RECIPIENT_SHEET,DBA_RECIPIENT_HEADERS,true);
  return rows.filter(r=>dba_norm_(r.STATUS)==='AKTIF'&&dba_text_(r.EMAIL)).map(r=>({nama:dba_text_(r.NAMA),email:dba_text_(r.EMAIL),role:dba_text_(r.ROLE)}));
}
function setupDashboardSigapAlertV2(){
  dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS);
  dba_ensureSheet_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS);
  dba_ensureSheet_(DBA_EMAIL_LOG_SHEET,DBA_EMAIL_HEADERS);
  dba_ensureSheet_(DBA_RECIPIENT_SHEET,DBA_RECIPIENT_HEADERS);
  dba_ensureConfig_();
  dba_resetRuntime_();
  const repair=dba_repairDuplicateAlerts_();
  const sync=dba_syncRiskAlertsInternal_({sendEmail:false});
  return {success:true,version:DBA_VERSION,sheets:[DBA_ALERT_SHEET,DBA_ACTION_SHEET,DBA_EMAIL_LOG_SHEET,DBA_RECIPIENT_SHEET,DBA_CONFIG_SHEET],repair:repair,sync:sync,recipients:dba_getRecipients_().length,message:'Sistem Alert ala SIGAP siap. Isi Alert_Recipients lalu jalankan setupDashboardAlertEmailAutomation().'};
}

// ---------------------------------------------------------------------
// MONTHLY ACTUAL STATS — source DB_DASHBOARD
// ---------------------------------------------------------------------
function dba_parseDashboardDate_(v){
  if(!v)return null; if(v instanceof Date)return isNaN(v.getTime())?null:v;
  const raw=dba_text_(v); let m=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
  m=raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); if(m)return new Date(Number(m[3]),Number(m[2])-1,Number(m[1]));
  const d=new Date(raw); return isNaN(d.getTime())?null:d;
}
function dba_getGangguan_(){
  if(Array.isArray(DBA_RUNTIME_GANGGUAN))return DBA_RUNTIME_GANGGUAN;
  let data=[]; try{data=getDashboardData();}catch(e){data=[];}
  DBA_RUNTIME_GANGGUAN=(Array.isArray(data)?data:[]).map(g=>{
    const date=dba_parseDashboardDate_(g.tanggal); return {
      tanggal:date,penyulang:dba_norm_(g.penyulang),penyebab:dba_norm_(g.penyebab)||'TIDAK DIKETAHUI',
      idAset:dba_text_(g.idAset),lamaPadam:dba_num_(g.lamaPadam),ens:dba_num_(g.ens),kategori:dba_norm_(g.kategori)
    };
  }).filter(g=>g.tanggal&&g.penyulang);
  return DBA_RUNTIME_GANGGUAN;
}
function dba_buildMonthlyMaps_(){
  const maps={}; let latestSerial=0,latestKey='';
  dba_getGangguan_().forEach(g=>{
    const y=Number(Utilities.formatDate(g.tanggal,dba_tz_(),'yyyy')); const m=Number(Utilities.formatDate(g.tanggal,dba_tz_(),'M')); const key=dba_periodKey_(y,m); const serial=y*12+(m-1);
    if(serial>latestSerial){latestSerial=serial;latestKey=key;}
    if(!maps[key])maps[key]={}; if(!maps[key][g.penyulang])maps[key][g.penyulang]={penyulang:g.penyulang,year:y,month:m,period:key,totalGangguan:0,totalDurasi:0,totalEns:0,jumlahSesaat:0,jumlahPermanen:0,causeCounts:{}};
    const s=maps[key][g.penyulang]; s.totalGangguan++; s.totalDurasi+=g.lamaPadam; s.totalEns+=g.ens; if(g.kategori==='SESAAT')s.jumlahSesaat++; else if(g.kategori==='PERMANEN')s.jumlahPermanen++; s.causeCounts[g.penyebab]=(s.causeCounts[g.penyebab]||0)+1;
  });
  Object.keys(maps).forEach(k=>Object.values(maps[k]).forEach(s=>{
    const top=Object.entries(s.causeCounts).sort((a,b)=>b[1]-a[1])[0]||['-',0]; s.penyebabDominan=top[0]; s.penyebabDominanCount=top[1]; s.riskScore=s.totalGangguan; s.riskLevel=dba_riskLevel_(s.riskScore);
  }));
  return {maps,latestKey,latestSerial};
}
function dba_emptyStats_(feeder,year,month){ return {penyulang:feeder,year:Number(year),month:Number(month),period:dba_periodKey_(year,month),totalGangguan:0,totalDurasi:0,totalEns:0,jumlahSesaat:0,jumlahPermanen:0,causeCounts:{},penyebabDominan:'-',penyebabDominanCount:0,riskScore:0,riskLevel:'Sempurna'}; }
function dba_feederList_(){ const set={}; dba_getGangguan_().forEach(g=>set[g.penyulang]=true); try{(mld_readPredictionObjects_()||[]).forEach(r=>set[dba_norm_(r.PENYULANG)]=true);}catch(e){} return Object.keys(set).filter(Boolean).sort(); }

// ---------------------------------------------------------------------
// ML RECOMMENDATIONS FOR ACTION PLAN
// ---------------------------------------------------------------------
function dba_findPredictionRow_(feeder,analysisPeriod){
  let rows=[]; try{rows=mld_readPredictionObjects_();}catch(e){rows=[];}
  const f=dba_norm_(feeder),period=dba_periodCanonical_(analysisPeriod);
  let row=rows.find(r=>dba_norm_(r.PENYULANG)===f&&dba_periodCanonical_(r.PERIODE_ANALISIS)===period);
  if(!row)row=rows.filter(r=>dba_norm_(r.PENYULANG)===f).sort((a,b)=>dba_num_(b.BULAN_INDEX)-dba_num_(a.BULAN_INDEX))[0];
  return row||null;
}
function dba_safeJsonArray_(v){ if(Array.isArray(v))return v; try{const x=JSON.parse(String(v||'[]'));return Array.isArray(x)?x:[];}catch(e){return [];} }
function dba_actionDefinitions_(feeder,analysisPeriod){
  analysisPeriod=dba_periodCanonical_(analysisPeriod); const row=dba_findPredictionRow_(feeder,analysisPeriod); if(!row)return [];
  let recs=dba_safeJsonArray_(row.REKOMENDASI_JSON);
  const prediction=dba_periodCanonical_(row.PERIODE_PREDIKSI);
  // Action memory tetap dipakai: tindakan selesai bisa ditahan/diganti verifikasi.
  if(typeof mlaa_filterRecommendationsForContract_==='function' && mlaa_filterRecommendationsForContract_!==dba_filterRecommendationsForMemory_){
    try{ const mem=mlaa_filterRecommendationsForContract_(feeder,analysisPeriod,prediction,recs); recs=Array.isArray(mem.shown)?mem.shown:recs; }catch(e){}
  } else {
    const mem=dba_filterRecommendationsForMemory_(feeder,analysisPeriod,prediction,recs); recs=mem.shown;
  }
  if(!recs.length){
    recs=[{kategori:'SEMUA',kodeWO:'MONITORING_TERARAH',idAset:'',namaAset:'',tindakan:'Lakukan monitoring terarah pada penyulang '+feeder+'.',alasan:'Penyulang masuk level SAKIT/KRONIS tetapi rekomendasi spesifik ML belum tersedia.',causeRisk:0}];
  }
  const pointEach=Math.max(1,Math.floor(100/recs.length)); let assigned=0;
  return recs.map((r,i)=>{
    const poin=i===recs.length-1?Math.max(1,100-assigned):pointEach; assigned+=poin;
    return {kodeAksi:dba_text_(r.kodeWO)||'MONITORING_TERARAH',idAset:dba_text_(r.idAset),namaAset:dba_text_(r.namaAset),kategori:dba_text_(r.kategori),riskML:dba_num_(r.causeRisk||r.skorPrioritas),tindakan:dba_text_(r.tindakan)||String(r.kodeWO||'Tindakan').replace(/_/g,' '),alasan:dba_text_(r.alasan),poin:poin,modelVersion:dba_text_(row.MODEL_VERSION),periodePrediksi:prediction,followUpOf:dba_text_(r.followUpOf)};
  });
}
function dba_syncActionRowsForAlert_(alertRow){
  const sh=dba_ensureSheet_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS); const existing=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true);
  const id=dba_text_(alertRow.ID_ALERT),cycle=Math.max(1,dba_num_(alertRow.SIKLUS_AKTIF)||1); const defs=dba_actionDefinitions_(alertRow.PENYULANG,alertRow.PERIODE);
  const now=new Date(); const touched={};
  defs.forEach(def=>{
    const key=[id,cycle,def.kodeAksi,def.idAset||'FEEDER'].join('|'); touched[key]=true;
    const old=existing.find(r=>dba_text_(r.ID_ALERT)===id&&Math.max(1,dba_num_(r.SIKLUS)||1)===cycle&&dba_text_(r.KODE_AKSI)===def.kodeAksi&&dba_text_(r.ID_ASET)===def.idAset);
    const base={ID_ALERT:id,TANGGAL:old?old.TANGGAL:now,PENYULANG:alertRow.PENYULANG,JENIS_ALERT:'RISK_BULANAN',TEMUAN:def.alasan,TINDAKAN:def.tindakan,STATUS:old?old.STATUS:'BELUM SELESAI',TANGGAL_SELESAI:old?old.TANGGAL_SELESAI:'',PIC:old?old.PIC:'',CATATAN:old?old.CATATAN:'',SIKLUS:cycle,POIN:def.poin,KODE_AKSI:def.kodeAksi,ID_ASET:def.idAset,NAMA_ASET:def.namaAset,KATEGORI:def.kategori,RISK_ML:def.riskML,SUMBER_REKOMENDASI:'MACHINE_LEARNING',MODEL_VERSION:def.modelVersion,ALASAN_REKOMENDASI:def.alasan,AKTIF_REKOMENDASI:'YA',PERIODE_ANALISIS:dba_periodCanonical_(alertRow.PERIODE),PERIODE_PREDIKSI:dba_periodCanonical_(def.periodePrediksi),COOLDOWN_BULAN:dba_actionCooldown_(def.kodeAksi),FOLLOW_UP_OF:def.followUpOf};
    if(old)dba_setRow_(sh,old._row,base); else dba_append_(sh,Object.assign({ID_ACTION:dba_uuid_('ACT')},base));
  });
  existing.filter(r=>dba_text_(r.ID_ALERT)===id&&Math.max(1,dba_num_(r.SIKLUS)||1)===cycle).forEach(r=>{
    const key=[id,cycle,dba_text_(r.KODE_AKSI),dba_text_(r.ID_ASET)||'FEEDER'].join('|'); if(!touched[key]&&dba_norm_(r.STATUS)!=='SELESAI')dba_setRow_(sh,r._row,{AKTIF_REKOMENDASI:'TIDAK'});
  });
  dba_resetRuntime_(); return defs.length;
}

// ---------------------------------------------------------------------
// ALERT SYNC — ONLY SAKIT/KRONIS
// ---------------------------------------------------------------------
function dba_buildAlertMessage_(s){ return 'Penyulang '+s.penyulang+' berada pada level '+dba_norm_(s.riskLevel)+' dengan '+s.totalGangguan+' gangguan pada '+dba_monthName_(s.month)+' '+s.year+'. Segera buka Alert Aktif dan proses rekomendasi penanganan.'; }
function dba_findAlert_(feeder,period){ const key=dba_periodCanonical_(period); return dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_norm_(r.PENYULANG)===dba_norm_(feeder)&&dba_periodCanonical_(r.PERIODE)===key&&dba_norm_(r.JENIS_ALERT)==='RISK_BULANAN'); }
function dba_progress_(alertRow,allActions){
  const id=dba_text_(alertRow.ID_ALERT),cycle=Math.max(1,dba_num_(alertRow.SIKLUS_AKTIF)||1);
  const rows=(allActions||dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true)).filter(r=>dba_text_(r.ID_ALERT)===id&&Math.max(1,dba_num_(r.SIKLUS)||1)===cycle&&dba_norm_(r.AKTIF_REKOMENDASI)!=='TIDAK');
  const total=rows.reduce((s,r)=>s+Math.max(0,dba_num_(r.POIN)||1),0)||100; const done=rows.filter(r=>dba_norm_(r.STATUS)==='SELESAI'); const point=done.reduce((s,r)=>s+Math.max(0,dba_num_(r.POIN)||1),0);
  const internal=dba_norm_(alertRow.STATUS_TINDAK_LANJUT||'BELUM DITANGANI'); let statusCode='PENDING',statusTampilan='BELUM DIPROSES',actionLabel='Proses',locked=false;
  if(['DIBATALKAN','BATAL'].includes(internal)){statusCode='CANCELLED';statusTampilan='DIBATALKAN';actionLabel='Dibatalkan';locked=true;}
  else if(['SUDAH DIMONITORING','SELESAI'].includes(internal)||done.length===rows.length&&rows.length>0){statusCode='COMPLETED';statusTampilan='TELAH DIPROSES';actionLabel='Telah Diproses';locked=true;}
  else if(internal==='PERLU MONITORING ULANG'){statusCode='REPROCESS';statusTampilan='PERLU DIPROSES ULANG';actionLabel='Proses Ulang';}
  else if(done.length>0){statusCode='PROCESSING';statusTampilan='SEDANG DIPROSES';actionLabel='Lanjutkan Proses';}
  return {rows,totalPoin:Math.min(total,point),maksimalPoin:Math.max(1,total),jumlahSelesai:done.length,totalTindakan:rows.length,progressPercent:Math.round(Math.min(total,point)/Math.max(1,total)*100),statusCode,statusTampilan,actionLabel,isLocked:locked,siklusAktif:cycle};
}
function dba_createAlert_(s){
  const sh=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS),now=new Date(),pred=dba_findPredictionRow_(s.penyulang,s.period); const id=dba_uuid_('ALT');
  const obj={ID_ALERT:id,TIMESTAMP:now,UPDATED_AT:now,PENYULANG:s.penyulang,BULAN:dba_monthName_(s.month),TAHUN:String(s.year),PERIODE:dba_periodCanonical_(s.period),JENIS_ALERT:'RISK_BULANAN',LEVEL_ALERT:dba_norm_(s.riskLevel),RISK_SCORE:s.riskScore,RISK_LEVEL:s.riskLevel,TOTAL_GANGGUAN:s.totalGangguan,PENYEBAB_DOMINAN:s.penyebabDominan,TOTAL_DURASI:s.totalDurasi,TOTAL_ENS:s.totalEns,PESAN_ALERT:dba_buildAlertMessage_(s),STATUS_KIRIM:'TIDAK_DIKIRIM',EMAIL_TUJUAN:'',STATUS_TINDAK_LANJUT:'BELUM DITANGANI',SIKLUS_AKTIF:1,TOTAL_GANGGUAN_SAAT_MONITORING:'',MODEL_VERSION:pred?dba_text_(pred.MODEL_VERSION):'',PERIODE_PREDIKSI:pred?dba_periodCanonical_(pred.PERIODE_PREDIKSI):''};
  dba_append_(sh,obj); dba_resetRuntime_(); const fresh=dba_findAlert_(s.penyulang,s.period); dba_syncActionRowsForAlert_(fresh||obj); return id;
}
function dba_updateAlert_(row,s){
  const sh=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS),progress=dba_progress_(row),now=new Date(); let cycle=Math.max(1,dba_num_(row.SIKLUS_AKTIF)||1),status=dba_norm_(row.STATUS_TINDAK_LANJUT)||'BELUM DITANGANI',reopened=false;
  if(progress.statusCode==='COMPLETED'&&s.totalGangguan>dba_num_(row.TOTAL_GANGGUAN_SAAT_MONITORING||row.TOTAL_GANGGUAN)){
    cycle++; status='PERLU MONITORING ULANG'; reopened=true;
  }
  const pred=dba_findPredictionRow_(s.penyulang,s.period);
  dba_setRow_(sh,row._row,{UPDATED_AT:now,LEVEL_ALERT:dba_norm_(s.riskLevel),RISK_SCORE:s.riskScore,RISK_LEVEL:s.riskLevel,TOTAL_GANGGUAN:s.totalGangguan,PENYEBAB_DOMINAN:s.penyebabDominan,TOTAL_DURASI:s.totalDurasi,TOTAL_ENS:s.totalEns,PESAN_ALERT:dba_buildAlertMessage_(s),STATUS_TINDAK_LANJUT:status,SIKLUS_AKTIF:cycle,MODEL_VERSION:pred?dba_text_(pred.MODEL_VERSION):row.MODEL_VERSION,PERIODE_PREDIKSI:pred?dba_periodCanonical_(pred.PERIODE_PREDIKSI):dba_periodCanonical_(row.PERIODE_PREDIKSI)});
  dba_resetRuntime_(); const fresh=dba_findAlert_(s.penyulang,s.period); dba_syncActionRowsForAlert_(fresh); return {idAlert:dba_text_(row.ID_ALERT),reopened,status:reopened?'MONITORING_ULANG_DIBUKA':'DIPERBARUI'};
}
function dba_syncRiskAlertsInternal_(options){
  options=options||{}; if(!dba_boolConfig_('ALERT_ENABLED',true))return {status:'NONAKTIF',created:0,updated:0,reopened:0,cancelled:0,period:''};
  const monthly=dba_buildMonthlyMaps_(),period=options.period||monthly.latestKey; if(!period)return {status:'TIDAK_ADA_DATA',created:0,updated:0,reopened:0,cancelled:0,period:''};
  const p=dba_parsePeriod_(period),statsMap=monthly.maps[period]||{},feeders=dba_feederList_(); let created=0,updated=0,reopened=0,cancelled=0; const createdIds=[],reopenedIds=[];
  feeders.forEach(feeder=>{
    const s=statsMap[feeder]||dba_emptyStats_(feeder,p.year,p.month); const old=dba_findAlert_(feeder,period);
    if(dba_riskEligible_(s.riskScore)){
      if(!old){const id=dba_createAlert_(s);created++;createdIds.push(id);} else {const r=dba_updateAlert_(old,s);updated++;if(r.reopened){reopened++;reopenedIds.push(r.idAlert);}}
    } else if(old && !['SUDAH DIMONITORING','SELESAI','DIBATALKAN'].includes(dba_norm_(old.STATUS_TINDAK_LANJUT))){
      const sh=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS); dba_setRow_(sh,old._row,{UPDATED_AT:new Date(),RISK_SCORE:s.riskScore,RISK_LEVEL:s.riskLevel,TOTAL_GANGGUAN:s.totalGangguan,STATUS_TINDAK_LANJUT:'DIBATALKAN'}); cancelled++; dba_resetRuntime_();
    }
  });
  if(options.sendEmail===true&&dba_boolConfig_('ALERT_SEND_EMAIL',false)){
    createdIds.concat(reopenedIds).forEach(id=>{try{dba_sendRiskAlertEmailForAlert_(id,{allowReminder:false});}catch(e){}});
  }
  dba_clearAlertCache_();
  return {status:'SELESAI',version:DBA_VERSION,period,bulan:dba_monthName_(p.month),tahun:String(p.year),created,updated,reopened,cancelled,eligible:Object.values(statsMap).filter(s=>dba_riskEligible_(s.riskScore)).length};
}
function syncDashboardRiskAlertsForUser(username,password){ dba_requireAdmin_(authenticateUser_(username,password)); return dba_syncRiskAlertsInternal_({sendEmail:true}); }

// Compatibility: rebuildMLDashboard() V2.5.1 otomatis memanggil fungsi ini.
function mlaa_syncLatestInternal_(){ return dba_syncRiskAlertsInternal_({sendEmail:false}); }

// ---------------------------------------------------------------------
// ACTION MEMORY COMPATIBILITY
// ---------------------------------------------------------------------
function dba_latestCompletedAction_(feeder,rec){
  const rows=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true).filter(r=>dba_norm_(r.PENYULANG)===dba_norm_(feeder)&&dba_norm_(r.STATUS)==='SELESAI'&&dba_norm_(r.KATEGORI)===dba_norm_(rec.kategori)&&dba_norm_(r.KODE_AKSI)===dba_norm_(rec.kodeWO)&&dba_norm_(r.ID_ASET||'FEEDER')===dba_norm_(rec.idAset||'FEEDER'));
  rows.sort((a,b)=>dba_periodSerial_(b.PERIODE_PREDIKSI)-dba_periodSerial_(a.PERIODE_PREDIKSI)||new Date(b.TANGGAL_SELESAI||0)-new Date(a.TANGGAL_SELESAI||0)); return rows[0]||null;
}
function dba_hasNewMatchingGangguan_(completed,feeder,rec){
  const done=completed&&completed.TANGGAL_SELESAI?new Date(completed.TANGGAL_SELESAI):null; if(!done||isNaN(done.getTime()))return false;
  const cause=dba_norm_(rec.kategori),asset=dba_text_(rec.idAset);
  return dba_getGangguan_().some(g=>g.tanggal>done&&g.penyulang===dba_norm_(feeder)&&(!asset||dba_text_(g.idAset)===asset)&&g.penyebab===cause);
}
function dba_filterRecommendationsForMemory_(feeder,analysisPeriod,predictionPeriod,recs){
  const shown=[],suppressed=[],seen={};
  (Array.isArray(recs)?recs:[]).forEach(original=>{
    const rec=Object.assign({},original||{}); if(!rec.kodeWO){shown.push(rec);return;}
    const completed=dba_latestCompletedAction_(feeder,rec); if(!completed){shown.push(rec);return;}
    const cooldown=Math.max(1,dba_num_(completed.COOLDOWN_BULAN)||dba_actionCooldown_(rec.kodeWO)); const completedSerial=dba_periodSerial_(completed.PERIODE_PREDIKSI),newSerial=dba_periodSerial_(predictionPeriod); const within=completedSerial>0&&newSerial>=completedSerial&&(newSerial-completedSerial)<=cooldown; const recurrence=dba_hasNewMatchingGangguan_(completed,feeder,rec);
    if(recurrence){
      const follow=Object.assign({},rec,{kodeWO:'VERIFIKASI_EFEKTIVITAS_TINDAKAN',tindakan:'Verifikasi efektivitas tindakan sebelumnya pada '+(rec.namaAset||rec.idAset||feeder)+'.',alasan:'Tindakan sebelumnya sudah SELESAI, tetapi terjadi gangguan '+dba_text_(rec.kategori)+' baru setelah penyelesaian. Verifikasi efektivitas sebelum mengulang WO lama.',followUpOf:dba_text_(completed.ID_ACTION),historyStatus:'FOLLOW_UP'});
      const key=[dba_norm_(follow.kodeWO),dba_norm_(follow.idAset||'FEEDER'),dba_norm_(follow.kategori)].join('|'); if(!seen[key]){shown.push(follow);seen[key]=true;} suppressed.push({rekomendasi:rec,reason:'Diganti verifikasi efektivitas karena ada gangguan baru.',completedId:completed.ID_ACTION}); return;
    }
    if(within){suppressed.push({rekomendasi:rec,reason:'Tindakan sudah selesai dan masih dalam cooldown '+cooldown+' bulan.',completedId:completed.ID_ACTION,cooldownBulan:cooldown});return;}
    shown.push(rec);
  });
  return {shown,suppressed};
}
function mlaa_filterRecommendationsForContract_(feeder,analysisPeriod,predictionPeriod,recs){ return dba_filterRecommendationsForMemory_(feeder,analysisPeriod,predictionPeriod,recs); }

// ---------------------------------------------------------------------
// FRONTEND CONTRACT — FAST READ, NO AUTO-SYNC
// ---------------------------------------------------------------------
function dba_actionContract_(r){ return {idAction:dba_text_(r.ID_ACTION),kodeAksi:dba_text_(r.KODE_AKSI),idAset:dba_text_(r.ID_ASET),namaAset:dba_text_(r.NAMA_ASET),kategori:dba_text_(r.KATEGORI),riskML:dba_num_(r.RISK_ML),tindakan:dba_text_(r.TINDAKAN),alasan:dba_text_(r.ALASAN_REKOMENDASI||r.TEMUAN),status:dba_norm_(r.STATUS)||'BELUM SELESAI',checked:dba_norm_(r.STATUS)==='SELESAI',pic:dba_text_(r.PIC),tanggalSelesai:dba_formatDateTime_(r.TANGGAL_SELESAI),catatan:dba_text_(r.CATATAN),poin:dba_num_(r.POIN),cooldownBulan:dba_num_(r.COOLDOWN_BULAN),sumberRekomendasi:dba_text_(r.SUMBER_REKOMENDASI),modelVersion:dba_text_(r.MODEL_VERSION)}; }
function dba_alertContract_(row,actions){
  const progress=dba_progress_(row,actions); return {idAlert:dba_text_(row.ID_ALERT),timestamp:dba_formatDateTime_(row.TIMESTAMP),updatedAt:dba_formatDateTime_(row.UPDATED_AT),penyulang:dba_text_(row.PENYULANG),bulan:dba_text_(row.BULAN),tahun:dba_text_(row.TAHUN),periode:dba_periodCanonical_(row.PERIODE),periodePrediksi:dba_periodCanonical_(row.PERIODE_PREDIKSI),jenisAlert:dba_norm_(row.JENIS_ALERT),levelAlert:dba_norm_(row.LEVEL_ALERT),riskScore:dba_num_(row.RISK_SCORE),riskLevel:dba_text_(row.RISK_LEVEL),totalGangguan:dba_num_(row.TOTAL_GANGGUAN),penyebabDominan:dba_text_(row.PENYEBAB_DOMINAN),totalDurasi:dba_num_(row.TOTAL_DURASI),totalEns:dba_num_(row.TOTAL_ENS),pesanAlert:dba_text_(row.PESAN_ALERT),statusKirim:dba_text_(row.STATUS_KIRIM),emailTujuan:dba_text_(row.EMAIL_TUJUAN),statusTindakLanjut:dba_text_(row.STATUS_TINDAK_LANJUT),statusTampilan:progress.statusTampilan,statusCode:progress.statusCode,actionLabel:progress.actionLabel,isLocked:progress.isLocked,progressPercent:progress.progressPercent,totalPoin:progress.totalPoin,maksimalPoin:progress.maksimalPoin,jumlahSelesai:progress.jumlahSelesai,totalTindakan:progress.totalTindakan,siklusAktif:progress.siklusAktif,actions:progress.rows.map(dba_actionContract_)}; }
function dba_alertCacheKey_(user){ return 'DBA:V2:'+dba_norm_(user.role)+':'+dba_norm_(user.username)+':'+dba_norm_(user.posko); }
function dba_clearAlertCache_(){ try{CacheService.getScriptCache().removeAll(['DBA:ALL']);}catch(e){} }
function getDashboardRiskAlertsForUser(username,password){
  const user=dba_requireAdmin_(authenticateUser_(username,password)); const allAlerts=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).filter(r=>dba_text_(r.ID_ALERT)); const allActions=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true);
  const alerts=allAlerts.map(r=>dba_alertContract_(r,allActions)).sort((a,b)=>dba_periodSerial_(b.periode)-dba_periodSerial_(a.periode)||dba_statusPriority_(a.statusCode)-dba_statusPriority_(b.statusCode)||b.riskScore-a.riskScore);
  const summary={semua:alerts.length,aktif:0,belumDiproses:0,sedangDiproses:0,telahDiproses:0,perluDiprosesUlang:0,dibatalkan:0,penyulangAktif:0}; const feeders={};
  alerts.forEach(a=>{if(['PENDING','PROCESSING','REPROCESS'].includes(a.statusCode)){summary.aktif++;feeders[a.penyulang]=true;} if(a.statusCode==='PENDING')summary.belumDiproses++; else if(a.statusCode==='PROCESSING')summary.sedangDiproses++; else if(a.statusCode==='COMPLETED')summary.telahDiproses++; else if(a.statusCode==='REPROCESS')summary.perluDiprosesUlang++; else if(a.statusCode==='CANCELLED')summary.dibatalkan++;}); summary.penyulangAktif=Object.keys(feeders).length;
  return {error:false,version:DBA_VERSION,summary,alerts};
}

function updateDashboardAlertActionForUser(username,password,payload){
  const user=dba_requireAdmin_(authenticateUser_(username,password)); payload=payload||{}; const idAlert=dba_text_(payload.idAlert),idAction=dba_text_(payload.idAction),checked=payload.checked===true,catatan=dba_text_(payload.catatan); if(!idAlert||!idAction)throw new Error('ID Alert dan ID Action wajib diisi.');
  const alert=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===idAlert); if(!alert)throw new Error('Alert tidak ditemukan.'); const before=dba_progress_(alert); if(before.isLocked)throw new Error('Alert ini sudah selesai dan dikunci.');
  const sh=dba_ensureSheet_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS); const action=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true).find(r=>dba_text_(r.ID_ACTION)===idAction&&dba_text_(r.ID_ALERT)===idAlert&&Math.max(1,dba_num_(r.SIKLUS)||1)===before.siklusAktif); if(!action)throw new Error('Tindakan tidak ditemukan.'); const now=new Date(); const pic=dba_text_(user.username||user.nama||username);
  dba_setRow_(sh,action._row,{STATUS:checked?'SELESAI':'BELUM SELESAI',PIC:checked?pic:'',TANGGAL_SELESAI:checked?now:'',CATATAN:catatan}); dba_resetRuntime_();
  const freshAlert=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===idAlert); const progress=dba_progress_(freshAlert); let status='BELUM DITANGANI'; if(progress.totalTindakan>0&&progress.jumlahSelesai>=progress.totalTindakan)status='SUDAH DIMONITORING'; else if(progress.jumlahSelesai>0)status='DALAM PROSES'; else if(dba_norm_(freshAlert.STATUS_TINDAK_LANJUT)==='PERLU MONITORING ULANG')status='PERLU MONITORING ULANG';
  const ash=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS); const monitorCount=status==='SUDAH DIMONITORING'?dba_num_(freshAlert.TOTAL_GANGGUAN):freshAlert.TOTAL_GANGGUAN_SAAT_MONITORING; dba_setRow_(ash,freshAlert._row,{UPDATED_AT:now,STATUS_TINDAK_LANJUT:status,TOTAL_GANGGUAN_SAAT_MONITORING:monitorCount}); dba_resetRuntime_(); dba_clearAlertCache_(); try{if(typeof mld_bumpCacheVersion_==='function')mld_bumpCacheVersion_();}catch(e){}
  const resultAlert=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===idAlert); return {success:true,message:status==='SUDAH DIMONITORING'?'Seluruh tindakan selesai. Alert dikunci dan menjadi Action Memory.':'Progress penanganan berhasil disimpan.',alert:dba_alertContract_(resultAlert,dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true))};
}


// ---------------------------------------------------------------------
// ADMIN-ONLY MANUAL WO
// ---------------------------------------------------------------------
function dba_findManualAlert_(feeder,period){
  const key=dba_periodCanonical_(period);
  const rows=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).filter(r=>dba_norm_(r.PENYULANG)===dba_norm_(feeder)&&dba_periodCanonical_(r.PERIODE)===key&&dba_norm_(r.JENIS_ALERT)==='MANUAL_ADMIN');
  rows.sort((a,b)=>new Date(b.UPDATED_AT||b.TIMESTAMP||0)-new Date(a.UPDATED_AT||a.TIMESTAMP||0));
  return rows[0]||null;
}
function dba_manualStats_(feeder,period){
  const p=dba_parsePeriod_(period); if(!p.key)throw new Error('Periode WO manual tidak valid.');
  const maps=dba_buildMonthlyMaps_();
  return (maps.maps[p.key]||{})[dba_norm_(feeder)]||dba_emptyStats_(dba_norm_(feeder),p.year,p.month);
}
function dba_createManualAlert_(feeder,period,user){
  const p=dba_parsePeriod_(period),s=dba_manualStats_(feeder,period),sh=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS),now=new Date(),id=dba_uuid_('ALT');
  const obj={ID_ALERT:id,TIMESTAMP:now,UPDATED_AT:now,PENYULANG:feeder,BULAN:dba_monthName_(p.month),TAHUN:String(p.year),PERIODE:p.key,JENIS_ALERT:'MANUAL_ADMIN',LEVEL_ALERT:'MANUAL',RISK_SCORE:dba_num_(s.riskScore),RISK_LEVEL:s.riskLevel||dba_riskLevel_(s.riskScore),TOTAL_GANGGUAN:dba_num_(s.totalGangguan),PENYEBAB_DOMINAN:s.penyebabDominan||'-',TOTAL_DURASI:dba_num_(s.totalDurasi),TOTAL_ENS:dba_num_(s.totalEns),PESAN_ALERT:'Alert manual dibuat oleh ADMIN '+dba_text_(user.nama||user.username)+'.',STATUS_KIRIM:'MANUAL_TIDAK_DIKIRIM',EMAIL_TUJUAN:'',STATUS_TINDAK_LANJUT:'BELUM DITANGANI',SIKLUS_AKTIF:1,TOTAL_GANGGUAN_SAAT_MONITORING:'',MODEL_VERSION:'MANUAL-ADMIN',PERIODE_PREDIKSI:dba_nextPeriodKey_(p.key)};
  dba_append_(sh,obj); dba_resetRuntime_();
  return dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===id)||obj;
}
function createDashboardManualWOForUser(username,password,payload){
  const user=dba_requireAdmin_(authenticateUser_(username,password)); payload=payload||{};
  const rawFeeder=dba_text_(payload.penyulang),period=dba_periodCanonical_(payload.periode),tindakan=dba_text_(payload.tindakan),alasan=dba_text_(payload.alasan);
  if(!rawFeeder||!period||!tindakan||!alasan)throw new Error('Penyulang, periode, tindakan, dan alasan wajib diisi.');
  const feeders=dba_feederList_(),feeder=feeders.find(f=>dba_norm_(f)===dba_norm_(rawFeeder)); if(!feeder)throw new Error('Penyulang tidak ditemukan pada master Dashboard.');
  const kode=dba_norm_(payload.kodeAksi)||'WO_MANUAL',kategori=dba_norm_(payload.kategori)||'MANUAL',idAset=dba_text_(payload.idAset),namaAset=dba_text_(payload.namaAset),cooldown=Math.min(24,Math.max(1,Math.round(dba_num_(payload.cooldownBulan)||1)));
  const riskAlert=dba_findAlert_(feeder,period); let alert=null;
  if(riskAlert && !dba_progress_(riskAlert).isLocked) alert=riskAlert;
  if(!alert){
    let manual=dba_findManualAlert_(feeder,period);
    if(!manual) manual=dba_createManualAlert_(feeder,period,user);
    else if(dba_progress_(manual).isLocked){
      const ash=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS),cycle=Math.max(1,dba_num_(manual.SIKLUS_AKTIF)||1)+1;
      dba_setRow_(ash,manual._row,{UPDATED_AT:new Date(),STATUS_TINDAK_LANJUT:'PERLU MONITORING ULANG',SIKLUS_AKTIF:cycle}); dba_resetRuntime_();
      manual=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===dba_text_(manual.ID_ALERT));
    }
    alert=manual;
  }
  const cycle=Math.max(1,dba_num_(alert.SIKLUS_AKTIF)||1),actions=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true);
  const duplicate=actions.find(r=>dba_text_(r.ID_ALERT)===dba_text_(alert.ID_ALERT)&&Math.max(1,dba_num_(r.SIKLUS)||1)===cycle&&dba_norm_(r.AKTIF_REKOMENDASI)!=='TIDAK'&&dba_norm_(r.SUMBER_REKOMENDASI)==='MANUAL_ADMIN'&&dba_norm_(r.KODE_AKSI)===kode&&dba_norm_(r.ID_ASET||'FEEDER')===dba_norm_(idAset||'FEEDER')&&dba_norm_(r.KATEGORI)===kategori&&dba_norm_(r.STATUS)!=='SELESAI'&&dba_norm_(r.TINDAKAN)===dba_norm_(tindakan));
  if(duplicate)throw new Error('WO manual yang sama masih aktif pada alert ini.');
  const now=new Date(),actionId=dba_uuid_('ACT'),predictionPeriod=dba_nextPeriodKey_(period),actionSh=dba_ensureSheet_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS);
  dba_append_(actionSh,{ID_ACTION:actionId,ID_ALERT:dba_text_(alert.ID_ALERT),TANGGAL:now,PENYULANG:feeder,JENIS_ALERT:dba_text_(alert.JENIS_ALERT)||'MANUAL_ADMIN',TEMUAN:alasan,TINDAKAN:tindakan,PIC:'',STATUS:'BELUM SELESAI',TANGGAL_SELESAI:'',CATATAN:'',SIKLUS:cycle,POIN:1,KODE_AKSI:kode,ID_ASET:idAset,NAMA_ASET:namaAset,KATEGORI:kategori,RISK_ML:0,SUMBER_REKOMENDASI:'MANUAL_ADMIN',MODEL_VERSION:'MANUAL-ADMIN',ALASAN_REKOMENDASI:alasan,AKTIF_REKOMENDASI:'YA',PERIODE_ANALISIS:period,PERIODE_PREDIKSI:predictionPeriod,COOLDOWN_BULAN:cooldown,FOLLOW_UP_OF:''});
  const ash=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS); dba_setRow_(ash,alert._row,{UPDATED_AT:now,STATUS_TINDAK_LANJUT:dba_progress_(alert).isLocked?'PERLU MONITORING ULANG':(dba_norm_(alert.STATUS_TINDAK_LANJUT)==='DIBATALKAN'?'BELUM DITANGANI':alert.STATUS_TINDAK_LANJUT)});
  dba_resetRuntime_(); dba_clearAlertCache_(); try{if(typeof mld_bumpCacheVersion_==='function')mld_bumpCacheVersion_();}catch(e){}
  const finalAlert=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===dba_text_(alert.ID_ALERT));
  return {success:true,version:DBA_VERSION,message:'WO Manual berhasil ditambahkan untuk '+feeder+'.',idAlert:dba_text_(alert.ID_ALERT),idAction:actionId,attachedTo:dba_norm_(finalAlert.JENIS_ALERT),alert:dba_alertContract_(finalAlert,dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true))};
}

// ---------------------------------------------------------------------
// EMAIL ALERT ALA SIGAP
// ---------------------------------------------------------------------
function dba_appendEmailLog_(o){ const sh=dba_ensureSheet_(DBA_EMAIL_LOG_SHEET,DBA_EMAIL_HEADERS); dba_append_(sh,Object.assign({ID_EMAIL:dba_uuid_('EML'),TIMESTAMP:new Date()},o||{})); }
function dba_successEmailLogs_(idAlert,cycle){ return dba_rows_(DBA_EMAIL_LOG_SHEET,DBA_EMAIL_HEADERS,true).filter(r=>dba_text_(r.ID_ALERT)===dba_text_(idAlert)&&Math.max(1,dba_num_(r.SIKLUS_ALERT)||1)===Math.max(1,dba_num_(cycle)||1)&&dba_norm_(r.STATUS_KIRIM)==='TERKIRIM'&&[DBA_RISK_EMAIL_INITIAL,DBA_RISK_EMAIL_REMINDER].includes(dba_norm_(r.JENIS_EMAIL))).sort((a,b)=>new Date(a.TIMESTAMP||0)-new Date(b.TIMESTAMP||0)); }
function dba_emailDecision_(alert,progress,allowReminder){
  if(progress.isLocked)return {send:false,status:'ALERT_SELESAI',message:'Alert sudah selesai.'};
  if(!dba_riskEligible_(alert.RISK_SCORE))return {send:false,status:'DI_BAWAH_THRESHOLD',message:'Risk Score sudah di bawah ambang.'};
  const logs=dba_successEmailLogs_(alert.ID_ALERT,progress.siklusAktif); if(!logs.length)return {send:true,type:DBA_RISK_EMAIL_INITIAL,reminder:0}; if(!allowReminder)return {send:false,status:'EMAIL_PERTAMA_SUDAH_TERKIRIM',message:'Email pertama sudah terkirim.'};
  const last=new Date(logs[logs.length-1].TIMESTAMP),days=Math.max(1,Math.round(dba_num_(dba_config_('ALERT_COOLDOWN_DAYS',7))||7)); const due=new Date(last.getTime()+days*86400000); if(new Date()<due)return {send:false,status:'MENUNGGU_REMINDER',message:'Belum jatuh tempo reminder.',nextDueAt:due}; const reminders=logs.filter(x=>dba_norm_(x.JENIS_EMAIL)===DBA_RISK_EMAIL_REMINDER).length; return {send:true,type:DBA_RISK_EMAIL_REMINDER,reminder:reminders+1};
}
function dba_buildRiskEmail_(alert,progress,type,reminder){
  const isReminder=type===DBA_RISK_EMAIL_REMINDER,subject=isReminder?'[REMINDER DASHBOARD #'+reminder+'] '+dba_text_(alert.PENYULANG)+' belum selesai - '+progress.progressPercent+'%':'[DASHBOARD SRIBAWONO] Alert Risiko '+dba_text_(alert.PENYULANG)+' - '+dba_norm_(alert.RISK_LEVEL)+' - '+dba_text_(alert.BULAN)+' '+dba_text_(alert.TAHUN); const heading=isReminder?'REMINDER PENANGANAN ALERT':'ALERT RISIKO PENYULANG';
  const actionLines=progress.rows.map((r,i)=>(i+1)+'. ['+(dba_norm_(r.STATUS)==='SELESAI'?'SELESAI':'BELUM')+'] '+dba_text_(r.TINDAKAN)+(r.ID_ASET?' · '+r.ID_ASET:'')).join('\n');
  const body=`${heading}\n\nPenyulang       : ${alert.PENYULANG}\nPeriode         : ${alert.BULAN} ${alert.TAHUN}\nRisk Score      : ${alert.RISK_SCORE}\nRisk Level      : ${alert.RISK_LEVEL}\nAmbang Alert    : >= 4 (SAKIT)\n\nRINGKASAN GANGGUAN\nTotal Gangguan  : ${alert.TOTAL_GANGGUAN} kejadian\nTotal Durasi    : ${dba_formatNumber_(alert.TOTAL_DURASI,2)} menit\nTotal ENS       : ${dba_formatNumber_(alert.TOTAL_ENS,2)} kWh\nPenyebab Dominan: ${alert.PENYEBAB_DOMINAN}\n\nSTATUS PENANGANAN\nStatus          : ${progress.statusTampilan}\nProgress        : ${progress.progressPercent}% (${progress.jumlahSelesai}/${progress.totalTindakan})\nSiklus          : ${progress.siklusAktif}\n\nREKOMENDASI / ACTION PLAN\n${actionLines||'-'}\n\n${isReminder?'Alert belum selesai. Reminder akan dikirim ulang sesuai cooldown sampai semua tindakan selesai.':'Segera buka menu Alert Aktif dan catat proses penanganan.'}\n\nPesan ini dibuat otomatis oleh DASHBOARD SRIBAWONO.`;
  const accent=isReminder?'#C8A96B':'#D95A5A'; const actionsHtml=progress.rows.map(r=>`<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">${dba_norm_(r.STATUS)==='SELESAI'?'✅':'⬜'} ${dba_escapeHtml_(r.TINDAKAN)}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${dba_escapeHtml_(r.ID_ASET||'-')}</td></tr>`).join('');
  const htmlBody=`<div style="max-width:720px;margin:auto;font-family:Arial,sans-serif;color:#243c32;line-height:1.55"><div style="padding:20px 24px;background:#17392B;color:#F6F3E8;border-radius:14px 14px 0 0"><div style="font-size:12px;font-weight:700;color:#E0BF4F">DASHBOARD SRIBAWONO</div><h2 style="margin:6px 0 0">${dba_escapeHtml_(heading)}</h2></div><div style="padding:24px;border:1px solid #d9e3dc;border-top:0;border-radius:0 0 14px 14px"><table style="width:100%;border-collapse:collapse"><tr><td style="padding:7px 0;color:#64746b">Penyulang</td><td style="text-align:right;font-weight:700">${dba_escapeHtml_(alert.PENYULANG)}</td></tr><tr><td style="padding:7px 0;color:#64746b">Periode</td><td style="text-align:right;font-weight:700">${dba_escapeHtml_(alert.BULAN+' '+alert.TAHUN)}</td></tr><tr><td style="padding:7px 0;color:#64746b">Risk Grade</td><td style="text-align:right;font-weight:800;color:${accent}">${alert.RISK_SCORE} / ${dba_escapeHtml_(alert.RISK_LEVEL)}</td></tr><tr><td style="padding:7px 0;color:#64746b">Gangguan</td><td style="text-align:right;font-weight:700">${alert.TOTAL_GANGGUAN} kejadian</td></tr><tr><td style="padding:7px 0;color:#64746b">Status</td><td style="text-align:right;font-weight:800">${dba_escapeHtml_(progress.statusTampilan)}</td></tr></table><div style="height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin:18px 0"><div style="height:100%;width:${progress.progressPercent}%;background:#C8A96B"></div></div><h3 style="font-size:15px">Action Plan ML</h3><table style="width:100%;border-collapse:collapse;background:#f7faf7">${actionsHtml||'<tr><td style="padding:10px">Belum ada action plan.</td></tr>'}</table><p style="margin-top:18px;font-size:12px;color:#64746b">${isReminder?'Alert belum selesai. Reminder akan dikirim ulang sesuai cooldown sampai seluruh tindakan selesai.':'Segera buka menu Alert Aktif pada Dashboard SRIBAWONO untuk menindaklanjuti rekomendasi.'}</p></div></div>`;
  return {subject,body,htmlBody};
}
function dba_sendRiskAlertEmailForAlert_(idAlert,options){
  options=options||{}; if(!dba_boolConfig_('ALERT_SEND_EMAIL',false))return {status:'EMAIL_NONAKTIF'}; const alert=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).find(r=>dba_text_(r.ID_ALERT)===dba_text_(idAlert)); if(!alert)throw new Error('Alert tidak ditemukan: '+idAlert); if(dba_norm_(alert.JENIS_ALERT)!=='RISK_BULANAN')return {status:'BUKAN_ALERT_RISK',message:'WO manual tidak dikirim sebagai email Alert Risiko otomatis.'}; const progress=dba_progress_(alert),decision=dba_emailDecision_(alert,progress,options.allowReminder===true); if(!decision.send)return {status:decision.status,message:decision.message,nextDueAt:decision.nextDueAt?dba_formatDateTime_(decision.nextDueAt):''}; const recipients=dba_getRecipients_(); const content=dba_buildRiskEmail_(alert,progress,decision.type,decision.reminder);
  if(!recipients.length){dba_appendEmailLog_({JENIS_EMAIL:decision.type,PENYULANG:alert.PENYULANG,BULAN:alert.BULAN,TAHUN:alert.TAHUN,LEVEL:alert.RISK_LEVEL,EMAIL_TUJUAN:'',SUBJECT:content.subject,STATUS_KIRIM:'TIDAK_ADA_PENERIMA',PESAN_ERROR:'Tidak ada penerima aktif pada Alert_Recipients.',ID_ALERT:alert.ID_ALERT,SIKLUS_ALERT:progress.siklusAktif});return {status:'TIDAK_ADA_PENERIMA'};}
  const to=recipients.map(r=>r.email).join(','); try{MailApp.sendEmail({to,subject:content.subject,body:content.body,htmlBody:content.htmlBody,name:'DASHBOARD SRIBAWONO'}); dba_appendEmailLog_({JENIS_EMAIL:decision.type,PENYULANG:alert.PENYULANG,BULAN:alert.BULAN,TAHUN:alert.TAHUN,LEVEL:alert.RISK_LEVEL,EMAIL_TUJUAN:to,SUBJECT:content.subject,STATUS_KIRIM:'TERKIRIM',PESAN_ERROR:'',ID_ALERT:alert.ID_ALERT,SIKLUS_ALERT:progress.siklusAktif}); const sh=dba_ensureSheet_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS); dba_setRow_(sh,alert._row,{STATUS_KIRIM:'TERKIRIM',EMAIL_TUJUAN:to,UPDATED_AT:new Date()}); dba_resetRuntime_(); return {status:decision.type===DBA_RISK_EMAIL_REMINDER?'REMINDER_TERKIRIM':'EMAIL_PERTAMA_TERKIRIM',emailTujuan:to,subject:content.subject};}catch(e){dba_appendEmailLog_({JENIS_EMAIL:decision.type,PENYULANG:alert.PENYULANG,BULAN:alert.BULAN,TAHUN:alert.TAHUN,LEVEL:alert.RISK_LEVEL,EMAIL_TUJUAN:to,SUBJECT:content.subject,STATUS_KIRIM:'GAGAL',PESAN_ERROR:String(e&&e.message?e.message:e),ID_ALERT:alert.ID_ALERT,SIKLUS_ALERT:progress.siklusAktif});return {status:'GAGAL',error:String(e&&e.message?e.message:e)};}
}
function runDashboardRiskAlertEmailScheduler(){
  const sync=dba_syncRiskAlertsInternal_({sendEmail:true}); if(!dba_boolConfig_('ALERT_SEND_EMAIL',false))return {status:'EMAIL_NONAKTIF',sync}; const alerts=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true).filter(r=>dba_norm_(r.JENIS_ALERT)==='RISK_BULANAN'&&dba_riskEligible_(r.RISK_SCORE)); let terkirim=0,dilewati=0,gagal=0; const hasil=[];
  alerts.forEach(a=>{const r=dba_sendRiskAlertEmailForAlert_(a.ID_ALERT,{allowReminder:true});hasil.push({idAlert:a.ID_ALERT,penyulang:a.PENYULANG,status:r.status});if(['EMAIL_PERTAMA_TERKIRIM','REMINDER_TERKIRIM'].includes(r.status))terkirim++;else if(['GAGAL','TIDAK_ADA_PENERIMA'].includes(r.status))gagal++;else dilewati++;}); return {status:'SELESAI',sync,totalAlert:alerts.length,terkirim,dilewati,gagal,hasil};
}
function installDashboardRiskAlertEmailTrigger(){
  const recipients=dba_getRecipients_(); if(!recipients.length)throw new Error('Isi minimal satu email AKTIF pada sheet Alert_Recipients.'); ScriptApp.getProjectTriggers().forEach(t=>{if(t.getHandlerFunction()===DBA_RISK_TRIGGER_HANDLER)ScriptApp.deleteTrigger(t);}); const hour=Math.min(23,Math.max(0,Math.round(dba_num_(dba_config_('ALERT_DAILY_HOUR',8))||8))); const tr=ScriptApp.newTrigger(DBA_RISK_TRIGGER_HANDLER).timeBased().atHour(hour).everyDays(1).inTimezone(dba_tz_()).create(); return {success:true,handler:DBA_RISK_TRIGGER_HANDLER,waktu:'Setiap hari sekitar pukul '+String(hour).padStart(2,'0')+'.00',timezone:dba_tz_(),cooldownDays:dba_num_(dba_config_('ALERT_COOLDOWN_DAYS',7)),recipients:recipients.length,triggerId:tr.getUniqueId()};
}

// ---------------------------------------------------------------------
// MONTHLY EMAIL ALA SIGAP — per feeder, queue 5 menit
// ---------------------------------------------------------------------
function dba_change_(current,previous){ const c=dba_num_(current),p=dba_num_(previous); if(p===0&&c===0)return {direction:'TETAP',percent:0,text:'Tetap 0%'}; if(p===0&&c>0)return {direction:'NAIK',percent:null,text:'Naik dari 0 menjadi '+dba_formatNumber_(c,2)}; const pct=(c-p)/p*100; if(Math.abs(pct)<0.005)return {direction:'TETAP',percent:0,text:'Tetap 0%'}; const dir=pct>0?'NAIK':'TURUN'; return {direction:dir,percent:Math.abs(pct),text:(dir==='NAIK'?'Naik ':'Turun ')+dba_formatNumber_(Math.abs(pct),2)+'%'}; }
function dba_monthlyConclusion_(feeder,current,change){ let t=change.direction==='TURUN'?'mengalami penurunan sebesar '+dba_formatNumber_(change.percent,2)+'%':change.direction==='NAIK'&&change.percent===null?'naik dari 0 menjadi '+current.totalGangguan+' kejadian':change.direction==='NAIK'?'mengalami kenaikan sebesar '+dba_formatNumber_(change.percent,2)+'%':'tidak mengalami perubahan'; let risk=dba_norm_(current.riskLevel)==='KRONIS'?' Penyulang berada pada kategori KRONIS dan memerlukan penanganan prioritas.':dba_norm_(current.riskLevel)==='SAKIT'?' Penyulang berada pada kategori SAKIT sehingga monitoring dan Alert Aktif harus ditindaklanjuti.':dba_norm_(current.riskLevel)==='SEHAT'?' Penyulang berada pada kategori SEHAT dan tetap memerlukan pemantauan rutin.':' Penyulang berada pada kategori SEMPURNA untuk periode ini.'; return 'Jumlah gangguan Penyulang '+feeder+' '+t+' dibandingkan bulan sebelumnya.'+risk; }
function dba_monthlyRecommendations_(riskLevel){ const l=dba_norm_(riskLevel); if(l==='KRONIS')return ['Lakukan inspeksi prioritas pada titik gangguan berulang.','Tuntaskan action plan pada menu Alert Aktif.','Evaluasi alat penahan/vegetasi/komponen sesuai rekomendasi ML.','Monitoring ulang setelah seluruh tindakan selesai.']; if(l==='SAKIT')return ['Lanjutkan monitoring titik gangguan berulang.','Tindaklanjuti rekomendasi ML pada menu Alert Aktif.','Periksa alat penahan, vegetasi, dan aset berisiko.','Pastikan checkbox tindakan diperbarui setelah pekerjaan selesai.']; return ['Pertahankan monitoring rutin.','Perbarui data lapangan dan kondisi aset secara berkala.','Pantau risk penyebab pada detail penyulang.']; }
function dba_monthlyMlSummary_(feeder,period){ const row=dba_findPredictionRow_(feeder,period); if(!row)return {point:0,lower:0,upper:0,prediction:'-',primary:'-',active:[],watch:[]}; return {point:dba_num_(row.PREDIKSI_TOTAL_GANGGUAN),lower:dba_num_(row.PREDIKSI_BAWAH),upper:dba_num_(row.PREDIKSI_ATAS),prediction:dba_text_(row.PERIODE_PREDIKSI).slice(0,7),primary:dba_text_(row.PENYEBAB_DOMINAN),active:dba_safeJsonArray_(row.CAUSE_AKTIF_JSON).map(x=>x.kategori||x),watch:dba_safeJsonArray_(row.CAUSE_PANTAU_JSON).map(x=>x.kategori||x)}; }
function dba_buildMonthlyEmail_(feeder,current,previous){
  const ch=dba_change_(current.totalGangguan,previous.totalGangguan),dur=dba_change_(current.totalDurasi,previous.totalDurasi),ens=dba_change_(current.totalEns,previous.totalEns),conclusion=dba_monthlyConclusion_(feeder,current,ch),recs=dba_monthlyRecommendations_(current.riskLevel),ml=dba_monthlyMlSummary_(feeder,current.period),currentText=dba_monthName_(current.month)+' '+current.year,prevText=dba_monthName_(previous.month)+' '+previous.year; const subject='[DASHBOARD SRIBAWONO] Laporan Bulanan '+feeder+' - '+currentText;
  const body=`LAPORAN BULANAN DASHBOARD SRIBAWONO\n\nPenyulang          : ${feeder}\nPeriode Laporan    : ${currentText}\nPeriode Pembanding : ${prevText}\n\nRINGKASAN ${currentText}\nTotal Gangguan    : ${current.totalGangguan} kejadian\nGangguan Sesaat   : ${current.jumlahSesaat} kejadian\nGangguan Permanen : ${current.jumlahPermanen} kejadian\nTotal Durasi      : ${dba_formatNumber_(current.totalDurasi,2)} menit\nTotal ENS         : ${dba_formatNumber_(current.totalEns,2)} kWh\nPenyebab Dominan  : ${current.penyebabDominan}\nRisk Score        : ${current.riskScore}\nRisk Level        : ${current.riskLevel}\n\nPERBANDINGAN BULANAN\nTotal Gangguan: ${ch.text}\nTotal Durasi: ${dur.text}\nTotal ENS: ${ens.text}\n\nMACHINE LEARNING\nPrediksi ${ml.prediction}: ${dba_formatNumber_(ml.point,1)} gangguan (${dba_formatNumber_(ml.lower,1)}-${dba_formatNumber_(ml.upper,1)})\nRisk utama: ${ml.primary}\nCause AKTIF: ${ml.active.join(', ')||'-'}\nCause PANTAU: ${ml.watch.join(', ')||'-'}\n\nKESIMPULAN\n${conclusion}\n\nREKOMENDASI\n${recs.map(x=>'- '+x).join('\n')}\n\nPesan ini dibuat otomatis oleh DASHBOARD SRIBAWONO.`;
  const htmlRecs=recs.map(x=>'<li>'+dba_escapeHtml_(x)+'</li>').join(''); const htmlBody=`<div style="max-width:760px;margin:auto;font-family:Arial,sans-serif;color:#243c32;line-height:1.5"><div style="padding:22px;background:#17392B;color:#F6F3E8;border-radius:14px 14px 0 0"><div style="font-size:12px;font-weight:bold;color:#E0BF4F">DASHBOARD SRIBAWONO</div><h2 style="margin:5px 0 0">Laporan Bulanan Penyulang</h2></div><div style="padding:24px;border:1px solid #d9e3dc;border-top:0"><p><strong>Penyulang:</strong> ${dba_escapeHtml_(feeder)}<br><strong>Periode:</strong> ${dba_escapeHtml_(currentText)}<br><strong>Pembanding:</strong> ${dba_escapeHtml_(prevText)}</p><h3>Ringkasan Bulan Berjalan</h3><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px;border-bottom:1px solid #ddd">Total Gangguan</td><td style="padding:8px;border-bottom:1px solid #ddd;text-align:right"><b>${current.totalGangguan}</b></td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd">Sesaat / Permanen</td><td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${current.jumlahSesaat} / ${current.jumlahPermanen}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd">Durasi / ENS</td><td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${dba_formatNumber_(current.totalDurasi,2)} menit / ${dba_formatNumber_(current.totalEns,2)} kWh</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd">Penyebab Dominan</td><td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${dba_escapeHtml_(current.penyebabDominan)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd">Risk Grade</td><td style="padding:8px;border-bottom:1px solid #ddd;text-align:right"><b>${current.riskScore} / ${dba_escapeHtml_(current.riskLevel)}</b></td></tr></table><h3>Perbandingan Bulanan</h3><ul><li>Gangguan: ${dba_escapeHtml_(ch.text)}</li><li>Durasi: ${dba_escapeHtml_(dur.text)}</li><li>ENS: ${dba_escapeHtml_(ens.text)}</li></ul><h3>Machine Learning</h3><p>Prediksi <b>${dba_escapeHtml_(ml.prediction)}</b>: ${dba_formatNumber_(ml.point,1)} gangguan (${dba_formatNumber_(ml.lower,1)}-${dba_formatNumber_(ml.upper,1)}).<br>Risk utama: <b>${dba_escapeHtml_(ml.primary)}</b><br>AKTIF: ${dba_escapeHtml_(ml.active.join(', ')||'-')}<br>PANTAU: ${dba_escapeHtml_(ml.watch.join(', ')||'-')}</p><h3>Kesimpulan</h3><p>${dba_escapeHtml_(conclusion)}</p><h3>Rekomendasi</h3><ul>${htmlRecs}</ul></div></div>`; return {subject,body,htmlBody};
}
function dba_hasMonthlyEmailLog_(feeder,period){ const p=dba_parsePeriod_(period); return dba_rows_(DBA_EMAIL_LOG_SHEET,DBA_EMAIL_HEADERS,true).some(r=>dba_norm_(r.JENIS_EMAIL)===DBA_MONTHLY_EMAIL_TYPE&&dba_norm_(r.PENYULANG)===dba_norm_(feeder)&&dba_norm_(r.STATUS_KIRIM)==='TERKIRIM'&&dba_norm_(r.BULAN)===dba_monthName_(p.month)&&dba_text_(r.TAHUN)===String(p.year)); }
function dba_sendMonthlyFeeder_(feeder,year,month){ const recipients=dba_getRecipients_(); if(!recipients.length)return {status:'TIDAK_ADA_PENERIMA'}; const maps=dba_buildMonthlyMaps_(),period=dba_periodKey_(year,month),prev=dba_previousPeriod_(year,month),current=(maps.maps[period]||{})[dba_norm_(feeder)]||dba_emptyStats_(dba_norm_(feeder),year,month),previous=(maps.maps[prev.key]||{})[dba_norm_(feeder)]||dba_emptyStats_(dba_norm_(feeder),prev.year,prev.month),content=dba_buildMonthlyEmail_(dba_norm_(feeder),current,previous),to=recipients.map(r=>r.email).join(','); try{MailApp.sendEmail({to,subject:content.subject,body:content.body,htmlBody:content.htmlBody,name:'DASHBOARD SRIBAWONO'}); dba_appendEmailLog_({JENIS_EMAIL:DBA_MONTHLY_EMAIL_TYPE,PENYULANG:dba_norm_(feeder),BULAN:dba_monthName_(month),TAHUN:String(year),LEVEL:current.riskLevel,EMAIL_TUJUAN:to,SUBJECT:content.subject,STATUS_KIRIM:'TERKIRIM',PESAN_ERROR:'',ID_ALERT:'',SIKLUS_ALERT:''}); return {status:'TERKIRIM',penyulang:dba_norm_(feeder),subject:content.subject};}catch(e){dba_appendEmailLog_({JENIS_EMAIL:DBA_MONTHLY_EMAIL_TYPE,PENYULANG:dba_norm_(feeder),BULAN:dba_monthName_(month),TAHUN:String(year),LEVEL:current.riskLevel,EMAIL_TUJUAN:to,SUBJECT:content.subject,STATUS_KIRIM:'GAGAL',PESAN_ERROR:String(e&&e.message?e.message:e)});return {status:'GAGAL',error:String(e&&e.message?e.message:e)};}}
function dba_getMonthlyQueue_(){ try{return JSON.parse(PropertiesService.getScriptProperties().getProperty(DBA_MONTHLY_QUEUE_PROPERTY)||'null');}catch(e){return null;} }
function dba_setMonthlyQueue_(s){ PropertiesService.getScriptProperties().setProperty(DBA_MONTHLY_QUEUE_PROPERTY,JSON.stringify(s)); }
function dba_clearMonthlyWorkerTriggers_(){ ScriptApp.getProjectTriggers().forEach(t=>{if(t.getHandlerFunction()===DBA_MONTHLY_WORKER_HANDLER)ScriptApp.deleteTrigger(t);}); }
function dba_clearMonthlyQueue_(){ PropertiesService.getScriptProperties().deleteProperty(DBA_MONTHLY_QUEUE_PROPERTY); dba_clearMonthlyWorkerTriggers_(); }
function dba_scheduleMonthlyWorker_(minutes){ dba_clearMonthlyWorkerTriggers_(); ScriptApp.newTrigger(DBA_MONTHLY_WORKER_HANDLER).timeBased().after(Math.max(1,Number(minutes)||5)*60*1000).create(); }
function sendDashboardMonthlyFeederReportsForPeriod(year,month){ if(!dba_boolConfig_('MONTHLY_EMAIL_ENABLED',false))return {status:'EMAIL_BULANAN_NONAKTIF'}; if(!dba_getRecipients_().length)return {status:'TIDAK_ADA_PENERIMA'}; const period=dba_periodKey_(year,month); if(!period)throw new Error('Periode tidak valid.'); const feeders=dba_feederList_(); dba_clearMonthlyQueue_(); const state={year:Number(year),month:Number(month),period,feeders,index:0,delayMinutes:Math.max(1,dba_num_(dba_config_('MONTHLY_QUEUE_DELAY_MINUTES',5))||5),startedAt:new Date().toISOString()}; dba_setMonthlyQueue_(state); const first=runDashboardMonthlyEmailQueueWorker(); return {status:'QUEUE_DIMULAI',period,total:feeders.length,jedaMenit:state.delayMinutes,workerPertama:first}; }
function runDashboardMonthlyEmailQueueWorker(){ const lock=LockService.getScriptLock(); if(!lock.tryLock(30000))return {status:'SEDANG_DIPROSES'}; try{const s=dba_getMonthlyQueue_(); if(!s||!Array.isArray(s.feeders)){dba_clearMonthlyQueue_();return {status:'QUEUE_KOSONG'};} if(s.index>=s.feeders.length){dba_clearMonthlyQueue_();return {status:'SELESAI',total:s.feeders.length};} const feeder=s.feeders[s.index]; let result=dba_hasMonthlyEmailLog_(feeder,s.period)?{status:'SUDAH_TERKIRIM',penyulang:feeder}:dba_sendMonthlyFeeder_(feeder,s.year,s.month); s.index++; if(s.index>=s.feeders.length){dba_clearMonthlyQueue_();return {status:'SELESAI',terakhir:result,total:s.feeders.length};} dba_setMonthlyQueue_(s); dba_scheduleMonthlyWorker_(s.delayMinutes); return {status:'MENUNGGU_EMAIL_BERIKUTNYA',terakhir:result,berikutnya:s.feeders[s.index],posisi:s.index+1,total:s.feeders.length,jedaMenit:s.delayMinutes};}finally{lock.releaseLock();} }
function runDashboardMonthlyEmailScheduler(){ const now=new Date(),y=Number(Utilities.formatDate(now,dba_tz_(),'yyyy')),m=Number(Utilities.formatDate(now,dba_tz_(),'M')),day=Number(Utilities.formatDate(now,dba_tz_(),'d')),last=new Date(y,m,0).getDate(); if(day!==last)return {status:'BUKAN_HARI_TERAKHIR_BULAN',tanggal:Utilities.formatDate(now,dba_tz_(),'yyyy-MM-dd')}; return sendDashboardMonthlyFeederReportsForPeriod(y,m); }
function installDashboardMonthlyEmailTrigger(){ const recipients=dba_getRecipients_(); if(!recipients.length)throw new Error('Isi minimal satu email AKTIF pada Alert_Recipients.'); ScriptApp.getProjectTriggers().forEach(t=>{if(t.getHandlerFunction()===DBA_MONTHLY_TRIGGER_HANDLER)ScriptApp.deleteTrigger(t);}); const hour=Math.min(23,Math.max(0,Math.round(dba_num_(dba_config_('MONTHLY_DAILY_HOUR',20))||20))); const tr=ScriptApp.newTrigger(DBA_MONTHLY_TRIGGER_HANDLER).timeBased().everyDays(1).atHour(hour).inTimezone(dba_tz_()).create(); return {success:true,handler:DBA_MONTHLY_TRIGGER_HANDLER,waktu:'Setiap hari sekitar pukul '+String(hour).padStart(2,'0')+'.00; email hanya dimulai pada hari terakhir bulan.',jedaPerPenyulangMenit:dba_num_(dba_config_('MONTHLY_QUEUE_DELAY_MINUTES',5)),triggerId:tr.getUniqueId()}; }
function setupDashboardAlertEmailAutomation(){ const recipients=dba_getRecipients_(); if(!recipients.length)throw new Error('Isi sheet Alert_Recipients dulu: NAMA, EMAIL, ROLE, STATUS=AKTIF.'); dba_setConfig_('ALERT_SEND_EMAIL','TRUE'); dba_setConfig_('MONTHLY_EMAIL_ENABLED','TRUE'); const risk=installDashboardRiskAlertEmailTrigger(),monthly=installDashboardMonthlyEmailTrigger(); return {success:true,version:DBA_VERSION,recipients:recipients.length,riskAlert:risk,monthly:monthly}; }
function getDashboardAlertEmailSetupStatus(){ const recipients=dba_getRecipients_(); const triggers=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction()); return {version:DBA_VERSION,alertEnabled:dba_boolConfig_('ALERT_ENABLED',true),alertEmailEnabled:dba_boolConfig_('ALERT_SEND_EMAIL',false),monthlyEmailEnabled:dba_boolConfig_('MONTHLY_EMAIL_ENABLED',false),recipients:recipients,riskTrigger:triggers.includes(DBA_RISK_TRIGGER_HANDLER),monthlyTrigger:triggers.includes(DBA_MONTHLY_TRIGGER_HANDLER),dailyHour:dba_config_('ALERT_DAILY_HOUR',8),monthlyHour:dba_config_('MONTHLY_DAILY_HOUR',20),cooldownDays:dba_config_('ALERT_COOLDOWN_DAYS',7)}; }

// ---------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------
function repairDashboardSigapAlertV21(){ const result=dba_repairDuplicateAlerts_(); Logger.log(JSON.stringify(result)); return result; }
function testDashboardSigapAlertV2(){ const setup=setupDashboardSigapAlertV2(); const alerts=dba_rows_(DBA_ALERT_SHEET,DBA_ALERT_HEADERS,true),actions=dba_rows_(DBA_ACTION_SHEET,DBA_ACTION_HEADERS,true),allActions=actions; const active=alerts.filter(a=>['PENDING','PROCESSING','REPROCESS'].includes(dba_progress_(a,allActions).statusCode)); const riskActive=active.filter(a=>dba_norm_(a.JENIS_ALERT)==='RISK_BULANAN'); const manualActive=active.filter(a=>dba_norm_(a.JENIS_ALERT)==='MANUAL_ADMIN'); const out={version:DBA_VERSION,repair:setup.repair,setupSync:setup.sync,totalAlertRows:alerts.length,activeAlerts:active.length,sickOrChronic:riskActive.map(a=>({penyulang:a.PENYULANG,periode:dba_periodCanonical_(a.PERIODE),riskScore:dba_num_(a.RISK_SCORE),riskLevel:a.RISK_LEVEL,status:dba_progress_(a,allActions).statusTampilan,actions:dba_progress_(a,allActions).totalTindakan})),manualAlerts:manualActive.map(a=>({penyulang:a.PENYULANG,periode:dba_periodCanonical_(a.PERIODE),status:dba_progress_(a,allActions).statusTampilan,actions:dba_progress_(a,allActions).totalTindakan})),totalActionRows:actions.length,manualActionRows:actions.filter(a=>dba_norm_(a.SUMBER_REKOMENDASI)==='MANUAL_ADMIN').length,recipients:dba_getRecipients_().length,emailSetup:getDashboardAlertEmailSetupStatus()}; Logger.log(JSON.stringify(out)); return out; }
function previewDashboardMonthlyEmail(feeder,year,month){ const maps=dba_buildMonthlyMaps_(),period=dba_periodKey_(year,month),prev=dba_previousPeriod_(year,month),f=dba_norm_(feeder),current=(maps.maps[period]||{})[f]||dba_emptyStats_(f,year,month),previous=(maps.maps[prev.key]||{})[f]||dba_emptyStats_(f,prev.year,prev.month),content=dba_buildMonthlyEmail_(f,current,previous); return {subject:content.subject,body:content.body}; }

function testDashboardAdminAccessV22(){
  const feeders=dba_feederList_();
  const out={version:DBA_VERSION,adminOnly:true,manualWOEndpoint:'createDashboardManualWOForUser',feeders:feeders.length,notes:['Alert Aktif server-side ditolak untuk role selain ADMIN.','Checkbox server-side ditolak untuk role selain ADMIN.','WO manual hanya ADMIN dan tidak mengirim email risk otomatis.']};
  Logger.log(JSON.stringify(out)); return out;
}
function testDashboardAlertEmailSetupStatusLog() {
  const out = getDashboardAlertEmailSetupStatus();
  Logger.log(JSON.stringify(out));
  return out;
} 