// Item selection for Ask AI: shared by index.ts, kept free of Deno APIs so it can be tested with Node.

export type Item = {
  id: string; pao_id: string; title: string; snippet?: string | null; url?: string | null; published_at?: string | null;
  first_seen_at?: string | null; source: string; kind?: string | null; relevance?: string | null; category?: string | null;
  ai_relevance?: string | null; ai_summary?: string | null; ai_themes?: string[] | null;
};
export const when = (it: Item) => it.published_at || it.first_seen_at || "";
export const effective = (it: Item) => it.relevance || it.ai_relevance || null;
export const rank = (it: Item) => (effective(it) === "high" ? 0 : effective(it) === "medium" ? 1 : 2);
export const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Same story collected twice (two Google News searches, website + email...): keep one per PAO+headline,
// preferring the copy staff reviewed.
export function dedupe(items: Item[]): Item[] {
  const best = new Map<string, Item>();
  for (const it of items) {
    const key = `${it.pao_id}|${norm(it.title || "")}`;
    const had = best.get(key);
    if (!had || (!had.relevance && it.relevance)) best.set(key, it);
  }
  return [...best.values()];
}

// Whole-region item choice: match the question to the brief's themes and to words in each item,
// keep the best matches (High/Medium first), at most perPaoMax per organisation.
// A vague question that matches nothing gets the most important recent items across the region.
export const THEME_WORDS: Record<string, RegExp> = {
  ai_digital: /\b(ai|a\.i\.|artificial intelligence|genai|generative|chatgpt|llm|machine learning|automation|digital\w*|technolog\w*|cyber\w*|data)\b/i,
  sustainability: /\b(sustainab\w*|esg|climate|issb|nature|carbon|green|net zero|ifrs s[12])\b/i,
  talent: /\b(talent|students?|young|youth|recruit\w*|retention|workforce|skills?|pipeline|careers?|education|universit\w*)\b/i,
  ethics_standards: /\b(ethic\w*|iesba|iaasb|standards?|audit quality|assurance|independence|isa|isqm)\b/i,
};
const STOP = new Set(("the a an and or of in on to for with about across what which who how are is was were be been do does did " +
  "there their them they this that these those any some region regional world global asia pacific capa pao paos " +
  "member members organisation organisations organization organizations concerns concern adoption tell me us give " +
  "show find latest recent recently news happening going update updates please can could would should").split(" "));

export function pickForTopic(pool: Item[], topic: string, max: number, perPaoMax = 4): Item[] {
  const themes = Object.entries(THEME_WORDS).filter(([, rx]) => rx.test(topic)).map(([t]) => t);
  const words = [...new Set(norm(topic).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)))];
  const score = (it: Item) => {
    const hay = norm(`${it.title} ${it.snippet ?? ""} ${it.ai_summary ?? ""} ${it.category ?? ""}`);
    let s = 0;
    for (const t of themes) {
      if (it.ai_themes?.includes(t)) s += 3;
      else if (THEME_WORDS[t].test(hay)) s += 2;
    }
    for (const w of words) if (hay.includes(w)) s += 1;
    return s;
  };
  const scored = pool.map((it) => ({ it, s: score(it) }));
  const matched = scored.some((x) => x.s > 0) ? scored.filter((x) => x.s > 0) : scored;
  matched.sort((a, b) => b.s - a.s || rank(a.it) - rank(b.it) || when(b.it).localeCompare(when(a.it)));
  const perPao = new Map<string, number>(), out: Item[] = [];
  for (const { it } of matched) {
    const n = perPao.get(it.pao_id) ?? 0;
    if (n >= perPaoMax) continue;
    perPao.set(it.pao_id, n + 1);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

