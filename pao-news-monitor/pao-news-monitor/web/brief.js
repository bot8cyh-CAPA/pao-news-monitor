/* Weekly brief page: list of briefs, read, edit (team), approve (admin), copy for Outlook, download Word. */
(() => {
  "use strict";
  const A = window.PAOApp;
  if (!A) return;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = A.esc;
  let briefs = [], current = null, editing = false;

  const canEdit = () => A.state.role === "admin" || A.state.role === "team";
  const isAdmin = () => A.state.role === "admin";
  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

  // ---------- safe Markdown -> HTML (everything is escaped first) ----------
  function inline(text, sources) {
    let h = esc(text);
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
    h = h.replace(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})+)\]/g, (m, list) => list.split(/[,;]/).map((n) => `[${n.trim()}]`).join(""));  // [3, 5] -> [3][5]
    h = h.replace(/\[(\d{1,3})\]/g, (m, n) => {
      const s = sources[n];
      return s && s.url ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.pao + ": " + s.title)}">[${n}]</a>`
        : `<span class="cite" title="${s ? esc(s.pao + ": " + s.title) : ""}">[${n}]</span>`;
    });
    h = h.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (m, sp, url) => `${sp}<a href="${url}" target="_blank" rel="noopener">${url.length > 70 ? url.slice(0, 67) + "…" : url}</a>`);
    return h;
  }
  function render(md, sourceList) {
    const sources = {};
    for (const s of sourceList || []) sources[s.n] = s;
    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "), sources)}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
    for (const raw of (md || "").split("\n")) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const lv = Math.min(4, m[1].length + 1); out.push(`<h${lv}>${inline(m[2], sources)}</h${lv}>`); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); (list ||= []).push(`<li>${inline(m[1], sources)}</li>`); continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1], sources)}</blockquote>`); continue; }
      if ((m = line.match(/^\[(\d+)\]\s+(.*)$/))) { flushPara(); (list ||= []).push(`<li class="src-line">${inline(`[${m[1]}] ` + m[2], sources)}</li>`); continue; }
      flushList(); para.push(line.trim());
    }
    flushPara(); flushList();
    return out.join("\n");
  }

  // ---------- data ----------
  async function load() {
    if (A.DEMO) { briefs = (A.api.demo?.briefs || []).slice(); return; }
    const { data, error } = await A.db.from("briefs").select("*").order("created_at", { ascending: false }).limit(52);
    if (error) throw error;
    briefs = data;
  }

  // ---------- view ----------
  function open() {
    for (const sel of [".filters", ".layout", "#admin-view"]) document.querySelector(sel).hidden = true;
    $("#brief-view").hidden = false;
    window.scrollTo(0, 0);
    $("#brief-list").innerHTML = "<li class='muted'>Loading…</li>";
    load().then(() => { current = current && briefs.find((b) => b.id === current.id) || briefs[0] || null; editing = false; draw(); })
      .catch((e) => {
        $("#brief-list").innerHTML = "";
        $("#brief-body").innerHTML = `<p class="error-box">${esc(/briefs|schema cache|does not exist/i.test(e.message)
          ? "The database needs updating: paste supabase/update-4.sql into Supabase > SQL Editor and Run." : e.message)}</p>`;
      });
  }
  function close() {
    $("#brief-view").hidden = true;
    document.querySelector(".filters").hidden = false;
    document.querySelector(".layout").hidden = false;
  }
  function draw() {
    $("#brief-list").innerHTML = briefs.length ? briefs.map((b) => `<li><button type="button" data-brief="${b.id}" class="${current && b.id === current.id ? "active" : ""}">
        <span>${fmt(b.period_start)} – ${fmt(b.period_end)}</span>
        <span class="brief-status ${b.status}">${b.status === "approved" ? "Approved" : "Draft"}</span></button></li>`).join("")
      : `<li class="muted small">No briefs yet. The first one is written on Monday morning, or run it now: GitHub → Actions → Weekly brief → Run workflow.</li>`;
    const t = $("#brief-tools"), body = $("#brief-body");
    if (!current) { t.innerHTML = ""; body.innerHTML = ""; return; }
    const meta = `<p class="muted small">Written ${new Date(current.created_at).toLocaleString()} by ${esc(current.models_used || "?")}
      · ${current.stats?.items ?? "?"} items this week${current.edited_by ? ` · edited by ${esc(current.edited_by)} ${fmt(current.edited_at)}` : ""}
      ${current.status === "approved" ? ` · <b>approved</b> by ${esc(current.approved_by || "")} ${fmt(current.approved_at)}` : ""}
      ${current.sent_at ? ` · <b>sent</b> to ${current.sent_to ?? "?"} people by ${esc(current.sent_by || "")} ${fmt(current.sent_at)}` : ""}</p>
      ${current.send_requested_at && !current.sent_at ? `<p class="send-state">Sending: queued by ${esc(current.send_requested_by || "")} at ${new Date(current.send_requested_at).toLocaleTimeString()}. It goes out within about 10 minutes - refresh to check.</p>` : ""}
      ${current.send_error ? `<p class="send-state bad">Sending failed: ${esc(current.send_error)}. Fix it and press Send to mailing list again.</p>` : ""}`;
    if (editing) {
      t.innerHTML = `<button class="btn primary" id="brief-save" type="button">Save</button><button class="btn ghost" id="brief-cancel" type="button">Cancel</button>`;
      body.innerHTML = meta + `<p class="muted small">Plain text with simple formatting: <code>## Heading</code>, <code>- bullet</code>, <code>**bold**</code>. Keep the [n] numbers - they link to the sources.</p>
        <textarea id="brief-text" spellcheck="true">${esc(current.content || "")}</textarea>`;
      return;
    }
    t.innerHTML = [
      canEdit() ? `<button class="btn" id="brief-edit" type="button">Edit</button>` : "",
      isAdmin() ? `<button class="btn ${current.status === "approved" ? "ghost" : "primary"}" id="brief-approve" type="button">${current.status === "approved" ? "Back to draft" : "Approve"}</button>` : "",
      isAdmin() && current.status === "approved" && current.send_requested_at && !current.sent_at
        ? `<button class="btn" id="brief-cancel-send" type="button">Cancel sending</button>`
        : isAdmin() && current.status === "approved" ? `<button class="btn primary" id="brief-send" type="button">${current.sent_at ? "Send again…" : "Send to mailing list…"}</button>` : "",
      `<button class="btn ghost" id="brief-copy" type="button" title="Copy with formatting, then paste into an Outlook email">Copy for email</button>`,
      `<button class="btn ghost" id="brief-word" type="button">Download Word</button>`,
    ].join("");
    body.innerHTML = meta + `<article class="brief-doc" id="brief-doc">${render(current.content, current.sources)}</article>`;
  }

  // ---------- actions ----------
  async function save() {
    const content = $("#brief-text").value;
    const patch = { content, edited_by: A.state.user?.email || null, edited_at: new Date().toISOString() };
    try {
      if (!A.DEMO) { const { error } = await A.db.from("briefs").update(patch).eq("id", current.id); if (error) throw error; }
      Object.assign(current, patch); editing = false; draw(); A.toast("Saved");
    } catch (e) { A.toast("Couldn't save: " + e.message, true); }
  }
  async function approve() {
    const next = current.status === "approved" ? "draft" : "approved";
    if (next === "approved" && !confirm("Approve this brief? Do this once you've checked the facts against the sources.")) return;
    try {
      if (!A.DEMO) { const { error } = await A.db.rpc("set_brief_status", { brief_id: current.id, new_status: next }); if (error) throw error; }
      Object.assign(current, { status: next, approved_by: next === "approved" ? A.state.user?.email : null, approved_at: next === "approved" ? new Date().toISOString() : null });
      draw(); A.toast(next === "approved" ? "Approved" : "Back to draft");
    } catch (e) { A.toast("Couldn't change: " + e.message, true); }
  }
  const DOC_CSS = "body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}h1{font-size:18pt}h2{font-size:14pt;margin-top:14pt}" +
    "h3{font-size:12pt}blockquote{color:#555;border-left:3px solid #ccc;margin:0;padding-left:8px}a{color:#0e5a57}li{margin:2pt 0}";
  // the "draft written by AI - please review" banner is for staff, not recipients
  function forRecipients() {
    const doc = $("#brief-doc").cloneNode(true);
    doc.querySelectorAll("blockquote").forEach((q) => { if (/Draft written by AI|No AI model was available/.test(q.textContent)) q.remove(); });
    doc.insertAdjacentHTML("beforeend", '<p style="font-size:9pt;color:#777">This briefing was prepared with AI assistance from public sources and reviewed by CAPA staff.</p>');
    return doc;
  }
  async function copy() {
    const doc = forRecipients();
    const html = doc.innerHTML;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([`<div style="font-family:Calibri,Arial,sans-serif">${html}</div>`], { type: "text/html" }),
        "text/plain": new Blob([doc.innerText], { type: "text/plain" }),
      })]);
      A.toast("Copied - paste into a new Outlook email (Ctrl+V)");
    } catch {
      const r = document.createRange(); r.selectNodeContents($("#brief-doc"));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      A.toast("Selected - press Ctrl+C, then paste into Outlook");
    }
  }
  function word() {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>${DOC_CSS}</style></head><body>${$("#brief-doc").innerHTML}</body></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + html], { type: "application/msword" }));
    a.download = `CAPA-weekly-brief-${(current.period_end || "").slice(0, 10)}.doc`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ---------- send to mailing list (from the user's own Outlook, everyone in BCC) ----------
  let sendList = [];
  const subject = () => `CAPA weekly intelligence brief: ${fmt(current.period_start)} – ${fmt(current.period_end)}`;
  async function openSend() {
    try { sendList = (await A.loadMailingList()).filter((m) => m.active).map((m) => m.email); }
    catch (e) { return A.toast(/mailing_list|schema cache|does not exist/i.test(e.message) ? "Database needs updating: run supabase/update-5.sql" : e.message, true); }
    if (!sendList.length) return A.toast("The mailing list is empty - add people on the Admin tab first", true);
    const bcc = sendList.join(";"), subj = encodeURIComponent(subject());
    const owa = `https://outlook.office.com/mail/deeplink/compose?bcc=${encodeURIComponent(bcc)}&subject=${subj}`;
    const mailto = `mailto:?bcc=${encodeURIComponent(sendList.join(","))}&subject=${subj}`;
    const tooLong = owa.length > 1900;
    $("#send-summary").innerHTML = `To <b>${sendList.length}</b> ${sendList.length === 1 ? "person" : "people"} on the mailing list. Subject: <i>${esc(subject())}</i>`
      + (current.sent_at ? `<br><span class="warn-text">Already sent ${fmt(current.sent_at)} by ${esc(current.sent_by || "")}.</span>` : "");
    $("#send-owa").href = tooLong ? `https://outlook.office.com/mail/deeplink/compose?subject=${subj}` : owa;
    $("#send-mailto").href = tooLong ? `mailto:?subject=${subj}` : mailto;
    $("#send-long").hidden = !tooLong;
    $("#send-dialog").showModal();
  }
  async function sendNow() {
    if (current.sent_at && !confirm(`This brief was already sent ${fmt(current.sent_at)}. Send it again to everyone?`)) return;
    try {
      if (!A.DEMO) { const { error } = await A.db.rpc("request_brief_send", { brief_id: current.id }); if (error) throw error; }
      Object.assign(current, { send_requested_at: new Date().toISOString(), send_requested_by: A.state.user?.email, send_error: null, sent_at: null });
      $("#send-dialog").close(); draw(); A.toast("Queued - it will be emailed within about 10 minutes");
    } catch (e) {
      A.toast(/request_brief_send|schema cache|does not exist/i.test(e.message) ? "Database needs updating: run supabase/update-6.sql" : "Couldn't send: " + e.message, true);
    }
  }
  async function cancelSend() {
    try {
      if (!A.DEMO) { const { error } = await A.db.rpc("cancel_brief_send", { brief_id: current.id }); if (error) throw error; }
      Object.assign(current, { send_requested_at: null, send_requested_by: null }); draw(); A.toast("Sending cancelled");
    } catch (e) { A.toast("Couldn't cancel: " + e.message, true); }
  }
  $("#send-now").addEventListener("click", sendNow);
  $("#send-copy").addEventListener("click", copy);
  $("#send-copy-bcc").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(sendList.join("; ")); A.toast("Addresses copied - paste into BCC"); }
    catch { prompt("Copy these addresses into BCC:", sendList.join("; ")); }
  });
  $("#send-done").addEventListener("click", async () => {
    try {
      if (!A.DEMO) { const { error } = await A.db.rpc("mark_brief_sent", { brief_id: current.id, recipients: sendList.length }); if (error) throw error; }
      Object.assign(current, { sent_at: new Date().toISOString(), sent_by: A.state.user?.email, sent_to: sendList.length });
      $("#send-dialog").close(); draw(); A.toast("Recorded as sent");
    } catch (e) { A.toast("Couldn't record: " + e.message, true); }
  });
  $("#send-close").addEventListener("click", () => $("#send-dialog").close());

  $("#brief-btn").addEventListener("click", open);
  $("#brief-back").addEventListener("click", close);
  $("#brief-view").addEventListener("click", (e) => {
    const b = e.target.closest("[data-brief]");
    if (b) {
      if (editing && !confirm("Discard your unsaved changes?")) return;
      current = briefs.find((x) => String(x.id) === b.dataset.brief); editing = false; return draw();
    }
    const id = e.target.id;
    if (id === "brief-edit") { editing = true; draw(); $("#brief-text").focus(); }
    else if (id === "brief-cancel") { editing = false; draw(); }
    else if (id === "brief-save") save();
    else if (id === "brief-approve") approve();
    else if (id === "brief-copy") copy();
    else if (id === "brief-word") word();
    else if (id === "brief-send") openSend();
    else if (id === "brief-cancel-send") cancelSend();
  });
  // leaving other views closes this one
  for (const sel of ["#admin-btn"]) document.querySelector(sel)?.addEventListener("click", () => { $("#brief-view").hidden = true; });
  A.renderBrief = render;   // for tests
})();
