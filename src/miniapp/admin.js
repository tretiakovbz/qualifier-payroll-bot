// Кабинет админа в Mini App. Использует общие помощники из index.html:
// api, view, esc, rub, ico, I, haptic, toast, human, plural, S, $, initials, growBars.
"use strict";

const Admin = (() => {
  const A = { settings: null, staff: null, overview: null, reportsTab: "pending", roleFilter: "all", analyticsRange: "30" };
  const ROLE = { qualifier: "Квалификатор", recruiter: "Рекрутер" };
  const ROLE_PL = { qualifier: "Квалификаторы", recruiter: "Рекрутеры" };
  const METRIC = { forms: "Анкеты", calls: "Недозвоны", contracts: "Контракты", docs: "Документы", vvk: "ВВК" };
  const DOW = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const isOwner = () => S.me.adminLevel === "owner";
  const chev = () => ico("chev", 16, 2.4).replace("<svg", '<svg class="chev"');
  const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  function ask(text) {
    return new Promise((res) => {
      try { if (tg && tg.showConfirm && INIT) return tg.showConfirm(text, (ok) => res(!!ok)); } catch (e) {}
      res(window.confirm(text));
    });
  }
  async function act(fn, okText) {
    try { const r = await fn(); if (okText) { toast(okText); haptic("success"); } return r; }
    catch (e) { toast("Не получилось", e.message, "error"); throw e; }
  }
  const post = (url, data, method = "POST") => api(url, { method, body: JSON.stringify(data || {}) });

  async function settings(force) {
    if (!A.settings || force) A.settings = await api("/api/v2/admin/settings");
    return A.settings;
  }

  // Предпросмотр суммы за отчёт по текущим ставкам (как на сервере)
  function previewAmount(r) {
    const s = A.settings && A.settings.settings;
    if (!s) return null;
    const m = r.metrics && Object.keys(r.metrics).length ? r.metrics : { forms: r.n };
    if (r.role !== "recruiter") return (m.forms || 0) * s.rates.perForm;
    let total = 0, special = 0;
    for (const [id, n] of Object.entries(m.special || {})) {
      const d = A.settings.directions.find((x) => String(x.id) === id);
      total += n * (d ? d.price : s.rates.contractBase); special += n;
    }
    return total + Math.max(0, (m.contracts || 0) - special) * s.rates.contractBase;
  }
  function metricLines(r) {
    const m = r.metrics && Object.keys(r.metrics).length ? r.metrics : { forms: r.n };
    const lines = [];
    if (r.role === "recruiter") {
      if (m.docs !== undefined) lines.push(["Получили документы", m.docs]);
      if (m.vvk !== undefined) lines.push(["Отправлено на ВВК", m.vvk]);
      lines.push(["Заключено контрактов", m.contracts || 0]);
      for (const [id, n] of Object.entries(m.special || {})) {
        const d = A.settings && A.settings.directions.find((x) => String(x.id) === id);
        lines.push([d ? d.name : "Особая цена", n]);
      }
    } else {
      if (m.calls !== undefined) lines.push(["Обработано недозвонов", m.calls]);
      lines.push(["Анкет собрано", m.forms || 0]);
    }
    return lines;
  }
  const av = (name, url, size = 36) => `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.8)}px">${url ? `<img src="${esc(url)}" alt="">` : esc(initials(name))}</span>`;

  // ───────── Главная админки ─────────
  async function home() {
    view(`<h1>Кабинет админа</h1><div class="empty">Загружаем…</div>`);
    const [o, co] = await Promise.all([api("/api/v2/admin/overview"), api("/api/v2/admin/company")]);
    A.overview = o; A.company = co;
    const tile = (href, title, icon, count, tone) => `<button class="card" data-go="${href}" style="text-align:left;display:flex;flex-direction:column;gap:10px;position:relative;min-height:118px">
      ${count ? `<span style="position:absolute;top:14px;right:14px;min-width:24px;height:24px;border-radius:12px;padding:0 7px;display:grid;place-items:center;font-size:13px;font-weight:800;background:${tone};color:#0A0E1F">${count}</span>` : ""}
      <span class="ico" style="width:40px;height:40px;border-radius:13px">${ico(icon, 21)}</span><b style="font-size:15px;line-height:1.25">${title}</b></button>`;
    view(`
      <div class="between"><div style="min-width:0"><h1>${esc(co.name)}</h1><div class="small muted">Кабинет руководителя</div></div><span class="pill" style="background:rgba(255,194,75,.14);color:var(--gold)">${isOwner() ? "Владелец" : "Менеджер"}</span></div>
      ${!co.group || !co.staff ? `<section class="card" style="display:flex;flex-direction:column;gap:12px;border:1px solid var(--accent)">
        <b>Запуск за две минуты</b>
        <div class="row" style="gap:10px"><span class="pill" style="${co.group ? "" : "background:var(--accent-soft);color:var(--accent)"}">${co.group ? ico("check", 12, 3) : "1"}</span><span class="grow small">${co.group ? `Рабочий чат подключён: ${esc(co.group.title || "группа")}` : "Подключите рабочий чат, где сотрудники пишут отчёты"}</span></div>
        <div class="row" style="gap:10px"><span class="pill" style="${co.staff ? "" : "background:var(--accent-soft);color:var(--accent)"}">${co.staff ? ico("check", 12, 3) : "2"}</span><span class="grow small">${co.staff ? `В команде ${co.staff} ${plural(co.staff, "сотрудник", "сотрудника", "сотрудников")}` : "Отправьте сотрудникам ссылку-приглашение"}</span></div>
        <button class="btn" data-go="#/admin/company">${co.group ? "Пригласить сотрудников" : "Подключить чат и пригласить"}</button>
      </section>` : ""}
      <div class="grid2">
        ${tile("#/admin/reports", "Отчёты на проверку", "check", o.pendingReports, "var(--warn)")}
        ${tile("#/admin/staff", "Сотрудники", "user", o.pendingRegistrations, "var(--accent)")}
        ${tile("#/admin/analytics", "Аналитика и выплаты", "stats", 0)}
        ${tile("#/admin/settings", "Настройки системы", "palette", 0)}
      </div>
      ${o.manual.length ? `<div class="section-title"><h2>Ручные бонусы</h2></div><div class="list">${o.manual.map((m) => `<button class="item" data-go="#/admin/manual/${m.ruleId}"><span class="ico">${ico("gift")}</span><div class="grow"><div style="font-weight:600">${esc(m.name)}</div><div class="tiny muted">${human(m.period[0])} – ${human(m.period[1])} · отмечено ${m.awarded} из ${m.total}</div></div>${chev()}</button>`).join("")}</div>` : ""}
      <div class="list">
        <button class="item" data-go="#/admin/company"><span class="ico">${ico("link")}</span><span class="grow">Компания и приглашения</span>${chev()}</button>
        <button class="item" data-go="#/admin/grant"><span class="ico">${ico("cash")}</span><span class="grow">Начислить бонус вручную</span>${chev()}</button>
        <button class="item" data-go="#/admin/promos"><span class="ico">${ico("gift")}</span><span class="grow">Акции и сторис</span>${chev()}</button>
      </div>
    `);
    bindCommon();
  }

  // ───────── Компания: приглашения и рабочий чат ─────────
  async function companyView() {
    view(`<h1>Компания</h1><div class="empty">Загружаем…</div>`);
    const c = (A.company = await api("/api/v2/admin/company"));
    const shareText = `Вступай в команду «${c.name}»: здесь наши отчёты, рейтинг, бонусы и зарплата.`;
    const openLink = (url) => { try { if (tg && tg.openTelegramLink) return tg.openTelegramLink(url); } catch (e) {} window.open(url, "_blank"); };
    view(`
      <h1>${esc(c.name)}</h1>
      <section class="card" style="display:flex;flex-direction:column;gap:12px">
        <div class="row" style="gap:10px"><span class="ico">${ico("users")}</span><div class="grow"><b>Ссылка-приглашение</b><div class="tiny muted">Сотрудник открывает её, заполняет анкету, вы одобряете</div></div></div>
        <div style="background:var(--card2);border-radius:12px;padding:12px;font-size:13px;word-break:break-all" id="inv">${esc(c.inviteLink)}</div>
        <div class="grid2"><button class="btn" id="share">${ico("link", 18)} Поделиться</button><button class="btn ghost" id="copy">${ico("copy", 18)} Скопировать</button></div>
        ${c.isOwner ? `<button class="tiny" style="color:var(--muted);text-align:left;padding:2px 0" id="reset">Ссылка попала не туда? Сделать новую — старая перестанет работать</button>` : ""}
      </section>
      <section class="card" style="display:flex;flex-direction:column;gap:12px">
        <div class="row" style="gap:10px"><span class="ico">${ico("chat")}</span><div class="grow"><b>Рабочий чат</b><div class="tiny muted">${c.group ? `Подключён: ${esc(c.group.title || "группа")}` : "Здесь сотрудники пишут отчёты с тегом #отчет"}</div></div>${c.group ? `<span class="pill">${ico("check", 12, 3)} работает</span>` : ""}</div>
        <p class="small muted" style="margin:0">${c.group ? "Можно подключить другой чат — старый отключится." : "Нажмите кнопку, выберите группу — Telegram предложит сделать бота администратором. Согласитесь: так бот видит отчёты в чате."}</p>
        <button class="btn ${c.group ? "ghost" : ""}" id="bind">${c.group ? "Подключить другой чат" : "Подключить рабочий чат"}</button>
      </section>
      ${c.isOwner ? `<form id="rename" class="card" style="display:flex;flex-direction:column;gap:12px" novalidate>
        <label class="field">Название компании<input name="name" maxlength="60" value="${esc(c.name)}"></label>
        <button class="btn ghost" type="submit">Сохранить название</button>
      </form>` : `<div class="list"><button class="item" id="leave"><span class="ico">${ico("building")}</span><span class="grow" style="color:var(--warn)">Выйти из компании</span>${chev()}</button></div>`}
    `);
    bindCommon();
    $("#share").onclick = () => { haptic(); openLink(`https://t.me/share/url?url=${encodeURIComponent(c.inviteLink)}&text=${encodeURIComponent(shareText)}`); };
    $("#copy").onclick = () => { try { navigator.clipboard.writeText(c.inviteLink); } catch (e) {} toast("Ссылка скопирована", "Отправьте её сотрудникам"); haptic("success"); };
    $("#bind").onclick = () => { haptic(); openLink(c.bindLink); };
    const reset = $("#reset");
    if (reset) reset.onclick = async () => { if (await ask("Сделать новую ссылку? Старая перестанет работать.")) { await act(() => post("/api/v2/admin/company", { resetInvite: true }), "Новая ссылка готова"); companyView(); } };
    const rn = $("#rename");
    if (rn) rn.onsubmit = async (e) => { e.preventDefault(); await act(() => post("/api/v2/admin/company", { name: rn.name.value }), "Название сохранено"); S.me.company.name = rn.name.value.trim(); companyView(); };
    const lv = $("#leave");
    if (lv) lv.onclick = () => leaveCompany();
  }

  // ───────── Отчёты ─────────
  async function reports() {
    await settings();
    view(`<h1>Отчёты</h1><div class="empty">Загружаем…</div>`);
    const status = A.reportsTab === "pending" ? "pending" : "";
    const role = A.roleFilter === "all" ? "" : A.roleFilter;
    const list = await api(`/api/v2/admin/reports?status=${status}&role=${role}`);
    const pending = list.filter((r) => r.status === "pending");
    const statusPill = (r) => r.status === "approved" ? `<span class="pill">${ico("check", 12, 3)} подтверждён${r.accrued ? " · " + rub(r.accrued) : ""}</span>`
      : r.status === "rejected" ? `<span class="pill" style="background:rgba(255,138,61,.14);color:var(--warn)">отклонён</span>` : `<span class="pill" style="background:var(--accent-soft);color:var(--accent)">ждёт проверки</span>`;
    view(`
      <h1>Отчёты</h1>
      <div class="seg" role="group" aria-label="Какие отчёты"><button data-tab="pending" aria-pressed="${A.reportsTab === "pending"}">На проверке</button><button data-tab="all" aria-pressed="${A.reportsTab === "all"}">Все</button></div>
      <div class="seg" role="group" aria-label="Роль" style="background:transparent;padding:0;font-size:14px">${["all", "qualifier", "recruiter"].map((r) => `<button data-role-f="${r}" aria-pressed="${A.roleFilter === r}" style="${A.roleFilter === r ? "" : "background:var(--card)"}">${r === "all" ? "Все" : ROLE_PL[r]}</button>`).join("")}</div>
      ${pending.length > 1 ? `<button class="btn" id="approveAll">Подтвердить все (${pending.length})</button>` : ""}
      ${list.length ? list.map((r) => {
        const amount = r.status === "approved" ? r.accrued : previewAmount(r);
        return `<article class="card" style="display:flex;flex-direction:column;gap:12px" data-msg="${r.msg}">
          <div class="row">${av(r.name, r.photo_url)}<div style="flex:1;min-width:0"><b>${esc(r.name)}</b><div class="tiny muted">${ROLE[r.role] || ""} · ${human(r.day)}</div></div>${statusPill(r)}</div>
          ${r.employee_status !== "active" ? `<div class="notice small" style="background:rgba(255,138,61,.12)">${r.employee_status === "pending" ? "Заявка на регистрацию ещё не одобрена" : "Сотрудник не зарегистрирован в боте"} — деньги начислятся на его Telegram-аккаунт</div>` : ""}
          <div style="background:var(--card2);border-radius:14px;padding:10px 12px;display:flex;flex-direction:column;gap:4px">${metricLines(r).map(([k, v]) => `<div class="between small"><span class="muted">${esc(k)}</span><b>${v}</b></div>`).join("")}</div>
          ${amount !== null && amount !== undefined ? `<div class="between small"><span class="muted">${r.status === "approved" ? "Начислено" : "К начислению"}</span><b class="num" style="color:var(--good);font-size:16px">${rub(amount)}</b></div>` : ""}
          ${r.status === "pending" ? `<div class="grid2"><button class="btn ghost" data-reject="${r.msg}">Отклонить</button><button class="btn" data-approve="${r.msg}">Подтвердить</button></div>`
            : `<button class="btn ghost" data-undo="${r.msg}" style="height:44px">${r.status === "approved" ? "Снять подтверждение" : "Вернуть на проверку"}</button>`}
        </article>`;
      }).join("") : `<div class="empty">${A.reportsTab === "pending" ? "Все отчёты проверены — новых нет" : "Отчётов пока нет"}</div>`}
    `);
    document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { A.reportsTab = b.dataset.tab; reports(); }));
    document.querySelectorAll("[data-role-f]").forEach((b) => (b.onclick = () => { A.roleFilter = b.dataset.roleF; reports(); }));
    const decide = async (msg, status, reason) => { await act(() => post(`/api/v2/admin/reports/${msg}`, { status, reason }), status === "approved" ? "Подтверждено" : status === "rejected" ? "Отклонено" : "Вернули на проверку"); if (status === "approved") playNotes(SOUND.coin); reports(); };
    document.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = () => decide(b.dataset.approve, "approved")));
    document.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = async () => { if (await ask("Вернуть отчёт на проверку? Деньги за него снимутся до повторного подтверждения.")) decide(b.dataset.undo, "pending"); }));
    document.querySelectorAll("[data-reject]").forEach((b) => (b.onclick = () => {
      const card = b.closest("article");
      const box = document.createElement("div"); box.style.cssText = "display:flex;flex-direction:column;gap:8px";
      box.innerHTML = `<label class="field">Причина — её увидит сотрудник<input id="why${b.dataset.reject}" placeholder="Например: дубль отчёта"></label><button class="btn" style="background:var(--warn)">Отклонить отчёт</button>`;
      b.parentElement.replaceWith(box);
      box.querySelector("input").focus();
      box.querySelector("button").onclick = () => decide(b.dataset.reject, "rejected", box.querySelector("input").value.trim() || undefined);
    }));
    const all = $("#approveAll");
    if (all) all.onclick = async () => {
      if (!(await ask(`Подтвердить ${pending.length} ${plural(pending.length, "отчёт", "отчёта", "отчётов")}?`))) return;
      all.disabled = true;
      for (const r of pending) await post(`/api/v2/admin/reports/${r.msg}`, { status: "approved" }).catch(() => {});
      toast("Все отчёты подтверждены"); playNotes(SOUND.coin); haptic("success"); reports();
    };
  }

  // ───────── Сотрудники ─────────
  async function staff() {
    view(`<h1>Сотрудники</h1><div class="empty">Загружаем…</div>`);
    const list = (A.staff = await api("/api/v2/admin/employees"));
    const pending = list.filter((e) => e.status === "pending" && e.role);
    const groups = ["qualifier", "recruiter"].map((role) => [role, list.filter((e) => e.role === role && e.status === "active")]);
    view(`
      <h1>Сотрудники</h1>
      ${pending.length ? `<div class="section-title"><h2>Новые заявки</h2></div>${pending.map((e) => `
        <article class="card" style="display:flex;flex-direction:column;gap:12px">
          <div class="row">${av(e.name, e.photoUrl, 44)}<div style="flex:1;min-width:0"><b>${esc(e.name)}</b><div class="tiny muted">${ROLE[e.role]}${e.city ? " · " + esc(e.city) : ""}</div></div></div>
          <div class="small muted">${e.phone ? "Телефон: " + esc(e.phone) : "Телефон не указан"}${e.username ? " · @" + esc(e.username) : ""}</div>
          <div class="grid2"><button class="btn ghost" data-reg="reject" data-uid="${e.uid}">Отклонить</button><button class="btn" data-reg="approve" data-uid="${e.uid}">Одобрить</button></div>
        </article>`).join("")}` : ""}
      ${groups.map(([role, people]) => `<div class="section-title"><h2>${ROLE_PL[role]}</h2><span class="tiny muted">${people.length}</span></div>
        <div class="list">${people.length ? people.map((e) => `<button class="item" data-go="#/admin/staff/${e.uid}">${av(e.name, e.photoUrl)}<div class="grow"><div style="font-weight:600">${esc(e.name)}${e.adminLevel ? ` <span class="tiny" style="color:var(--gold)">· ${e.adminLevel === "owner" ? "владелец" : "менеджер"}</span>` : ""}</div><div class="tiny muted">Баланс ${rub(e.balance || 0)}</div></div>${chev()}</button>`).join("") : '<div class="empty">Пока никого</div>'}</div>`).join("")}
    `);
    document.querySelectorAll("[data-reg]").forEach((b) => (b.onclick = async () => {
      const approve = b.dataset.reg === "approve";
      await act(() => post(`/api/v2/admin/employees/${b.dataset.uid}`, { action: approve ? "approve" : "reject" }), approve ? "Заявка одобрена" : "Заявка отклонена");
      staff();
    }));
    bindCommon();
  }

  async function staffCard(uid) {
    view(`<div class="empty">Загружаем…</div>`);
    const e = await api(`/api/v2/admin/employees/${uid}`);
    const prevUnpaid = e.previous.accrued > 0 && (e.previous.paid === null || e.previous.paid === undefined);
    const kindRu = { salary: "Оклад", form: "Анкеты", contract: "Контракты", bonus: "Бонус", manual: "Разовый бонус", promo: "Акция" };
    view(`
      <div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding-top:4px">${av(e.name, e.photoUrl, 76)}<h2 style="text-align:center">${esc(e.name)}</h2><div class="small muted">${ROLE[e.role] || "Без роли"}${e.adminLevel ? " · " + (e.adminLevel === "owner" ? "владелец" : "менеджер") : ""}</div></div>
      <div class="list">
        ${e.phone ? `<div class="item"><span class="grow muted">Телефон</span><b>${esc(e.phone)}</b></div>` : ""}
        ${e.city ? `<div class="item"><span class="grow muted">Город</span><b>${esc(e.city)}</b></div>` : ""}
        ${e.username ? `<div class="item"><span class="grow muted">Telegram</span><b>@${esc(e.username)}</b></div>` : ""}
        ${e.approvedAt ? `<div class="item"><span class="grow muted">В команде с</span><b>${human(new Date(e.approvedAt).toISOString().slice(0, 10))}</b></div>` : ""}
      </div>
      <div class="grid2">
        <div class="card"><div class="tiny muted">${esc(e.balance.label)}</div><div class="num" style="font-size:22px;margin-top:6px">${rub(e.balance.accrued)}</div><div class="tiny muted">идёт сейчас</div></div>
        <div class="card"><div class="tiny muted">${esc(e.previous.label)}</div><div class="num" style="font-size:22px;margin-top:6px">${rub(e.previous.accrued)}</div><div class="tiny" style="color:${e.previous.accrued === 0 ? "var(--muted)" : prevUnpaid ? "var(--warn)" : "var(--good)"}">${e.previous.accrued === 0 ? "нет начислений" : prevUnpaid ? "не выплачено" : "выплачено"}</div></div>
      </div>
      ${prevUnpaid ? `<button class="btn" id="paid">Отметить выплату ${rub(e.previous.accrued)}</button>` : ""}
      <button class="btn ghost" data-go="#/admin/grant?uid=${e.uid}">Начислить бонус</button>
      ${e.role && e.status === "active" ? `<div class="list"><button class="item" data-go="#/admin/salary/${e.uid}"><span style="color:var(--accent)">${ico("cash", 22)}</span><div class="grow" style="text-align:left"><div style="font-weight:600">Оклад</div><div class="tiny muted">${e.salary ? `${rub(e.salary.monthly)} в месяц${e.salary.individual !== null ? " · свой" : ""}${e.salary.workStart ? " · с " + human(e.salary.workStart) : ""}` : "размер, первый рабочий день, суммы по периодам"}</div></div>${chev()}</button></div>` : ""}
      <div class="section-title"><h2>Начисления</h2></div>
      <div class="list">${e.accruals.length ? e.accruals.map((a) => `<div class="item" style="${a.cancelled ? "opacity:.45" : ""}"><div class="grow"><div style="font-weight:600">${esc(kindRu[a.kind] || a.kind)}${a.cancelled ? " · отменено" : ""}</div><div class="tiny muted">${human(a.day)}${a.comment ? " · " + esc(a.comment) : ""}</div></div><b style="color:var(--good)">${rub(a.amount)}</b>${isOwner() && !a.cancelled && a.kind !== "salary" ? `<button class="icon-btn" style="width:36px;height:36px;margin-left:6px" aria-label="Отменить начисление" data-cancel="${a.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ""}</div>`).join("") : '<div class="empty">Начислений пока нет</div>'}</div>
      ${isOwner() && e.status === "active" ? `<div class="list">
        ${e.adminLevel !== "owner" ? `<button class="item" id="mgr"><span class="grow">${e.adminLevel === "manager" ? "Убрать из менеджеров" : "Сделать менеджером"}</span>${chev()}</button>` : ""}
        <button class="item" id="arch"><span class="grow" style="color:var(--warn)">Убрать из команды</span>${chev()}</button></div>
        <p class="tiny muted" style="margin:0 4px">История отчётов и выплат остаётся у компании. Человек сможет вступить заново по ссылке или создать свою компанию.</p>` : ""}
    `);
    bindCommon();
    const paid = $("#paid");
    if (paid) paid.onclick = async () => { if (await ask(`Отметить выплату ${rub(e.previous.accrued)} за ${e.previous.label}?`)) { await act(() => post("/api/v2/admin/payouts", { uid: e.uid, periodStart: e.previous.period[0] }), "Выплата отмечена"); staffCard(uid); } };
    document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => { if (await ask("Отменить это начисление? Сумма уйдёт с баланса.")) { await act(() => api(`/api/v2/admin/accruals/${b.dataset.cancel}`, { method: "DELETE" }), "Начисление отменено"); staffCard(uid); } }));
    const mgr = $("#mgr");
    if (mgr) mgr.onclick = async () => { await act(() => post(`/api/v2/admin/employees/${uid}`, { action: e.adminLevel === "manager" ? "remove_manager" : "make_manager" }), "Готово"); staffCard(uid); };
    const arch = $("#arch");
    if (arch) arch.onclick = async () => { if (await ask(`Убрать ${e.name} из команды? История отчётов и выплат сохранится.`)) { await act(() => post(`/api/v2/admin/employees/${uid}`, { action: "archive" }), "Сотрудник убран из команды"); location.hash = "#/admin/staff"; } };
  }

  // ───────── Оклад сотрудника ─────────
  async function salaryView(uid, openPs) {
    view(`<div class="empty">Загружаем…</div>`);
    const [d, e] = await Promise.all([api(`/api/v2/admin/employees/${uid}/salary`), api(`/api/v2/admin/employees/${uid}`)]);
    const own = isOwner();
    const DOWS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
    const weekWord = `${DOWS[d.week.startDow]}–${DOWS[(d.week.startDow + d.week.days - 1) % 7]}`;
    const badge = (p) => p.when === "next" ? "следующий" : p.when === "current" ? "идёт сейчас" : p.paid !== null ? "выплачен" : `выплата ${human(p.payoutDay)}`;
    const why = (p) => {
      if (p.override) return `вписано вручную${p.override.comment ? " · " + esc(p.override.comment) : ""} · по расчёту ${rub(p.auto)}`;
      if (p.notStarted) return `до первого рабочего дня (${human(d.workStart)})`;
      if (p.prorated) return `${p.prorated.worked} из ${p.prorated.total} раб. дней с ${human(p.prorated.from)} · полный период ${rub(p.full)}`;
      return "половина месячного оклада";
    };
    view(`
      <h1>Оклад</h1>
      <div class="small muted" style="margin-top:-8px">${esc(e.name)} · ${ROLE[d.role] || ""}</div>
      <form id="sp" class="card" style="display:flex;flex-direction:column;gap:14px" novalidate>
        <label class="field">Оклад в месяц, ₽<input name="monthly" inputmode="numeric" ${own ? "" : "disabled"} value="${d.individual !== null ? d.individual : ""}" placeholder="${d.roleEnabled ? d.roleMonthly.toLocaleString("ru-RU") + " — как у всех" : "оклад роли выключен"}"></label>
        <div class="tiny muted" style="margin-top:-6px">Пусто — как у всех: ${d.roleEnabled ? rub(d.roleMonthly) : "без оклада"}. За каждый период начисляется половина.</div>
        <label class="field">Первый рабочий день<input name="workStart" type="date" ${own ? "" : "disabled"} value="${d.workStart || ""}"></label>
        <div class="tiny muted" style="margin-top:-6px">Если человек вышел посреди периода, оклад за этот период считается по отработанным рабочим дням (${weekWord}). Со следующего периода — полный.</div>
        <div class="error" id="spErr" role="alert"></div>
        ${own ? `<button class="btn" id="spBtn">Сохранить</button>` : `<div class="tiny muted">Менять оклад может только владелец</div>`}
      </form>
      <div class="section-title"><h2>По периодам</h2><span class="tiny muted">${own ? "суммы можно поправить" : ""}</span></div>
      <div class="list">${d.periods.filter((p) => !(p.notStarted && p.when === "past" && !p.override && !p.accrued)).map((p) => `
        <div class="item" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="between"><div><div style="font-weight:600">${esc(p.label)}</div><div class="tiny muted">${badge(p)}</div></div>
            <div style="text-align:right"><b class="num" style="font-size:17px">${rub(p.amount)}</b>${own ? `<button class="tiny" style="display:block;margin-left:auto;color:var(--accent);font-weight:700;padding:4px 0 0" data-edit="${p.period[0]}">Изменить</button>` : ""}</div></div>
          <div class="tiny muted">${why(p)}${p.paid !== null && p.accrued !== p.paid ? ` · отмечено выплаченным ${rub(p.paid)}` : ""}</div>
          <div id="ed${p.period[0]}" hidden style="display:flex;flex-direction:column;gap:10px">
            <label class="field">Сумма оклада за этот период, ₽<input data-amt="${p.period[0]}" inputmode="numeric" value="${p.amount}"></label>
            <label class="field">Пояснение — увидит сотрудник<input data-cm="${p.period[0]}" maxlength="120" value="${p.override && p.override.comment ? esc(p.override.comment) : ""}" placeholder="Оклад за неполный период"></label>
            ${p.paid !== null ? `<div class="tiny" style="color:var(--warn)">Период уже отмечен выплаченным — разница останется на балансе сотрудника.</div>` : ""}
            <div class="grid2"><button class="btn" data-save="${p.period[0]}">Сохранить</button>${p.override ? `<button class="btn ghost" data-reset="${p.period[0]}">По расчёту</button>` : `<button class="btn ghost" data-close="${p.period[0]}">Отмена</button>`}</div>
          </div>
        </div>`).join("")}</div>
      <p class="tiny muted" style="margin:0 4px">Изменение сразу меняет начисление за период — сотрудник увидит новую сумму в «Мои деньги». Будущий период начислится сам, когда наступит.</p>
    `);
    bindCommon();
    const toggle = (ps, show) => { const box = $("#ed" + ps); if (box) { box.hidden = !show; box.style.display = show ? "flex" : "none"; } };
    d.periods.forEach((p) => toggle(p.period[0], p.period[0] === openPs));
    document.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { haptic(); const box = $("#ed" + b.dataset.edit); toggle(b.dataset.edit, box.hidden); }));
    document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => toggle(b.dataset.close, false)));
    document.querySelectorAll("[data-save]").forEach((b) => (b.onclick = async () => {
      const ps = b.dataset.save;
      const amount = Number(String(document.querySelector(`[data-amt="${ps}"]`).value).replace(/\s/g, ""));
      if (!Number.isFinite(amount) || amount < 0) return toast("Укажите сумму", "Число в рублях, можно 0", "error");
      const comment = document.querySelector(`[data-cm="${ps}"]`).value;
      await act(() => post(`/api/v2/admin/employees/${uid}/salary/period`, { periodStart: ps, amount, comment }), "Оклад за период изменён");
      salaryView(uid);
    }));
    document.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = async () => {
      await act(() => post(`/api/v2/admin/employees/${uid}/salary/period`, { periodStart: b.dataset.reset, amount: null }), "Вернули расчёт");
      salaryView(uid);
    }));
    const f = $("#sp");
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!own) return;
      const raw = String(f.monthly.value).replace(/\s/g, "");
      if (raw !== "" && !(Number(raw) >= 0)) return ($("#spErr").textContent = "Оклад — число в рублях");
      await act(() => post(`/api/v2/admin/employees/${uid}/salary`, { monthly: raw === "" ? null : Number(raw), workStart: f.workStart.value || null }), "Оклад сохранён");
      salaryView(uid);
    };
  }

  // ───────── Ручное начисление ─────────
  async function grant(params) {
    const [st, people] = await Promise.all([settings(), A.staff ? A.staff : api("/api/v2/admin/employees")]);
    A.staff = people;
    const active = people.filter((e) => e.status === "active" && e.role);
    const rules = st.rules.filter((r) => r.enabled);
    const pre = params.get("uid");
    view(`
      <h1>Начислить бонус</h1>
      <form id="g" class="card" style="display:flex;flex-direction:column;gap:14px" novalidate>
        <label class="field">Сотрудник<select class="input" name="uid">${active.map((e) => `<option value="${e.uid}" ${String(e.uid) === pre ? "selected" : ""}>${esc(e.name)} · ${ROLE[e.role].toLowerCase()}</option>`).join("")}</select></label>
        <label class="field">Бонус<select class="input" name="rule"><option value="">Разовый бонус</option>${rules.map((r) => `<option value="${r.id}" data-amount="${r.amount}">${esc(r.name)} · ${rub(r.amount)}</option>`).join("")}</select></label>
        <label class="field">Сумма, ₽<input name="amount" inputmode="numeric" placeholder="3 000"></label>
        <label class="field">За что — увидит сотрудник<input name="comment" placeholder="Закрыла сложного кандидата"></label>
        <div class="error" id="gErr" role="alert"></div>
        <button class="btn" id="gBtn">Начислить</button>
      </form>`);
    const f = $("#g");
    f.rule.onchange = () => { const o = f.rule.selectedOptions[0]; if (o && o.dataset.amount) { f.amount.value = o.dataset.amount; if (!f.comment.value) f.comment.value = o.textContent.split(" · ")[0]; } };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const amount = Number(String(f.amount.value).replace(/\s/g, ""));
      if (!f.uid.value) return ($("#gErr").textContent = "Выберите сотрудника");
      if (!(amount > 0)) return ($("#gErr").textContent = "Укажите сумму");
      if (!f.comment.value.trim()) return ($("#gErr").textContent = "Напишите, за что начисление");
      $("#gBtn").disabled = true;
      try {
        await post("/api/v2/admin/accruals", { uid: Number(f.uid.value), amount, comment: f.comment.value.trim(), ruleId: f.rule.value ? Number(f.rule.value) : undefined });
        toast("Бонус начислен", `${rub(amount)} · сотрудник получил уведомление`, "bonus"); playNotes(SOUND.fanfare); confetti(); haptic("success");
        history.back();
      } catch (e) { $("#gErr").textContent = e.message; $("#gBtn").disabled = false; }
    };
  }

  // ───────── Ручной бонус по неделям ─────────
  async function manual(ruleId, params) {
    const key = params.get("key") || "";
    view(`<div class="empty">Загружаем…</div>`);
    const d = await api(`/api/v2/admin/manual/${ruleId}${key ? "?key=" + key : ""}`);
    const step = d.rule.period === "week" ? 7 : 31;
    const shift = (n) => { const k = d.rule.period === "week" ? addDays(d.key, n * step) : (() => { const x = new Date(d.key + "-01T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 7); })(); location.hash = `#/admin/manual/${ruleId}?key=${k}`; };
    const awarded = d.staff.filter((s) => s.awarded !== null).length;
    view(`
      <h1>${esc(d.rule.name)}</h1>
      <p class="muted" style="margin:0">${rub(d.rule.amount)} каждому, кого отметите. Галочка начисляет сумму сразу, снятая — отменяет.</p>
      <div class="card between" style="padding:10px"><button class="icon-btn" id="prev" aria-label="Раньше" style="background:var(--card2)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button><b>${human(d.period[0])} – ${human(d.period[1])}</b><button class="icon-btn" id="next" aria-label="Позже" style="background:var(--card2)" ${d.period[1] >= today() ? "disabled" : ""}>${ico("chev", 18, 2.4)}</button></div>
      <div class="list">${d.staff.length ? d.staff.map((s) => `<button class="item" data-award="${s.uid}" aria-pressed="${s.awarded !== null}">
        <span style="width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex-shrink:0;${s.awarded !== null ? "background:var(--accent);color:var(--on-accent)" : "border:2px solid var(--faint)"}">${s.awarded !== null ? ico("check", 15, 3.2) : ""}</span>
        <span class="grow">${esc(s.name)}</span><b style="color:${s.awarded !== null ? "var(--good)" : "var(--faint)"}">${rub(s.awarded ?? d.rule.amount)}</b></button>`).join("") : '<div class="empty">В этой роли пока нет сотрудников</div>'}</div>
      <p class="tiny muted" style="margin:0 4px">Отмечено ${awarded} из ${d.staff.length}</p>
    `);
    $("#prev").onclick = () => shift(-1);
    $("#next").onclick = () => shift(1);
    document.querySelectorAll("[data-award]").forEach((b) => (b.onclick = async () => {
      const award = b.getAttribute("aria-pressed") !== "true";
      b.disabled = true; haptic();
      await act(() => post(`/api/v2/admin/manual/${ruleId}`, { key: d.key, uid: Number(b.dataset.award), award }), award ? "Бонус начислен" : "Бонус снят");
      if (award) playNotes(SOUND.coin);
      manual(ruleId, new URLSearchParams("key=" + d.key));
    }));
  }

  // ───────── Аналитика и выплаты ─────────
  async function analytics(params) {
    const range = A.analyticsRange;
    const to = today(), from = range === "7" ? addDays(to, -6) : range === "90" ? addDays(to, -89) : addDays(to, -29);
    view(`<h1>Аналитика</h1><div class="empty">Считаем…</div>`);
    const d = await api(`/api/v2/admin/analytics?from=${from}&to=${to}`);
    const money = {};
    for (const m of d.money) money[m.uid] = (money[m.uid] || 0) + m.sum;
    const roleBlock = (role, metrics) => {
      const main = metrics[0];
      const rows = d[role][main] || [];
      if (!rows.length) return `<div class="card small muted">${ROLE_PL[role]}: пока никого</div>`;
      const top = Math.max(1, ...rows.map((r) => r.value));
      const byUid = {};
      for (const m of metrics) for (const r of d[role][m] || []) (byUid[r.uid] = byUid[r.uid] || {})[m] = r.value;
      const team = metrics.map((m) => (d[role][m] || []).reduce((s, r) => s + r.value, 0));
      return `<section class="card" style="display:flex;flex-direction:column;gap:12px">
        <div class="between"><h3>${ROLE_PL[role]}</h3><span class="tiny muted">${metrics.map((m, i) => `${METRIC[m]}: ${team[i]}`).join(" · ")}</span></div>
        ${rows.map((r) => `<div style="display:flex;flex-direction:column;gap:6px"><div class="between small"><span style="font-weight:600">${esc(r.name)}</span><span class="muted">${metrics.map((m) => `${byUid[r.uid][m] || 0}`).join(" / ")} · <b style="color:var(--text)">${rub(money[r.uid] || 0)}</b></span></div><div class="bar" style="height:7px"><i data-w="${Math.round((r.value / top) * 100)}"></i></div></div>`).join("")}
        <div class="tiny muted">Столбик — ${METRIC[main].toLowerCase()}; цифры — ${metrics.map((m) => METRIC[m].toLowerCase()).join(" / ")}; сумма — начислено за выбранные дни</div>
      </section>`;
    };
    const payBlock = (rows, label, payoutDay, canPay, periodStart) => `
      <div class="list">${rows.length ? rows.map((r) => `<div class="item"><div class="grow"><div style="font-weight:600">${esc(r.name)}</div><div class="tiny muted">${ROLE[r.role] || ""} · оклад ${rub(r.salary)} · работа ${rub(r.work)} · бонусы ${rub(r.bonus)}</div></div><div style="text-align:right"><b class="num" style="font-size:15px">${rub(r.total)}</b>${r.paid !== null && r.paid !== undefined ? `<div class="tiny" style="color:var(--good)">выплачено</div>` : canPay ? `<button class="tiny" style="display:block;margin-left:auto;color:var(--accent);font-weight:700;padding:6px 0 0" data-pay="${r.uid}" data-ps="${periodStart}" data-sum="${r.total}" data-name="${esc(r.name)}">Отметить выплату</button>` : `<div class="tiny muted">к ${human(payoutDay)}</div>`}</div></div>`).join("") : '<div class="empty">Начислений нет</div>'}</div>
      <div class="between small" style="padding:0 4px"><span class="muted">Итого за ${esc(label)}</span><b>${rub(rows.reduce((s, r) => s + r.total, 0))}</b></div>`;
    view(`
      <h1>Аналитика</h1>
      <div class="seg" role="group" aria-label="Период">${[["7", "7 дней"], ["30", "30 дней"], ["90", "90 дней"]].map(([k, l]) => `<button data-range="${k}" aria-pressed="${range === k}">${l}</button>`).join("")}</div>
      ${roleBlock("qualifier", ["forms", "calls"])}
      ${roleBlock("recruiter", ["contracts", "docs", "vvk"])}
      <div class="section-title"><h2>К выплате ${human(d.periods.previous.payoutDay)}</h2><span class="tiny muted">${esc(d.periods.previous.label)}</span></div>
      ${payBlock(d.payrollPrev, d.periods.previous.label, d.periods.previous.payoutDay, true, d.periods.previous.period[0])}
      <div class="section-title"><h2>Текущий период</h2><span class="tiny muted">${esc(d.periods.current.label)}</span></div>
      ${payBlock(d.payroll, d.periods.current.label, d.periods.current.payoutDay, false, d.periods.current.period[0])}
      <div class="grid2"><button class="btn ghost" data-export="${d.periods.previous.period[0]}">Ведомость к выплате</button><button class="btn ghost" data-export="${d.periods.current.period[0]}">Ведомость текущая</button></div>
    `);
    document.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => { A.analyticsRange = b.dataset.range; analytics(params); }));
    document.querySelectorAll("[data-pay]").forEach((b) => (b.onclick = async () => {
      if (!(await ask(`Отметить выплату ${rub(+b.dataset.sum)} — ${b.dataset.name}?`))) return;
      await act(() => post("/api/v2/admin/payouts", { uid: Number(b.dataset.pay), periodStart: b.dataset.ps }), "Выплата отмечена");
      analytics(params);
    }));
    document.querySelectorAll("[data-export]").forEach((b) => (b.onclick = async () => {
      const r = await act(() => post("/api/v2/admin/export", { periodStart: b.dataset.export }));
      if (r.sent) return toast("Файл в чате с ботом", r.filename);
      try {
        const url = URL.createObjectURL(new Blob(["﻿" + r.csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000); toast("Файл скачан", r.filename);
      } catch (e) { toast("Не удалось скачать", "Откройте кабинет с компьютера", "error"); }
    }));
    growBars();
  }

  // ───────── Настройки системы ─────────
  async function settingsView() {
    const st = await settings(true);
    const s = st.settings, ro = !isOwner();
    const dis = ro ? "disabled" : "";
    const num = (name, val, label, suffix = "₽") => `<label class="item" style="cursor:text"><span class="grow">${label}</span><input class="inp" name="${name}" inputmode="numeric" value="${val}" ${dis} style="width:110px;text-align:right;background:var(--card2);border:0;border-radius:10px;padding:9px 10px;color:var(--text);font:600 15px Onest,sans-serif"><span class="small muted" style="margin-left:4px">${suffix}</span></label>`;
    const toggle = (name, on, label) => `<div class="item"><span class="grow">${label}</span><button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-toggle="${name}" ${dis}></button></div>`;
    view(`
      <h1>Настройки</h1>
      ${ro ? '<div class="notice">Менять настройки может только владелец. Вы видите текущие значения.</div>' : ""}
      <form id="sf" style="display:flex;flex-direction:column;gap:12px" novalidate>
        <div class="small muted" style="padding:0 4px">Ставки</div>
        <div class="list">${num("perForm", s.rates.perForm, "За анкету")}${num("contractBase", s.rates.contractBase, "Контракт, базовая цена")}</div>
        <div class="small muted" style="padding:0 4px">Оклад в месяц</div>
        <div class="list">${toggle("salQ", s.salary.qualifier.enabled, "Квалификаторам")}${num("salQAmount", s.salary.qualifier.monthly, "Сумма")}${toggle("salR", s.salary.recruiter.enabled, "Рекрутерам")}${num("salRAmount", s.salary.recruiter.monthly, "Сумма")}</div>
        <p class="tiny muted" style="margin:0 4px">Оклад делится пополам между двумя выплатами месяца.</p>
        <div class="small muted" style="padding:0 4px">Выплаты и рабочая неделя</div>
        <div class="list">${num("p1", s.payoutDays[0], "Первая выплата", "число")}${num("p2", s.payoutDays[1], "Вторая выплата", "число")}
          <label class="item"><span class="grow">Неделя начинается</span><select class="input" name="startDow" ${dis} style="height:40px">${DOW.map((d, i) => `<option value="${i}" ${s.week.startDow === i ? "selected" : ""}>${d}</option>`).join("")}</select></label>
          ${num("days", s.week.days, "Рабочих дней", "дн.")}
          <label class="item"><span class="grow">Итоги недели</span><select class="input" name="resultsDow" ${dis} style="height:40px">${DOW.map((d, i) => `<option value="${i}" ${s.week.resultsDow === i ? "selected" : ""}>${d}</option>`).join("")}</select></label>
          ${num("resultsHour", s.week.resultsHour, "Время итогов", "ч")}
          ${num("remH", s.reminders.hour, "Напоминание об отчёте", "ч")}${num("remM", s.reminders.minute, "", "мин")}
        </div>
        ${ro ? "" : '<button class="btn" id="sSave">Сохранить настройки</button>'}
      </form>

      <div class="section-title"><h2>Контракты по особой цене</h2></div>
      <div class="list">${st.directions.map((d) => `<div class="item" data-dir="${d.id}"><input class="inp" value="${esc(d.name)}" data-f="name" ${dis} style="flex:1;min-width:0;background:transparent;border:0;color:var(--text);font:600 15px Onest,sans-serif"><input class="inp" value="${d.price}" data-f="price" inputmode="numeric" ${dis} style="width:100px;text-align:right;background:var(--card2);border:0;border-radius:10px;padding:9px 10px;color:var(--text);font:600 15px Onest,sans-serif"><span class="small muted" style="margin-left:4px">₽</span></div>`).join("")}
        ${ro ? "" : `<div class="item"><input class="inp" id="newDirName" placeholder="Новое направление" style="flex:1;min-width:0;background:transparent;border:0;color:var(--text);font:15px Onest,sans-serif"><input class="inp" id="newDirPrice" placeholder="Цена" inputmode="numeric" style="width:100px;text-align:right;background:var(--card2);border:0;border-radius:10px;padding:9px 10px;color:var(--text);font:600 15px Onest,sans-serif"></div>`}</div>
      <p class="tiny muted" style="margin:0 4px">Строка в отчёте рекрутера с этим названием считается по этой цене, остальные контракты — по базовой.</p>
      ${ro ? "" : '<button class="btn ghost" id="dSave">Сохранить направления</button>'}

      <div class="section-title"><h2>Бонусы</h2></div>
      ${st.rules.map((r) => `<article class="card" data-rule="${r.id}" style="display:flex;flex-direction:column;gap:10px">
        <div class="between"><div><b>${esc(r.name)}</b><div class="tiny muted">${ROLE_PL[r.role]} · за ${r.period === "week" ? "неделю" : "месяц"}${r.kind === "top_metric" ? " · " + (METRIC[r.metric] || "").toLowerCase() : ""}</div></div><button type="button" class="switch" role="switch" aria-checked="${r.enabled}" aria-label="Включён" data-f="enabled" ${dis}></button></div>
        <div class="grid2"><label class="field">Сумма, ₽<input data-f="amount" inputmode="numeric" value="${r.amount}" ${dis}></label>${r.kind === "top_metric" ? `<label class="field">Порог<input data-f="threshold" inputmode="numeric" value="${r.threshold}" ${dis}></label>` : '<div class="field">Режим<span style="height:50px;display:flex;align-items:center;color:var(--text)">Отмечаете вручную</span></div>'}</div>
        <div class="between small"><span class="muted">${r.kind === "manual" ? "Начисляется галочкой в кабинете" : "Начисляется автоматически лучшему; при ничьей"}</span>${r.kind === "top_metric" ? `<select class="input" data-f="split_ties" ${dis} style="height:36px"><option value="1" ${r.split_ties ? "selected" : ""}>делится</option><option value="0" ${r.split_ties ? "" : "selected"}>каждому</option></select>` : ""}</div>
        ${r.kind === "top_metric" ? `<label class="row small" style="gap:8px"><input type="checkbox" data-f="manual" ${dis}> Отмечать вручную вместо автоматического начисления</label>` : `<label class="row small" style="gap:8px"><input type="checkbox" data-f="auto" ${dis} ${r.metric ? "" : "disabled"}> Начислять автоматически лучшему${r.metric ? "" : " (нет показателя)"}</label>`}
        ${ro ? "" : '<button class="btn ghost" data-save-rule style="height:44px">Сохранить</button>'}
      </article>`).join("")}
      ${ro ? "" : '<button class="btn ghost" data-go="#/admin/rule-new">Добавить бонус</button>'}
    `);
    bindCommon();
    if (ro) return;
    document.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = () => b.setAttribute("aria-checked", b.getAttribute("aria-checked") !== "true")));
    document.querySelectorAll("[data-rule] .switch").forEach((b) => (b.onclick = () => b.setAttribute("aria-checked", b.getAttribute("aria-checked") !== "true")));
    const f = $("#sf"), n = (k) => Number(String(f[k].value).replace(/\s/g, ""));
    const on = (k) => f.querySelector(`[data-toggle="${k}"]`).getAttribute("aria-checked") === "true";
    f.onsubmit = async (e) => {
      e.preventDefault();
      const patch = {
        rates: { perForm: n("perForm"), contractBase: n("contractBase") },
        salary: { qualifier: { enabled: on("salQ"), monthly: n("salQAmount") }, recruiter: { enabled: on("salR"), monthly: n("salRAmount") } },
        payoutDays: [n("p1"), n("p2")],
        week: { startDow: n("startDow"), days: n("days"), resultsDow: n("resultsDow"), resultsHour: n("resultsHour") },
        reminders: { hour: n("remH"), minute: n("remM") },
      };
      await act(() => post("/api/v2/admin/settings", patch, "PUT"), "Настройки сохранены");
      A.settings = null;
    };
    $("#dSave").onclick = async () => {
      for (const row of document.querySelectorAll("[data-dir]")) {
        const d = st.directions.find((x) => String(x.id) === row.dataset.dir);
        const name = row.querySelector('[data-f="name"]').value.trim(), price = Number(row.querySelector('[data-f="price"]').value.replace(/\s/g, ""));
        if (name !== d.name || price !== d.price) await act(() => post("/api/v2/admin/directions", { id: d.id, name, price, aliases: name === d.name ? d.aliases : [name], active: d.active }));
      }
      const nn = $("#newDirName").value.trim(), np = Number($("#newDirPrice").value.replace(/\s/g, ""));
      if (nn && np > 0) await act(() => post("/api/v2/admin/directions", { name: nn, price: np, aliases: [nn] }));
      toast("Направления сохранены"); settingsView();
    };
    document.querySelectorAll("[data-save-rule]").forEach((b) => (b.onclick = async () => {
      const card = b.closest("[data-rule]"), r = st.rules.find((x) => String(x.id) === card.dataset.rule);
      const val = (k) => card.querySelector(`[data-f="${k}"]`);
      const next = { ...r, enabled: val("enabled").getAttribute("aria-checked") === "true", amount: Number(val("amount").value.replace(/\s/g, "")) };
      if (val("threshold")) next.threshold = Number(val("threshold").value.replace(/\s/g, ""));
      if (val("split_ties")) next.split_ties = val("split_ties").value === "1";
      if (val("manual") && val("manual").checked) next.kind = "manual";
      if (val("auto") && val("auto").checked) next.kind = "top_metric";
      await act(() => post(`/api/v2/admin/rules/${r.id}`, next, "PUT"), "Бонус сохранён");
      settingsView();
    }));
  }

  async function ruleNew() {
    view(`
      <h1>Новый бонус</h1>
      <form id="rf" class="card" style="display:flex;flex-direction:column;gap:14px" novalidate>
        <label class="field">Название<input name="name" placeholder="Лучший по документам недели"></label>
        <label class="field">Для кого<select class="input" name="role"><option value="qualifier">Квалификаторы</option><option value="recruiter">Рекрутеры</option></select></label>
        <label class="field">Как начисляется<select class="input" name="kind"><option value="top_metric">Автоматически лучшему</option><option value="manual">Отмечаю вручную</option></select></label>
        <label class="field" id="metricF">Показатель<select class="input" name="metric"></select></label>
        <label class="field">Период<select class="input" name="period"><option value="week">Неделя</option><option value="month">Месяц</option></select></label>
        <div class="grid2"><label class="field">Сумма, ₽<input name="amount" inputmode="numeric"></label><label class="field" id="thrF">Порог<input name="threshold" inputmode="numeric" value="0"></label></div>
        <div class="error" id="rErr" role="alert"></div>
        <button class="btn">Создать бонус</button>
      </form>`);
    const f = $("#rf");
    const fill = () => { const m = f.role.value === "recruiter" ? ["contracts", "docs", "vvk"] : ["forms", "calls"]; f.metric.innerHTML = m.map((x) => `<option value="${x}">${METRIC[x]}</option>`).join(""); const auto = f.kind.value === "top_metric"; $("#metricF").style.display = auto ? "" : "none"; $("#thrF").style.display = auto ? "" : "none"; };
    f.role.onchange = fill; f.kind.onchange = fill; fill();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await post("/api/v2/admin/rules", { name: f.name.value, role: f.role.value, kind: f.kind.value, metric: f.kind.value === "top_metric" ? f.metric.value : null, period: f.period.value, amount: Number(f.amount.value.replace(/\s/g, "")), threshold: Number(f.threshold.value || 0), enabled: true });
        toast("Бонус создан"); A.settings = null; history.back();
      } catch (er) { $("#rErr").textContent = er.message; }
    };
  }

  // ───────── Акции и сторис ─────────
  const KIND = { multiplier: "Множитель", threshold: "Порог", contest: "Конкурс", news: "Новость" };
  function promoLine(p) {
    const who = p.role === "all" ? "всем" : ROLE_PL[p.role].toLowerCase();
    if (p.kind === "multiplier") return `×${p.multiplier} к деньгам за отчёт${p.weekdays.length ? " по " + p.weekdays.map((d) => DOW[d]).join(", ") : ""} · ${who}`;
    if (p.kind === "threshold") return `${p.threshold} ${METRIC[p.metric].toLowerCase()} за ${p.period === "week" ? "неделю" : p.period === "month" ? "месяц" : "срок"} → +${rub(p.amount)} · ${who}`;
    if (p.kind === "contest") return `Лучший по «${METRIC[p.metric].toLowerCase()}» → +${rub(p.amount)} · ${who}`;
    return `Новость · ${who}`;
  }
  async function promos() {
    view(`<h1>Акции и сторис</h1><div class="empty">Загружаем…</div>`);
    const d = await api("/api/v2/admin/promos");
    const t = today();
    view(`
      <h1>Акции и сторис</h1>
      ${isOwner() ? '<button class="btn" data-go="#/admin/promo-new">Новая акция или сторис</button>' : ""}
      <div class="section-title"><h2>Акции</h2></div>
      <div class="list">${d.promos.length ? d.promos.map((p) => { const live = p.enabled && p.starts_on <= t && p.ends_on >= t; return `<div class="item"><div class="grow"><div style="font-weight:600">${esc(p.name)} <span class="tiny" style="color:${live ? "var(--good)" : "var(--faint)"}">· ${live ? "идёт" : p.ends_on < t ? "завершена" : p.enabled ? "запланирована" : "выключена"}</span></div><div class="tiny muted">${esc(KIND[p.kind])}: ${esc(promoLine(p))}</div><div class="tiny muted">${human(p.starts_on)} – ${human(p.ends_on)}</div></div>${isOwner() ? `<button class="switch" role="switch" aria-checked="${p.enabled}" aria-label="Акция включена" data-promo="${p.id}"></button>` : ""}</div>`; }).join("") : '<div class="empty">Акций пока нет</div>'}</div>
      <div class="section-title"><h2>Сторис</h2></div>
      <div class="list">${d.stories.length ? d.stories.map((s) => { const live = s.active && s.starts_on <= t && s.ends_on >= t; return `<div class="item" style="${s.active ? "" : "opacity:.5"}"><div class="grow"><div style="font-weight:600">${esc(s.title)}</div><div class="tiny muted">${s.role === "all" ? "Всем" : ROLE_PL[s.role]} · ${human(s.starts_on)} – ${human(s.ends_on)}${live ? " · показывается" : ""}</div></div>${isOwner() && s.active ? `<button class="tiny" style="color:var(--warn);font-weight:700" data-hide="${s.id}">Скрыть</button>` : ""}</div>`; }).join("") : '<div class="empty">Сторис пока нет. Встроенные «Как писать отчёт» и «Когда выплаты» видны всем всегда.</div>'}</div>
    `);
    bindCommon();
    document.querySelectorAll("[data-promo]").forEach((b) => (b.onclick = async () => {
      const p = d.promos.find((x) => String(x.id) === b.dataset.promo);
      const on = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", on);
      await act(() => post("/api/v2/admin/promos", { ...p, enabled: on }), on ? "Акция включена" : "Акция выключена");
    }));
    document.querySelectorAll("[data-hide]").forEach((b) => (b.onclick = async () => { await act(() => api(`/api/v2/admin/stories/${b.dataset.hide}`, { method: "DELETE" }), "Сторис скрыта"); promos(); }));
  }

  async function promoNew() {
    let kind = "multiplier", weekdays = [];
    const t = today();
    view(`
      <h1>Новая акция</h1>
      <div class="seg" role="group" aria-label="Вид акции">${Object.entries(KIND).map(([k, l]) => `<button data-kind="${k}" aria-pressed="${k === kind}">${l}</button>`).join("")}</div>
      <p class="small muted" id="kindHint" style="margin:0 4px"></p>
      <form id="pf" class="card" style="display:flex;flex-direction:column;gap:14px" novalidate>
        <label class="field">Название<input name="name" placeholder="Анкета ×2 в пятницу"></label>
        <label class="field">Для кого<select class="input" name="role"><option value="all">Всем</option><option value="qualifier">Квалификаторам</option><option value="recruiter">Рекрутерам</option></select></label>
        <div data-show="multiplier" style="display:flex;flex-direction:column;gap:14px">
          <label class="field">Множитель<select class="input" name="multiplier"><option value="1.5">×1,5</option><option value="2" selected>×2</option><option value="3">×3</option></select></label>
          <div class="field" style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--muted)">Дни недели (пусто — все дни)<div style="display:flex;gap:6px;flex-wrap:wrap">${DOW.map((d, i) => `<button type="button" class="pill" data-dow="${i}" style="background:var(--card2);color:var(--text);height:36px;padding:0 12px">${d}</button>`).join("")}</div></div>
        </div>
        <div data-show="threshold contest" style="display:flex;flex-direction:column;gap:14px">
          <label class="field">Показатель<select class="input" name="metric"></select></label>
          <div class="grid2"><label class="field">Сумма, ₽<input name="amount" inputmode="numeric" placeholder="3000"></label><label class="field"><span id="thrLabel">Порог</span><input name="threshold" inputmode="numeric" placeholder="30"></label></div>
          <label class="field" data-show="threshold">Считать за<select class="input" name="period"><option value="week">Каждую неделю</option><option value="month">Каждый месяц</option><option value="range">Весь срок акции</option></select></label>
        </div>
        <div class="grid2"><label class="field">С<input type="date" name="starts" value="${t}"></label><label class="field">По<input type="date" name="ends" value="${addDays(t, 13)}"></label></div>
        <div class="item" style="border:0;min-height:44px;padding:0"><span class="grow">Показать сторис на главной</span><button type="button" class="switch" role="switch" aria-checked="true" id="withStory" aria-label="Показать сторис"></button></div>
        <div id="storyF" style="display:flex;flex-direction:column;gap:14px">
          <label class="field">Заголовок сторис — до 40 символов<input name="stitle" maxlength="40" placeholder="Анкета ×2 в пятницу"></label>
          <label class="field">Крупная надпись на плитке<input name="sbig" maxlength="10" placeholder="×2"></label>
          <label class="field">Текст сторис<input name="sbody" placeholder="В эту пятницу каждая подтверждённая анкета считается вдвойне"></label>
          <label class="field">Цвет плитки<select class="input" name="sstyle"><option value="accent">Яркая</option><option value="gold">Тёмная</option><option value="card">Спокойная</option></select></label>
        </div>
        <div class="error" id="pErr" role="alert"></div>
        <button class="btn" id="pBtn">Запустить</button>
      </form>`);
    const f = $("#pf");
    const HINT = { multiplier: "Деньги за подтверждённые отчёты в выбранные дни умножаются. Доплата приходит отдельной строкой.", threshold: "Каждый, кто наберёт порог за период, получает сумму.", contest: "Лучший результат за срок акции получает сумму; при ничьей — делится.", news: "Просто сторис с новостью, на деньги не влияет." };
    const fill = () => {
      document.querySelectorAll("[data-kind]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.kind === kind));
      document.querySelectorAll("[data-show]").forEach((el) => (el.style.display = el.dataset.show.split(" ").includes(kind) ? "flex" : "none"));
      $("#kindHint").textContent = HINT[kind];
      $("#thrLabel").textContent = kind === "contest" ? "Минимум, чтобы победить" : "Порог";
      const role = f.role.value, m = role === "recruiter" ? ["contracts", "docs", "vvk"] : ["forms", "calls"];
      f.metric.innerHTML = m.map((x) => `<option value="${x}">${METRIC[x]}</option>`).join("");
      if (kind === "news") { $("#withStory").setAttribute("aria-checked", "true"); }
      $("#storyF").style.display = $("#withStory").getAttribute("aria-checked") === "true" ? "flex" : "none";
    };
    document.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { kind = b.dataset.kind; haptic(); fill(); }));
    f.role.onchange = fill;
    $("#withStory").onclick = () => { if (kind === "news") return; const el = $("#withStory"); el.setAttribute("aria-checked", el.getAttribute("aria-checked") !== "true"); fill(); };
    document.querySelectorAll("[data-dow]").forEach((b) => (b.onclick = () => { const d = +b.dataset.dow; weekdays = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d]; b.style.background = weekdays.includes(d) ? "var(--accent)" : "var(--card2)"; b.style.color = weekdays.includes(d) ? "var(--on-accent)" : "var(--text)"; }));
    f.name.oninput = () => { if (!f.stitle.dataset.touched) f.stitle.value = f.name.value.slice(0, 40); };
    f.stitle.oninput = () => (f.stitle.dataset.touched = "1");
    fill();
    f.onsubmit = async (e) => {
      e.preventDefault();
      $("#pErr").textContent = ""; $("#pBtn").disabled = true;
      try {
        let promoId = null;
        if (kind !== "news") {
          const p = await post("/api/v2/admin/promos", { name: f.name.value, kind, role: f.role.value, metric: f.metric.value, multiplier: Number(f.multiplier.value), weekdays, amount: Number(String(f.amount.value).replace(/\s/g, "")), threshold: Number(f.threshold.value || 0), period: f.period.value, starts_on: f.starts.value, ends_on: f.ends.value });
          promoId = p.id;
        }
        if ($("#withStory").getAttribute("aria-checked") === "true") {
          await post("/api/v2/admin/stories", { title: f.stitle.value || f.name.value, big: f.sbig.value || null, body: f.sbody.value || null, style: f.sstyle.value, role: f.role.value, promo_id: promoId, starts_on: f.starts.value, ends_on: f.ends.value });
        }
        toast(kind === "news" ? "Сторис опубликована" : "Акция запущена"); haptic("success"); playNotes(SOUND.fanfare);
        location.hash = "#/admin/promos";
      } catch (er) { $("#pErr").textContent = er.message; $("#pBtn").disabled = false; }
    };
  }

  async function render(hash) {
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs || "");
    const parts = path.split("/"); // ["#", "admin", sub, id]
    const sub = parts[2], id = parts[3];
    if (!sub) return home();
    if (sub === "reports") return reports();
    if (sub === "company") return companyView();
    if (sub === "staff") return id ? staffCard(id) : staff();
    if (sub === "grant") return grant(params);
    if (sub === "salary" && id) return salaryView(id, params.get("ps"));
    if (sub === "manual") return manual(id, params);
    if (sub === "analytics") return analytics(params);
    if (sub === "settings") return settingsView();
    if (sub === "rule-new") return ruleNew();
    if (sub === "promos") return promos();
    if (sub === "promo-new") return promoNew();
    return home();
  }

  return { render };
})();
