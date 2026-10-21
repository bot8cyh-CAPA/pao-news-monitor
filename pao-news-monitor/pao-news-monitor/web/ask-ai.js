/* Ask AI - real-time Q&A about one PAO, via a Supabase Edge Function (see supabase/functions/ask-ai). */
(() => {
  "use strict";
  const CFG = window.PAO_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let db, paos = [], threadId = null, messages = [], sending = false;

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  async function boot() {
    if (DEMO) {
      $("#signin-needed").hidden = false;
      $("#signin-needed").innerHTML = "Ask AI needs a live database - it isn't available in demo mode. <a href=\"index.html\">Back to the tracker</a>";
      return;
    }
    await loadScript(SUPABASE_JS);
    db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const { data } = await db.auth.getSession();
    if (!data.session?.user) { $("#signin-needed").hidden = false; return; }
    $("#user").textContent = data.session.user.email;

    const { data: perms, error: permErr } = await db.rpc("my_permissions");
    if (permErr) { $("#not-set-up").hidden = false; return; }
    const { data: role } = await db.rpc("my_role");
    if (role !== "admin" && !(perms || []).includes("ask_ai")) { $("#no-perm").hidden = false; return; }

    const { data: paoRows, error: paoErr } = await db.from("paos").select("id,name,abbr,jurisdiction,grp").eq("active", true).order("sort_order");
    if (paoErr) { $("#not-set-up").hidden = false; return; }
    paos = paoRows || [];
    $("#pao").innerHTML = paos.map((p) => `<option value="${esc(p.id)}">${esc(p.abbr || p.name)}${p.jurisdiction ? ` (${esc(p.jurisdiction)})` : ""}</option>`).join("");

    $("#ask-ai").hidden = false;
    wire();
  }

  function wire() {
    $("#new-chat").addEventListener("click", () => { threadId = null; messages = []; render(); });
    $("#pao").addEventListener("change", () => { threadId = null; messages = []; render(); });
    $("#ask-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (sending) return;
      const q = $("#question").value.trim();
      if (!q) return;
      sending = true;
      $("#ask-btn").disabled = true; $("#ask-btn").textContent = "Asking…";
      messages.push({ role: "user", content: q, at: new Date().toISOString() });
      render();
      $("#question").value = "";
      try {
        const { data, error } = await db.functions.invoke("ask-ai", {
          body: { pao_id: $("#pao").value, thread_id: threadId, question: q },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        threadId = data.thread_id;
        messages.push({ role: "assistant", content: data.answer, cited_item_ids: data.cited_item_ids, model: data.model, at: new Date().toISOString() });
        $("#new-chat").disabled = false;
      } catch (err) {
        messages.push({ role: "error", content: err.message || "Something went wrong." });
      }
      sending = false;
      $("#ask-btn").disabled = false; $("#ask-btn").textContent = "Ask";
      render();
      $("#question").focus();
    });
  }

  function render() {
    $("#thread").innerHTML = messages.map((m) => {
      if (m.role === "user") return `<div class="ai-msg ai-user">${esc(m.content)}</div>`;
      if (m.role === "error") return `<div class="ai-msg ai-error">${esc(m.content)}</div>`;
      const cited = m.cited_item_ids?.length ? `<p class="muted small">Cited ${m.cited_item_ids.length} collected item${m.cited_item_ids.length === 1 ? "" : "s"}.</p>` : "";
      return `<div class="ai-msg ai-assistant">${escMd(m.content)}${cited}</div>`;
    }).join("") || `<p class="empty-note">Ask a question about the selected PAO - e.g. "What's changed recently?" or "What are possible routes of collaboration?"</p>`;
    $("#ask-note").textContent = threadId ? "Replies continue this conversation. Start a new question to begin a fresh one." : "";
    $("#thread").scrollTop = $("#thread").scrollHeight;
  }

  // light markdown: paragraphs, **bold**, and [n] citation markers kept as plain text
  function escMd(s) {
    return esc(s).split(/\n{2,}/).map((p) => `<p>${p.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</p>`).join("");
  }

  boot();
})();
