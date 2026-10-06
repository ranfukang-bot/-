'use strict';
/*
 * 星光打卡 · 服务器（云端控制中心）
 * 零依赖：只需要 Node.js 18+。  启动：node server.js
 *
 * 环境变量（都可选）：
 *   PORT=8080            监听端口
 *   HOST=0.0.0.0         监听地址
 *   DATA_DIR=./data      数据目录（db.json 和每日备份）
 *   TRUST_PROXY=1        部署在 Nginx/Caddy 反向代理后面时打开，用于识别真实 IP 和 HTTPS
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./public/rules.js');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BK_DIR = path.join(DATA_DIR, 'backups');
const PUB = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TEST_CLOCK = process.env.SP_TEST_CLOCK === '1'; // 仅自动化测试使用
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

fs.mkdirSync(BK_DIR, { recursive: true });

/* ---------------- 工具 ---------------- */
const uid = () => crypto.randomBytes(8).toString('hex');
const KEY_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randCode = (n, a) => Array.from(crypto.randomBytes(n), b => a[b % a.length]).join('');
const newTerminalKey = () => randCode(4, KEY_ALPHA) + '-' + randCode(4, KEY_ALPHA);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isDs = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const isHM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const isHMS = s => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(s));
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/* ---------------- 数据库（JSON 文件） ---------------- */
function freshDb() {
  return {
    version: 2,
    settings: {
      company: '星光团队', salary: 3000, commissionRate: 0, payDay: 15,
      inDL: '11:00', taskDL: '16:00', undoneRatio: 0.5, tzOffset: 8,
      installedAt: R.dkey(now(), { tzOffset: 8 })
    },
    secrets: { adminSalt: '', adminHash: '', terminalKey: newTerminalKey(), setupCode: randCode(6, '0123456789') },
    employees: [], records: {}, perf: [], payrolls: [], badges: {}, audit: []
  };
}
function normalize(d) {
  const f = freshDb();
  d.settings = Object.assign(f.settings, d.settings || {});
  d.secrets = Object.assign(f.secrets, d.secrets || {});
  for (const k of ['employees', 'perf', 'payrolls', 'audit']) if (!Array.isArray(d[k])) d[k] = [];
  for (const k of ['records', 'badges']) if (!d[k] || typeof d[k] !== 'object') d[k] = {};
  d.version = 2;
  return d;
}
let db;
function loadDb() {
  if (fs.existsSync(DB_FILE)) db = normalize(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  else { db = freshDb(); save(); }
}
function save() {
  const tmp = DB_FILE + '.tmp', body = JSON.stringify(db);
  fs.writeFileSync(tmp, body);
  try { fs.renameSync(tmp, DB_FILE); } catch (e) { fs.writeFileSync(DB_FILE, body); try { fs.unlinkSync(tmp); } catch (_) {} }
  dailyBackup();
}
function dailyBackup() {
  const f = path.join(BK_DIR, `db-${R.dkey(now(), db.settings)}.json`);
  if (fs.existsSync(f)) return;
  fs.copyFileSync(DB_FILE, f);
  const all = fs.readdirSync(BK_DIR).filter(x => /^db-.*\.json$/.test(x)).sort();
  all.slice(0, Math.max(0, all.length - 90)).forEach(x => fs.unlinkSync(path.join(BK_DIR, x)));
}
function audit(req, action, detail) {
  db.audit.push({ at: now(), ip: ipOf(req), action, detail });
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
}
function tick() {
  const fresh = R.ensurePayrolls(db, now(), uid);
  if (fresh.length) {
    fresh.forEach(p => { const e = db.employees.find(x => x.id === p.empId); if (e) R.checkBadges(db, e, now()); });
    db.audit.push({ at: now(), ip: 'system', action: '自动结算', detail: `生成 ${fresh.length} 条工资结算（${fresh[0].period}）` });
    save();
  }
}

/* ---------------- HTTP 工具 ---------------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function ipOf(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...headers });
  res.end(JSON.stringify(obj));
}
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpErr(code, msg); };
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpErr(413, '数据太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpErr(400, 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

/* 登录失败限流：同一来源连续失败 8 次锁 10 分钟 */
const fails = new Map();
function checkLimit(key) { const f = fails.get(key); if (f && f.until > Date.now()) fail(429, '尝试次数太多，请 10 分钟后再试'); }
function addFail(key) { const f = fails.get(key) || { n: 0, until: 0 }; f.n++; if (f.n >= 8) { f.until = Date.now() + 10 * 60e3; f.n = 0; } fails.set(key, f); }

/* 管理员会话 */
const sessions = new Map();
const SESSION_MS = 12 * 3600e3;
function isAdmin(req) {
  const t = cookies(req).sp_admin; if (!t) return false;
  const exp = sessions.get(t); if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESSION_MS); return true;
}
function sessionCookie(req, token, maxAge) {
  const secure = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sp_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

/* ---------------- 视图数据 ---------------- */
const pubEmp = e => { const { pinHash, pinSalt, ...rest } = e; return { ...rest, hasPin: !!pinHash }; };
const empOf = id => db.employees.find(e => e.id === id);
function lastPayroll(empId) {
  const l = db.payrolls.filter(p => p.empId === empId).sort((a, b) => b.period.localeCompare(a.period))[0];
  return l ? { amount: l.amount, paid: l.paid, period: l.period, payDate: l.payDate } : null;
}
function clientState() {
  const t = now(), st = db.settings, ds = R.dkey(t, st), p = R.parts(t, st);
  return {
    now: t,
    settings: { company: st.company, payDay: st.payDay, inDL: st.inDL, taskDL: st.taskDL, undoneRatio: st.undoneRatio, tzOffset: st.tzOffset },
    nextPayDate: R.nextPayDate(db, t),
    employees: db.employees.filter(e => e.active !== false).map(e => {
      const ev = R.evalDay(db, e, ds, t), mc = R.computeMonth(db, e, p.y, p.m, t), rec = ev.rec || {};
      return {
        id: e.id, name: e.name, avatar: e.avatar, hasPin: !!e.pinHash,
        today: { code: ev.code, label: ev.label, final: ev.final, ratio: ev.ratio, potential: ev.potential || 0, in: rec.in || null, done: rec.done || null },
        rate: mc.rate, month: { days: mc.days, counts: mc.counts, base: mc.base, perfTotal: mc.perfTotal, commissionRate: mc.commissionRate, commission: mc.commission, amount: mc.amount, salary: mc.salary },
        streak: R.calcStreak(db, e, t), badges: db.badges[e.id] || {}, lastPayroll: lastPayroll(e.id)
      };
    })
  };
}
function adminState() {
  const { secrets, ...rest } = db;
  return { now: now(), terminalKey: secrets.terminalKey, db: { ...rest, employees: db.employees.map(pubEmp), audit: db.audit.slice(-500) } };
}

/* ---------------- 旧版（单机版 v1）备份导入 ---------------- */
function convertV1(d) {
  const out = freshDb();
  Object.assign(out.settings, {
    company: d.settings?.company || out.settings.company, salary: +d.settings?.salary || 3000, payDay: +d.settings?.payDay || 15,
    inDL: d.settings?.inDL || '11:00', taskDL: d.settings?.taskDL || '16:00', undoneRatio: d.settings?.undoneRatio ?? 0.5,
    installedAt: d.settings?.installedAt || out.settings.installedAt
  });
  out.employees = (d.employees || []).map(e => {
    const n = { id: e.id, name: e.name, avatar: e.avatar || '😊', salary: +e.salary || 3000, commissionRate: null, hireDate: e.hireDate || '', active: e.active !== false, leftAt: e.leftAt, createdAt: e.createdAt || now() };
    if (e.pin) { n.pinSalt = uid(); n.pinHash = hashPw(e.pin, n.pinSalt); }
    return n;
  });
  out.records = d.records || {};
  out.badges = d.badges || {};
  out.payrolls = (d.payrolls || []).map(p => ({ ...p, days: p.workdays ?? p.days, base: p.amount, perfTotal: 0, commissionRate: 0, commission: 0 }));
  return out;
}

/* ---------------- 路由 ---------------- */
async function api(req, res, url) {
  const p = url.pathname, method = req.method, t = now(), st = db.settings;
  const ip = ipOf(req);

  /* ---------- 测试时钟 ---------- */
  if (TEST_CLOCK && p === '/api/test/clock' && method === 'POST') {
    const b = await readBody(req); clockOffset = +b.now - Date.now(); tick(); return send(res, 200, { ok: true, now: now() });
  }

  /* ---------- 员工端 ---------- */
  if (p.startsWith('/api/client/')) {
    checkLimit('term:' + ip);
    if (!safeEq(req.headers['x-terminal-key'] || '', db.secrets.terminalKey)) { addFail('term:' + ip); fail(401, '终端未激活或激活码已更换'); }
    tick();
    if (p === '/api/client/state' && method === 'GET') return send(res, 200, clientState());
    if (p === '/api/client/month' && method === 'GET') {
      const e = empOf(url.searchParams.get('emp')); if (!e || e.active === false) fail(404, '员工不存在');
      const [y, m] = R.splitDs(url.searchParams.get('ym') || R.dkey(t, st).slice(0, 7));
      const n = R.daysIn(y, m), days = [];
      const rate = n ? (+e.salary || 0) / n : 0;
      for (let d = 1; d <= n; d++) {
        const ev = R.evalDay(db, e, R.ymd(y, m, d), t), r = ev.rec || {};
        days.push({ ds: ev.ds, code: ev.code, label: ev.label, final: ev.final, ratio: ev.ratio, in: r.in || null, done: r.done || null, note: r.note || '', edited: !!r.edited, amount: ev.final ? R.r2(ev.ratio * rate) : null });
      }
      return send(res, 200, { now: t, summary: R.computeMonth(db, e, y, m, t), days, payroll: db.payrolls.find(x => x.empId === e.id && x.period === R.mkey(y, m)) || null });
    }
    if (p === '/api/client/punch' && method === 'POST') {
      const b = await readBody(req, 64 * 1024);
      const e = empOf(b.empId); if (!e || e.active === false) fail(404, '员工不存在');
      if (e.pinHash) {
        const lk = 'pin:' + ip + ':' + e.id; checkLimit(lk);
        if (!b.pin || hashPw(b.pin, e.pinSalt) !== e.pinHash) { addFail(lk); fail(403, '打卡密码不正确'); }
        fails.delete(lk);
      }
      const ds = R.dkey(t, st), key = R.recKey(e.id, ds), rec = db.records[key] || {};
      if (b.type === 'in') {
        if (rec.in) fail(409, '今天已经打过上班卡啦');
        rec.in = t;
      } else if (b.type === 'done') {
        if (!rec.in) fail(400, '请先打上班卡');
        if (rec.done) fail(409, '今天的任务已经完成打卡啦');
        rec.done = t;
        const note = str(b.note, 200); if (note) rec.note = note;
      } else fail(400, '未知的打卡类型');
      db.records[key] = rec;
      const ev = R.evalDay(db, e, ds, t), newBadges = R.checkBadges(db, e, t);
      const rate = (+e.salary || 0) / R.daysIn(R.parts(t, st).y, R.parts(t, st).m);
      save();
      return send(res, 200, { ok: true, at: t, ev: { code: ev.code, label: ev.label, ratio: ev.ratio, final: ev.final }, rate, amount: ev.final ? R.r2(ev.ratio * rate) : 0, newBadges, state: clientState() });
    }
    fail(404, '接口不存在');
  }

  /* ---------- 管理后台：登录 ---------- */
  if (p === '/api/admin/status' && method === 'GET') return send(res, 200, { needsSetup: !db.secrets.adminHash, loggedIn: isAdmin(req), company: st.company });
  if (p === '/api/admin/setup' && method === 'POST') {
    if (db.secrets.adminHash) fail(400, '管理员密码已设置过');
    checkLimit('setup:' + ip);
    const b = await readBody(req, 64 * 1024);
    if (!safeEq(str(b.code, 20), db.secrets.setupCode)) { addFail('setup:' + ip); fail(403, '初始化码不正确（在服务器启动窗口里查看）'); }
    if (String(b.password || '').length < 6) fail(400, '密码至少 6 位');
    db.secrets.adminSalt = uid(); db.secrets.adminHash = hashPw(b.password, db.secrets.adminSalt); db.secrets.setupCode = '';
    audit(req, '初始化', '设置管理员密码'); save();
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }
  if (p === '/api/admin/login' && method === 'POST') {
    checkLimit('login:' + ip);
    const b = await readBody(req, 64 * 1024);
    if (!db.secrets.adminHash || hashPw(b.password || '', db.secrets.adminSalt) !== db.secrets.adminHash) { addFail('login:' + ip); fail(403, '密码不正确'); }
    fails.delete('login:' + ip);
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, Date.now() + SESSION_MS);
    audit(req, '登录', '管理员登录'); save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }
  if (p === '/api/admin/logout' && method === 'POST') {
    sessions.delete(cookies(req).sp_admin);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  /* ---------- 管理后台：需要登录 ---------- */
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) fail(401, '请先登录');
    if (method === 'POST' && req.headers['x-requested-with'] !== 'starpunch') fail(403, '非法请求');
    tick();
    if (p === '/api/admin/state' && method === 'GET') return send(res, 200, adminState());
    if (p === '/api/admin/backup' && method === 'GET') {
      const { secrets, ...rest } = db;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="starpunch-backup-${R.dkey(t, st)}.json"`, ...SEC });
      return res.end(JSON.stringify({ ...rest, exportedAt: t }, null, 1));
    }
    if (method !== 'POST') fail(404, '接口不存在');
    const b = await readBody(req);
    let msg = 'ok';

    switch (p) {
      case '/api/admin/employee': {
        const name = str(b.name, 16); if (!name) fail(400, '请填写姓名');
        const salary = +b.salary; if (!(salary >= 0)) fail(400, '月薪格式不正确');
        let cr = b.commissionRate;
        if (cr === '' || cr === null || cr === undefined) cr = null; else { cr = +cr; if (!(cr >= 0 && cr <= 100)) fail(400, '提成比例需在 0–100 之间'); }
        const hireDate = b.hireDate ? (isDs(b.hireDate) ? b.hireDate : fail(400, '入职日期格式不正确')) : '';
        let e = b.id ? empOf(b.id) : null;
        if (b.id && !e) fail(404, '员工不存在');
        const isNew = !e;
        if (isNew) { e = { id: uid(), createdAt: t, active: true }; db.employees.push(e); }
        const before = isNew ? null : { salary: e.salary, commissionRate: e.commissionRate };
        Object.assign(e, { name, salary, commissionRate: cr, hireDate, avatar: str(b.avatar, 8) || '😊' });
        if (b.pinAction === 'set') { const pin = str(b.pin, 12); if (pin.length < 4) fail(400, '打卡密码至少 4 位'); e.pinSalt = uid(); e.pinHash = hashPw(pin, e.pinSalt); }
        if (b.pinAction === 'clear') { delete e.pinSalt; delete e.pinHash; }
        audit(req, isNew ? '添加员工' : '编辑员工', `${name}：月薪 ${salary}，提成 ${cr == null ? '默认' : cr + '%'}${before ? `（原月薪 ${before.salary}，原提成 ${before.commissionRate == null ? '默认' : before.commissionRate + '%'}）` : ''}${b.pinAction === 'set' ? '，设置了打卡密码' : b.pinAction === 'clear' ? '，清除了打卡密码' : ''}`);
        break;
      }
      case '/api/admin/employee/toggle': {
        const e = empOf(b.id) || fail(404, '员工不存在');
        if (e.active === false) { e.active = true; delete e.leftAt; audit(req, '启用员工', e.name); }
        else { e.active = false; e.leftAt = R.dkey(t, st); audit(req, '停用员工', e.name); }
        break;
      }
      case '/api/admin/employee/delete': {
        const e = empOf(b.id) || fail(404, '员工不存在');
        db.employees = db.employees.filter(x => x.id !== e.id);
        Object.keys(db.records).forEach(k => { if (k.startsWith(e.id + '|')) delete db.records[k]; });
        db.perf = db.perf.filter(x => x.empId !== e.id);
        delete db.badges[e.id];
        audit(req, '删除员工', `${e.name}（打卡与业绩记录已删除，结算记录保留）`);
        break;
      }
      case '/api/admin/record': {
        const e = empOf(b.empId) || fail(404, '员工不存在');
        if (!isDs(b.ds)) fail(400, '日期格式不正确');
        if (b.ds > R.dkey(t, st)) fail(400, '不能修改未来的日期');
        if (b.in && !isHMS(b.in)) fail(400, '上班时间格式不正确');
        if (b.done && !isHMS(b.done)) fail(400, '完成时间格式不正确');
        const nin = b.in ? R.tsOf(b.ds, b.in, st) : null, ndone = b.done ? R.tsOf(b.ds, b.done, st) : null;
        if (ndone && !nin) fail(400, '有完成时间就必须有上班时间');
        if (nin && ndone && ndone < nin) fail(400, '完成时间不能早于上班时间');
        const why = str(b.why, 100); if (!why) fail(400, '请填写修改原因');
        const key = R.recKey(e.id, b.ds), old = db.records[key] || {};
        const note = str(b.note, 200);
        const log = (old.editLog || []).concat([{ at: t, from: { in: old.in || null, done: old.done || null }, to: { in: nin, done: ndone }, why }]);
        if (!nin && !ndone && !note) { if (old.editLog || old.in) db.records[key] = { in: null, done: null, edited: true, editLog: log }; else delete db.records[key]; }
        else db.records[key] = { in: nin, done: ndone, note: note || undefined, edited: true, editLog: log };
        const fmt = v => v ? R.fmtTS(v, st) : '无';
        audit(req, '补卡/修改考勤', `${e.name} ${b.ds}：上班 ${fmt(old.in)}→${fmt(nin)}，完成 ${fmt(old.done)}→${fmt(ndone)}；原因：${why}`);
        const s = R.syncPayroll(db, e.id, b.ds.slice(0, 7), t);
        msg = s === 'updated' ? '已同步更新该月结算记录' : s === 'paid' ? '该月工资已发放，结算记录保持不变' : 'ok';
        break;
      }
      case '/api/admin/perf': {
        const e = empOf(b.empId) || fail(404, '员工不存在');
        if (!isDs(b.date)) fail(400, '日期格式不正确');
        const amount = R.r2(+b.amount); if (!isFinite(amount) || amount === 0) fail(400, '业绩金额不正确');
        const item = { id: uid(), empId: e.id, date: b.date, amount, note: str(b.note, 100), createdAt: t };
        db.perf.push(item);
        audit(req, '录入业绩', `${e.name} ${b.date}：¥${amount}${item.note ? '（' + item.note + '）' : ''}`);
        const s = R.syncPayroll(db, e.id, b.date.slice(0, 7), t);
        msg = s === 'updated' ? '已同步更新该月结算记录' : s === 'paid' ? '该月工资已发放，结算记录保持不变' : 'ok';
        break;
      }
      case '/api/admin/perf/delete': {
        const it = db.perf.find(x => x.id === b.id) || fail(404, '记录不存在');
        db.perf = db.perf.filter(x => x.id !== it.id);
        const e = empOf(it.empId);
        audit(req, '删除业绩', `${e ? e.name : it.empId} ${it.date}：¥${it.amount}`);
        R.syncPayroll(db, it.empId, it.date.slice(0, 7), t);
        break;
      }
      case '/api/admin/payroll/mark': {
        const ids = Array.isArray(b.ids) ? b.ids : [];
        const list = db.payrolls.filter(x => ids.includes(x.id));
        list.forEach(x => { x.paid = !!b.paid; x.paidAt = b.paid ? t : null; });
        audit(req, b.paid ? '标记已发放' : '撤销发放', list.map(x => `${x.empName} ${x.period} ¥${x.amount}`).join('；'));
        if (b.paid) list.forEach(x => { const e = empOf(x.empId); if (e) R.checkBadges(db, e, t); });
        break;
      }
      case '/api/admin/payroll/recalc': {
        const x = db.payrolls.find(q => q.id === b.id) || fail(404, '记录不存在');
        if (x.paid) fail(400, '已发放的记录不能重算');
        const before = x.amount; R.recalcPayroll(db, x, t);
        audit(req, '重算工资', `${x.empName} ${x.period}：¥${before} → ¥${x.amount}`);
        break;
      }
      case '/api/admin/settings': {
        const n = {
          company: str(b.company, 20), salary: +b.salary, commissionRate: +b.commissionRate, payDay: +b.payDay,
          inDL: b.inDL, taskDL: b.taskDL, undoneRatio: +b.undoneRatio
        };
        if (!(n.salary >= 0)) fail(400, '默认月薪格式不正确');
        if (!(n.commissionRate >= 0 && n.commissionRate <= 100)) fail(400, '提成比例需在 0–100 之间');
        if (!(Number.isInteger(n.payDay) && n.payDay >= 1 && n.payDay <= 28)) fail(400, '发薪日需在 1–28 之间');
        if (!isHM(n.inDL) || !isHM(n.taskDL)) fail(400, '时间格式不正确');
        if (R.hm(n.taskDL) <= R.hm(n.inDL)) fail(400, '任务截止时间应晚于上班截止时间');
        if (![0, 0.5, 1].includes(n.undoneRatio)) fail(400, '规则选项不正确');
        const diff = Object.keys(n).filter(k => st[k] !== n[k]).map(k => `${k}: ${st[k]} → ${n[k]}`).join('；');
        Object.assign(st, n);
        audit(req, '修改设置', diff || '无变化');
        break;
      }
      case '/api/admin/password': {
        if (hashPw(b.old || '', db.secrets.adminSalt) !== db.secrets.adminHash) fail(403, '原密码不正确');
        if (String(b.password || '').length < 6) fail(400, '新密码至少 6 位');
        db.secrets.adminSalt = uid(); db.secrets.adminHash = hashPw(b.password, db.secrets.adminSalt);
        sessions.clear();
        const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, Date.now() + SESSION_MS);
        audit(req, '修改管理员密码', '其他已登录的管理后台已被强制退出'); save();
        return send(res, 200, { ok: true, ...adminState() }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
      }
      case '/api/admin/terminal-key/reset': {
        db.secrets.terminalKey = newTerminalKey();
        audit(req, '更换终端激活码', '所有打卡电脑需要重新输入激活码');
        break;
      }
      case '/api/admin/restore': {
        const d = b.data;
        if (!d || !Array.isArray(d.employees) || typeof d.records !== 'object') fail(400, '备份文件格式不正确');
        const secrets = db.secrets;
        db = d.version === 2 ? normalize({ ...d, secrets }) : normalize({ ...convertV1(d), secrets });
        audit(req, '从备份恢复', `${db.employees.length} 位员工，${Object.keys(db.records).length} 条打卡记录`);
        break;
      }
      default: fail(404, '接口不存在');
    }
    save();
    return send(res, 200, { ok: true, msg, ...adminState() });
  }
  fail(404, '接口不存在');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC }); return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
  fs.createReadStream(file).pipe(res);
}

loadDb();
tick();
setInterval(tick, 5 * 60e3).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, { error: '不支持的请求' });
  } catch (e) {
    if (e instanceof HttpErr) send(res, e.code, { error: e.message });
    else { console.error(e); send(res, 500, { error: '服务器内部错误' }); }
  }
});
server.listen(PORT, HOST, () => {
  const line = '='.repeat(56);
  console.log(`\n${line}\n  ✦ 星光打卡服务器已启动\n${line}`);
  console.log(`  员工打卡页：  http://localhost:${PORT}/`);
  console.log(`  管理后台：    http://localhost:${PORT}/admin`);
  console.log(`  数据目录：    ${DATA_DIR}`);
  console.log(`  终端激活码：  ${db.secrets.terminalKey}   （每台打卡电脑第一次打开时输入）`);
  if (!db.secrets.adminHash) console.log(`  ⚠ 首次使用：打开管理后台，用初始化码 ${db.secrets.setupCode} 设置管理员密码`);
  console.log(`${line}\n  请不要关闭这个窗口，关闭后员工将无法打卡。\n`);
});
