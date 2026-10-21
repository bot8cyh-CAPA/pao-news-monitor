// Ask AI - real-time Q&A about one PAO, grounded only in its collected items.
// Deploy: supabase functions deploy ask-ai   (see README "Ask AI setup")
// Secrets needed (set once): supabase secrets set GROQ_API_KEY=... GEMINI_API_KEY=... (etc.)
//
// Why this exists as an Edge Function and not a schedule job: see
// _bmad-output/planning-artifacts/architecture/ask-ai-architecture.md
//
// Guardrails (do not loosen without re-reading the architecture doc):
//  - Answers are grounded ONLY in the PAO's collected items + the CAPA context below.
//  - No tool call claims web research - these providers, called this way, cannot browse.
//  - Every material claim must cite [n] matching the numbered item list given to the model.
//  - Thread length is capped (MAX_TURNS) so one conversation can't grow without bound.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { COLLABORATION_GUIDELINES } from "./capa_context.ts";

const MAX_TURNS = 15;        // user+assistant pairs per thread before the UI must start a new one
const MAX_ITEMS = 120;       // most recent items fed in, to bound the prompt size
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const CF_URL = (account: string) => `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Groq first (cheap, generous free tier) - see ask-ai-architecture.md for why, unlike the
// brief/tagging chain in collector/ai.py which tries Gemini first.
function chain(env: Record<string, string | undefined>) {
  const steps: { url: string; key: string; model: string; headers?: Record<string, string> }[] = [];
  if (env.GROQ_API_KEY) steps.push({ url: GROQ_URL, key: env.GROQ_API_KEY, model: "openai/gpt-oss-120b" });
  if (env.GEMINI_API_KEY) steps.push({ url: GEMINI_URL, key: env.GEMINI_API_KEY, model: "gemini-3.8-flash" });
  if (env.CF_ACCOUNT_ID && env.CF_AI_TOKEN)
    steps.push({ url: CF_URL(env.CF_ACCOUNT_ID), key: env.CF_AI_TOKEN, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
  if (env.OPENROUTER_API_KEY) steps.push({ url: OPENROUTER_URL, key: env.OPENROUTER_API_KEY, model: "nvidia/nemotron-3-super-120b-a12b:free" });
  return steps;
}

async function askModel(env: Record<string, string | undefined>, messages: unknown[]): Promise<{ text: string; model: string }> {
  let lastError = "no AI provider has a key set";
  for (const step of chain(env)) {
    try {
      const r = await fetch(step.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${step.key}` },
        body: JSON.stringify({ model: step.model, messages, temperature: 0.3, max_tokens: 1800 }),
      });
      if (!r.ok) { lastError = `${step.model} failed ${r.status}`; continue; }
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return { text, model: step.model };
      lastError = `${step.model} returned no usable text`;
    } catch (e) {
      lastError = `${step.model} error: ${(e as Error).message}`;
    }
  }
  throw new Error(lastError);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  let body: { pao_id?: string; thread_id?: number; question?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request body" }, 400); }
  const { pao_id, question } = body;
  if (!pao_id || !question?.trim()) return json({ error: "pao_id and question are required" }, 400);

  // The caller's own session - RLS applies, so this can only ever see what they're allowed to.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: authError } = await userClient.auth.getUser();
  if (authError || !userData?.user?.email) return json({ error: "Sign in required" }, 401);
  const email = userData.user.email;

  const { data: canAsk } = await userClient.rpc("has_perm", { p: "ask_ai" });
  if (!canAsk) return json({ error: "You don't have permission to use Ask AI" }, 403);

  // Service role from here, now that permission is confirmed - needed to write the thread
  // (writes are function-only, see update-11.sql: table grants SELECT only to authenticated).
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: pao } = await svc.from("paos").select("id,name,abbr,jurisdiction,grp,website").eq("id", pao_id).single();
  if (!pao) return json({ error: "Unknown PAO" }, 404);

  const { data: items } = await svc
    .from("items")
    .select("id,title,snippet,url,published_at,first_seen_at,source,kind,relevance,category")
    .eq("pao_id", pao_id)
    .is("removed_at", null)
    .order("first_seen_at", { ascending: false })
    .limit(MAX_ITEMS);

  let thread: { id: number; messages: { role: string; content: string; cited_item_ids?: string[]; at: string }[] } | null = null;
  if (body.thread_id) {
    const { data } = await svc.from("ask_ai_threads").select("id,messages,ended_at").eq("id", body.thread_id).single();
    if (data && !data.ended_at) thread = data as typeof thread;
  }
  const priorTurns = thread ? thread.messages.filter((m) => m.role !== "system").length / 2 : 0;
  if (priorTurns >= MAX_TURNS) return json({ error: "This conversation has reached its limit - please start a new one." }, 400);

  const numbered = (items ?? []).map((it, i) => {
    const date = (it.published_at ?? it.first_seen_at ?? "").slice(0, 10);
    return `[${i + 1}] ${date} | ${it.source}${it.kind && it.kind !== "news" ? ` (${it.kind})` : ""}${it.relevance ? ` | staff-tagged: ${it.relevance}` : ""} | ${it.title}\n    ${it.snippet ?? ""}\n    ${it.url}`;
  });

  const system = `You are answering questions for CAPA staff about one specific organisation: \
${pao.name} (${pao.abbr ?? pao.id}), ${pao.grp ?? "Member"}, ${pao.jurisdiction ?? "jurisdiction unknown"}.

${COLLABORATION_GUIDELINES}

Collected items about ${pao.name} (most recent first, numbered for citation; this is ALL the \
evidence you have - you cannot browse the web):
${numbered.length ? numbered.join("\n\n") : "(No items collected yet for this PAO.)"}
`;

  const history = (thread?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: question }];

  let answer: { text: string; model: string };
  try {
    answer = await askModel(
      {
        GROQ_API_KEY: Deno.env.get("GROQ_API_KEY"),
        GEMINI_API_KEY: Deno.env.get("GEMINI_API_KEY"),
        CF_ACCOUNT_ID: Deno.env.get("CF_ACCOUNT_ID"),
        CF_AI_TOKEN: Deno.env.get("CF_AI_TOKEN"),
        OPENROUTER_API_KEY: Deno.env.get("OPENROUTER_API_KEY"),
      },
      messages,
    );
  } catch (e) {
    return json({ error: `No AI model was available right now (${(e as Error).message}). Try again shortly.` }, 503);
  }

  const citedIds = [...answer.text.matchAll(/\[(\d+)\]/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= numbered.length)
    .map((n) => items![n - 1].id);

  const now = new Date().toISOString();
  const newMessages = [
    ...(thread?.messages ?? []),
    { role: "user", content: question, at: now },
    { role: "assistant", content: answer.text, cited_item_ids: [...new Set(citedIds)], at: now, model: answer.model },
  ];

  let threadId = thread?.id;
  if (threadId) {
    await svc.from("ask_ai_threads").update({ messages: newMessages }).eq("id", threadId);
  } else {
    const { data: created } = await svc
      .from("ask_ai_threads")
      .insert({ pao_id, started_by: email, messages: newMessages })
      .select("id")
      .single();
    threadId = created?.id;
  }

  return json({ thread_id: threadId, answer: answer.text, model: answer.model, cited_item_ids: [...new Set(citedIds)] });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
