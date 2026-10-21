# Changes

Plain-language log of what changed and why, for anyone who isn't reading the code. One entry per fix or feature, newest first. See the User Guide for how to use each thing; see `_bmad-output/.../addendum.md` for technical detail.

## 2026-10-21 — Simpler tracker layout: CAPA logo, collapsible PAOs, filter dropdowns
- **CAPA logo** at the top left (also on the Ask AI and Screenshots pages), with your account, Password and Sign out on the right.
- **Second row:** Weekly brief, Screenshots (OCR), Ask AI, Import, Admin - and the search box on the right.
- **Filters are now one tidy row:** Period, Show, **Scan type** and **News type** (the two rows of tick boxes became two dropdown menus, each with All / None), Refresh, then Expand all and Export CSV on the right. A dropdown turns green and says e.g. "3 of 6" when you've narrowed it, so a hidden filter is easy to spot. "Include first-scan links" now lives inside Scan type.
- **Every PAO collapses into one header row** showing its health dot, how many items are left to review, and how many items it has. Click to open. Whatever you open stays open while you tag. **Expand all / Collapse all** does them all at once. While you search, every PAO with a match opens automatically.
- The left sidebar and the "Jump to PAO" list are gone - the collapsed list now does that job.
Website-only change: nothing to run or redeploy.

## 2026-10-21 — Relevance becomes High / Medium / Low / No relevance; "Opportunity to comment"; realistic AI suggestions
**Why:** CAPA is regional. "Regional vs Country-specific vs PAO-specific" was sorting items by *where*, when what matters is *how much it matters to CAPA* - and big regional themes like AI were ending up in the same bucket as one country's tax rules.

**What changed:**
- **The tag buttons are now High / Med / Low / No relevance.** Existing tags were converted automatically: Regional → High, PAO-specific → Medium, Country-specific → Low, Not relevant → No relevance. Re-tag anything that landed wrong.
- **Weekly brief:** new **Open for comment** section at the top, then **Key developments** (High items, by theme), then **Other updates** (Medium). Low and No relevance items stay in the tracker only. Untagged items are still considered, but the AI only promotes one to Key developments if it clearly matters region-wide.
- **New item type "Opportunity to comment"** (in the type dropdown, the type filter, the screenshot page and spreadsheet import) for consultations and exposure drafts.
- **Realism rules for AI suggestions**, used by both Ask AI and the brief's "Suggested CAPA actions": think regionally (no proposals built on one country's domestic issue); webinars, online workshops and online collaboration are fine; in-person events are a stretch and never more than a day; no summits; roundtables only as a topic for CAPA members' meetings, never for a sub-region; meetings with a PAO's leaders are fine but the AI lists *what to discuss* and how CAPA's network could tackle it together, not dates and logistics. Edit these in `collector/capa_context.py` (`CAPA_ACTION_RULES`).
- **Ask AI reads High items first, then Medium, then untagged** (skipping Low / No relevance) - 30 articles, slightly fewer than before, to keep room for the new rules within Groq's free limit.
- Filters: "High + Medium (brief material)", "High only", "Medium only", "Low only", "No relevance only". Anyone who had an old filter saved (e.g. "Country-specific only") is put back on the default.

**Needs:** `supabase/update-12.sql` (converts the tags), then redeploy Ask AI (`supabase functions deploy ask-ai --project-ref uipumuednycqjrkoacgm`). Run the SQL first - until then, tagging buttons on the site will be refused by the database.

## 2026-10-21 — Ask AI: clickable citations, sources list, tables; smarter article picking
Citation numbers in answers ([5], [2][5], [19, 33]) are now links to the actual article, and each answer has a **Sources** list (click to expand) showing every cited article's title, outlet and date - so any claim can be checked in one click. Tables in answers now display as proper tables instead of rows of | symbols. Also changed which 35 articles Ask AI reads: it now skips anything staff tagged **Not relevant** (as well as Removed items), and picks the newest by **publish date** rather than by when the monitor happened to find them, so an old story that surfaced late no longer crowds out real recent news. Needs a redeploy: `supabase functions deploy ask-ai --project-ref uipumuednycqjrkoacgm`.

## 2026-10-21 — Fix: Ask AI answers stopping mid-sentence
Two causes. (1) The AI models "think" before writing, and that thinking used the same length allowance as the answer - so on big questions the allowance ran out partway through. The allowance is bigger now, the models are told to keep thinking brief, and if an answer is ever still cut short it now says so ("reply continue for the rest") instead of just stopping. (2) We were sending far more text than Groq's free tier accepts per minute (it caps question + answer combined), so Groq was likely refusing every question and the backup providers were answering. Ask AI now reads the 35 most recent items for the PAO with short excerpts - enough for its purpose, and small enough for Groq. A second Groq model was added as the next fallback, so Gemini's small daily quota is a last resort. Each answer now shows which AI model replied ("answered by …"). Needs a redeploy: `supabase functions deploy ask-ai --project-ref uipumuednycqjrkoacgm`.

