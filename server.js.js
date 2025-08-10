import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { init } from './db.js';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ODDS_KEY = process.env.ODDS_API_KEY;

if (!ODDS_KEY) {
  console.warn('WARNING: ODDS_API_KEY is not set in environment.');
}

app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(','), credentials: false }));
app.use(express.json());
app.use(morgan('dev'));

const dbConn = init();

// --- Serve frontend (static) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.resolve(__dirname, '../frontend')));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function americanPayout(stake, price) {
  if (price > 0) return stake + stake * (price/100);
  if (price < 0) return stake + stake * (100/Math.abs(price));
  return stake;
}

// --- Seed users if empty ---
(function seedUsers(){
  const c = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (c === 0) {
    const users = [
      { id:'u1', username:'agent1', pass:'1234', center:'Centro A', name:'Ana López', phone:'' },
      { id:'u2', username:'agent2', pass:'5678', center:'Centro B', name:'Carlos Ruiz', phone:'' },
    ];
    const ins = db.prepare('INSERT INTO users(id, username, pass_hash, center, name, phone, balance) VALUES(?,?,?,?,?,?,0)');
    users.forEach(u => {
      const hash = bcrypt.hashSync(u.pass, 10);
      ins.run(u.id, u.username, hash, u.center, u.name, u.phone);
    });
    console.log('Seeded users.');
  }
})();

// --- Auth ---
app.post('/api/auth/login', (req,res)=>{
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error:'username & password required' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u) return res.status(401).json({ error:'invalid credentials' });
  const ok = bcrypt.compareSync(password, u.pass_hash);
  if (!ok) return res.status(401).json({ error:'invalid credentials' });
  const token = jwt.sign({ sub:u.id, username:u.username, center:u.center }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id:u.id, username:u.username, center:u.center, name:u.name, phone:u.phone, balance:u.balance } });
});

// --- Codes by league ---
const RANGES = {
  baseball_mlb: { start:100, end:199 },
  basketball_nba: { start:200, end:299 },
  americanfootball_nfl: { start:300, end:399 },
  icehockey_nhl: { start:400, end:499 },
};
function nextCodeFor(sport_key, used) {
  const r = RANGES[sport_key];
  if (!r) return null;
  for (let c=r.start; c<=r.end; c++) {
    if (!used.has(c)) return c;
  }
  return null;
}

