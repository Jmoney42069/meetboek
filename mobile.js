/* Meetboek Mobiel — volwaardige pc-loze health-app. De telefoon praat
   RECHTSTREEKS met het horloge (Web Bluetooth), alle data lokaal (IndexedDB),
   alle analyse (HRV, slaapscore, trends, ringen) client-side. Geen server.
   Vereist Web Bluetooth: Android-Chrome, of iOS via de Bluefy-browser. */
"use strict";

/* ==================== Protocol (port van driver/protocol.py) ==================== */
const UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const UART_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const ADV_SERVICE = 0xfe00;
const OP = { SET_TIME: 0x01, BATTERY: 0x03, PHONE_OS: 0x04, DAY_SPORT: 0x07,
  HR_HISTORY: 0x15, REALTIME_HR: 0x1e, FUNC_SUPPORT: 0x3c, SLEEP: 0x44,
  FIND_DEVICE: 0x50, STEPS_TODAY: 0x48, START_MEASURE: 0x69, STOP_MEASURE: 0x6a };
const MEASURE = { heart_rate: 1, blood_pressure: 2, spo2: 3, hrv: 10 };
const STAGE_CODE = { 0: "awake", 1: "light", 2: "deep", 3: "rem" };

const bcd = (n) => ((Math.floor(n / 10)) << 4) | (n % 10);
function buildFrame(op, payload = []) {
  const f = new Uint8Array(16); f[0] = op & 0xff;
  payload.forEach((b, i) => { f[1 + i] = b & 0xff; });
  let s = 0; for (let i = 0; i < 15; i++) s += f[i]; f[15] = s & 0xff; return f;
}
const checksumOk = (d) => { let s = 0; for (let i = 0; i < 15; i++) s += d[i]; return (s & 0xff) === d[15]; };
function setTimeFrame() {
  const n = new Date(), tz = -n.getTimezoneOffset() / 60;
  return buildFrame(OP.SET_TIME, [bcd(n.getFullYear() % 2000), bcd(n.getMonth() + 1),
    bcd(n.getDate()), bcd(n.getHours()), bcd(n.getMinutes()), bcd(n.getSeconds()),
    8, Math.round(((tz + 24) % 24) * 2 + 1)]);
}
const beInt = (d, a, b) => { let v = 0; for (let i = a; i < b; i++) v = (v << 8) | d[i]; return v; };
const dbcd = (b) => (b >> 4) * 10 + (b & 0x0f);

/* ==================== HRV (port van hrv.py) ==================== */
const RR_MIN = 300, RR_MAX = 2000, MIN_BEATS = 10;
function rmssd(rr) { if (rr.length < 2) return null; let s = 0; for (let i = 1; i < rr.length; i++) s += (rr[i] - rr[i - 1]) ** 2; return Math.sqrt(s / (rr.length - 1)); }
function stressIndex(rr) {
  if (rr.length < MIN_BEATS) return null;
  const bins = {}; rr.forEach((x) => { const k = Math.floor(x / 50); bins[k] = (bins[k] || 0) + 1; });
  let mB = 0, mC = 0; for (const [k, c] of Object.entries(bins)) if (c > mC) { mC = c; mB = +k; }
  const mo = (mB * 50 + 25) / 1000, amo = mC / rr.length * 100;
  const mx = Math.max((Math.max(...rr) - Math.min(...rr)) / 1000, 0.02);
  return Math.max(0, Math.min(100, 68 * Math.log10(Math.max(amo / (2 * mo * mx), 30) / 30)));
}

/* ==================== Slaapscore (port van sleepscore.py) ==================== */
function sleepScore(sess, ownMedian) {
  if (!sess || !sess.segments || !sess.segments.length) return null;
  const slept = sess.total_minutes || 0; if (slept < 120) return null;
  const inBed = sess.segments.reduce((a, s) => a + s.minutes, 0) || 1;
  const t = sess.totals || {}, awake = t.awake || 0;
  const target = ownMedian || 450;
  const duur = 40 * Math.min(1, slept / target);
  const eff = sess.efficiency != null ? sess.efficiency : slept / inBed;
  const effp = 20 * Math.min(1, eff / 0.9);
  const inner = sess.segments.slice(1, -1);
  const wakes = inner.filter((s) => s.stage === "awake").length;
  const rust = 20 * Math.max(0, 1 - wakes * 0.18 - Math.min(awake, 90) / 90 * 0.35);
  const dr = (t.deep || 0) + (t.rem || 0), share = slept ? dr / slept : 0;
  let drf = share >= 0.35 && share <= 0.5 ? 1 : share < 0.35 ? Math.max(0, share / 0.35) : Math.max(0.6, 1 - (share - 0.5) * 2);
  const total = duur + effp + rust + 20 * drf;
  const label = total >= 85 ? "Uitstekend geslapen" : total >= 70 ? "Goed geslapen" : total >= 50 ? "Matig geslapen" : "Slecht geslapen";
  return { score: Math.round(total), label, basislijn: ownMedian ? "eigen mediaan" : "algemene richtlijn",
    breakdown: { Duur: [Math.round(duur), 40], Efficiëntie: [Math.round(effp), 20], Rustigheid: [Math.round(rust), 20], "Diep + REM": [Math.round(20 * drf), 20] } };
}

