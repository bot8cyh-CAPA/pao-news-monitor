/* PAO News Monitor - web page.
 * Shows every PAO (even with nothing found), the items found for it,
 * and lets the team mark relevance, set a category and write notes.
 */
(() => {
  "use strict";
  const CFG = window.PAO_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js";
  const SOURCE_LABEL = { website: "Website", google_news: "Google News", newsapi: "NewsAPI", email: "Email", manual: "Added by team", page_watch: "Page watch" };
  const THEME_LABEL = { ai_digital: "AI & digital", talent: "Talent", sustainability: "Sustainability", ethics_standards: "Ethics & standards" };
  const ALL_PERMS = ["tag_items","add_items","edit_briefs","approve_briefs","send_briefs","manage_mailing_list","manage_members"];
  const can = (p) => state.role === "admin" || (state.perms || []).includes(p);
  const RELEVANCE_LABEL = { relevant: "Regional", country: "Country-specific", not_relevant: "Not relevant" };
  const KIND_LABEL = { news: "News", events: "Event", publications: "Publication", articles: "Newsletter / article", leadership: "Leadership change", contact: "Contact change" };
  const GROUP_ORDER = ["Member", "Associate", "Affiliate", "Stakeholder", "Inbox"];
  const GROUP_LABEL = { Member: "Members", Associate: "Associates", Affiliate: "Affiliates", Stakeholder: "Stakeholders", Inbox: "Inbox" };
  const STALE_DAYS = 60;
  const NOTE_FILTER_KEY = "pao-news-filters";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // what kind of email link brought us here (read before Supabase tidies the address bar)
  const LINK = (() => {
    const h = new URLSearchParams(location.hash.replace(/^#/, "")), q = new URLSearchParams(location.search);
    return { type: h.get("type") || q.get("type") || "", error: h.get("error_description") || q.get("error_description") || "" };
  })();
  const state = { paos: [], items: [], health: [], lastRun: null, user: null, loadedSince: undefined, role: "team", perms: [] };
  let db = null;

  // ---------- data layer ----------
  const api = {
    async init() {
      if (DEMO) {
        const res = await fetch("demo-data.json");
        this.demo = await res.json();
        state.user = { email: "demo@example.org" };
        state.role = "admin";
        state.perms = ALL_PERMS.slice();
        return true;
      }
      await loadScript(SUPABASE_JS);
      db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      const { data } = await db.auth.getSession();
      state.user = data.session?.user || null;
      db.auth.onAuthStateChange((event, session) => {
        const had = !!state.user;
        state.user = session?.user || null;
        if (event === "PASSWORD_RECOVERY") setTimeout(() => openPassword("recovery"), 0);
        if (!had && state.user) start();
        if (had && !state.user) showLogin();
      });
      return !!state.user;
    },
    async loadRole() {
      if (DEMO || !state.user) return;
      const { data, error } = await db.rpc("my_role");
      state.role = error ? "team" : (data || "team");   // database not updated yet: everyone is team
      const p = await db.rpc("my_permissions");
      state.perms = !p.error && Array.isArray(p.data) ? p.data      // before update-8: built-in defaults
        : state.role === "admin" ? ALL_PERMS.slice() : state.role === "team" ? ["tag_items", "add_items", "edit_briefs"] : [];
    },
    async signIn(email, password) {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUp(email, password) {
      const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      // an existing account comes back with no identities (and no email is sent)
      return { exists: !data.session && Array.isArray(data.user?.identities) && data.user.identities.length === 0, session: !!data.session };
    },
    async forgot(email) {
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) throw error;
    },
    async setPassword(password) {
      if (DEMO) return;
      const { error } = await db.auth.updateUser({ password });
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
      const BASE = "id,pao_id,source,title,url,published_at,snippet,source_name,language,is_baseline,first_seen_at,relevance,category,notes,reviewed_by,reviewed_at";
      const tries = [BASE + ",kind,ai_summary,ai_themes", BASE + ",kind", BASE];   // newer columns first; older databases fall back
      let cols = tries.shift();
      const items = [];
      for (let from = 0; ; from += 1000) {
        let q = db.from("items").select(cols).order("first_seen_at", { ascending: false }).range(from, from + 999);
        if (sinceIso) q = q.or(`first_seen_at.gte.${sinceIso},published_at.gte.${sinceIso}`);
        const { data, error } = await q;
        if (error && tries.length && /column|schema cache/i.test(error.message)) {  // database not updated yet
          cols = tries.shift(); from -= 1000; continue;
        }
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
      sources: $$("input[name=src]:checked").map((i) => i.value).concat("_seen_pw"),
      kinds: $$("input[name=kind]:checked").map((i) => i.value),
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
    // "page_watch" is new: tick it for people whose saved filters predate it
    if (Array.isArray(f.sources)) $$("input[name=src]").forEach((i) => (i.checked = f.sources.includes(i.value) || (i.value === "page_watch" && !f.sources.includes("_seen_pw"))));
    if (Array.isArray(f.kinds)) $$("input[name=kind]").forEach((i) => (i.checked = f.kinds.includes(i.value)));
    $("#f-baseline").checked = !!f.baseline;
  }
  // what an item is: saved by the collector, or guessed from its address for older items
  function kindOf(it) {
    if (it.kind) return it.kind;
    if (it.source === "page_watch") return "leadership";
    if (it.source === "website" && it.url) {
      let path = it.url;
      try { path = new URL(it.url).pathname; } catch { /* keep */ }
      if (/\/(events?|seminars?|webinars?|conferences?|workshops?|cpd|cpe)(\/|-|_|\b)/i.test(path)) return "events";
      if (/\/(newsletters?|e-?newsletters?|articles?|blogs?|insights?|opinions?|columns?)(\/|-|_|\b)/i.test(path)) return "articles";
      if (/\/(publications?|journals?|magazines?|reports?|library|resources)(\/|-|_|\b)|\.pdf($|\?)/i.test(it.url)) return "publications";
    }
    return "news";
  }
  const kindGroup = (k) => (k === "leadership" || k === "contact" ? "changes" : k);
  const sinceIso = (period) => (period === "all" ? null : new Date(Date.now() - Number(period) * 864e5).toISOString());
  const itemDate = (it) => it.published_at || it.first_seen_at;

  function visible(it, f, since) {
    if (!f.sources.includes(it.source)) return false;
    if (!f.kinds.includes(kindGroup(kindOf(it)))) return false;
    if (it.is_baseline && !f.baseline) return false;
    // in the period = published in it, or newly found by us in it
    if (since && !(itemDate(it) >= since || it.first_seen_at >= since)) return false;
    if (f.status === "hide_not" && it.relevance === "not_relevant") return false;
    if (f.status === "unreviewed" && it.relevance) return false;
    if (f.status === "relevant" && it.relevance !== "relevant") return false;
    if (f.status === "country" && it.relevance !== "country") return false;
    if (f.status === "tagged" && !["relevant", "country"].includes(it.relevance)) return false;
    if (f.status === "not_relevant" && it.relevance !== "not_relevant") return false;
    if (f.q) {
      const hay = `${it.title} ${translations[it.id] || ""} ${it.ai_summary || ""} ${it.snippet || ""} ${it.notes || ""} ${it.category || ""} ${it.source_name || ""}`.toLowerCase();
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
  const FOREIGN_WORDS = /\b(le|la|les|des|du|et|pour|sur|dans|une|aux|au|par|vers|avec|est|el|los|las|del|para|und|der|die|das|dan|yang|untuk)\b/gi;
  function nonEnglish(it) {
    const lang = it.language || state.paos.find((p) => p.id === it.pao_id)?.lang || "";
    if (lang && !lang.startsWith("en")) return true;
    if (/[^\u0000-\u024F\u2000-\u206F\u20A0-\u20CF]/.test(it.title)) return true;   // non-Latin script
    const words = (it.title.match(FOREIGN_WORDS) || []).length;
    return words >= 2 || (words >= 1 && /[\u00C0-\u00FF]/.test(it.title));
  }
  const realSnippet = (it) => (it.snippet && !it.snippet.startsWith("Search: ") && it.source !== "page_watch" ? it.snippet : "");
  // Google News links are Google redirects that its page translator refuses, so translate the text instead
  // ---- headline translation in place (Google Translate) ----
  const TR_KEY = "pao-news-translations";
  const translations = (() => { try { return JSON.parse(localStorage.getItem(TR_KEY) || "{}"); } catch { return {}; } })();
  const showingEnglish = new Set();
  async function translateTitle(it) {
    if (translations[it.id]) return translations[it.id];
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" + encodeURIComponent(it.title);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Google Translate returned " + res.status);
    const data = await res.json();
    const text = (data[0] || []).map((seg) => seg[0]).join("").trim();
    if (!text) throw new Error("no translation returned");
    translations[it.id] = text;
    try {
      const keys = Object.keys(translations);
      if (keys.length > 3000) delete translations[keys[0]];
      localStorage.setItem(TR_KEY, JSON.stringify(translations));
    } catch { /* private mode / storage full: keep in memory only */ }
    return text;
  }
  const shownTitle = (it) => (showingEnglish.has(it.id) && translations[it.id]) || it.title;
  const textTranslateUrl = (it) =>
    `https://translate.google.com/?sl=auto&tl=en&op=translate&text=${encodeURIComponent((it.title + "\n\n" + realSnippet(it)).trim().slice(0, 4000))}`;
  const pageTranslateUrl = (url) => `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(url)}`;
  const canTranslatePage = (it) => it.url && (it.source === "website" || it.source === "page_watch") && !/news\.google\.com/.test(it.url);

  function healthFor(paoId) {
    const rows = state.health.filter((h) => h.pao_id === paoId);
    return ["website", "page_watch", "google_news", "newsapi"].map((src) => {
      const h = rows.find((r) => r.source === src);
      if (!h) return src === "page_watch" ? null : { src, level: "none", text: "not run yet" };
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
    }).filter(Boolean);
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
          ${p.facebook ? `<a class="btn ghost small" target="_blank" rel="noopener" title="Check their Facebook page by hand" href="${esc(p.facebook)}">Facebook</a>` : ""}
          ${can("add_items") ? `<button class="btn ghost small" data-add="${esc(p.id)}" type="button">+ Add item</button>` : ""}
        </div>
      </header>
      ${hs.length ? `<div class="health">${hs.map((h) => `<span class="chip ${h.level}" title="${esc(h.text)}">${esc(SOURCE_LABEL[h.src])}${h.when ? ` · ${ago(h.when)}` : ""}</span>`).join("")}
        ${hs.filter((h) => h.level === "error" || h.level === "warn").map((h) => `<p class="health-note ${h.level}">${esc(SOURCE_LABEL[h.src])}: ${esc(h.text)}</p>`).join("")}</div>` : ""}
      ${items.length ? `<ol class="items">${items.map(card).join("")}</ol>` : `<p class="empty-note">Nothing found in this period.</p>`}
    </section>`;
  }

  function card(it) {
    const ro = can("tag_items") ? "" : " disabled";
    const reviewed = it.reviewed_by ? `<span class="muted small">by ${esc(it.reviewed_by.split("@")[0])} ${ago(it.reviewed_at)}</span>` : "";
    return `<li class="item ${it.relevance || ""}" data-id="${esc(it.id)}">
      <div class="meta">
        <span class="src ${esc(it.source)}">${esc(SOURCE_LABEL[it.source] || it.source)}</span>
        ${kindOf(it) !== "news" ? `<span class="kind ${esc(kindOf(it))}">${esc(KIND_LABEL[kindOf(it)] || kindOf(it))}</span>` : ""}
        ${itemDate(it) ? `<time datetime="${esc(itemDate(it))}">${fmtDate(itemDate(it))}</time>` : ""}
        ${it.source_name ? `<span class="muted">${esc(it.source_name)}</span>` : ""}
        ${it.is_baseline ? `<span class="tag" title="Found on the first scan of this site, may be old">first scan</span>` : ""}
        ${(it.ai_themes || []).filter((t) => THEME_LABEL[t]).map((t) => `<span class="theme" title="Theme tagged by AI">${THEME_LABEL[t]}</span>`).join("")}
      </div>
      <h4${showingEnglish.has(it.id) ? ` title="Original: ${esc(it.title)}"` : ""}>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(shownTitle(it))}</a>` : esc(shownTitle(it))}</h4>
      ${it.ai_summary && nonEnglish(it) && !showingEnglish.has(it.id) ? `<p class="muted small ai-sum" title="One-line summary written by AI for the weekly brief">In English: ${esc(it.ai_summary)}</p>` : ""}
      ${realSnippet(it) ? `<p class="snippet">${esc(it.snippet)}</p>` : ""}
      ${it.source === "page_watch" && it.snippet ? `<p class="snippet diff">${esc(it.snippet)}</p><p class="muted small">Check the page before updating your records - a layout change can look like a new name.</p>` : ""}
      ${it.snippet && it.snippet.startsWith("Search: ") ? `<p class="muted small">Found by ${esc(it.snippet.toLowerCase())}</p>` : ""}
      ${it.source === "email" ? `<button class="link small" data-content="${esc(it.id)}" data-show="Show full email" data-hide="Hide email" type="button">Show full email</button><pre class="full" hidden></pre>` : ""}
      ${it.source === "page_watch" ? `<button class="link small" data-content="${esc(it.id)}" data-show="Show before / now" data-hide="Hide before / now" type="button">Show before / now</button><pre class="full" hidden></pre>` : ""}
      <div class="actions">
        <div class="seg" role="group" aria-label="Relevance">
          <button type="button" data-rel="relevant" aria-pressed="${it.relevance === "relevant"}" title="Matters across Asia-Pacific / to CAPA as a whole"${ro}>Regional</button>
          <button type="button" data-rel="country" aria-pressed="${it.relevance === "country"}" title="Only matters in that country"${ro}>Country-specific</button>
          <button type="button" data-rel="not_relevant" aria-pressed="${it.relevance === "not_relevant"}"${ro}>Not relevant</button>
        </div>
        <input class="cat" list="cats" value="${esc(it.category || "")}" placeholder="Category" aria-label="Category"${ro}>
        <input class="notes" value="${esc(it.notes || "")}" placeholder="Notes" aria-label="Notes"${ro}>
        ${it.source !== "page_watch" ? `<select class="kind-pick" aria-label="Type" title="Type"${ro}>${["news", "events", "publications", "articles"].map((k) => `<option value="${k}"${kindOf(it) === k ? " selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select>` : ""}
        ${nonEnglish(it) ? `<button class="link small" type="button" data-translate="${esc(it.id)}" title="Show the headline in English (Google Translate)">${showingEnglish.has(it.id) ? "Show original" : "Translate"}</button>` : ""}
        ${nonEnglish(it) && canTranslatePage(it) ? `<a class="link small" href="${esc(pageTranslateUrl(it.url))}" target="_blank" rel="noopener" title="Open the whole page translated">Translate page</a>` : ""}
        ${reviewed}
      </div>
    </li>`;
  }

  function renderHeader() {
    const r = state.lastRun;
    $("#last-run").textContent = r ? `Last checked ${ago(r.finished_at)} · ${r.summary?.new ?? 0} new that run` : "Not run yet";
    $("#user").textContent = (state.user?.email || "") + (state.role && state.role !== "team" ? ` (${state.role})` : "");
    document.body.dataset.role = state.role + ":" + state.perms.join(",");
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
    $$("input[name=src], input[name=kind]").forEach((i) => i.addEventListener("change", () => { saveFilters(); render(); }));
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
      const tr = e.target.closest("[data-translate]");
      if (tr) {
        const it = state.items.find((i) => i.id === tr.dataset.translate);
        if (showingEnglish.has(it.id)) { showingEnglish.delete(it.id); return render(); }
        tr.textContent = "Translating…"; tr.disabled = true;
        try {
          await translateTitle(it);
          showingEnglish.add(it.id);
          render();
        } catch (err) {
          // Google refused (rare): fall back to opening Google Translate in a new tab
          tr.textContent = "Translate"; tr.disabled = false;
          toast("Couldn't translate here (" + err.message + ") - opening Google Translate instead", true);
          window.open(textTranslateUrl(it), "_blank", "noopener");
        }
        return;
      }
      const more = e.target.closest("[data-content]");
      if (more) {
        const pre = more.nextElementSibling;
        if (pre.hidden && !pre.textContent) {
          try { pre.textContent = await api.content(more.dataset.content) || "(empty)"; } catch (err) { toast(err.message, true); return; }
        }
        pre.hidden = !pre.hidden;
        more.textContent = pre.hidden ? more.dataset.show : more.dataset.hide;
      }
    });
    $("#main").addEventListener("change", (e) => {
      const el = e.target;
      if (el.matches(".kind-pick")) return save(el.closest(".item").dataset.id, { kind: el.value });
      if (!el.matches(".cat, .notes")) return;
      const id = el.closest(".item").dataset.id;
      const field = el.classList.contains("cat") ? "category" : "notes";
      const val = el.value.trim() || null;
      const it = state.items.find((i) => i.id === id);
      if ((it[field] || null) !== val) save(id, { [field]: val });
    });

    // ---- sign in / first time / forgot password ----
    const HELP = {
      signin: ["Sign in with your work email and password.", "Sign in"],
      signup: ["An admin must have given your email access first. Choose a password; we'll email you once to confirm it's really you.", "Create my password"],
      forgot: ["We'll email you a link to set a new password. (Also use this if you used to sign in with email links and never had a password.)", "Email me a link"],
    };
    let mode = "signin";
    function setMode(m) {
      mode = m;
      $$(".login-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
      $("#login-help").textContent = HELP[m][0];
      $("#login-submit").textContent = HELP[m][1];
      $$("#login-form .pw").forEach((el) => (el.hidden = m === "forgot"));
      $$("#login-form .pw2").forEach((el) => (el.hidden = m !== "signup"));
      $("#login-password").required = m !== "forgot";
      $("#login-password2").required = m === "signup";
      $("#login-password").autocomplete = m === "signup" ? "new-password" : "current-password";
      $("#login-msg").textContent = "";
    }
    $$(".login-tabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#login-msg"), email = $("#login-email").value.trim(), pw = $("#login-password").value;
      if (mode === "signup" && pw !== $("#login-password2").value) { msg.textContent = "The two passwords don't match."; return; }
      msg.textContent = mode === "signin" ? "Signing in…" : "Sending…";
      try {
        if (mode === "signin") {
          await api.signIn(email, pw);
          msg.textContent = "";
        } else if (mode === "signup") {
          const r = await api.signUp(email, pw);
          msg.textContent = r.exists ? "This email already has an account. Sign in, or use Forgot password to set a password."
            : r.session ? "" : "Almost done: check your email and click the confirmation link, then sign in here.";
        } else {
          await api.forgot(email);
          msg.textContent = "If that email has access, a link is on its way. Open it on this device to set your password.";
        }
      } catch (err) {
        const m = err.message || String(err);
        msg.textContent = /invalid login credentials/i.test(m) ? "Wrong email or password. First time here? Use the 'First time here' tab."
          : /email not confirmed/i.test(m) ? "Please click the confirmation link we emailed you first (check spam too)."
          : /not been given access|signups not allowed|not allowed/i.test(m) ? "This email hasn't been given access yet. Ask an admin to add you on the Admin tab."
          : /rate limit|too many/i.test(m) ? "Too many emails sent - please wait a few minutes and try again."
          : "Couldn't do that: " + m;
      }
    });
    if (LINK.error) { $("#login-msg").textContent = "That link didn't work (" + LINK.error.replace(/\+/g, " ") + "). Use Forgot password to get a new one."; }

    // ---- set / change password ----
    $("#password-btn").addEventListener("click", () => openPassword("change"));
    $("#pw-dialog").addEventListener("close", async () => {
      if ($("#pw-dialog").returnValue !== "save") return;
      const f = $("#pw-form");
      if (f.elements.p1.value !== f.elements.p2.value) { toast("The two passwords don't match", true); return openPassword(pwReason); }
      try { await api.setPassword(f.elements.p1.value); toast("Password saved. Next time, sign in with your email and password."); }
      catch (err) { toast("Couldn't save the password: " + err.message, true); openPassword(pwReason); }
    });
  }

  let pwReason = "change";
  function openPassword(reason) {
    pwReason = reason;
    const f = $("#pw-form"); f.reset();
    $("#pw-title").textContent = reason === "change" ? "Change your password" : "Set your password";
    $("#pw-cancel").textContent = reason === "change" ? "Cancel" : "Later";
    if (!$("#pw-dialog").open) $("#pw-dialog").showModal();
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
    const head = ["PAO", "Organisation", "Jurisdiction", "Date", "Type", "Source", "Outlet / sender", "Title", "Title (English)", "Link", "Relevance", "Category", "Notes", "Reviewed by"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [head.map(cell).join(",")].concat(rows.map((it) => {
      const p = paoById.get(it.pao_id);
      return [p.abbr, p.name, p.jurisdiction, (itemDate(it) || "").slice(0, 10), KIND_LABEL[kindOf(it)], SOURCE_LABEL[it.source], it.source_name, it.title, translations[it.id] || "", it.url,
        RELEVANCE_LABEL[it.relevance] || "", it.category, it.notes, it.reviewed_by].map(cell).join(",");
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
    await api.loadRole();
    if (LINK.type === "invite" || LINK.type === "recovery") { openPassword(LINK.type); LINK.type = ""; }
    await reload();
  }

  // keep the sidebar and section jumps clear of the sticky filter bar
  new ResizeObserver(([e]) => {
    const h = Math.ceil(e.target.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--filters-h", h + "px");
  }).observe($(".filters"));

  // shared with manage.js (Members, People, Import)
  window.PAOApp = { api, state, reload, render, toast, esc, get db() { return db; }, DEMO, CFG, kindLabel: KIND_LABEL, can, ALL_PERMS };

  restoreFilters();
  wire();
  api.init().then((signedIn) => (signedIn ? start() : showLogin())).catch((e) => {
    document.body.innerHTML = `<p class="error-box">Couldn't start: ${esc(e.message)}</p>`;
  });
})();
