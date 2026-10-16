/* PAO News Monitor - web page.
 * Shows every PAO (even with nothing found), the items found for it,
 * and lets the team mark relevance, set a category and write notes.
 */
(() => {
  "use strict";
  const CFG = window.PAO_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js";
  const SOURCE_LABEL = { website: "Website", google_news: "Google News", newsapi: "NewsAPI", email: "Email", manual: "Added by team" };
  const GROUP_ORDER = ["Member", "Associate", "Affiliate", "Stakeholder", "Inbox"];
  const GROUP_LABEL = { Member: "Members", Associate: "Associates", Affiliate: "Affiliates", Stakeholder: "Stakeholders", Inbox: "Inbox" };
  const STALE_DAYS = 60;
  const NOTE_FILTER_KEY = "pao-news-filters";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = { paos: [], items: [], health: [], lastRun: null, user: null, loadedSince: undefined };
  let db = null;

  // ---------- data layer ----------
  const api = {
    async init() {
      if (DEMO) {
        const res = await fetch("demo-data.json");
        this.demo = await res.json();
        state.user = { email: "demo@example.org" };
        return true;
      }
      await loadScript(SUPABASE_JS);
      db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      const { data } = await db.auth.getSession();
      state.user = data.session?.user || null;
      db.auth.onAuthStateChange((_e, session) => {
        const had = !!state.user;
        state.user = session?.user || null;
        if (!had && state.user) start();
        if (had && !state.user) showLogin();
      });
      return !!state.user;
    },
    async signIn(email) {
      const { error } = await db.auth.signInWithOtp({
        email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
    },
    async signOut() { if (db) await db.auth.signOut(); },
    async load(sinceIso) {
      if (DEMO) {
        const d = this.demo;
        return { paos: d.paos, health: d.health, lastRun: d.runs.at(-1), items: d.items };
      }
      const [paos, health, runs] = await Promise.all([
        db.from("paos").select("*").eq("active", true).order("sort_order"),
        db.from("source_health").select("*"),
        db.from("runs").select("*").order("id", { ascending: false }).limit(1),
      ]);
      for (const r of [paos, health, runs]) if (r.error) throw r.error;
      const cols = "id,pao_id,source,title,url,published_at,snippet,source_name,language,is_baseline,first_seen_at,relevance,category,notes,reviewed_by,reviewed_at";
      const items = [];
      for (let from = 0; ; from += 1000) {
        let q = db.from("items").select(cols).order("first_seen_at", { ascending: false }).range(from, from + 999);
        if (sinceIso) q = q.or(`first_seen_at.gte.${sinceIso},published_at.gte.${sinceIso}`);
        const { data, error } = await q;
        if (error) throw error;
        items.push(...data);
        if (data.length < 1000) break;
      }
      return { paos: paos.data, health: health.data, lastRun: runs.data[0], items };
    },
    async content(id) {
      if (DEMO) return this.demo.items.find((i) => i.id === id)?.content || "";
      const { data, error } = await db.from("items").select("content").eq("id", id).single();
      if (error) throw error;
      return data.content || "";
    },
    async update(id, patch) {
      if (DEMO) return;
      const { error } = await db.from("items").update(patch).eq("id", id);
      if (error) throw error;
    },
    async insert(row) {
      if (DEMO) return;
      const { error } = await db.from("items").insert(row);
      if (error) throw error;
    },
  };

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  // ---------- filters ----------
  function filters() {
    return {
      period: $("#f-period").value,
      status: $("#f-status").value,
      sources: $$("input[name=src]:checked").map((i) => i.value),
      baseline: $("#f-baseline").checked,
      q: $("#f-search").value.trim().toLowerCase(),
    };
  }
  function saveFilters() {
    try { localStorage.setItem(NOTE_FILTER_KEY, JSON.stringify(filters())); } catch { /* private mode */ }
  }
  function restoreFilters() {
    let f = null;
    try { f = JSON.parse(localStorage.getItem(NOTE_FILTER_KEY) || "null"); } catch { /* ignore */ }
    if (!f) return;
    if (f.period) $("#f-period").value = f.period;
    if (f.status) $("#f-status").value = f.status;
    if (Array.isArray(f.sources)) $$("input[name=src]").forEach((i) => (i.checked = f.sources.includes(i.value)));
    $("#f-baseline").checked = !!f.baseline;
  }
  const sinceIso = (period) => (period === "all" ? null : new Date(Date.now() - Number(period) * 864e5).toISOString());
  const itemDate = (it) => it.published_at || it.first_seen_at;

  function visible(it, f, since) {
    if (!f.sources.includes(it.source)) return false;
    if (it.is_baseline && !f.baseline) return false;
    // in the period = published in it, or newly found by us in it
    if (since && !(itemDate(it) >= since || it.first_seen_at >= since)) return false;
    if (f.status === "hide_not" && it.relevance === "not_relevant") return false;
    if (f.status === "unreviewed" && it.relevance) return false;
    if (f.status === "relevant" && it.relevance !== "relevant") return false;
    if (f.status === "not_relevant" && it.relevance !== "not_relevant") return false;
    if (f.q) {
      const hay = `${it.title} ${it.snippet || ""} ${it.notes || ""} ${it.category || ""} ${it.source_name || ""}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }

  // ---------- formatting ----------
  function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function ago(iso) {
    if (!iso) return "never";
    const m = (Date.now() - new Date(iso)) / 6e4;
    if (m < 60) return `${Math.max(1, Math.round(m))} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} d ago`;
  }
  const nonEnglish = (it) => (it.language && !it.language.startsWith("en")) || /[^\u0000-ɏ -⁯]/.test(it.title);
  const translateUrl = (it) =>
    it.url && it.source !== "email"
      ? `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(it.url)}`
      : `https://translate.google.com/?sl=auto&tl=en&op=translate&text=${encodeURIComponent(it.title + "\n\n" + (it.snippet || ""))}`;

  function healthFor(paoId) {
    const rows = state.health.filter((h) => h.pao_id === paoId);
    return ["website", "google_news", "newsapi"].map((src) => {
      const h = rows.find((r) => r.source === src);
      if (!h) return { src, level: "none", text: "not run yet" };
      let level = h.status === "ok" ? "ok" : h.status === "warning" ? "warn" : h.status === "error" ? "error" : "none";
      let text = h.message || h.status;
      if (src === "website" && h.status !== "skipped" && h.last_success_at) {
        const since = h.last_new_at || h.last_success_at;
        if ((Date.now() - new Date(since)) / 864e5 > STALE_DAYS && level === "ok") {
          level = "warn";
          text = `No new links for ${STALE_DAYS}+ days - check the site still works. ${text}`;
        }
      }
      if (h.status === "error" && h.consecutive_failures > 1) text = `Failed ${h.consecutive_failures} runs in a row. ${text}`;
      return { src, level, text, when: h.last_run_at };
    });
  }
  function worstLevel(hs) {
    for (const l of ["error", "warn", "ok"]) if (hs.some((h) => h.level === l)) return l;
    return "none";
  }

  // ---------- rendering ----------
  function render() {
    const f = filters();
    const since = sinceIso(f.period);
    const byPao = new Map(state.paos.map((p) => [p.id, []]));
    for (const it of state.items) if (byPao.has(it.pao_id) && visible(it, f, since)) byPao.get(it.pao_id).push(it);
    for (const list of byPao.values()) list.sort((a, b) => (itemDate(b) || "").localeCompare(itemDate(a) || ""));

    const groups = GROUP_ORDER.map((g) => ({ g, paos: state.paos.filter((p) => (p.grp || "Member") === g) }))
      .filter((x) => x.paos.length);

    // sidebar + mobile jump list
    $("#sidebar").innerHTML = groups.map(({ g, paos }) => `
      <div class="side-group"><h2>${esc(GROUP_LABEL[g] || g)}</h2><ul>${paos.map((p) => {
        const items = byPao.get(p.id);
        const unrev = items.filter((i) => !i.relevance).length;
        const lvl = p.id === "_unmatched_email" ? "none" : worstLevel(healthFor(p.id));
        return `<li><a href="#pao-${esc(p.id)}" class="${items.length ? "" : "empty"}">
          <span class="dot ${lvl}" title="${lvl === "error" ? "A source failed" : lvl === "warn" ? "Needs a look" : ""}"></span>
          <span class="side-name">${esc(p.abbr || p.name)}</span>
          ${items.length ? `<span class="count${unrev ? " unrev" : ""}" title="${unrev} unreviewed of ${items.length}">${unrev || items.length}</span>` : ""}
        </a></li>`;
      }).join("")}</ul></div>`).join("");
    $("#jump").innerHTML = `<option value="">Jump to PAO…</option>` + groups.map(({ g, paos }) =>
      `<optgroup label="${esc(GROUP_LABEL[g] || g)}">${paos.map((p) => `<option value="${esc(p.id)}">${esc(p.abbr || p.name)} (${byPao.get(p.id).length})</option>`).join("")}</optgroup>`).join("");

    // main sections - every PAO, even with nothing found
    const total = [...byPao.values()].reduce((n, l) => n + l.length, 0);
    const withNews = [...byPao.values()].filter((l) => l.length).length;
    const cats = [...new Set((CFG.CATEGORIES || []).concat(state.items.map((i) => i.category).filter(Boolean)))];
    $("#main").innerHTML = `<datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>` +
      `<p class="summary">${total} item${total === 1 ? "" : "s"} across ${withNews} of ${state.paos.length} organisations</p>` +
      groups.map(({ g, paos }) => `<h2 class="group-title">${esc(GROUP_LABEL[g] || g)}</h2>` + paos.map((p) => section(p, byPao.get(p.id))).join("")).join("");
  }

  function section(p, items) {
    const isInbox = p.id === "_unmatched_email";
    const hs = isInbox ? [] : healthFor(p.id);
    const searchName = encodeURIComponent(p.name);
    return `<section class="pao" id="pao-${esc(p.id)}">
      <header class="pao-head">
        <div>
          <h3>${p.abbr && p.abbr !== p.name ? `${esc(p.abbr)}<span class="pao-name">${esc(p.name)}</span>` : esc(p.name)}</h3>
          <p class="muted small">${esc(p.jurisdiction || "")}${p.website ? ` · <a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : ""}${p.notes ? ` · ${esc(p.notes)}` : ""}</p>
        </div>
        <div class="pao-tools">
          ${isInbox ? "" : `<a class="btn ghost small" target="_blank" rel="noopener" title="Check LinkedIn by hand" href="https://www.linkedin.com/search/results/content/?keywords=${searchName}&sortBy=%22date_posted%22">LinkedIn</a>`}
          <button class="btn ghost small" data-add="${esc(p.id)}" type="button">+ Add item</button>
        </div>
      </header>
      ${hs.length ? `<div class="health">${hs.map((h) => `<span class="chip ${h.level}" title="${esc(h.text)}">${esc(SOURCE_LABEL[h.src])}${h.when ? ` · ${ago(h.when)}` : ""}</span>`).join("")}
        ${hs.filter((h) => h.level === "error" || h.level === "warn").map((h) => `<p class="health-note ${h.level}">${esc(SOURCE_LABEL[h.src])}: ${esc(h.text)}</p>`).join("")}</div>` : ""}
      ${items.length ? `<ol class="items">${items.map(card).join("")}</ol>` : `<p class="empty-note">Nothing found in this period.</p>`}
    </section>`;
  }

  function card(it) {
    const reviewed = it.reviewed_by ? `<span class="muted small">by ${esc(it.reviewed_by.split("@")[0])} ${ago(it.reviewed_at)}</span>` : "";
    return `<li class="item ${it.relevance || ""}" data-id="${esc(it.id)}">
      <div class="meta">
        <span class="src ${esc(it.source)}">${esc(SOURCE_LABEL[it.source] || it.source)}</span>
        ${itemDate(it) ? `<time datetime="${esc(itemDate(it))}">${fmtDate(itemDate(it))}</time>` : ""}
        ${it.source_name ? `<span class="muted">${esc(it.source_name)}</span>` : ""}
        ${it.is_baseline ? `<span class="tag" title="Found on the first scan of this site, may be old">first scan</span>` : ""}
      </div>
      <h4>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}</h4>
      ${it.snippet && !it.snippet.startsWith("Search: ") ? `<p class="snippet">${esc(it.snippet)}</p>` : ""}
      ${it.snippet && it.snippet.startsWith("Search: ") ? `<p class="muted small">Found by ${esc(it.snippet.toLowerCase())}</p>` : ""}
      ${it.source === "email" ? `<button class="link small" data-content="${esc(it.id)}" type="button">Show full email</button><pre class="full" hidden></pre>` : ""}
      <div class="actions">
        <div class="seg" role="group" aria-label="Relevance">
          <button type="button" data-rel="relevant" aria-pressed="${it.relevance === "relevant"}">Relevant</button>
          <button type="button" data-rel="not_relevant" aria-pressed="${it.relevance === "not_relevant"}">Not relevant</button>
        </div>
        <input class="cat" list="cats" value="${esc(it.category || "")}" placeholder="Category" aria-label="Category">
        <input class="notes" value="${esc(it.notes || "")}" placeholder="Notes" aria-label="Notes">
        ${nonEnglish(it) ? `<a class="link small" href="${esc(translateUrl(it))}" target="_blank" rel="noopener">Translate</a>` : ""}
        ${reviewed}
      </div>
    </li>`;
  }

  function renderHeader() {
    const r = state.lastRun;
    $("#last-run").textContent = r ? `Last checked ${ago(r.finished_at)} · ${r.summary?.new ?? 0} new that run` : "Not run yet";
    $("#user").textContent = state.user?.email || "";
    const inbox = state.health.find((h) => h.pao_id === "_inbox" && h.source === "email");
    const el = $("#inbox-status");
    if (!inbox) { el.hidden = true; return; }
    el.hidden = false;
    el.className = "chip " + (inbox.status === "ok" ? "ok" : inbox.status === "error" ? "error" : "none");
    el.textContent = inbox.status === "error" ? "Inbox: failed" : inbox.status === "skipped" ? "Inbox: off" : "Inbox: ok";
    el.title = inbox.message || "";
  }

  // ---------- actions ----------
  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
  }

  async function save(id, patch) {
    const it = state.items.find((i) => i.id === id);
    const before = { ...it };
    Object.assign(patch, { reviewed_by: state.user?.email || null, reviewed_at: new Date().toISOString() });
    Object.assign(it, patch);
    try { await api.update(id, patch); }
    catch (e) { Object.assign(it, before); toast("Couldn't save: " + e.message, true); }
    render();
  }

  async function reload() {
    const f = filters();
    const since = sinceIso(f.period);
    // only refetch from the server when we need older items than we have
    $("#main").innerHTML = `<p class="summary">Loading…</p>`;
    try {
      const data = await api.load(since);
      Object.assign(state, data, { loadedSince: since });
      renderHeader(); render();
    } catch (e) {
      $("#main").innerHTML = `<p class="error-box">Couldn't load data: ${esc(e.message)}</p>`;
    }
  }

  function wire() {
    $("#f-period").addEventListener("change", () => {
      saveFilters();
      const since = sinceIso($("#f-period").value);
      const needMore = state.loadedSince && (!since || since < state.loadedSince);
      needMore ? reload() : render();
    });
    for (const el of ["#f-status", "#f-baseline"]) $(el).addEventListener("change", () => { saveFilters(); render(); });
    $$("input[name=src]").forEach((i) => i.addEventListener("change", () => { saveFilters(); render(); }));
    let typing; $("#f-search").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(render, 200); });
    $("#jump").addEventListener("change", (e) => { if (e.target.value) location.hash = "pao-" + e.target.value; e.target.value = ""; });
    $("#refresh").addEventListener("click", reload);
    $("#export").addEventListener("click", exportCsv);
    $("#signout").addEventListener("click", async () => { await api.signOut(); if (DEMO) toast("Demo mode - nothing to sign out of"); });

    $("#main").addEventListener("click", async (e) => {
      const rel = e.target.closest("[data-rel]");
      if (rel) {
        const id = rel.closest(".item").dataset.id;
        const it = state.items.find((i) => i.id === id);
        return save(id, { relevance: it.relevance === rel.dataset.rel ? null : rel.dataset.rel });
      }
      const add = e.target.closest("[data-add]");
      if (add) return openAdd(add.dataset.add);
      const more = e.target.closest("[data-content]");
      if (more) {
        const pre = more.nextElementSibling;
        if (pre.hidden && !pre.textContent) {
          try { pre.textContent = await api.content(more.dataset.content) || "(empty)"; } catch (err) { toast(err.message, true); return; }
        }
        pre.hidden = !pre.hidden;
        more.textContent = pre.hidden ? "Show full email" : "Hide email";
      }
    });
    $("#main").addEventListener("change", (e) => {
      const el = e.target;
      if (!el.matches(".cat, .notes")) return;
      const id = el.closest(".item").dataset.id;
      const field = el.classList.contains("cat") ? "category" : "notes";
      const val = el.value.trim() || null;
      const it = state.items.find((i) => i.id === id);
      if ((it[field] || null) !== val) save(id, { [field]: val });
    });

    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#login-msg");
      msg.textContent = "Sending…";
      try {
        await api.signIn($("#login-email").value.trim());
        msg.textContent = "Check your email for the sign-in link.";
      } catch (err) {
        msg.textContent = /signups not allowed|not found/i.test(err.message)
          ? "This email hasn't been invited yet. Ask the admin to invite you in Supabase."
          : "Couldn't send: " + err.message;
      }
    });
  }

  let addFor = null;
  function openAdd(paoId) {
    addFor = paoId;
    const p = state.paos.find((x) => x.id === paoId);
    $("#add-pao-name").textContent = p.abbr || p.name;
    $("#add-form").reset();
    $("#add-dialog").showModal();
  }
  $("#add-dialog").addEventListener("close", async () => {
    if ($("#add-dialog").returnValue !== "save" || !addFor) return;
    const fd = new FormData($("#add-form"));
    const now = new Date().toISOString();
    const row = {
      id: "manual-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
      pao_id: addFor, source: "manual", title: fd.get("title").trim(), url: fd.get("url").trim() || null,
      published_at: fd.get("date") ? new Date(fd.get("date") + "T00:00:00Z").toISOString() : null,
      notes: fd.get("notes").trim() || null, source_name: state.user?.email || "", first_seen_at: now, is_baseline: false,
    };
    try {
      await api.insert(row);
      state.items.unshift({ ...row, relevance: null, category: null });
      render(); toast("Added");
    } catch (e) { toast("Couldn't add: " + e.message, true); }
  });

  function exportCsv() {
    const f = filters(); const since = sinceIso(f.period);
    const paoById = new Map(state.paos.map((p) => [p.id, p]));
    const rows = state.items.filter((it) => paoById.has(it.pao_id) && visible(it, f, since))
      .sort((a, b) => (paoById.get(a.pao_id).sort_order - paoById.get(b.pao_id).sort_order) || (itemDate(b) || "").localeCompare(itemDate(a) || ""));
    const head = ["PAO", "Organisation", "Jurisdiction", "Date", "Source", "Outlet / sender", "Title", "Link", "Relevance", "Category", "Notes", "Reviewed by"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [head.map(cell).join(",")].concat(rows.map((it) => {
      const p = paoById.get(it.pao_id);
      return [p.abbr, p.name, p.jurisdiction, (itemDate(it) || "").slice(0, 10), SOURCE_LABEL[it.source], it.source_name, it.title, it.url,
        it.relevance === "relevant" ? "Relevant" : it.relevance === "not_relevant" ? "Not relevant" : "", it.category, it.notes, it.reviewed_by].map(cell).join(",");
    }));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pao-news-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Exported ${rows.length} item${rows.length === 1 ? "" : "s"} (what's on screen now)`);
  }

  // ---------- start ----------
  function showLogin() { $("#app").hidden = true; $("#login").hidden = false; }
  async function start() {
    $("#login").hidden = true; $("#app").hidden = false;
    $("#demo-banner").hidden = !DEMO;
    await reload();
  }

  // keep the sidebar and section jumps clear of the sticky filter bar
  new ResizeObserver(([e]) => {
    const h = Math.ceil(e.target.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--filters-h", h + "px");
  }).observe($(".filters"));

  restoreFilters();
  wire();
  api.init().then((signedIn) => (signedIn ? start() : showLogin())).catch((e) => {
    document.body.innerHTML = `<p class="error-box">Couldn't start: ${esc(e.message)}</p>`;
  });
})();
