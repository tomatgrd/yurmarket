/* Server-backed interactions. No credentials or personal records in browser storage. */
(() => {
  const $=id=>document.getElementById(id), esc=escapeHtml;
  const demo=lawyers.map((p,i)=>({...p,id:'demo-'+i,demo:true}));
  let real=[], ownProfile=null, available=false, threads={}, recipient=null, busy=false;
  const status={pending:'Ожидает ответа',active:'В работе',done:'Завершено'};
  async function api(url,method='GET',data) {
    const response=await fetch('/api/'+url,{method,credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
    let result; try{result=await response.json();}catch{throw new Error('Сервер не подключён. Регистрация и отправка сейчас недоступны.');}
    if(!response.ok)throw new Error(result.error||'Не удалось выполнить действие.'); return result;
  }
  async function action(button,fn,error) {
    if(busy)return;busy=true;if(button)button.disabled=true;
    try{await fn();}catch(e){if(error)error.textContent=e.message;else showToast(e.message);}finally{busy=false;if(button)button.disabled=false;}
  }
  function all(){return real.length?real:demo;}
  function listProfiles(){
    const q=($('f-query')?.value||'').trim().toLowerCase();
    let list=all();
    if(q){const inferred=findSpecialtyByKeywords(q);list=list.filter(p=>[p.name,p.specialty,p.city,...p.tags].join(' ').toLowerCase().includes(q)||(inferred&&p.specialty===inferred));}
    const practice=$('f-practice').value,city=$('f-city').value,audience=$('f-audience').value,price=$('f-price').selectedIndex;
    if(practice)list=list.filter(p=>p.specialty===practice);
    if(city)list=list.filter(p=>p.city===city);
    if(audience==='Бизнес')list=list.filter(p=>['Корпоративное право','Банкротство','Недвижимость'].includes(p.specialty));
    if(audience==='Физлица')list=list.filter(p=>p.specialty!=='Корпоративное право');
    if(price)list=list.filter(p=>{const n=Number(p.price.replace(/\D/g,''));return price===1?n<=3000:price===2?n>=3000&&n<=5000:n>=5000;});
    return list;
  }
  async function reloadProfiles(){real=(await api('profiles')).profiles;runSearch();}
  function syncUser(u){
    window.currentUser=u;
    if(u){applyLoggedInState();$('login-btn').textContent=u.first;}
    else{$('login-btn').textContent='Войти';$('login-btn').onclick=openLogin;window.myCases=[];threads={};window.chatThreads={};showView('home');}
  }
  async function refreshPrivate(){
    if(!window.currentUser)return;
    const [m,t]=await Promise.all([api('matters'),api('messages')]);
    window.myCases=m.matters;threads={};
    for(const msg of t.messages){const lawyerView=isLawyerUser(),key=lawyerView?msg.client_id:msg.lawyer_id;
      const thread=threads[key]||(threads[key]={id:key,name:lawyerView?msg.client:msg.lawyer,messages:[]});thread.messages.push(msg);}
    window.chatThreads=Object.fromEntries(Object.entries(threads).map(([k,v])=>[k,v.messages]));
    renderMyCases();renderCabMessages();if(recipient)renderChatMessages();
  }
  window.runSearch=()=>{window.filteredLawyers=listProfiles();renderLawyers();};
  window.filterByTag=tag=>{window.filteredLawyers=all().filter(p=>p.specialty===tag||p.tags.includes(tag));renderLawyers();$('results-section').scrollIntoView({behavior:'smooth'});};
  window.renderLawyers=()=>{
    let list=[...(window.filteredLawyers||all())];
    if($('sort-select').value==='price')list.sort((a,b)=>Number(String(a.price).replace(/\D/g,''))-Number(String(b.price).replace(/\D/g,'')));
    else list.sort((a,b)=>b.years-a.years);
    window.currentList=list;
    $('results-count').textContent=list.length?`${list.length} анкет · ${real.length?'данные предоставлены специалистами':'демонстрационные примеры'}`:'По вашему запросу никого не найдено. Измените фильтры.';
    $('lawyer-list').innerHTML=list.map((p,i)=>`<button type="button" class="lawyer-card" data-profile="${i}"><span class="avatar">${esc(p.name.split(' ').slice(0,2).map(x=>x[0]).join(''))}</span><span class="lawyer-body"><span class="name-row"><span class="lawyer-name">${esc(p.name)}</span><span class="profile-label">${p.demo?'Пример анкеты':'Без проверки документов'}</span></span><span class="lawyer-specialty">${esc(p.specialty)} · ${esc(p.city)}</span><span class="lawyer-facts">${p.years} лет опыта</span><span class="tag-row">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</span><span class="card-bottom"><span class="price-block"><b>${esc(p.price)} ₽</b><span class="unit"> / час</span></span><span class="profile-open">Открыть анкету</span></span></span></button>`).join('');
    $('lawyer-list').querySelectorAll('[data-profile]').forEach(b=>b.onclick=()=>openLawyerProfile(Number(b.dataset.profile)));
  };
  window.findLawyerByName=name=>all().find(p=>p.name===name);
  window.openLawyerProfile=i=>{
    const p=window.currentList[i];if(!p)return;window.currentLawyer=p;
    $('lawyer-modal-content').innerHTML=`<div class="profile-head"><div class="avatar">${esc(p.name.split(' ').slice(0,2).map(x=>x[0]).join(''))}</div><div><div class="profile-name">${esc(p.name)}</div><div class="profile-specialty">${esc(p.specialty)} · ${esc(p.city)}</div></div></div><p class="profile-label">${p.demo?'Демонстрационная анкета. Специалист и дела вымышлены.':'Сведения указаны специалистом. Документы платформой не проверены.'}</p><div class="profile-facts"><span>${p.years} лет опыта</span><span>${esc(p.price)} ₽ / час</span></div><div class="tag-row">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><p class="profile-bio">${esc(p.bio||'Пример представления специализации, опыта и практики юриста.')}</p><div class="profile-section-label">${p.demo?'Примеры представления дел':'Практика и подход к работе'}</div><div id="profile-cases"></div><div class="profile-actions" id="profile-actions"></div>`;
    const box=$('profile-cases');
    (p.cases||[]).forEach((c,ci)=>{const b=document.createElement('button');b.className='case-preview';b.textContent=c.title+' · '+c.year;b.onclick=()=>openCaseDetail(ci);box.append(b);});
    if(!p.cases?.length)box.textContent='Подробности практики можно обсудить в личном сообщении.';
    if(!p.demo){const msg=document.createElement('button');msg.className='btn btn-outline';msg.textContent='Написать';msg.onclick=()=>openChat(p.id);const request=document.createElement('button');request.className='btn btn-primary';request.textContent='Отправить обращение';request.onclick=()=>openCaseIntakeForm(p.name);$('profile-actions').append(msg,request);}
    $('lawyer-overlay').classList.add('show');
  };
  window.refreshProfileActions=()=>{};
  window.setRegisterType=type=>{
    window.registerType=type;$('register-toggle-person').classList.toggle('active',type==='person');$('register-toggle-lawyer').classList.toggle('active',type==='lawyer');
  };
  window.submitRegister=()=>action($('register-overlay').querySelector('.modal-submit'),async()=>{
    const password=$('register-password').value;
    if(password!==$('register-password-confirm').value)throw new Error('Пароли не совпадают.');
    const r=await api('register','POST',{login:$('register-login').value,name:$('register-name').value,password,role:window.registerType==='lawyer'?'lawyer':'client'});
    ownProfile=null;syncUser(r.user);closeRegister();await refreshPrivate();showView('cabinet');
    if(isLawyerUser())showCabTab('lawprofile',{preventDefault(){},target:document.querySelector('.cab-lawyer-link')});
    showToast('Аккаунт создан. Данные сохранены на сервере.');
  },$('register-error'));
  window.submitLogin=()=>action($('login-overlay').querySelector('.modal-submit'),async()=>{
    const r=await api('login','POST',{login:$('login-user').value,password:$('login-pass').value});
    const me=await api('me');ownProfile=me.profile;syncUser(r.user);closeLogin();await refreshPrivate();showView('cabinet');
  },$('login-error'));
  window.logout=()=>action(null,async()=>{await api('logout','POST',{});ownProfile=null;syncUser(null);showToast('Вы вышли из аккаунта.');});
  window.renderLawProfile=()=>{
    if(!isLawyerUser())return;const p=ownProfile||{};
    $('cab-lawprofile-content').innerHTML=`<p class="field-hint">Публикуйте только свои достоверные профессиональные сведения. Контакты и документы по делам в публичное описание не добавляйте.</p><form id="profile-form" class="profile-form"><label>Специализация<input name="specialty" class="modal-input" required minlength="3" maxlength="100" value="${esc(p.specialty||'')}"></label><label>Город<input name="city" class="modal-input" required minlength="2" maxlength="80" value="${esc(p.city||'')}"></label><div class="form-grid"><label>Стаж, лет<input name="years" class="modal-input" type="number" required min="0" max="70" value="${p.years||0}"></label><label>Стоимость часа, ₽<input name="price" class="modal-input" type="number" required min="0" max="1000000" value="${p.price||0}"></label></div><label>Направления через запятую<input name="tags" class="modal-input" maxlength="300" value="${esc(p.tags?.join(', ')||'')}"></label><label>О себе и практике<textarea name="bio" class="modal-input" required minlength="30" maxlength="3000" rows="6">${esc(p.bio||'')}</textarea></label><div id="profile-error" role="alert" class="login-error"></div><button class="btn btn-primary" type="submit">Сохранить и опубликовать анкету</button></form>`;
    $('profile-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;action(form.querySelector('button'),async()=>{const r=await api('profile','PUT',Object.fromEntries(new FormData(form)));ownProfile=r.profile;await reloadProfiles();showToast('Анкета сохранена и опубликована.');},$('profile-error'));};
  };
  window.renderMyCases=()=>{
    const make=()=>{const container=document.createElement('div');
      if(!window.myCases.length){container.className='chat-empty';container.textContent='Обращений пока нет.';return container;}
      for(const c of window.myCases){const row=document.createElement('div');row.className='case-card';row.innerHTML=`<div><div class="case-title">${esc(c.title)}</div><div class="case-sub">${esc(isLawyerUser()?c.client:c.lawyer)}</div></div><span class="status-pill">${status[c.status]}</span>`;
        const detail=document.createElement('button');detail.className='btn btn-outline';detail.textContent='Подробнее';detail.onclick=()=>openCaseStatus(window.myCases.indexOf(c));row.append(detail);
        if(isLawyerUser()&&c.status!=='done'){const b=document.createElement('button');b.className='btn btn-primary';b.textContent=c.status==='pending'?'Принять':'Завершить';b.onclick=()=>advanceCaseStatus(window.myCases.indexOf(c));row.append(b);}container.append(row);}return container;};
    for(const target of ['cab-cases-list','cab-requests-list','cab-overview-cases'])$(target).replaceChildren(make());
    $('stat-1').textContent=window.myCases.filter(c=>c.status!=='done').length;$('stat-2').textContent=Object.keys(threads).length;$('stat-3').textContent=ownProfile?'1':'0';$('stat-3-label').textContent='опубликованных анкет';
    document.querySelectorAll('.cases-badge,.requests-badge').forEach(b=>b.textContent=window.myCases.filter(c=>c.status==='pending').length);
  };
  window.openCaseStatus=i=>{
    const c=window.myCases[i];if(!c)return;
    $('case-status-content').innerHTML=`<h3>${esc(c.title)}</h3><p>${esc(c.name)} · ${status[c.status]}</p><p class="case-description">${esc(c.description)}</p>${c.address?`<p>Адрес: ${esc(c.address)}</p>`:''}`;
    const b=document.createElement('button');b.className='btn btn-primary';b.textContent='Открыть переписку';b.onclick=()=>{closeCaseStatus();openChat(isLawyerUser()?c.client_id:c.lawyer_id);};$('case-status-content').append(b);$('case-status-overlay').classList.add('show');
  };
  window.advanceCaseStatus=i=>action(null,async()=>{const c=window.myCases[i];await api('matters/'+c.id,'PATCH',{status:c.status==='pending'?'active':'done'});await refreshPrivate();});
  window.openCaseIntakeForm=name=>{
    if(!window.currentUser){openLogin();return;}if(isLawyerUser()){showToast('Для обращения нужен аккаунт клиента.');return;}
    const p=real.find(x=>x.name===name);if(!p){showToast('Это пример анкеты. Обращения доступны зарегистрированным юристам.');return;}
    window.contactTargetLawyer=p;window.intakePersonType='person';$('intake-lawyer-name').textContent=p.name;$('intake-name').value=window.currentUser.login;$('intake-description').value='';$('intake-defendant-address').value='';$('intake-error').textContent='';setIntakePersonType('person');$('intake-overlay').classList.add('show');
  };
  window.submitCaseIntakeForm=()=>action($('intake-overlay').querySelector('.modal-submit'),async()=>{
    await api('matters','POST',{lawyerId:window.contactTargetLawyer.id,name:$('intake-name').value,personType:window.intakePersonType,title:$('intake-case-type').value,address:$('intake-defendant-address').value,description:$('intake-description').value});
    await refreshPrivate();closeCaseIntakeForm();closeLawyerProfile();showToast('Обращение сохранено и доступно юристу в кабинете.');
  },$('intake-error'));
  window.openChat=async key=>{
    if(!window.currentUser){openLogin();return;}
    let p=real.find(x=>x.id===key||x.name===key), t=threads[key];
    if(!p&&!t){const m=window.myCases.find(x=>(isLawyerUser()?x.client_id:x.lawyer_id)===key);if(m)t={id:key,name:isLawyerUser()?m.client:m.lawyer};}
    if(!p&&!t){showToast('Переписка доступна только с зарегистрированным специалистом.');return;}
    if(isLawyerUser()&&!t){showToast('Переписка начинается с обращения клиента.');return;}
    recipient={id:p?.id||t.id,name:p?.name||t.name};$('chat-avatar').textContent=recipient.name[0];$('chat-lawyer-name').textContent=recipient.name;$('chat-lawyer-status').textContent='Личная переписка';$('chat-overlay').classList.add('show');
    try{await refreshPrivate();}catch(e){showToast(e.message);}renderChatMessages();$('chat-input').focus();
  };
  window.renderChatMessages=()=>{
    if(!recipient)return;const messages=threads[recipient.id]?.messages||[];
    $('chat-messages').innerHTML=messages.length?messages.map(m=>`<div class="chat-msg ${m.sender_id===window.currentUser.id?'me':'lawyer'}">${esc(m.text)}<span class="chat-msg-time">${new Date(m.created).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span></div>`).join(''):'<p class="chat-empty">Сообщений пока нет. Автоматических ответов здесь нет.</p>';
    $('chat-messages').scrollTop=$('chat-messages').scrollHeight;
  };
  window.sendChatMessage=()=>action(null,async()=>{
    if(!recipient)return;const text=$('chat-input').value.trim();if(!text)return;await api('messages','POST',{recipientId:recipient.id,text});$('chat-input').value='';await refreshPrivate();
  });
  window.renderCabMessages=()=>{
    const box=$('cab-messages-list');box.innerHTML='';
    if(!Object.keys(threads).length){box.innerHTML='<p class="chat-empty">Сообщений пока нет.</p>';return;}
    for(const t of Object.values(threads)){const b=document.createElement('button');b.className='case-card';b.innerHTML=`<div><strong>${esc(t.name)}</strong><p>${esc(t.messages.at(-1)?.text||'')}</p></div>`;b.onclick=()=>openChat(t.id);box.append(b);}
  };
  const oldShowTab=showCabTab;
  window.showCabTab=(tab,e)=>{oldShowTab(tab,e);if(tab==='lawprofile')renderLawProfile();};
  // Replace unsupported settings with truthful account information.
  $('cab-settings').innerHTML='<h2>Аккаунт</h2><p id="settings-sub"></p><p class="field-hint">Уведомления по email и восстановление пароля пока не подключены. Не используйте пароль от других сервисов.</p><button type="button" class="btn btn-outline" onclick="logout()">Выйти</button>';
  $('register-pass-hint').outerHTML='<label class="field-label" for="register-login">Логин</label><input class="modal-input" id="register-login" minlength="3" maxlength="80" autocomplete="username" placeholder="Придумайте логин"><label class="field-label" for="register-password">Пароль — от 12 символов</label><input class="modal-input" type="password" id="register-password" minlength="12" maxlength="128" autocomplete="new-password"><label class="field-label" for="register-password-confirm">Повторите пароль</label><input class="modal-input" type="password" id="register-password-confirm" autocomplete="new-password">';
  $('login-user').value='';$('login-user').placeholder='Ваш логин';$('login-user').autocomplete='username';$('login-pass').autocomplete='current-password';
  $('sort-select').innerHTML='<option value="experience">По опыту</option><option value="price">По стоимости</option>';
  $('login-error').setAttribute('role','alert');$('register-error').setAttribute('role','alert');$('intake-error').setAttribute('role','alert');$('toast').setAttribute('role','status');
  document.querySelectorAll('.modal-close').forEach(b=>b.setAttribute('aria-label','Закрыть'));
  $('intake-defendant-address').placeholder='Необязательно — без лишних персональных данных';
  document.querySelectorAll('.reels-wrap,.header-quote').forEach(e=>e.hidden=true);
  const hero=document.querySelector('.hero h1');if(hero)hero.innerHTML='Правовая помощь.<br><em>С понятным выбором.</em>';
  const lede=document.querySelector('.hero .lede');if(lede)lede.textContent='Изучите специализацию и опыт юриста, задайте вопрос и обсудите условия до начала работы.';
  // Preserve zero-result searches rather than silently showing every specialist.
  document.querySelectorAll('.filter-row select').forEach(s=>s.onchange=()=>{const chip=$(s.id.replace('f-','chip-')+'-text');if(chip)chip.textContent=s.value||s.options[0].textContent;runSearch();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal-overlay.show').forEach(m=>m.classList.remove('show'));});
  for(const overlay of document.querySelectorAll('.modal-overlay'))overlay.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const nodes=[...overlay.querySelectorAll('button,input,select,textarea,a[href]')].filter(n=>!n.disabled&&n.offsetParent!==null);if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
  renderLawyers();
  (async()=>{
    try{
      await api('health');
      available=true;
      await reloadProfiles();
      const me=await api('me');
      ownProfile=me.profile;
      syncUser(me.user);
      await refreshPrivate();
    }catch{
      // The demo catalog and news remain available when the API cannot be reached.
    }
  })();
  setInterval(()=>{if(available&&window.currentUser&&!document.hidden)refreshPrivate().catch(()=>{});},15000);
})();