/* ==================== Frame-parsers ==================== */
function parseSteps(d) {
  return { steps: beInt(d, 1, 4), running: beInt(d, 4, 7), kcal: Math.round(beInt(d, 7, 10) / 1000),
    dist: beInt(d, 10, 13), active: beInt(d, 13, 15) };
}
function parseDaySport(frames) {  // opcode 7, 2 pockets
  const out = {};
  for (const d of frames) {
    const pocket = d[1], daysAgo = dbcd(d[2]);
    const a = beInt(d, 6, 9), b = beInt(d, 9, 12), c = beInt(d, 12, 15);
    const key = daysAgo;
    out[key] = out[key] || { daysAgo, year: 2000 + dbcd(d[3]), month: dbcd(d[4]), day: dbcd(d[5]) };
    if (pocket === 0) Object.assign(out[key], { steps: a, running: b, kcal: Math.round(c / 1000) });
    else Object.assign(out[key], { dist: a, sport: b, sleepMin: c });
  }
  return Object.values(out);
}
function parseHrHistory(frames, rangeMin = 5) {
  let start = null; const samples = [];
  const sorted = frames.map((d) => d.slice(1, 15)).sort((a, b) => (a[0] || 255) - (b[0] || 255));
  for (const p of sorted) {
    if (p[0] === 0) continue;
    if (p[0] === 1) { start = p[1] | (p[2] << 8) | (p[3] << 16) | (p[4] << 24); for (let i = 5; i < 14; i++) samples.push(p[i]); }
    else for (let i = 1; i < 14; i++) samples.push(p[i]);
  }
  if (start == null) return [];
  const out = [];
  samples.forEach((bpm, i) => { if (bpm >= 30 && bpm <= 220) out.push([start + i * rangeMin * 60, bpm]); });
  return out;
}
function parseSleep(frames) {
  const codes = [];
  for (const d of frames) {
    const p = d.slice(1, 15), head = p[0] & 0xff;
    if (head === 0xff || head === 0xf0 || p.length < 13) continue;
    for (let i = 6; i < 13; i++) codes.push(STAGE_CODE[p[i] & 0xff] || "light");
  }
  if (!codes.length) return null;
  const segs = []; const SLOT = 5;
  for (const st of codes) { if (segs.length && segs[segs.length - 1].stage === st) segs[segs.length - 1].minutes += SLOT; else segs.push({ stage: st, minutes: SLOT }); }
  const totals = { deep: 0, light: 0, rem: 0, awake: 0 };
  segs.forEach((s) => { totals[s.stage] += s.minutes; });
  const total = segs.reduce((a, s) => a + s.minutes, 0);
  const sleptMin = total - totals.awake;
  const now = Date.now() / 1000, end = now - 2 * 3600, startTs = end - total * 60;
  return { start: startTs, end, total_minutes: sleptMin, totals, segments: segs,
    efficiency: total ? Math.round(sleptMin / total * 1000) / 1000 : 0 };
}

/* ==================== Lokale opslag (IndexedDB) ==================== */
const DB = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const rq = indexedDB.open("meetboek", 2);
      rq.onupgradeneeded = (e) => {
        const d = rq.result;
        if (!d.objectStoreNames.contains("m")) { const st = d.createObjectStore("m", { keyPath: "id", autoIncrement: true }); st.createIndex("metric_ts", ["metric", "ts"]); }
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    return this._p;
  },
  async add(metric, value, unit, conf = null, ts = null) {
    const d = await this.open();
    return new Promise((res, rej) => { const tx = d.transaction("m", "readwrite");
      tx.objectStore("m").add({ metric, value, unit, conf, ts: ts != null ? ts : Date.now() / 1000 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
  async addAt(metric, value, unit, ts, conf = null) { return this.add(metric, value, unit, conf, ts); },
  async history(metric, sinceTs = 0) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const idx = d.transaction("m").objectStore("m").index("metric_ts");
      const out = []; idx.openCursor(IDBKeyRange.bound([metric, sinceTs], [metric, Infinity])).onsuccess = (e) => {
        const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
      d.onerror = () => rej(d.error);
    });
  },
  async latest(metric) { const h = await this.history(metric); return h.length ? h[h.length - 1] : null; },
  async getMeta(k) { const d = await this.open(); return new Promise((res) => { const r = d.transaction("meta").objectStore("meta").get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
  async setMeta(k, v) { const d = await this.open(); return new Promise((res) => { const tx = d.transaction("meta", "readwrite"); tx.objectStore("meta").put(v, k); tx.oncomplete = res; }); },
  // dagelijkse historie-dedup: alleen opslaan als er die dag nog geen sample staat
  async hasOnDay(metric, ts) {
    const dayStart = Math.floor(ts / 86400) * 86400;
    const h = await this.history(metric, dayStart);
    return h.some((m) => m.ts >= dayStart && m.ts < dayStart + 86400);
  },
};

/* ==================== Helpers ==================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3400); }
function relTime(ts) { if (!ts) return "—"; const s = Date.now() / 1000 - ts; if (s < 45) return "zojuist"; if (s < 3600) return Math.round(s / 60) + " min geleden"; if (s < 86400) return Math.round(s / 3600) + " u geleden"; if (s < 172800) return "gisteren"; return new Date(ts * 1000).toLocaleDateString("nl-NL", { day: "numeric", month: "short" }); }
function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }); }
const tab = () => location.hash.replace("#", "") || "today";
const TABS = { today: "Vandaag", measure: "Meten", sleep: "Slaap", trends: "Trends" };

/* ==================== BLE-sessie (zelfherstellend) ==================== */
const S = { device: null, server: null, wr: null, connected: false, connecting: false,
  lastBpm: null, lastBpmTs: 0, lastHr0Ts: 0, pending: {}, collectors: [], hrKeep: null,
  reconnectTimer: null, backoff: 3000, battery: null, syncing: false };

function onFrame(dv) {
  const d = new Uint8Array(dv.buffer);
  if (d.length !== 16 || !checksumOk(d)) return;
  const op = d[0] & 0x7f;
  if (op === OP.REALTIME_HR) { const bpm = d[1]; if (bpm > 0) { S.lastBpm = bpm; S.lastBpmTs = Date.now(); onLiveHr(bpm); } else S.lastHr0Ts = Date.now(); }
  const w = S.pending[op]; if (w && (!w.pred || w.pred(d))) { delete S.pending[op]; w.res(d); }
  S.collectors.forEach((c) => { if (c.op === op) { c.frames.push(d); c.last = Date.now(); } });
  if (S.hrvGrab && op === OP.START_MEASURE) S.hrvGrab(d);
}
async function write(frame) {
  if (!S.wr) throw new Error("Niet verbonden");
  // Robuust schrijven: sommige stacks (o.a. iOS/Bluefy) ondersteunen alleen
  // één schrijfmethode. Kies op basis van de characteristic-eigenschappen.
  const w = S.wr, p = w.properties || {};
  if (p.writeWithoutResponse && w.writeValueWithoutResponse) return w.writeValueWithoutResponse(frame);
  if (p.write && w.writeValueWithResponse) return w.writeValueWithResponse(frame);
  if (w.writeValueWithoutResponse) { try { return await w.writeValueWithoutResponse(frame); } catch {} }
  if (w.writeValueWithResponse) { try { return await w.writeValueWithResponse(frame); } catch {} }
  return w.writeValue(frame);
}
function request(op, frame, timeout = 12000, pred = null) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { delete S.pending[op]; rej(new Error("Horloge antwoordde niet")); }, timeout);
    S.pending[op] = { pred, res: (d) => { clearTimeout(to); res(d); } };
    write(frame).catch((e) => { clearTimeout(to); delete S.pending[op]; rej(e); });
  });
}
async function collect(op, frame, { quiet = 700, maxMs = 8000 } = {}) {
  const c = { op, frames: [], last: Date.now() }; S.collectors.push(c);
  try {
    await write(frame); const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 120));
      if (c.frames.length && Date.now() - c.last > quiet) break;
      if (!c.frames.length && Date.now() - t0 > 2500) break;
    }
    return c.frames;
  } finally { S.collectors = S.collectors.filter((x) => x !== c); }
}

