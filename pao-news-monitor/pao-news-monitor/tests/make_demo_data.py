"""Builds web/demo-data.json (sample data for demo mode). Run: python tests/make_demo_data.py"""
import json
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from collector.common import iso, load_paos, make_id, now_utc  # noqa: E402
from collector.main import pao_rows  # noqa: E402

now = now_utc()
d = lambda days: iso(now - timedelta(days=days))  # noqa: E731
paos = pao_rows(load_paos())
paos = [p for p in paos if p["active"]]

samples = [
    ("picpa", "website", "SAMPLE - PICPA welcomes its new National President", 3, "", "picpa.com.ph", "en", None, None),
    ("picpa", "google_news", "SAMPLE - Accountancy body names new president at annual convention", 40, "Search: \"picpa\"", "Example Daily", "", "relevant", "Leadership / President"),
    ("picpa", "manual", "SAMPLE - Induction video posted on LinkedIn", 75, "", "you@example.org", "", "relevant", "Leadership / President"),
    ("icai", "google_news", "SAMPLE - Institute announces revised exam schedule", 2, "Search: \"institute of chartered accountants of india\"", "Example Times", "", None, None),
    ("icai", "website", "SAMPLE - Announcement regarding CPD hours for members", 5, "", "icai.org", "en", "not_relevant", None),
    ("icai", "newsapi", "SAMPLE - Chartered accountants' body signs MoU with regional federation", 9, "Accountancy bodies in the region signed an agreement to cooperate on education and standards.", "Example Wire", "", None, None),
    ("jicpa", "google_news", "SAMPLE - 日本公認会計士協会、新会長を選出", 6, "Search: 日本公認会計士協会", "Example Shimbun", "ja", None, None),
    ("kicpa", "website", "SAMPLE - 한국공인회계사회 공지사항: 회원 교육 일정 안내", 12, "", "kicpa.or.kr", "ko", None, None),
    ("vacpa", "google_news", "SAMPLE - VACPA tổ chức hội nghị thường niên 2026", 15, "Search: \"vacpa\"", "Example Báo", "vi", None, None),
    ("hkicpa", "email", "SAMPLE - Press release: Institute statement on new auditing standard", 1, "The Institute welcomes the new standard and will issue member guidance next month...", "Communications <press@hkicpa.org.hk>", "en", None, None),
    ("ca-sri-lanka", "website", "SAMPLE - Council election results announced", 20, "", "casrilanka.com", "en", "relevant", "Council & elections"),
    ("ifac", "website", "SAMPLE - IFAC congratulates new leadership at member bodies", 8, "", "ifac.org", "en", None, None),
    ("_unmatched_email", "email", "SAMPLE - Newsletter: Regional accountancy update", 4, "This month's regional roundup...", "Newsletter <news@example.org>", "", None, None),
    ("cncc", "google_news", "SAMPLE - Évaluation d'entreprise : vers un jugement professionnel augmenté par l'IA", 0.4, "Search: \"compagnie nationale des commissaires aux comptes\"", "mesinfos", "", None, None),
    ("icai", "website", "SAMPLE - The Chartered Accountant Journal, October 2026 issue", 0.5, "", "icai.org", "en", None, None, "publications"),
    ("icai", "website", "SAMPLE - National Conference 2026: registration open", 4, "", "icai.org", "en", None, None, "events"),
    ("icai", "page_watch", "Leadership changed on website: + CA Prasanna Kumar D | Vice-President", 0.3,
     "Removed:\n  - CA Charanjot Singh Nanda | Vice-President\nAdded:\n  + CA Prasanna Kumar D | Vice-President", "icai.org", "en", None, None, "leadership"),
    ("ca-sri-lanka", "page_watch", "Contact details changed on website: + Phone: +94 11 235 2000", 2,
     "Removed:\n  - Phone: +94 11 235 2100\nAdded:\n  + Phone: +94 11 235 2000", "casrilanka.com", "en", None, None, "contact"),
]
for b in range(3):
    samples.append(("icap", "website", f"SAMPLE - Older page found on first scan #{b + 1}", 2, "", "icap.org.pk", "en", None, None))

items = []
for i, (pid, src, title, age, snippet, srcname, lang, rel, cat, *kind) in enumerate(samples):
    baseline = "first scan" in title
    items.append(dict(kind=kind[0] if kind else "news",
        id=make_id("demo", str(i)), pao_id=pid, source=src, title=title,
        url="https://example.org/sample" if src != "email" else "", published_at=d(age) if src != "website" or i % 2 else None,
        snippet=snippet, content=(snippet + "\n\n(full email text would appear here)") if src == "email"
        else ("Before:\n(watched lines last time)\n\nNow:\n(watched lines today)" if src == "page_watch" else ""),
        source_name=srcname, language=lang, is_baseline=baseline, first_seen_at=d(min(age, 3)),
        relevance=rel, category=cat, notes="Confirm date with secretariat" if rel == "relevant" and i == 1 else None,
        reviewed_by="colleague@example.org" if rel else None, reviewed_at=d(1) if rel else None))

health = []
for p in paos:
    if p["id"] == "_unmatched_email":
        continue
    pid = p["id"]
    web_status, web_msg = "ok", "Scanned 2 news page(s) + homepage"
    if not p["website"]:
        web_status, web_msg = "skipped", "No website listed"
    elif pid == "monicpa":
        web_status, web_msg = "error", "ConnectionError: site did not respond"
    elif pid == "sia":
        web_status, web_msg = "warning", "Scanned homepage only (no news page found); no links found - site may need JavaScript to show content"
    health.append(dict(pao_id=pid, source="website", status=web_status, message=web_msg, last_run_at=d(0.1),
                       last_success_at=d(0.1) if web_status != "error" else d(9), last_new_at=d(80) if pid == "cpapng" else d(2),
                       items_found=10, items_new=0, consecutive_failures=3 if web_status == "error" else 0))
    gn = "skipped" if p["grp"] == "Stakeholder" else "ok"
    health.append(dict(pao_id=pid, source="page_watch", status="ok" if p["website"] else "skipped",
                       message="Watching 1 leadership + 1 contact page(s)" if p["website"] else "No website listed",
                       last_run_at=d(0.1), last_success_at=d(0.1), last_new_at=None, items_found=0, items_new=0, consecutive_failures=0))
    health.append(dict(pao_id=pid, source="google_news", status=gn, message="2 search(es)" if gn == "ok" else "No search terms set",
                       last_run_at=d(0.1), last_success_at=d(0.1), last_new_at=d(2), items_found=3, items_new=0, consecutive_failures=0))
    health.append(dict(pao_id=pid, source="newsapi", status=gn, message="Search ok" if gn == "ok" else "No plain search term",
                       last_run_at=d(0.1), last_success_at=d(0.1), last_new_at=d(5), items_found=1, items_new=0, consecutive_failures=0))
health.append(dict(pao_id="_inbox", source="email", status="ok", message="Read 4 email(s)", last_run_at=d(0.1),
                   last_success_at=d(0.1), last_new_at=d(1), items_found=4, items_new=1, consecutive_failures=0))

out = Path(__file__).resolve().parent.parent / "web" / "demo-data.json"
out.write_text(json.dumps({"paos": paos, "items": items, "health": health,
                           "runs": [{"started_at": d(0.11), "finished_at": d(0.1), "summary": {"new": 4}}]},
                          ensure_ascii=False, indent=1), encoding="utf-8")
print("wrote", out, len(items), "items")
