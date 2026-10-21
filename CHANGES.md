# Changes

Plain-language log of what changed and why, for anyone who isn't reading the code. One entry per fix or feature, newest first. See the User Guide for how to use each thing; see `_bmad-output/.../addendum.md` for technical detail.

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