function connBanner(msg, kind) {
  // Zichtbare verbindings-statusregel (zodat je precies ziet wat er gebeurt).
  let el = $("#connmsg");
  if (!el) { el = document.createElement("div"); el.id = "connmsg"; $("#view").prepend(el); }
  el.className = "connmsg " + (kind || "");
  el.textContent = msg;
}
async function connectWatch(filtered) {
  clearTimeout(S.reconnectTimer);
  if (!navigator.bluetooth) { showNoBluetooth(); return; }
  try {
    connBanner("Kies je horloge in de lijst (H59_…)…", "wait");
    // Standaard ALLE apparaten tonen: op iOS/Bluefy verschijnt de H59 dan
    // gegarandeerd in de kieslijst (gefilterd op naam/service faalt soms stil).
    const opts = filtered
      ? { filters: [{ namePrefix: "H59" }, { services: [ADV_SERVICE] }], optionalServices: [UART_SERVICE, "device_information"] }
      : { acceptAllDevices: true, optionalServices: [UART_SERVICE, "device_information"] };
    const dev = await navigator.bluetooth.requestDevice(opts);
    S.device = dev;
    dev.addEventListener("gattserverdisconnected", onDisconnected);
    localStorage.setItem("watchName", dev.name || "horloge");
    await gattConnect();
  } catch (e) {
    setChip();
    if (e && (e.name === "NotFoundError" || e.name === "AbortError")) {
      connBanner("Geen apparaat gekozen. Tik nog eens op 'Verbind' en kies H59_5A06. Zie je 'm niet? Ga naar iPhone → Instellingen → Bluetooth en 'vergeet' H59 daar (dan is hij vrij voor deze app).", "err");
    } else {
      connBanner("Bluetooth-fout: " + (e && e.message ? e.message : e), "err");
    }
  }
}
// Bij het openen: als je het horloge eerder koos, meteen weer verbinden.
async function tryAutoReconnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devs = await navigator.bluetooth.getDevices();
    const w = devs.find((d) => (d.name || "").toUpperCase().includes("H59")) || devs[0];
    if (w) { S.device = w; w.addEventListener("gattserverdisconnected", onDisconnected); localStorage.setItem("watchName", w.name || "horloge"); setChip(); gattConnect(); }
  } catch {}
}
async function gattConnect() {
  const dev = S.device; if (!dev || S.connecting) return;
  S.connecting = true;
  try {
    connBanner("Verbinden met " + (dev.name || "horloge") + "…", "wait");
    setChip("verbinden…");
    S.server = await dev.gatt.connect();
    connBanner("Services zoeken…", "wait");
    const svc = await S.server.getPrimaryService(UART_SERVICE);
    const nt = await svc.getCharacteristic(UART_NOTIFY);
    S.wr = await svc.getCharacteristic(UART_WRITE);
    await nt.startNotifications();
    nt.addEventListener("characteristicvaluechanged", (e) => onFrame(e.target.value));
    // Verbinding staat zodra we kunnen luisteren+schrijven. De handshake is
    // best-effort: een hikje daarin mag de verbinding niet laten mislukken.
    S.connected = true; S.backoff = 3000; setChip();
    const cm = $("#connmsg"); if (cm) cm.remove(); const ab = $("#allbtn"); if (ab) ab.remove();
    toast(`Verbonden met ${dev.name || "horloge"}`);
    for (const f of [setTimeFrame(), buildFrame(OP.FUNC_SUPPORT), buildFrame(OP.BATTERY), buildFrame(OP.PHONE_OS, [2])]) { try { await write(f); } catch {} await new Promise((r) => setTimeout(r, 250)); }
    startLiveHr();
    render();
    sync();  // meteen alles ophalen
  } catch (e) {
    S.connected = false; S.wr = null; setChip();
    connBanner("Verbinden mislukt: " + (e && e.message ? e.message : e) + " — ik probeer het automatisch opnieuw.", "err");
    clearTimeout(S.reconnectTimer); S.backoff = Math.min(S.backoff * 1.6, 30000);
    S.reconnectTimer = setTimeout(() => { if (S.device && !S.connected) gattConnect(); }, S.backoff);
  } finally { S.connecting = false; }
}
function onDisconnected() {
  S.connected = false; S.wr = null; setChip(); clearInterval(S.hrKeep);
  clearTimeout(S.reconnectTimer); S.reconnectTimer = setTimeout(() => { if (S.device && !S.connected) gattConnect(); }, 3000);
}

