import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'yurmarket.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('client','lawyer')));
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id), specialty TEXT NOT NULL, city TEXT NOT NULL, years INTEGER NOT NULL, price INTEGER NOT NULL, bio TEXT NOT NULL, tags TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS matters(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id), lawyer_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, person_type TEXT NOT NULL, title TEXT NOT NULL, address TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id), lawyer_id TEXT NOT NULL REFERENCES users(id), sender_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
const id = () => randomBytes(16).toString('hex');
const hash = v => createHash('sha256').update(v).digest('hex');
const pub = u => ({ id:u.id, login:u.name, first:u.name.split(' ')[0], type:u.role, role:u.role === 'lawyer' ? 'Юрист' : 'Клиент', lawyerName:u.role==='lawyer'?u.name:undefined, avatar:u.name.split(' ').slice(0,2).map(x=>x[0]).join(''), country:'Россия', region:'', language:'Русский' });
function bad(message, status=400) { throw Object.assign(new Error(message), {status}); }
function text(v, name, min=1, max=200) { if(typeof v!=='string'||v.trim().length<min||v.trim().length>max) bad(`Проверьте поле «${name}» (${min}–${max} символов).`); return v.trim(); }
function rate(key, max=30) {
  const now=Date.now(), r=db.prepare('SELECT * FROM limits WHERE key=?').get(key);
  if(r && r.expires>now && r.count>=max) bad('Слишком много попыток. Повторите через 15 минут.',429);
  db.prepare('INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires>? THEN count+1 ELSE 1 END, expires=CASE WHEN expires>? THEN expires ELSE excluded.expires END').run(key,now+900000,now,now);
}
function user(req) {
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ym_session='))?.slice(11);
  if(!token) bad('Войдите в аккаунт.',401);
  const u=db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?').get(hash(token),Date.now());
  if(!u) bad('Сеанс истёк. Войдите снова.',401);
  return u;
}
function session(res, u) {
  const token=randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),u.id,Date.now()+86400000*7);
  res.setHeader('Set-Cookie',`ym_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`);
}
async function body(req) {
  if(!(req.headers['content-type']||'').startsWith('application/json')) bad('Нужен JSON.',415);
  let data='', length=0;
  for await (const chunk of req) { length+=chunk.length; if(length>20000) bad('Слишком большой запрос.',413); data+=chunk; }
  try { const v=JSON.parse(data); if(!v||Array.isArray(v)||typeof v!=='object') bad('Некорректные данные.'); return v; } catch { bad('Некорректные данные.'); }
}
function profiles() { return db.prepare('SELECT p.*,u.name FROM profiles p JOIN users u ON u.id=p.user_id ORDER BY u.name').all().map(p=>({id:p.user_id,name:p.name,specialty:p.specialty,city:p.city,years:p.years,price:String(p.price),bio:p.bio,tags:JSON.parse(p.tags),cases:[],online:false,verified:false,avatar:p.name.split(' ').slice(0,2).map(x=>x[0]).join('')})); }
function partner(me, otherId) {
  const other=db.prepare('SELECT * FROM users WHERE id=?').get(otherId);
  if(!other||other.role===me.role) bad('Получатель недоступен.');
  const client=me.role==='client'?me.id:other.id, lawyer=me.role==='lawyer'?me.id:other.id;
  if(me.role==='client'&&!db.prepare('SELECT 1 FROM profiles WHERE user_id=?').get(lawyer)) bad('Анкета пока не опубликована.');
  if(me.role==='lawyer'&&!db.prepare('SELECT 1 FROM messages WHERE client_id=? AND lawyer_id=? UNION SELECT 1 FROM matters WHERE client_id=? AND lawyer_id=?').get(client,lawyer,client,lawyer)) bad('Нет обращения от этого клиента.',403);
  return {client,lawyer,other};
}
async function api(req,res,url) {
  const route=url.pathname, method=req.method;
  if(method==='GET'&&route==='/api/health') return {ok:true};
  if(method==='GET'&&route==='/api/profiles') return {profiles:profiles()};
  if(method==='POST'&&(route==='/api/register'||route==='/api/login')) {
    const b=await body(req); rate('auth:'+(req.socket.remoteAddress||'unknown'),15);
    const login=text(b.login,'логин',3,80).normalize('NFKC').toLowerCase();
    const password=text(b.password,'пароль',12,128);
    if(route==='/api/register') {
      const name=text(b.name,'ФИО',3,100), role=b.role==='lawyer'?'lawyer':'client';
      if(db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) bad('Этот логин уже занят.',409);
      const salt=randomBytes(16).toString('hex'), derived=await scrypt(password,salt,64);
      try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id(),login,name,salt+':'+derived.toString('hex'),role); }
      catch(e) { if(String(e.message).includes('UNIQUE')) bad('Этот логин уже занят.',409); throw e; }
    }
    const u=db.prepare('SELECT * FROM users WHERE login=?').get(login);
    const [salt, stored]=(u?.password||'dummy:00').split(':');
    const derived=await scrypt(password,salt,64), expected=Buffer.from(stored,'hex');
    if(!u||expected.length!==derived.length||!timingSafeEqual(derived,expected)) bad('Неверный логин или пароль.',401);
    session(res,u); return {user:pub(u)};
  }
  const me=user(req);
  if(method==='POST'&&route==='/api/logout') {
    const token=(req.headers.cookie||'').match(/(?:^|;\s*)ym_session=([^;]+)/)?.[1];
    if(token) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
    res.setHeader('Set-Cookie','ym_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return {ok:true};
  }
  if(method==='GET'&&route==='/api/me') return {user:pub(me),profile:profiles().find(p=>p.id===me.id)||null};
  if(method==='PUT'&&route==='/api/profile') {
    if(me.role!=='lawyer') bad('Анкету может создать только юрист.',403);
    const b=await body(req), specialty=text(b.specialty,'специализация',3,100), city=text(b.city,'город',2,80), bio=text(b.bio,'о себе',30,3000);
    const years=Number(b.years), price=Number(b.price);
    if(!Number.isInteger(years)||years<0||years>70||!Number.isInteger(price)||price<0||price>1000000) bad('Проверьте стаж и стоимость.');
    const tags=text(b.tags||specialty,'направления',1,300).split(',').map(x=>x.trim()).filter(Boolean).slice(0,8);
    db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET specialty=excluded.specialty,city=excluded.city,years=excluded.years,price=excluded.price,bio=excluded.bio,tags=excluded.tags').run(me.id,specialty,city,years,price,bio,JSON.stringify(tags));
    return {profile:profiles().find(p=>p.id===me.id)};
  }
  if(method==='GET'&&route==='/api/matters') {
    return {matters:db.prepare('SELECT m.*,l.name AS lawyer,c.name AS client FROM matters m JOIN users l ON l.id=m.lawyer_id JOIN users c ON c.id=m.client_id WHERE client_id=? OR lawyer_id=? ORDER BY created DESC').all(me.id,me.id)};
  }
  if(method==='POST'&&route==='/api/matters') {
    if(me.role!=='client') bad('Обращение отправляет клиент.',403);
    rate('write:'+me.id,50); const b=await body(req), p=partner(me,b.lawyerId);
    const name=text(b.name,'имя',3,100), title=text(b.title,'тип дела',2,150), description=text(b.description,'описание',20,5000);
    const address=typeof b.address==='string'?b.address.trim().slice(0,300):'';
    const matterId=id();
    db.prepare('INSERT INTO matters(id,client_id,lawyer_id,name,person_type,title,address,description,created) VALUES(?,?,?,?,?,?,?,?,?)').run(matterId,me.id,p.lawyer,name,b.personType==='company'?'company':'person',title,address,description,new Date().toISOString());
    return {id:matterId};
  }
  if(method==='PATCH'&&route.startsWith('/api/matters/')) {
    const b=await body(req), m=db.prepare('SELECT * FROM matters WHERE id=?').get(route.split('/').pop());
    if(!m||m.lawyer_id!==me.id) bad('Нет доступа к обращению.',403);
    if(!((m.status==='pending'&&b.status==='active')||(m.status==='active'&&b.status==='done'))) bad('Недопустимый переход статуса.');
    db.prepare('UPDATE matters SET status=? WHERE id=?').run(b.status,m.id); return {ok:true};
  }
  if(method==='GET'&&route==='/api/messages') {
    const rows=db.prepare('SELECT m.*,c.name AS client,l.name AS lawyer FROM messages m JOIN users c ON c.id=m.client_id JOIN users l ON l.id=m.lawyer_id WHERE client_id=? OR lawyer_id=? ORDER BY created,id').all(me.id,me.id);
    return {messages:rows};
  }
  if(method==='POST'&&route==='/api/messages') {
    rate('write:'+me.id,50); const b=await body(req), p=partner(me,b.recipientId), message=text(b.text,'сообщение',1,3000);
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),p.client,p.lawyer,me.id,message,new Date().toISOString()); return {ok:true};
  }
  bad('Страница не найдена.',404);
}
export async function handler(req,res){
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY');
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store');
    try {
      if(req.method!=='GET'&&req.headers.origin) {
        const expected=process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`;
        if(req.headers.origin!==expected) bad('Источник запроса не разрешён.',403);
      }
      const result=await api(req,res,url); res.end(JSON.stringify(result));
    } catch(e) {res.statusCode=e.status||500;res.end(JSON.stringify({error:e.status?e.message:'Ошибка сервера. Попробуйте позже.'}));}
    return;
  }
  const files={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/theme.css':['theme.css','text/css; charset=utf-8']};
  const file=files[url.pathname];
  if(!file||!['GET','HEAD'].includes(req.method)){res.statusCode=404;res.end('Not found');return;}
  res.setHeader('Content-Type',file[1]); res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.end(req.method==='HEAD'?undefined:readFileSync(path.join(root,file[0])));
}
export const server=http.createServer(handler);
export function closeDatabase(){db.close();}
if(process.env.NODE_ENV==='production'&&!process.env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN to the HTTPS site origin.');
if(process.env.YURMARKET_TEST!=='1')server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`ЮрМаркет: http://127.0.0.1:${server.address().port}`));