## 2026-10-21 — Fix: Ask AI stuck on "Asking…" forever
If one AI provider stalled, Ask AI waited on it indefinitely - one test sat on "Asking…" for 5+ minutes. Now each provider gets 30 seconds before the next one is tried, the whole attempt stops well within Supabase's time limit, and the page itself gives up after 2 minutes with a clear "try again" message. The main Groq model is also told to keep its behind-the-scenes "thinking" short, which makes it faster. Failures are now written to the function's log (Supabase → Edge Functions → ask-ai → Logs) so problems can be diagnosed. Needs a redeploy: `supabase functions deploy ask-ai --project-ref uipumuednycqjrkoacgm`.

## 2026-10-21 — Fix: Ask AI answers cut off and showing ### / ** symbols
Long answers (several collaboration recommendations) were being squashed into a fixed-height chat box, so they looked like they stopped mid-sentence. The conversation now grows with the page, and each new answer scrolls into view from its first line. Answers also now display properly formatted - headings, bullet points, numbered lists, dividers, bold - instead of the raw formatting symbols the AI writes. Website-only change: no redeploy or database step.

## 2026-10-21 — Fix: Ask AI "Failed to send a request to the Edge Function"
The first live test failed because the website and Supabase sit on different web addresses, and browsers block a page from calling another address unless that address says "yes, you're allowed" (called CORS). The Ask AI function never said yes, so every question was blocked before it left the browser. It now answers that check. Also: if something else goes wrong (e.g. all AI providers busy), the page now shows the actual reason instead of a generic error. Needs a redeploy: `supabase functions deploy ask-ai` (no database change).

## 2026-10-21 — Ask AI: real-time Q&A about a PAO
New page (**Ask AI**, needs the new permission of the same name) where staff pick a PAO and ask it questions, e.g. "what are possible routes of collaboration with this PAO?" Unlike everything else in the monitor, this answers live in a few seconds rather than on a schedule - it's the system's first real-time feature, built as a Supabase Edge Function so it reuses the same sign-in and roles as the rest of the site, never exposes AI keys to the browser, and stays on free usage. Answers are grounded only in that PAO's collected items (it has no ability to browse the web) and cite every claim like the weekly brief does. Follows the collaboration-assessment guidelines the team provided - realistic, evidence-based opportunities, not generic suggestions. Needs `supabase/update-11.sql` plus a one-off Edge Function deploy (see README "Ask AI setup"). Architecture decision recorded at `_bmad-output/planning-artifacts/architecture/ask-ai-architecture.md`.

## 2026-10-20 — Remove and restore items, automatic clean-up
Added a **Remove** link on each item (red, needs the new "Remove items" permission) that hides it everywhere - tracker, brief, exports. **Show > Removed** lists what's removed, with a **Restore** link. Every daily run also deletes old clutter on its own: removed items after 90 days, untagged/Not relevant items after 12 months. Anything tagged, or cited in a brief, is kept forever. A deleted item is remembered so it never gets collected again. Needs `supabase/update-10.sql`.

## 2026-10-20 — Two new categories: Insights & trends, Research & surveys
Added to the Category suggestion list, for interview/opinion/trend pieces and for survey findings a PAO gave to the press without publishing a full paper. No database change needed.

## 2026-10-20 — PAO-specific relevance tag
Added a fourth relevance option, between Country-specific and Not relevant, for news about a PAO itself (its own events, council, exams, CPD, awards). These items get their own "PAO updates" section in the weekly brief, after Country updates. Needs `supabase/update-9.sql`.

## 2026-10-20 — Move an item to a different PAO
Added a "Move to another PAO" link on each item, for when Google News (or another source) filed a story under the wrong organisation. The move sticks - the daily collection never undoes it. Needs `supabase/update-9.sql`.

## 2026-10-19 — Custom roles with per-role permissions
Replaced the fixed Team/Viewer roles with roles admins can create and configure themselves. Admins tick which of 7 permissions each role has (tag items, add items, edit/approve/send briefs, manage the mailing list, manage members). Admin always has everything. Needs `supabase/update-8.sql`.

## 2026-10-19 — Relevance: Regional / Country-specific / Not relevant
Replaced the old Relevant/Not relevant pair with three options, so staff can separate "matters across the region" from "only matters in one country." Country-specific items get their own section in the brief.

## 2026-10-19 — Newsletter / article item type
Added a fourth item type so magazine-style pieces (e.g. CPA Australia's INTHEBLACK) aren't miscounted as plain News.

## 2026-10-19 — Brief only uses items published in the week; OCR date fixes
The weekly brief no longer includes old news that was simply *found* during the week (e.g. a June leadership change surfacing in October). OCR screenshots can now have a date set once and applied to a whole batch.

## 2026-10-19 — Send job skips quietly until set up
The brief-sending job no longer fails loudly if `update-6.sql` (brief sending) hasn't been run yet - it just waits.

---
*Earlier changes (collector, AI fallback chain, auth, admin tab, mailing list, brief approval flow) predate this log; see `README.md` and git history for those.*