/* ---- live hartslag ---- */
function startLiveHr() {
  write(buildFrame(OP.REALTIME_HR, [1])).catch(() => {});
  clearInterval(S.hrKeep);
  S.hrKeep = setInterval(() => { write(buildFrame(OP.REALTIME_HR, [3])).catch(() => {}); }, 15000);
  clearInterval(S.hrPersist);
  S.hrPersist = setInterval(() => { if (S.lastBpm && Date.now() - S.lastBpmTs < 15000) DB.add("heart_rate", S.lastBpm, "bpm", 0.8); }, 30000);
}
function onLiveHr(bpm) {
  const el = $("#hrhero"); if (!el) return;
  const v = $("#hrval", el), b = $("#hrbadge", el);
  if (v && v.textContent !== String(bpm)) { v.textContent = bpm; const row = $(".hr-main", el); if (row) { row.classList.remove("pop"); void row.offsetWidth; row.classList.add("pop"); } }
  el.classList.add("beat"); el.classList.remove("nocontact"); el.style.setProperty("--beat", (60 / Math.max(40, bpm)).toFixed(2) + "s");
  if (b) b.textContent = "LIVE";
}
setInterval(() => {
  const el = $("#hrhero"); if (!el) return;
  const b = $("#hrbadge", el), v = $("#hrval", el);
  if (Date.now() - S.lastBpmTs < 20000) return;
  el.classList.remove("beat"); el.classList.add("nocontact"); if (v) v.textContent = "—";
  if (b) b.textContent = !S.connected ? (S.device ? "VERBINDEN…" : "NIET GEKOPPELD") : (Date.now() - S.lastHr0Ts < 20000 ? "GEEN HUIDCONTACT" : "WACHT OP HARTSLAG…");
}, 3000);