app.get('/api/odds/public', async (req,res)=>{
  try{
    const sports = Object.keys(RANGES);
    const urls = sports.map(s => `https://api.the-odds-api.com/v4/sports/${s}/odds?regions=us&markets=h2h,totals&oddsFormat=american&apiKey=${ODDS_KEY}`);
    const results = await Promise.allSettled(urls.map(u => axios.get(u)));
    const all = [];
    results.forEach(r => { if (r.status==='fulfilled' && Array.isArray(r.value.data)) r.value.data.forEach(g => all.push(g)); });

    const norm = all.map(g => ({
      sport_key:g.sport_key, sport_title:g.sport_title, commence_time:g.commence_time,
      home_team:g.home_team, away_team:g.away_team, bookmakers:g.bookmakers||[]
    }));
    norm.sort((a,b)=>{
      const s = String(a.sport_title||'').localeCompare(String(b.sport_title||''));
      if (s!==0) return s;
      return new Date(a.commence_time) - new Date(b.commence_time);
    });

    const used = new Set(db.prepare('SELECT code FROM codes').all().map(r=>r.code));
    const ins = db.prepare('INSERT OR REPLACE INTO codes(code,sport_key,sport,team,ml,over,under,points,game_time,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const codebook = [];

    for (const m of norm) {
      const bm = m.bookmakers[0];
      const h2h = bm?.markets?.find(x=>x.key==='h2h')?.outcomes||[];
      const totals = bm?.markets?.find(x=>x.key==='totals')?.outcomes||[];
      const over = totals.find(o=>/over/i.test(o.name));
      const under = totals.find(o=>/under/i.test(o.name));
      const totalPoint = over?.point ?? under?.point ?? null;

      const away = h2h.find(o=>o.name===m.away_team) || { name:m.away_team, price:null };
      const home = h2h.find(o=>o.name===m.home_team) || { name:m.home_team, price:null };

      const codeAway = nextCodeFor(m.sport_key, used);
      if (codeAway==null) continue;
      used.add(codeAway);
      ins.run(codeAway, m.sport_key, m.sport_title||m.sport_key.toUpperCase(), m.away_team, away.price, over?.price??null, under?.price??null, totalPoint, m.commence_time, Date.now());
      codebook.push({ code:codeAway, sport_key:m.sport_key, sport:m.sport_title||m.sport_key.toUpperCase(), team:m.away_team, ml:away.price, over:over?.price??null, under:under?.price??null, points: totalPoint });

      const codeHome = nextCodeFor(m.sport_key, used);
      if (codeHome==null) continue;
      used.add(codeHome);
      ins.run(codeHome, m.sport_key, m.sport_title||m.sport_key.toUpperCase(), m.home_team, home.price, over?.price??null, under?.price??null, totalPoint, m.commence_time, Date.now());
      codebook.push({ code:codeHome, sport_key:m.sport_key, sport:m.sport_title||m.sport_key.toUpperCase(), team:m.home_team, ml:home.price, over:over?.price??null, under:under?.price??null, points: totalPoint });
    }

    res.json({ codebook });
  }catch(e){
    console.error(e);
    res.status(500).json({ error:'failed to load odds' });
  }
});

// --- Tickets ---
app.get('/api/tickets', auth, (req,res)=>{
  const rows = db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC').all(req.user.sub);
  res.json({ tickets: rows });
});
app.post('/api/tickets', auth, (req,res)=>{
  const { code, bet, pts, stake, clientName, clientPhone } = req.body || {};
  if (!code || !bet || !stake) return res.status(400).json({ error:'code, bet, stake required' });
  const c = db.prepare('SELECT * FROM codes WHERE code=?').get(code);
  if (!c) return res.status(400).json({ error:'code not found' });
  const price = bet==='ML' ? c.ml : (bet==='Over' ? c.over : c.under);
  const points = bet==='ML' ? null : (pts || c.points);
  if (price===null || price===undefined) return res.status(400).json({ error:'no price for that market' });

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  const ins = db.prepare(`INSERT INTO tickets(created_at,user_id,center,client_name,client_phone,sport_key,sport,team,bet,pts,price,stake,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'open')`);
  const info = ins.run(Date.now(), u.id, u.center, clientName||'', clientPhone||'', c.sport_key, c.sport, c.team, bet, points, price, Number(stake));
  const row = db.prepare('SELECT * FROM tickets WHERE id=?').get(info.lastInsertRowid);
  res.json({ ticket: row });
});

app.patch('/api/tickets/:id', auth, (req,res)=>{
  const { action } = req.body || {};
  const t = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(req.params.id, req.user.sub);
  if (!t) return res.status(404).json({ error:'not found' });
  if (t.status!=='open') return res.status(400).json({ error:'already settled' });

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  let newStatus = null;
  if (action==='win') { newStatus='won'; u.balance -= (americanPayout(t.stake, t.price) - t.stake); }
  else if (action==='lose') { newStatus='lost'; u.balance += t.stake; }
  else if (action==='void') { newStatus='void'; }
  else return res.status(400).json({ error:'invalid action' });

  db.prepare('UPDATE tickets SET status=? WHERE id=?').run(newStatus, t.id);
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(u.balance, u.id);
  const updated = db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id);
  res.json({ ticket: updated, balance: u.balance });
});

