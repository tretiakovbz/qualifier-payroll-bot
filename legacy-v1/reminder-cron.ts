import { SQL } from "bun";
const db=new SQL(Bun.env.DATABASE_URL);
const group=Number(Bun.env.GROUP_ID), token=Bun.env.BOT_TOKEN;
const date=new Date(Date.now()+10800000),day=date.toISOString().slice(0,10),dow=date.getUTCDay();
if(dow===5||dow===6){console.log("No reminders on Friday/Saturday");}else{
await db`CREATE TABLE IF NOT EXISTS reminder_deliveries(uid BIGINT,day DATE,PRIMARY KEY(uid,day))`;
const candidates=await db`SELECT e.uid FROM employees e WHERE e.can_dm=TRUE AND e.reminders=TRUE AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.chat=${group} AND r.uid=e.uid AND r.day=${day}) AND NOT EXISTS(SELECT 1 FROM reminder_deliveries q WHERE q.uid=e.uid AND q.day=${day})`;
let ok=0;
for(const c of candidates){
const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:Number(c.uid),text:"🔔 До 20:00 МСК ждём ваш #отчет в рабочем чате. Если сегодня нет анкет, отправьте 0. Выключить напоминания: /reminders"})});const result=await response.json();
if(result.ok){await db`INSERT INTO reminder_deliveries(uid,day) VALUES(${c.uid},${day}) ON CONFLICT DO NOTHING`;ok++}
}
console.log("reminders delivered",ok,"of",candidates.length);
}
