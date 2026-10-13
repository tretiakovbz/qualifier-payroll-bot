
import { SQL } from "bun";
import { createHmac, timingSafeEqual } from "node:crypto";
const token=Bun.env.BOT_TOKEN||"", admin=Number(Bun.env.ADMIN_IDS||0), group=Number(Bun.env.GROUP_ID||0), base=Bun.env.PUBLIC_URL||"", secret=Bun.env.WEBHOOK_SECRET||"qpayroll-secret-2026";
const db=new SQL(Bun.env.DATABASE_URL||"postgres://localhost/missing");
const api=async(m,p)=>{let x=await fetch("https://api.telegram.org/bot"+token+"/"+m,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(p)});return x.json()};
const send=async(id,text,extra={})=>api("sendMessage",{chat_id:id,text,...extra});
await db`CREATE TABLE IF NOT EXISTS reports(chat BIGINT NOT NULL, msg BIGINT NOT NULL, uid BIGINT NOT NULL,name TEXT NOT NULL, n INTEGER NOT NULL,day DATE NOT NULL, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(chat,msg))`;
await db`CREATE TABLE IF NOT EXISTS payments(uid BIGINT NOT NULL,period DATE NOT NULL,amount INTEGER NOT NULL,paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(uid,period))`;
const REPLIES=["Принято, спасибо! ✅","Молодец, зафиксировано!","Отчёт принят. Движемся дальше!","Ещё один результат в копилку 📋","Красиво отчитались!","Цифры любят порядок. Записано.","Отчёт на месте, всё под контролем.","Есть контакт! Результат зафиксирован.","Работа кипит — статистика растёт.","Зачёт! Отправлено на подтверждение.","Оперативно! Так держать.","Принято в штаб хороших результатов.","Ваши анкеты уже в очереди на проверку.","Чётко, коротко, по делу. Спасибо!","Зафиксировали. Продолжаем в том же духе.","Плюс один отчёт в летопись команды.","График одобрительно кивает 📈","Система довольна, спасибо!","Вот это дисциплина! Принято.","Документально подтверждаем ваш энтузиазм.","Результаты поступили, бюрократия счастлива.","Никакой магии — только учёт.","Отлично, отчёт в надёжных руках.","Зафиксировано без лишней суеты ✅","Принято. Таблица стала умнее.","Серьёзный подход, хорошая работа!","Всё записал, ничего не потерял.","Вы сделали день немного продуктивнее.","Вижу отчёт. Спасибо за работу!","Отчёт принят. До новых рекордов!","Данные на месте. Порядок!","Проверка цифр запущена. Спасибо!","Ваш результат отправился в статистику.","Принято. Маленькие шаги — большие итоги.","Профессионально. Отчёт получен.","Стабильность — признак мастерства.","Учёт говорит вам спасибо.","По форме — отлично. По духу — тем более.","Сегодня статистика на вашей стороне.","Отчёт получен. Вы держите темп!","Спасибо, трудовой подвиг задокументирован 😎","Зафиксировано. Галочка мысленно поставлена.","Ваш вклад замечен и записан.","Отчёт получен. Хорошего дня!","Всё отлично, теперь ждём подтверждения.","Порядок в отчётах — порядок в выплатах.","Принято! Машина статистики работает.","Спасибо! Точность — наше всё.","Анкеты учтены предварительно. Ждём 👍","Ещё один кирпичик в общем результате.","Сегодня вы на связи — это уже приятно.","Принято. Продолжаем собирать победы!"];
await db`CREATE TABLE IF NOT EXISTS employees(uid BIGINT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', can_dm BOOLEAN NOT NULL DEFAULT FALSE, reminders BOOLEAN NOT NULL DEFAULT TRUE, reply_idx INTEGER NOT NULL DEFAULT -1)`;
await db`CREATE TABLE IF NOT EXISTS payment_audit(uid BIGINT NOT NULL,period DATE NOT NULL, actor BIGINT NOT NULL, amount INTEGER NOT NULL, marked_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(uid,period))`;
const msk=()=>new Date(Date.now()+3*3600000);
function iso(y,m,d){return new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)}
function period(date=msk()){let y=date.getUTCFullYear(),m=date.getUTCMonth()+1,d=date.getUTCDate();return d>=5&&d<=19?[iso(y,m,5),iso(y,m,19)]:d>=20?[iso(y,m,20),iso(y,m+1,4)]:[iso(y,m-1,20),iso(y,m,4)]}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function telegramUser(raw){
 try{let q=new URLSearchParams(raw),hash=q.get("hash")||"";q.delete("hash");const chk=[...q.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([a,b])=>a+"="+b).join("\n");const key=createHmac("sha256","WebAppData").update(token).digest();const h=createHmac("sha256",key).update(chk).digest("hex");if(!hash||!timingSafeEqual(Buffer.from(hash,"hex"),Buffer.from(h,"hex")))return null;const stamp=Number(q.get("auth_date"));if(!stamp||Math.abs(Date.now()/1000-stamp)>86400)return null;return JSON.parse(q.get("user")||"null") }catch{return null}
}
async function ranking(a,b){return db`SELECT uid, MAX(name) AS name, COALESCE(SUM(n) FILTER(WHERE status='approved'),0)::int AS approved,COALESCE(SUM(n) FILTER(WHERE status='pending'),0)::int AS pending FROM reports WHERE chat=${group} AND day BETWEEN ${a} AND ${b} GROUP BY uid ORDER BY approved DESC,name`}
async function updates(u){
 const msg=u.message||u.edited_message;
 const canApprove=(user)=>Boolean(user&&(user.id===admin||String(user.username||"").toLowerCase()==="aleksandrakosova1"));
 if(msg&&msg.chat?.id===group&&msg.from&&!msg.from.is_bot){
 const t=msg.text||"", match=t.match(/Анкет\s+собрано:\s*(\d+)/i);
 if(/#отч[её]т(?:дня)?(?![А-Яа-яЁёA-Za-z0-9_])/i.test(t)&&match){
 const n=Number(match[1]);if(!Number.isInteger(n)||n<0||n>500)return;
 const dt=new Date((msg.date||Date.now()/1000)*1000+3*3600000),day=dt.toISOString().slice(0,10),name=[msg.from.first_name,msg.from.last_name].filter(Boolean).join(" ");
 await db`INSERT INTO reports(chat,msg,uid,name,n,day,status) VALUES(${group},${msg.message_id},${msg.from.id},${name},${n},${day},'pending') ON CONFLICT(chat,msg) DO UPDATE SET n=excluded.n,name=excluded.name,status='pending'`;
 if(!u.edited_message){
 await db`INSERT INTO employees(uid,name) VALUES(${msg.from.id},${name}) ON CONFLICT(uid) DO UPDATE SET name=excluded.name`;
 const prev=await db`SELECT reply_idx FROM employees WHERE uid=${msg.from.id}`;
 const idx=((prev[0]?.reply_idx??-1)+1)%REPLIES.length;
 await db`UPDATE employees SET reply_idx=${idx} WHERE uid=${msg.from.id}`;
 await send(group,REPLIES[idx]+" · "+n+" анкет ожидают подтверждения 👍",{reply_to_message_id:msg.message_id});
 }return;
 }
 const cmd=t.split(" ")[0].split("@")[0], [a,b]=period();
 if(cmd==="/stat"||cmd==="/week"){let from=a,to=b;if(cmd==="/week"){from=new Date(msk().valueOf()-6*86400000).toISOString().slice(0,10);to=msk().toISOString().slice(0,10)}let rs=await ranking(from,to);await send(group,"🏆 Рейтинг "+from+" — "+to+"\n"+(rs.map((r,i)=>(i+1)+". "+r.name+": "+r.approved+" ✅, "+r.pending+" ⏳").join("\n")||"Нет отчётов"));return}
 if(["/approve","/reject"].includes(cmd)&&canApprove(msg.from)&&msg.reply_to_message){await db`UPDATE reports SET status=${cmd==="/approve"?"approved":"rejected"} WHERE chat=${group} AND msg=${msg.reply_to_message.message_id}`;await send(group,"Статус отчёта обновлён.");return;}
 if(cmd==="/payroll"&&msg.from.id===admin){const rs=await ranking(a,b);await send(msg.from.id,"💰 Ведомость "+a+" — "+b+"\\n"+rs.map(r=>r.name+": "+r.approved+" × 500 = "+(r.approved*500)+" ₽").join("\\n")+"\\nИтого: "+rs.reduce((n,r)=>n+r.approved*500,0)+" ₽");return}
 if(cmd==="/history"){let d=new Date(a+"T00:00:00Z"),out=[];for(let i=0;i<8;i++){d.setUTCDate(d.getUTCDate()-1);let [start,end]=period(d);let row=await db`SELECT COALESCE(SUM(n),0)::int AS n FROM reports WHERE chat=${group} AND status='approved' AND day BETWEEN ${start} AND ${end}`;out.push(start+"—"+end+": "+row[0].n);d=new Date(start+"T00:00:00Z")}await send(group,"📚 История подтверждённых анкет\\n"+out.join("\\n"));return}
 if(cmd==="/paid"&&msg.from.id===admin){await send(group,"🔒 Отметки выплат доступны только в личном чате бота: /paid TELEGRAM_ID");return;}
 if(cmd==="/export"&&msg.from.id===admin){await send(group,"🔒 Выгрузка доступна в личном чате бота: /export");return;}
 if(cmd==="/app"){await send(group,"📊 Статистика квалификаторов",{reply_markup:{inline_keyboard:[[{text:"Открыть Mini App",url:base}]]}});return;}
 }
 if(msg&&msg.chat?.type==="private"){
  const [a,b]=period();
  const uid=msg.from.id, name=[msg.from.first_name,msg.from.last_name].filter(Boolean).join(" ");
  await db`INSERT INTO employees(uid,name,can_dm) VALUES(${uid},${name},TRUE) ON CONFLICT(uid) DO UPDATE SET name=excluded.name,can_dm=TRUE`;
  if(msg.text==="/reminders"||msg.text==="/settings"){
    const opts=await db`SELECT reminders FROM employees WHERE uid=${uid}`;
    await send(uid,"🔔 Напоминания в 19:30 МСК (вс–чт): "+(opts[0].reminders?"Включены":"Выключены"),{reply_markup:{inline_keyboard:[[{text:opts[0].reminders?"🔕 Выключить":"🔔 Включить",callback_data:"toggle_reminder"}]]}});
    return;
  }
  if(msg.text?.startsWith("/paid")&&uid===admin){
    const employee=Number(msg.text.split(/\s+/)[1]);
    if(!Number.isSafeInteger(employee)||employee<=0){await send(uid,"Используй: /paid TELEGRAM_ID (отмечает выплату за завершённый период)");return;}
    const pdate=new Date(a+"T00:00:00Z");pdate.setUTCDate(pdate.getUTCDate()-1);const [from,to]=period(pdate);
    const rows=await db`SELECT COALESCE(SUM(n),0)::int AS n FROM reports WHERE chat=${group} AND uid=${employee} AND status='approved' AND day BETWEEN ${from} AND ${to}`;
    if(rows[0].n===0){await send(uid,"Нет подтверждённых анкет сотрудника за "+from+" — "+to);return;}
    const amount=rows[0].n*500;
    await db`INSERT INTO payments(uid,period,amount) VALUES(${employee},${from},${amount}) ON CONFLICT(uid,period) DO UPDATE SET amount=excluded.amount,paid_at=now()`;
    await db`INSERT INTO payment_audit(uid,period,actor,amount) VALUES(${employee},${from},${uid},${amount}) ON CONFLICT(uid,period) DO UPDATE SET amount=excluded.amount,actor=excluded.actor,marked_at=now()`;
    await send(uid,"✅ Выплата отмечена: "+employee+" · "+amount+" ₽ за "+from+" — "+to);return;
  }
  if(msg.text==="/export"&&uid===admin){
    const rows=await ranking(a,b);
    const quote=x=>'"'+String(x).replaceAll('"','""')+'"';
    const csv="Период;Telegram ID;Сотрудник;Подтверждено;Ожидает;Начислено ₽;Выплачено ₽;Статус\\r\\n"+(await Promise.all(rows.map(async r=>{
      const paid=await db`SELECT amount FROM payments WHERE uid=${r.uid} AND period=${a}`;
      return [a,r.uid,r.name,r.approved,r.pending,r.approved*500,paid[0]?.amount||0,paid.length?"Оплачено":"Не оплачено"].map(quote).join(";");
    }))).join("\\r\\n");
    const form=new FormData();form.set("chat_id",String(uid));form.set("document",new Blob(["\\uFEFF"+csv],{type:"text/csv;charset=utf-8"}),"qualifiers_"+a+"_"+b+".csv");
    const uploaded=await fetch("https://api.telegram.org/bot"+token+"/sendDocument",{method:"POST",body:form});
    if(!(await uploaded.json()).ok)await send(uid,"Ошибка отправки CSV");return;
  }
  if(msg.text==="/me"){let r=await db`SELECT COALESCE(SUM(n),0)::int AS n FROM reports WHERE chat=${group} AND uid=${msg.from.id} AND status='approved' AND day BETWEEN ${a} AND ${b}`;await send(msg.chat.id,"✅ Подтверждено: "+r[0].n+"\nНачислено: "+r[0].n*500+" ₽");return}
  if(msg.text?.startsWith("/start")||msg.text==="/app")await send(msg.chat.id,"📊 Статистика и результаты",{reply_markup:{inline_keyboard:[[{text:"Открыть статистику",web_app:{url:base}}]]}});
 }
 if(u.callback_query?.data==="toggle_reminder"){
   const q=u.callback_query, uid=q.from.id;
   await db`INSERT INTO employees(uid,name,can_dm) VALUES(${uid},${q.from.first_name||""},TRUE) ON CONFLICT(uid) DO UPDATE SET reminders=NOT employees.reminders, can_dm=TRUE`;
   const rows=await db`SELECT reminders FROM employees WHERE uid=${uid}`;
   await api("answerCallbackQuery",{callback_query_id:q.id,text:rows[0].reminders?"Напоминания включены":"Напоминания выключены"});
   await api("editMessageText",{chat_id:q.message.chat.id,message_id:q.message.message_id,text:"🔔 Напоминания в 19:30 МСК (вс–чт): "+(rows[0].reminders?"Включены":"Выключены"),reply_markup:{inline_keyboard:[[{text:rows[0].reminders?"🔕 Выключить":"🔔 Включить",callback_data:"toggle_reminder"}]]}});
   return;
 }
 if(u.message_reaction&&u.message_reaction.chat?.id===group&&canApprove(u.message_reaction.user)){
 const r=u.message_reaction;const yes=(r.new_reaction||[]).some(x=>x.type==="emoji"&&x.emoji==="👍");await db`UPDATE reports SET status=${yes?"approved":"pending"} WHERE chat=${group} AND msg=${r.message_id}`;return;
 }
}
const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><title>Квалификаторы • Статистика</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box}body{margin:0;background:#0d1019;color:#f6f7fa;font:15px 'Montserrat',Arial,sans-serif}main{max-width:650px;margin:auto;padding:24px 18px}header{display:flex;gap:12px;align-items:center;margin-bottom:22px}.logo{border:2px solid #eee;border-radius:50%;width:52px;height:52px;display:grid;place-items:center;font-size:28px}.sub{color:#8d96ad;font-size:13px}h1{font-size:22px;margin:0 0 5px}.panel{background:#191d2a;border:1px solid #2a3040;border-radius:20px;padding:20px;margin:14px 0}.tag{color:#9fa6bc;font-size:13px}.big{font-size:36px;font-weight:800;margin:8px 0}h2{font-size:17px;margin:8px 0 18px}.row{margin:16px 0}.line{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.bar{height:9px;background:#30384b;border-radius:20px;overflow:hidden}.bar b{display:block;height:100%;background:#81d5b5;border-radius:20px}.muted{color:#9fa6bc}.pill{background:#2b3440;border-radius:8px;padding:5px 9px}button{background:#3d846e;color:white;border:0;border-radius:10px;padding:9px 13px;font-weight:600}.error{color:#f59d9d}</style></head><body><main><header><div class="logo">✓</div><div><h1>Статистика команды</h1><div class="sub">Отчёты • Рейтинг • Начисления</div></div></header><div id="content" class="panel"><span class="muted">Загружаем данные…</span></div><div class="sub">Выплаты 5 и 20 числа. Личные начисления видны только вам.</div></main><script>
let tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();
(async()=>{const holder=document.getElementById('content');if(!tg?.initData){holder.innerHTML='<h2>Откройте Mini App из Telegram</h2><p class="muted">Для безопасности статистика доступна только авторизованным участникам.</p>';return}try{const resp=await fetch('/api/stats'+location.search,{headers:{'X-Telegram-Init-Data':tg.initData}}),data=await resp.json();if(!resp.ok)throw new Error(data.error||'Ошибка');let max=Math.max(1,...data.rows.map(x=>x.approved));const node=document.createElement('div');const ctr=document.createElement('div');ctr.className='panel';const h=document.createElement('h2');h.textContent='📅 Расчётные периоды';ctr.append(h);for(const [label,shift] of [['← Раньше',1],['Позже →',-1]]){const button=document.createElement('button');button.textContent=label;button.style.marginRight='8px';button.disabled=shift===-1&&data.offset===0;button.onclick=()=>{const q=new URLSearchParams(location.search);q.set('period',Math.max(0,data.offset+shift));location.search=q.toString()};ctr.append(button)}const test=document.createElement('button');test.textContent=data.demo?'Показать реальные данные':'🧪 Пример: 4 квалификатора';test.style.marginTop='10px';test.onclick=()=>{const q=new URLSearchParams(location.search);q.set('demo',data.demo?'0':'1');location.search=q.toString()};ctr.append(document.createElement('br'),test);node.append(ctr);if(data.demo){const label=document.createElement('p');label.className='muted';label.textContent='Демонстрация: вымышленные сотрудники, не участвуют в выплатах';node.append(label)}const top=document.createElement('div');top.innerHTML='<div class="tag">Период: '+data.start+' — '+data.end+'</div><div class="big">'+data.total+'</div><div class="muted">подтверждённых анкет командой</div>';node.append(top);const rankingTitle=document.createElement('h2');rankingTitle.style.marginTop='30px';rankingTitle.textContent='🏆 Рейтинг сотрудников';node.append(rankingTitle);if(!data.rows.length){let e=document.createElement('p');e.textContent='Пока нет отчётов';node.append(e)}data.rows.forEach((r,i)=>{const el=document.createElement('div');el.className='row';const line=document.createElement('div');line.className='line';const name=document.createElement('strong');name.textContent=(i+1)+'. '+r.name;const score=document.createElement('span');score.textContent=r.approved+' ✅';line.append(name,score);const bar=document.createElement('div');bar.className='bar';const fill=document.createElement('b');fill.style.width=(100*r.approved/max)+'%';bar.append(fill);el.append(line,bar);node.append(el)});if(data.self){const box=document.createElement('div');box.className='panel';box.innerHTML='<div class="tag">Мои начисления (видны только вам)</div><div class="big">'+data.self.approved*500+' ₽</div><div class="muted">Подтверждено: '+data.self.approved+' · Ожидают: '+data.self.pending+'</div>';node.append(box)}const daybox=document.createElement('div');daybox.className='panel';const dh=document.createElement('h2');dh.textContent='Мои результаты по дням';daybox.append(dh);(data.days||[]).forEach(x=>{const r=document.createElement('div');r.className='line';const d=document.createElement('span');d.textContent=x.day;const n=document.createElement('span');n.textContent=x.approved+' ✅ · '+x.pending+' ⏳';r.append(d,n);daybox.append(r)});if(!(data.days||[]).length)daybox.append('Отчётов пока нет');node.append(daybox);if(data.isAdmin&&!data.demo){const box=document.createElement('div');box.className='panel';const h=document.createElement('h2');h.textContent='👑 Администратор: результаты по дням';box.append(h);(data.details||[]).forEach(item=>{const line=document.createElement('div');line.className='line';const left=document.createElement('span');left.textContent=item.day+' · '+item.name;const right=document.createElement('b');right.textContent=item.approved+' ✅';line.append(left,right);box.append(line)});node.append(box)}
const settings=document.createElement('div');settings.className='panel';const head=document.createElement('h2');head.textContent='Напоминания';const toggle=document.createElement('button');toggle.textContent=data.reminders?'🔔 Включены · выключить':'🔕 Выключены · включить';toggle.onclick=async()=>{toggle.disabled=true;try{let res=await fetch('/api/reminders',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Init-Data':tg.initData},body:JSON.stringify({enabled:!data.reminders})});if(!res.ok)throw Error('Настройка не сохранена');data.reminders=!data.reminders;toggle.textContent=data.reminders?'🔔 Включены · выключить':'🔕 Выключены · включить'}catch(e){alert(e.message)}finally{toggle.disabled=false}};const hint=document.createElement('p');hint.className='muted';hint.textContent='Лично в 19:30 МСК, вс–чт. Для получения уведомлений нажмите Start в боте.';settings.append(head,toggle,hint);node.append(settings);holder.replaceWith(node)}catch(e){holder.textContent='Не удалось загрузить статистику: '+e.message;holder.className='panel error'}})();
</script></body></html>`;
Bun.serve({port:Number(Bun.env.PORT||3000),async fetch(req){
const url=new URL(req.url);
if(url.pathname==="/health")return Response.json({ok:true,service:"qualifier-miniapp"});
if(url.pathname==="/")return new Response(html,{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store"}});
if(url.pathname==="/api/reminders"&&req.method==="POST"){const user=telegramUser(req.headers.get("X-Telegram-Init-Data")||"");if(!user)return Response.json({error:"Unauthorized"},{status:401});let body=await req.json().catch(()=>({}));if(typeof body.enabled!=="boolean")return Response.json({error:"Bad preference"},{status:400});await db`INSERT INTO employees(uid,name,reminders) VALUES(${user.id},${user.first_name||""},${body.enabled}) ON CONFLICT(uid) DO UPDATE SET reminders=EXCLUDED.reminders`;return Response.json({enabled:body.enabled});}
if(url.pathname==="/api/stats"){const user=telegramUser(req.headers.get("X-Telegram-Init-Data")||"");if(!user)return Response.json({error:"Требуется авторизация Telegram"},{status:401});const isAdmin=user.id===admin||String(user.username||"").toLowerCase()==="aleksandrakosova1";
const offset=Math.max(0,Math.min(24,Number(url.searchParams.get("period")||0)||0));
let [a,b]=period();for(let i=0;i<offset;i++){const dt=new Date(a+"T00:00:00Z");dt.setUTCDate(dt.getUTCDate()-1);[a,b]=period(dt)}
const demo=url.searchParams.get("demo")==="1";let rows=await ranking(a,b);
if(demo){rows=["Александр","Мария","Екатерина","Дмитрий"].map((name,i)=>({name:name+" · демо",uid:-(i+1),approved:offset===0?47-i*8:32-i*5,pending:i%3}));}
let self=demo?null:rows.find(r=>String(r.uid)===String(user.id));const days=await db`SELECT day::text AS day,COALESCE(SUM(n) FILTER(WHERE status='approved'),0)::int AS approved,COALESCE(SUM(n) FILTER(WHERE status='pending'),0)::int AS pending FROM reports WHERE chat=${group} AND uid=${user.id} AND day BETWEEN ${a} AND ${b} GROUP BY day ORDER BY day DESC`;const preference=await db`SELECT reminders FROM employees WHERE uid=${user.id}`;const details=isAdmin&&!demo?await db`SELECT day::text AS day,uid,MAX(name) AS name,COALESCE(SUM(n) FILTER(WHERE status='approved'),0)::int AS approved FROM reports WHERE chat=${group} AND day BETWEEN ${a} AND ${b} GROUP BY day,uid ORDER BY day DESC`:[];return Response.json({isAdmin,demo,offset,details,days:demo?[]:days,reminders:preference[0]?.reminders??true,start:a,end:b,total:rows.reduce((v,r)=>v+r.approved,0),rows:rows.map(x=>({name:x.name,approved:x.approved,pending:x.pending})),self:self?{approved:self.approved,pending:self.pending}:{approved:0,pending:0}})}
if(url.pathname==="/telegram/webhook"&&req.method==="POST"){if(req.headers.get("X-Telegram-Bot-Api-Secret-Token")!==secret)return new Response("forbidden",{status:403});try{await updates(await req.json());return Response.json({ok:true})}catch(e){console.error(e);return Response.json({error:"retry"},{status:500})}}
return new Response("Not found",{status:404})
}});