/* ---- synchroniseren: batterij, stappen, HR-historie, dagtotalen, slaap ---- */
async function sync() {
  if (!S.connected || S.syncing) return;
  S.syncing = true; $("#syncbar").classList.add("show");
  try {
    try { const b = await request(OP.BATTERY, buildFrame(OP.BATTERY)); S.battery = b[1]; await DB.add("battery", b[1], "%"); } catch {}
    try { const st = parseSteps(await request(OP.STEPS_TODAY, buildFrame(OP.STEPS_TODAY)));
      if (st.steps > 0) await DB.add("steps", st.steps, "");
      if (st.kcal > 0) await DB.add("calories", st.kcal, "kcal");
      if (st.dist > 0) await DB.add("distance", st.dist, "m"); } catch {}
    // HR-historie sinds de cursor (max een week terug)
    try {
      let since = await DB.getMeta("hrHistorySince");
      const now = Date.now() / 1000;
      if (!since || since <= 0) since = now - 24 * 3600;
      since = Math.max(since, now - 7 * 86400);
      const buf = new Uint8Array(4); new DataView(buf.buffer).setUint32(0, Math.floor(since), true);
      const frames = await collect(OP.HR_HISTORY, buildFrame(OP.HR_HISTORY, [...buf]), { quiet: 700, maxMs: 9000 });
      const samples = parseHrHistory(frames);
      let newest = since;
      for (const [ts, bpm] of samples) { if (ts >= since && ts <= now + 300) { await DB.addAt("heart_rate", bpm, "bpm", ts, 0.7); newest = Math.max(newest, ts); } }
      if (samples.length) await DB.setMeta("hrHistorySince", newest + 1); else await DB.setMeta("hrHistorySince", now);
    } catch {}
    // dagtotalen 7 dagen terug
    try {
      const frames = [];
      for (let off = 1; off <= 7; off++) { const fs = await collect(OP.DAY_SPORT, buildFrame(OP.DAY_SPORT, [off]), { quiet: 500, maxMs: 3000 }); frames.push(...fs); }
      for (const day of parseDaySport(frames)) {
        const end = new Date(day.year, day.month - 1, day.day, 23, 59).getTime() / 1000;
        if (isNaN(end)) continue;
        for (const [metric, val, unit] of [["steps", day.steps, ""], ["calories", day.kcal, "kcal"], ["distance", day.dist, "m"], ["sleep", day.sleepMin, "min"]]) {
          if (val && val > 0 && !(await DB.hasOnDay(metric, end))) await DB.addAt(metric, val, unit, end);
        }
      }
    } catch {}
    // slaap van vannacht
    try {
      const frames = await collect(OP.SLEEP, buildFrame(OP.SLEEP, [0, 15, 0, 95]), { quiet: 800, maxMs: 9000 });
      const sess = parseSleep(frames);
      if (sess && sess.total_minutes > 0) {
        await DB.setMeta("lastSleep", sess);
        await DB.add("sleep", sess.total_minutes, "min", 0.6);
        const hist = (await DB.getMeta("sleepSessions")) || [];
        const key = new Date((sess.end || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
        const merged = hist.filter((h) => h.date !== key); merged.push({ date: key, start: sess.start, end: sess.end, total_minutes: sess.total_minutes });
        await DB.setMeta("sleepSessions", merged.slice(-30));
      }
    } catch {}
    await DB.setMeta("lastSync", Date.now() / 1000);
    toast("Synchronisatie klaar");
  } finally { S.syncing = false; $("#syncbar").classList.remove("show"); setChip(); render(); }
}

/* ---- metingen ---- */
let measuring = false;
async function doMeasure(kind, btn) {
  if (!S.connected) { toast("Verbind eerst met het horloge"); return; }
  if (measuring) return;
  measuring = true;
  const last = $(".last", btn), t0 = Date.now();
  btn.setAttribute("aria-busy", "true");
  const tick = setInterval(() => { last.innerHTML = `<span class="spin"></span>meten… ${Math.round((Date.now() - t0) / 1000)}s`; }, 400);
  try {
    if (kind === "hrv") {
      // Het horloge rekent zelf geen HRV: het streamt RR-intervallen (bytes 6-7),
      // wij verzamelen ze en rekenen RMSSD + stressindex uit (port van hrv.py).
      const rr = [];
      S.hrvGrab = (d) => { if (d[1] === MEASURE.hrv) { const live = d[6] | (d[7] << 8); if (live >= RR_MIN && live <= RR_MAX) rr.push(live); } };
      await write(buildFrame(OP.START_MEASURE, [MEASURE.hrv, bcd(25)]));
      const t1 = Date.now();
      while (Date.now() - t1 < 45000 && rr.length < 30) { await new Promise((r) => setTimeout(r, 400)); if (!rr.length && Date.now() - t1 > 9000) break; }
      S.hrvGrab = null;
      await write(buildFrame(OP.STOP_MEASURE, [MEASURE.hrv, 0, 0])).catch(() => {});
      if (rr.length >= MIN_BEATS) {
        const h = Math.round(rmssd(rr) * 10) / 10, st = Math.round(stressIndex(rr));
        await DB.add("hrv", h, "ms", 0.7); await DB.add("stress", st, "score", 0.7);
        toast(`HRV ${h} ms · stress ${st} · ${rr.length} slagen`);
      } else toast("Geen hartslagen gevangen — draag het horloge strak");
    } else {
      const type = MEASURE[kind];
      const isRes = (d) => d[1] === type && d[2] === 0 && (d[3] > 0 || d[4] > 0);
      const d = await request(OP.START_MEASURE, buildFrame(OP.START_MEASURE, [type, type >= 3 ? bcd(25) : 0]), 40000, isRes);
      await write(buildFrame(OP.STOP_MEASURE, [type, 0, 0])).catch(() => {});
      if (kind === "blood_pressure") { await DB.add("blood_pressure_systolic", d[4], "mmHg", 0.7); await DB.add("blood_pressure_diastolic", d[5], "mmHg", 0.7); toast(`${d[4]}/${d[5]} mmHg`); }
      else { const unit = kind === "spo2" ? "%" : "bpm"; await DB.add(kind === "spo2" ? "spo2" : "heart_rate", d[3], unit, 0.8); toast(`${d[3]} ${unit}`); }
    }
  } catch (e) { toast("Meten: " + e.message); }
  finally { clearInterval(tick); btn.removeAttribute("aria-busy"); measuring = false; S.hrvGrab = null; render(); }
}
async function vibrate() { try { await write(buildFrame(OP.FIND_DEVICE, [0x55, 0xaa])); toast("Tril verstuurd 📳"); } catch (e) { toast(e.message); } }

/* ==================== UI-componenten ==================== */
const CVAR = { heart_rate: "heart", hrv: "hrv", spo2: "spo2", stress: "stress", blood_pressure_systolic: "bp", steps: "steps", distance: "dist", calories: "cal", sleep: "sleep", battery: "batt" };
const LABEL = { heart_rate: "Hartslag", hrv: "HRV", spo2: "SpO2", stress: "Stress", blood_pressure_systolic: "Bloeddruk", steps: "Stappen", distance: "Afstand", calories: "Calorieën", sleep: "Slaap", battery: "Batterij" };
const UNIT = { heart_rate: "bpm", hrv: "ms", spo2: "%", stress: "", blood_pressure_systolic: "mmHg", steps: "", distance: "m", calories: "kcal", battery: "%" };
const HEART = '<path d="M12 21s-7-4.4-9.5-8.4C.8 9.6 2 6 5.2 6c1.9 0 3.1 1 3.8 2 .7-1 1.9-2 3.8-2C16 6 17.2 9.6 15.5 12.6 13 16.6 12 21 12 21z"/>';
function ecg() { const beat = [[0, 20], [10, 20], [14, 16], [18, 20], [26, 20], [30, 22], [33, 6], [36, 32], [39, 18], [42, 20], [54, 20], [60, 14], [66, 20], [80, 20]]; let p = ""; for (let r = 0; r < 8; r++) p += beat.map(([x, y]) => `${x + r * 80},${y}`).join(" ") + " "; return `<svg viewBox="0 0 320 40" preserveAspectRatio="none"><g class="ecg-g"><polyline points="${p}" fill="none" stroke="var(--c-heart)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></g></svg>`; }
function heroCard(bpm, fresh) {
  return `<a class="hero ${fresh ? "beat" : "nocontact"}" id="hrhero" href="#measure" ${fresh ? `style="--beat:${(60 / Math.max(40, bpm)).toFixed(2)}s"` : ""}>
    <div class="hr-top"><svg class="heart" viewBox="0 0 24 24" fill="currentColor">${HEART}</svg><span class="hr-name">Hartslag</span><span class="live" id="hrbadge">${fresh ? "LIVE" : (S.connected ? "WACHT OP HARTSLAG…" : (S.device ? "VERBINDEN…" : "NIET GEKOPPELD"))}</span></div>
    <div class="hr-main"><span class="v" id="hrval">${fresh ? bpm : "—"}</span><u>bpm</u></div><div class="ecg">${ecg()}</div></a>`;
}
function sparkline(pts, cvar) { if (pts.length < 2) return ""; const v = pts.map((p) => p.value), mn = Math.min(...v), mx = Math.max(...v), sp = (mx - mn) || 1; const pp = pts.map((p, i) => `${(i / (pts.length - 1) * 96 + 2).toFixed(1)},${(36 - (p.value - mn) / sp * 32).toFixed(1)}`).join(" "); return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:100%"><polyline class="sline" points="${pp}" pathLength="1" fill="none" stroke="var(${cvar})" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`; }
function metricCard(metric, m, spark) {
  const cv = "--c-" + (CVAR[metric] || "heart");
  return `<a class="hcard" href="#trends" style="--c:var(${cv})"><div class="hc-top"><span class="hc-name" style="color:var(${cv})">${LABEL[metric]}</span><span class="hc-time">${relTime(m.ts)}</span></div><div class="hc-val">${fmt(m.value, Number.isInteger(m.value) ? 0 : 1)}<u>${UNIT[metric] || ""}</u></div>${spark && spark.length > 1 ? `<div class="hc-spark">${sparkline(spark, cv)}</div>` : ""}</a>`;
}
function ringCard(today, best, goal) {
  const R = [52, 40, 28], col = ["var(--c-steps)", "var(--c-cal)", "var(--c-dist)"];
  const fr = [goal ? clamp((today.steps || 0) / goal, 0, 1) : 0, best.kcal ? clamp((today.kcal || 0) / best.kcal, 0, 1) : 0, best.dist ? clamp((today.dist || 0) / best.dist, 0, 1) : 0];
  const circ = (r, f, c) => { const L = 2 * Math.PI * r; return `<circle class="track" cx="64" cy="64" r="${r}" stroke="${c}"/><circle class="prog" cx="64" cy="64" r="${r}" stroke="${c}" style="--len:${(f * L).toFixed(1)}" stroke-dasharray="${(f * L).toFixed(1)} 1000"/>`; };
  const km = (m) => m >= 1000 ? fmt(m / 1000, 1) + " km" : fmt(m) + " m";
  return `<div class="ringcard"><div class="ringwrap"><svg class="rings" viewBox="0 0 128 128">${circ(R[0], fr[0], col[0])}${circ(R[1], fr[1], col[1])}${circ(R[2], fr[2], col[2])}</svg></div>
    <div class="rc-txt"><div class="rc-row"><i style="background:var(--c-steps)"></i><b>${fmt(today.steps || 0)}</b><span>/ ${fmt(goal)} stappen</span></div>
    <div class="rc-row"><i style="background:var(--c-cal)"></i><b>${fmt(today.kcal || 0)}</b><span>kcal</span></div>
    <div class="rc-row"><i style="background:var(--c-dist)"></i><b>${km(today.dist || 0)}</b><span>afstand</span></div></div></div>`;
}
const SL_LBL = { deep: "Diep", light: "Licht", rem: "REM", awake: "Wakker" };
function sleepCard(s, score) {
  const segs = s.segments || [], total = segs.reduce((a, x) => a + x.minutes, 0) || 1;
  const W = 320, H = 76, lvl = { deep: 3, light: 2, rem: 1, awake: 0 }, rh = H / 4; let x = 0, rects = "";
  for (const g of segs) { const w = g.minutes / total * W, y = (lvl[g.stage] ?? 2) * rh; rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.8, w).toFixed(1)}" height="${rh.toFixed(1)}" fill="var(--st-${g.stage})"/>`; x += w; }
  const pct = (st) => Math.round((s.totals?.[st] || 0) / total * 100);
  const leg = ["deep", "rem", "light", "awake"].map((st) => `<span><i style="background:var(--st-${st})"></i>${SL_LBL[st]} ${pct(st)}%</span>`).join("");
  const h = (m) => `${Math.floor(m / 60)} u ${m % 60} min`;
  const sc = score ? `<div class="slscore"><div class="num">${score.score}</div><div class="lbl">${esc(score.label)}</div><div class="base">${esc(score.basislijn)}</div></div>` : "";
  const bd = score ? `<div class="slbd">${Object.entries(score.breakdown).map(([k, [p, mx]]) => `<div class="row"><span>${k}</span><i><b style="width:${Math.round(p / mx * 100)}%"></b></i><em>${p}/${mx}</em></div>`).join("")}</div>` : "";
  return `<div class="hcard wide" style="--c:var(--c-sleep)"><div class="hc-top"><span class="hc-name" style="color:var(--c-sleep)">Slaap</span><span class="hc-time">${s.start ? hhmm(s.start) + "–" + hhmm(s.end) : ""}</span></div>
    <div class="slgrid"><div><div class="hc-val" style="margin-top:2px">${h(s.total_minutes || 0)}<u style="font-size:12px">${s.efficiency != null ? Math.round(s.efficiency * 100) + "% efficiëntie" : ""}</u></div>
    <svg class="hyp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${rects}</svg><div class="hyp-legend">${leg}</div></div>${sc}</div>${bd}</div>`;
}
function bigChart(pts, cvar) {
  if (pts.length < 2) return `<div class="empty">Te weinig data.</div>`;
  const W = 620, H = 200, pB = 20, pT = 10, pL = 6, pR = 6;
  const v = pts.map((p) => p.value), mn = Math.min(...v), mx = Math.max(...v), sp = (mx - mn) || 1;
  const x = (i) => pL + i / (pts.length - 1) * (W - pL - pR), y = (val) => H - pB - (val - mn) / sp * (H - pT - pB);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `M${x(0).toFixed(1)},${H - pB} ${pts.map((p, i) => `L${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")} L${x(pts.length - 1).toFixed(1)},${H - pB} Z`;
  const st = { avg: Math.round(v.reduce((a, b) => a + b) / v.length), min: Math.round(mn), max: Math.round(mx) };
  return `<div class="readout"><span class="big">gem ${st.avg} · min ${st.min} · max ${st.max}</span></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="area" d="${area}" fill="var(${cvar})" fill-opacity=".08"/><path class="line" d="${line}" pathLength="1" fill="none" stroke="var(${cvar})" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/* ==================== Views ==================== */
const DISCL = `<p class="disclaimer">Pc-loos — je telefoon praat rechtstreeks met het horloge; alle data blijft op dit toestel. Geen medisch hulpmiddel; stress is een index uit je eigen RR-intervallen.</p>`;
const views = {};
views.today = async () => {
  const fresh = S.lastBpm && Date.now() - S.lastBpmTs < 20000;
  const hero = `<div class="sec" style="margin-top:8px">${heroCard(S.lastBpm, fresh)}</div>`;
  // ringen
  const stepsToday = await DB.latest("steps"), calToday = await DB.latest("calories"), distToday = await DB.latest("distance");
  const wkMax = async (m) => { const h = await DB.history(m, Date.now() / 1000 - 7 * 86400); return Math.max(0, ...h.map((x) => x.value)); };
  const goal = (await DB.getMeta("stepGoal")) || 10000;
  const today = { steps: stepsToday?.value, kcal: calToday?.value, dist: distToday?.value };
  const rings = (stepsToday || calToday) ? `<div class="sec">${ringCard(today, { kcal: await wkMax("calories"), dist: await wkMax("distance") }, goal)}</div>` : "";
  // vitalen
  const vk = ["hrv", "spo2", "stress", "blood_pressure_systolic", "battery"];
  const cards = [];
  for (const k of vk) { const m = await DB.latest(k === "blood_pressure_systolic" ? "blood_pressure_systolic" : k); if (m) { const sp = await DB.history(k, Date.now() / 1000 - 7 * 86400); cards.push(metricCard(k, m, sp.slice(-40))); } }
  const vit = cards.length ? `<div class="sec"><div class="sec-h"><h2>Vitalen</h2></div><div class="grid2">${cards.join("")}</div></div>` : "";
  // slaap-teaser
  const slp = await DB.getMeta("lastSleep");
  const sleepSec = slp ? `<div class="sec"><div class="sec-h"><h2>Slaap</h2><a href="#sleep">Toon meer</a></div>${sleepCard(slp, sleepScore(slp))}</div>` : "";
  const connBtn = !S.device ? `<div class="sec"><button class="btn block" data-action="connect">Verbind met horloge</button></div>` : (!S.connected ? `<div class="sec"><button class="btn block" data-action="connect">Opnieuw verbinden</button></div>` : `<div class="sec"><button class="btn ghost block" data-action="sync">Synchroniseer nu</button></div>`);
  if (!stepsToday && !calToday && !slp && !fresh) return connBtn + hero + `<div class="empty">Verbind je horloge om je gegevens te zien.</div>` + DISCL;
  return connBtn + hero + rings + vit + sleepSec + DISCL;
};
const MEASURABLE = [["heart_rate", "Hartslag", "±20 s"], ["spo2", "Bloedzuurstof (SpO2)", "±35 s"], ["blood_pressure", "Bloeddruk", "±35 s"], ["hrv", "HRV + stress", "±45 s"]];
views.measure = async () => {
  const rows = [];
  for (const [kind, label, dur] of MEASURABLE) {
    const mk = kind === "blood_pressure" ? "blood_pressure_systolic" : kind;
    const lm = await DB.latest(mk);
    let lastTxt = lm ? `${fmt(lm.value, Number.isInteger(lm.value) ? 0 : 1)} ${UNIT[mk] || ""} · ${relTime(lm.ts)}` : dur;
    if (kind === "blood_pressure" && lm) { const dia = await DB.latest("blood_pressure_diastolic"); if (dia) lastTxt = `${lm.value}/${dia.value} mmHg · ${relTime(lm.ts)}`; }
    const cv = "--c-" + (CVAR[mk] || "heart");
    rows.push(`<button class="mrow" data-action="measure" data-kind="${kind}" style="color:var(${cv})"><span class="mic">${LABEL_ICON(mk)}</span><div style="color:var(--ink)"><div class="lab">${label}</div><div class="last">${lastTxt}</div></div><span></span><span class="chev">›</span></button>`);
  }
  const status = S.connected ? "" : `<p class="disclaimer" style="margin:4px 0 0;color:var(--bad)">Niet verbonden — verbind eerst op Vandaag.</p>`;
  return `${status}<p class="disclaimer" style="margin:4px 0 0">Draag het horloge strak; een meting duurt 20–45 s.</p>
    <div class="sec"><div class="sec-h"><h2>Meet nu</h2></div><div class="list">${rows.join("")}</div></div>
    <div class="sec"><button class="btn ghost block" data-action="vibrate">Laat horloge trillen 📳</button></div>${DISCL}`;
};
function LABEL_ICON(k) {
  const I = { heart_rate: HEART, blood_pressure_systolic: HEART, spo2: '<path d="M12 3s6 6.4 6 11a6 6 0 1 1-12 0c0-4.6 6-11 6-11z"/>', hrv: '<path d="M3 12h3l2-6 3 12 2-8 2 5h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' };
  return `<svg viewBox="0 0 24 24" fill="currentColor" width="19" height="19">${I[k] || HEART}</svg>`;
}
views.sleep = async () => {
  const slp = await DB.getMeta("lastSleep");
  const sessions = (await DB.getMeta("sleepSessions")) || [];
  if (!slp && !sessions.length) return `<div class="empty" style="padding-top:60px"><div style="font-size:40px;margin-bottom:10px">🌙</div>Nog geen slaapdata.<br/>Draag het horloge vannacht; bij de ochtend-sync verschijnt hier je slaap.</div>${DISCL}`;
  const nights = sessions.map((s) => s.total_minutes).filter(Boolean);
  let own = null; if (nights.length >= 5) { const s = [...nights].sort((a, b) => a - b); own = s[Math.floor(s.length / 2)]; }
  const nightSec = slp ? `<div class="sec" style="margin-top:8px"><div class="sec-h"><h2>Laatste nacht</h2></div>${sleepCard(slp, sleepScore(slp, own))}</div>` : "";
  const list = sessions.length ? `<div class="sec"><div class="sec-h"><h2>Nachten</h2></div><div class="list">${sessions.slice().reverse().map((n) => { const h = Math.floor((n.total_minutes || 0) / 60), m = (n.total_minutes || 0) % 60; const dt = new Date(n.date + "T12:00:00"); return `<div class="setrow" style="min-height:50px"><span class="mic" style="color:var(--c-sleep)"><svg viewBox="0 0 24 24" fill="currentColor" width="18"><path d="M21 12.8A8 8 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/></svg></span><div><div class="lab">${dt.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "short" })}</div></div><b style="font-family:var(--rounded);font-weight:700">${h}u${String(m).padStart(2, "0")}</b></div>`; }).join("")}</div></div>` : "";
  return nightSec + list + DISCL;
};
views.trends = async () => {
  const metrics = ["heart_rate", "spo2", "hrv", "stress", "steps", "calories", "distance", "sleep"];
  const parts = [];
  for (const m of metrics) {
    const h = await DB.history(m, Date.now() / 1000 - 30 * 86400);
    if (h.length < 2) continue;
    parts.push(`<div class="sec"><div class="sec-h"><h2>${LABEL[m] || m}</h2></div><div class="chartcard">${bigChart(h.slice(-200), "--c-" + (CVAR[m] || "heart"))}</div></div>`);
  }
  return parts.length ? parts.join("") + DISCL : `<div class="empty">Nog geen trends — verbind, synchroniseer en meet een paar dagen.</div>`;
};

/* ==================== Router ==================== */
let lastView = null;
async function render() {
  const t = tab(), name = views[t] ? t : "today";
  $("#title").textContent = TABS[name];
  $$("#dock a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
  const host = $("#view");
  const nav = name !== lastView;
  try {
    const html = await views[name]();
    host.innerHTML = `<div class="screen ${nav ? "enter" : "still"}">${html}</div>`;
    lastView = name; if (nav) window.scrollTo({ top: 0 });
  } catch (e) { host.innerHTML = `<div class="screen"><div class="empty">Kon niet laden: ${esc(e.message)}</div></div>`; }
}
function setChip(txt) {
  const chip = $("#chip");
  const name = localStorage.getItem("watchName") || "horloge";
  if (txt) { chip.innerHTML = `<span class="dot"></span>${esc(txt)}`; return; }
  if (S.connected) chip.innerHTML = `<span class="dot on"></span>${esc(name)}${S.battery != null ? " · " + S.battery + "%" : ""}`;
  else chip.innerHTML = `<span class="dot"></span>${S.device ? "verbinden…" : "niet verbonden"}`;
}
function showNoBluetooth() {
  $("#view").innerHTML = `<div class="screen"><div class="empty" style="padding-top:50px">
    <div style="font-size:40px;margin-bottom:12px">📵</div>
    <b>Deze browser kan geen Bluetooth</b><br/><br/>
    Op de iPhone kan Safari geen Bluetooth (Apple-beperking). Open deze app in de
    gratis <b>Bluefy</b>-browser uit de App Store — dan werkt alles rechtstreeks,
    zonder pc. Op Android werkt gewoon Chrome.</div></div>`;
}

/* ==================== PIN-slot (privé voor alleen jou) ====================
   De data staat al alleen op dít toestel; dit slot voorkomt dat iemand die je
   telefoon in handen krijgt de app opent. Client-side (persoonlijk toestel);
   de echte bescherming is je telefoon-vergrendeling zelf. */
async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("meetboek:" + text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function lockScreen({ setup }) {
  return new Promise((resolve) => {
    let pin = "", first = null;
    const host = $("#view");
    $("#top").style.visibility = "hidden"; $(".dock-wrap").style.visibility = "hidden";
    function paint(msg, errShake) {
      host.innerHTML = `<div class="lock"><div class="logo">❤️</div>
        <div class="lk-t">${setup ? (first ? "Herhaal je pincode" : "Kies een pincode") : "Voer je pincode in"}</div>
        <div class="lk-sub">${msg || (setup ? "Zo blijft de app privé voor jou" : "Welkom terug")}</div>
        <div class="dots ${errShake ? "err" : ""}">${[0, 1, 2, 3, 4, 5].map((i) => `<i class="${i < pin.length ? "on" : ""}"></i>`).join("")}</div>
        <div class="pad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].map((k) => k === "" ? "<span></span>" : `<button class="key ${k === "del" ? "fn" : ""}" data-k="${k}">${k === "del" ? "wis" : k}</button>`).join("")}</div></div>`;
    }
    async function done() {
      if (setup) {
        if (!first) { first = pin; pin = ""; paint(); return; }
        if (first !== pin) { first = null; pin = ""; paint("Pincodes verschillen — opnieuw", true); return; }
        localStorage.setItem("mbLock", await sha(pin));
      } else {
        if (await sha(pin) !== localStorage.getItem("mbLock")) { pin = ""; paint("Onjuiste pincode", true); if (navigator.vibrate) navigator.vibrate(80); return; }
      }
      $("#top").style.visibility = ""; $(".dock-wrap").style.visibility = "";
      host.onclick = null; resolve();
    }
    host.onclick = (e) => {
      const b = e.target.closest("[data-k]"); if (!b) return;
      const k = b.dataset.k;
      if (k === "del") pin = pin.slice(0, -1);
      else if (pin.length < 6) pin += k;
      paint();
      if (pin.length >= 4 && setup && !first) { /* wacht op langere invoer of extra tik */ }
      if (pin.length === 6 || (!setup && pin.length >= 4 && false)) done();
    };
    // knop "klaar" niet nodig: 6 cijfers = auto; ondersteun ook Enter voor 4-5
    document.onkeydown = (e) => { if (e.key === "Enter" && pin.length >= 4) done(); if (/^[0-9]$/.test(e.key) && pin.length < 6) { pin += e.key; paint(); if (pin.length === 6) done(); } if (e.key === "Backspace") { pin = pin.slice(0, -1); paint(); } };
    paint();
  });
}
async function gate() {
  try {
    if (!localStorage.getItem("mbLock")) await lockScreen({ setup: true });
    else await lockScreen({ setup: false });
  } catch {}
}

/* events */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]"); if (!el) return;
  const a = el.dataset.action;
  if (a === "connect") return connectWatch();
  if (a === "sync") return sync();
  if (a === "vibrate") return vibrate();
  if (a === "measure") return doMeasure(el.dataset.kind, el);
});
window.addEventListener("hashchange", render);
try { $("#hdate").textContent = new Date().toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" }); } catch {}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
(async () => { await gate(); document.onkeydown = null; setChip(); render(); tryAutoReconnect(); setInterval(() => { if (tab() === "today") render(); }, 30000); })();