// Auto-settle by scores (for tickets of logged user)
app.post('/api/tickets/auto-settle', auth, async (req,res)=>{
  const open = db.prepare('SELECT * FROM tickets WHERE user_id=? AND status="open"').all(req.user.sub);
  if (open.length===0) return res.json({ settled: 0 });

  const bySport = open.reduce((acc,t)=>{ (acc[t.sport_key]=acc[t.sport_key]||[]).push(t); return acc; }, {});
  const settledTickets = [];
  for (const sportKey of Object.keys(bySport)) {
    try{
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?daysFrom=3&apiKey=${ODDS_KEY}`;
      const resp = await axios.get(url);
      const list = resp.data || [];
      const idx = {};
      list.forEach(g => {
        const hk = String(g.home_team||'').toLowerCase();
        const ak = String(g.away_team||'').toLowerCase();
        (idx[hk]=idx[hk]||[]).push(g);
        (idx[ak]=idx[ak]||[]).push(g);
      });

      for (const t of bySport[sportKey]) {
        const arr = idx[String(t.team).toLowerCase()] || [];
        const game = arr.filter(g=> g.completed).sort((a,b)=> new Date(b.commence_time)-new Date(a.commence_time))[0];
        if (!game) continue;
        let hs=0, as=0;
        if (Array.isArray(game.scores) && game.scores.length){
          const home = String(game.home_team||'').toLowerCase();
          const away = String(game.away_team||'').toLowerCase();
          hs = Number((game.scores.find(s => String(s.name||'').toLowerCase()===home)?.score) || 0);
          as = Number((game.scores.find(s => String(s.name||'').toLowerCase()===away)?.score) || 0);
        } else { hs = Number(game.home_score||0); as = Number(game.away_score||0); }

        let result = null;
        if (t.bet==='ML'){
          const teamLower = String(t.team||'').toLowerCase();
          const wonTeam = (hs>as) ? String(game.home_team||'').toLowerCase() : ((as>hs) ? String(game.away_team||'').toLowerCase() : null);
          result = wonTeam ? (wonTeam===teamLower ? 'win' : 'lose') : 'void';
        } else if (t.bet==='Over' || t.bet==='Under'){
          const total = hs + as;
          const pts = parseFloat(String(t.pts||'').replace(',', '.'));
          if (!isNaN(pts)) {
            if (t.bet==='Over') result = total>pts ? 'win' : (total<pts ? 'lose' : 'void');
            else result = total<pts ? 'win' : (total>pts ? 'lose' : 'void');
          }
        }

        if (result) {
          const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
          if (result==='win') u.balance -= (americanPayout(t.stake, t.price) - t.stake);
          if (result==='lose') u.balance += t.stake;
          db.prepare('UPDATE users SET balance=? WHERE id=?').run(u.balance, u.id);
          db.prepare('UPDATE tickets SET status=? WHERE id=?').run(result==='win'?'won':(result==='lose'?'lost':'void'), t.id);
          settledTickets.push(t.id);
        }
      }
    }catch(e){
      console.warn('scores fail', sportKey, e?.message);
    }
  }
  res.json({ settled: settledTickets.length, ids: settledTickets });
});

// --- Reports ---
app.get('/api/reports/daily', auth, (req,res)=>{
  const { from, to } = req.query;
  let rows = db.prepare('SELECT * FROM tickets WHERE user_id=?').all(req.user.sub);
  if (from) {
    const ts = new Date(from + 'T00:00:00').getTime();
    rows = rows.filter(r => r.created_at >= ts);
  }
  if (to) {
    const ts = new Date(to + 'T23:59:59').getTime();
    rows = rows.filter(r => r.created_at <= ts);
  }
  const map = {};
  rows.forEach(t=>{
    const d = new Date(t.created_at); const day = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    map[day] = map[day] || { day, tickets:0, risk:0, payout:0, profit:0 };
    map[day].tickets++;
    map[day].risk += t.stake;
    map[day].payout += americanPayout(t.stake, t.price);
    if (t.status==='won') map[day].profit -= (americanPayout(t.stake,t.price) - t.stake);
    if (t.status==='lost') map[day].profit += t.stake;
  });
  const list = Object.values(map).sort((a,b)=> a.day.localeCompare(b.day));
  res.json({ rows: list });
});

app.get('/api/reports/excel', auth, async (req,res)=>{
  const rows = db.prepare('SELECT * FROM tickets WHERE user_id=?').all(req.user.sub);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tickets');
  ws.columns = [
    { header:'ID', key:'id', width:8 },
    { header:'Fecha', key:'date', width:22 },
    { header:'Centro', key:'center', width:16 },
    { header:'Cliente', key:'client', width:24 },
    { header:'Deporte', key:'sport', width:12 },
    { header:'Equipo', key:'team', width:24 },
    { header:'Tipo', key:'bet', width:8 },
    { header:'Pts', key:'pts', width:8 },
    { header:'Cuota', key:'price', width:10 },
    { header:'Riesgo', key:'stake', width:10 },
    { header:'Estado', key:'status', width:10 },
  ];
  rows.forEach(r=>{
    ws.addRow({
      id: r.id, date: new Date(r.created_at).toLocaleString(),
      center: r.center, client: (r.client_name||'') + (r.client_phone?` (${r.client_phone})`:''),
      sport: r.sport, team: r.team, bet: r.bet, pts: r.pts||'', price: r.price, stake: r.stake, status: r.status
    });
  });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="tickets.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/reports/pdf', auth, (req,res)=>{
  const rows = db.prepare('SELECT * FROM tickets WHERE user_id=?').all(req.user.sub);
  const doc = new PDFDocument({ margin:30 });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','attachment; filename="tickets.pdf"');
  doc.pipe(res);
  doc.fontSize(18).text('Reporte de Tickets', { align:'center' });
  doc.moveDown();
  rows.forEach(r=>{
    doc.fontSize(11).text(`#${r.id} • ${new Date(r.created_at).toLocaleString()} • ${r.center}`);
    doc.text(`${r.sport} • ${r.team} • ${r.bet} ${r.pts||''} @ ${r.price} | Riesgo: $${r.stake.toFixed(2)} | Estado: ${r.status}`);
    doc.moveDown(0.5);
  });
  doc.end();
});

app.listen(PORT, ()=>{
  console.log('Server listening on http://localhost:' + PORT);
});
