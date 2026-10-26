/* Ask AI - real-time Q&A about one PAO or the whole region, via a Supabase Edge Function (see supabase/functions/ask-ai). */
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
    $("#pao").innerHTML = `<option value="_region">Whole region (all PAOs)</option>` + paos.map((p) => `<option value="${esc(p.id)}">${esc(p.abbr || p.name)}${p.jurisdiction ? ` (${esc(p.jurisdiction)})` : ""}</option>`).join("");

    $("#pao").value = paos[0]?.id || "_region";   // a single PAO first, as before
    placeholder();
    $("#ask-ai").hidden = false;
    wire();
  }

  function wire() {
    $("#new-chat").addEventListener("click", () => { threadId = null; messages = []; render(); });
    $("#pao").addEventListener("change", () => { threadId = null; messages = []; placeholder(); render(); });
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
        // never spin forever: give up after 2 minutes with a clear message
        const timeout = new Promise((_, fail) => setTimeout(() => fail(new Error("No answer after 2 minutes - the AI services may be busy. Please try again.")), 120_000));
        const { data, error } = await Promise.race([
          db.functions.invoke("ask-ai", { body: { pao_id: $("#pao").value, thread_id: threadId, question: q } }),
          timeout,
        ]);
        if (error) {
          // The function sends back a readable reason (e.g. "AI providers all failed"); show that, not the generic wrapper.
          let detail = "";
          try { detail = (await error.context.json()).error || ""; } catch { /* no readable body */ }
          throw new Error(detail || error.message);
        }
        if (data?.error) throw new Error(data.error);
        threadId = data.thread_id;
        messages.push({ role: "assistant", content: data.answer, cited_item_ids: data.cited_item_ids, sources: data.sources || [], model: data.model, at: new Date().toISOString() });
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
      const n = m.cited_item_ids?.length || 0;
      const meta = [n ? `Cited ${n} collected item${n === 1 ? "" : "s"}` : "", m.model ? `answered by ${m.model}` : ""].filter(Boolean).join(" · ");
      const cited = meta ? `<p class="muted small">${esc(meta)}</p>` : "";
      return `<div class="ai-msg ai-assistant">${escMd(m.content, m.sources)}${sourcesList(m.sources)}${cited}</div>`;
    }).join("") || `<p class="empty-note">Ask a question about the selected PAO - e.g. "What's changed recently?" or "What are possible routes of collaboration?"</p>`;
    $("#ask-note").textContent = threadId ? "Replies continue this conversation. Start a new question to begin a fresh one." : "";
    // bring the newest message into view from its top, so a long answer is read from the start
    const last = $("#thread").lastElementChild;
    if (last && messages.length) last.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Only ever link to http(s) addresses - never javascript: or other schemes.
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

  // Sources list under an answer: every article the AI cited, numbered as in the text.
  function placeholder() {
    $("#question").placeholder = $("#pao").value === "_region"
      ? "e.g. How are PAOs across the region approaching AI adoption, and what concerns are they raising?"
      : "e.g. What are possible routes of collaboration with this PAO?";
  }

  function sourcesList(sources) {
    if (!sources?.length) return "";
    const li = sources.map((x) => {
      const url = safeUrl(x.url);
      const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(x.title || url)}</a>` : esc(x.title || "(untitled)");
      return `<li value="${Number(x.n)}">${title} <span class="muted small">${esc([x.pao, x.source, x.date].filter(Boolean).join(" · "))}</span></li>`;
    }).join("");
    return `<details class="ai-sources"><summary>Sources (${sources.length})</summary><ol>${li}</ol></details>`;
  }

  // Light markdown for AI answers: headings (#..####), bullets (* / -), numbered lists, tables,
  // --- dividers, **bold**, *italic*, and [n] citations turned into links to the article.
  // Everything is HTML-escaped first, so nothing in an answer can inject markup.
  function escMd(s, sources) {
    const byN = new Map((sources || []).map((x) => [Number(x.n), x]));
    const cite = (n) => {
      const x = byN.get(Number(n)), url = x && safeUrl(x.url);
      return url ? `<a class="ai-cite" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(x.title || "")}">${n}</a>` : n;
    };
    const inline = (t) => t
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
      .replace(/\[(\d+(?:\s*[,/]\s*\d+)*)\]/g, (_, inner) => `[${inner.replace(/\d+/g, cite)}]`);
    const cells = (row) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const out = [];
    let list = null, para = [], table = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r));   // drop the |---|---| separator line
      const [head, ...body] = rows;
      out.push(`<div class="ai-table"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      table = [];
    };
    for (const raw of esc(s).split("\n")) {
      const line = raw.trim();
      let m;
      if (line.startsWith("|")) { flushPara(); closeList(); table.push(line); continue; }
      flushTable();
      if (!line) { flushPara(); closeList(); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); const h = m[1].length <= 3 ? "h3" : "h4"; out.push(`<${h}>${inline(m[2])}</${h}>`); continue; }
      const bullet = line.match(/^[*\-•]\s+(.*)$/), numbered = line.match(/^\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        continue;
      }
      closeList();
      para.push(line);
    }
    flushTable(); flushPara(); closeList();
    return out.join("");
  }

  boot();
})();
