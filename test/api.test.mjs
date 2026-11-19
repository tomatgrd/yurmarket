import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

test('accounts, persistent profiles, private messages, matters and access boundaries',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'yurmarket-test-'));
  process.env.DATA_DIR=dir;process.env.YURMARKET_TEST='1';
  const {handler,closeDatabase}=await import('../server.mjs');
  async function request(url,method='GET',body,cookie='',origin){
    const headers={host:'localhost',...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{})};
    const req=Object.assign(Readable.from(body?[JSON.stringify(body)]:[]),{url,method,headers,socket:{remoteAddress:'test'}});
    const out={status:200,headers:{},text:''};
    const res={statusCode:200,setHeader(k,v){out.headers[k.toLowerCase()]=v;},end(v){out.text=v?String(v):'';out.status=this.statusCode;}};
    await handler(req,res);return out;
  }
  async function call(route,method='GET',body,cookie=''){
    const res=await request('/api/'+route,method,body,cookie);
    return {status:res.status,data:JSON.parse(res.text),cookie:res.headers['set-cookie']?.split(';')[0]};
  }
  try{
    assert.equal((await call('me')).status,401);
    assert.equal((await call('register','POST',{login:'short',name:'Test',password:'123',role:'client'})).status,400);
    const a=await call('register','POST',{login:'client-1',name:'Тестовый Клиент',password:'test-password-12345',role:'client'});
    const b=await call('register','POST',{login:'lawyer-1',name:'Тестовый Юрист',password:'test-password-54321',role:'lawyer'});
    const c=await call('register','POST',{login:'client-2',name:'Другой Клиент',password:'test-password-98765',role:'client'});
    assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(c.status,200);
    assert.ok(!JSON.stringify(a.data).includes('password'));
    const profile={specialty:'Семейное право',city:'Москва',years:5,price:2500,tags:'Развод, Алименты',bio:'Тестовое описание практики юриста для проверки сохранения анкеты.'};
    assert.equal((await call('profile','PUT',profile,a.cookie)).status,403);
    assert.equal((await call('profile','PUT',profile,b.cookie)).status,200);
    const listed=(await call('profiles')).data.profiles;assert.equal(listed.length,1);assert.equal(listed[0].id,b.data.user.id);assert.equal(listed[0].verified,false);
    assert.equal((await call('login','POST',{login:'client-1',password:'wrong-password-123'})).status,401);
    const login=await call('login','POST',{login:'client-1',password:'test-password-12345'});assert.equal(login.data.user.id,a.data.user.id);
    assert.equal((await call('messages','POST',{recipientId:c.data.user.id,text:'Unexpected outreach'},b.cookie)).status,403);
    assert.equal((await call('messages','POST',{recipientId:b.data.user.id,text:'Private test message'},a.cookie)).status,200);
    assert.equal((await call('messages','GET',null,b.cookie)).data.messages.length,1);
    assert.equal((await call('messages','GET',null,c.cookie)).data.messages.length,0);
    assert.equal((await call('messages','POST',{recipientId:a.data.user.id,text:'Reply from lawyer'},b.cookie)).status,200);
    const matter=await call('matters','POST',{lawyerId:b.data.user.id,name:'Тестовый Клиент',title:'Семейный спор',description:'Тестовое описание обращения, достаточно длинное для проверки.',personType:'person'},a.cookie);
    assert.equal(matter.status,200);
    assert.equal((await call('matters','GET',null,c.cookie)).data.matters.length,0);
    assert.equal((await call('matters/'+matter.data.id,'PATCH',{status:'active'},c.cookie)).status,403);
    assert.equal((await call('matters/'+matter.data.id,'PATCH',{status:'done'},b.cookie)).status,400);
    assert.equal((await call('matters/'+matter.data.id,'PATCH',{status:'active'},b.cookie)).status,200);
    assert.equal((await call('matters/'+matter.data.id,'PATCH',{status:'done'},b.cookie)).status,200);
    assert.equal((await call('matters','GET',null,a.cookie)).data.matters[0].status,'done');
    const cross=await request('/api/logout','POST',{},a.cookie,'https://untrusted.example');assert.equal(cross.status,403);
    assert.equal((await call('logout','POST',{},a.cookie)).status,200);
    assert.equal((await call('me','GET',null,a.cookie)).status,401);
    assert.equal((await request('/server.mjs')).status,404);
    assert.equal((await request('/data/yurmarket.sqlite')).status,404);
    const html=(await request('/')).text;assert.ok(!html.includes('password:'));assert.ok(html.includes('app.js'));
  }finally{closeDatabase();rmSync(dir,{recursive:true,force:true});}
});
