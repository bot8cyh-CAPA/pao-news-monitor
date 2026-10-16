"""Run every source for every PAO and save what's new.

    python -m collector                 # normal run (saves to Supabase)
    python -m collector --dry-run       # save to data/local.json instead
    python -m collector --only icai,picpa
    python -m collector --sources website,google_news
"""
import argparse
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from . import browser, email_inbox, news_search, websites
from .common import iso, load_paos, log, now_utc
from .store import get_store

ALL_SOURCES = ["website", "google_news", "newsapi", "email"]
LAYOUT_CHANGE_SHARE = 0.7   # if >70% of a site's links are suddenly new, the site was probably redesigned
LAYOUT_CHANGE_MIN = 10
WARN_WORDS = ("redirects", "certificate", "no links", "no article links", "JavaScript", "failed", "error")


def pao_rows(paos):
    rows = [dict(id=p.id, grp=p.group, jurisdiction=p.jurisdiction, name=p.name, abbr=p.abbr,
                 website=p.website, active=p.is_active, notes=p.notes, sort_order=i)
            for i, p in enumerate(paos)]
    rows.append(dict(id=email_inbox.UNMATCHED_ID, grp="Inbox", jurisdiction="", name="Unmatched emails",
                     abbr="Inbox", website="", active=True,
                     notes="Emails that couldn't be matched to a PAO", sort_order=len(paos)))
    return rows


def apply_baseline(res, health, store):
    """Website items: the first scan of a site is 'baseline' (hidden by default),
    so you don't get 80 old links on day one. Same if a redesign makes most links new."""
    if res.source != "website" or not res.items:
        return
    prev = health.get((res.pao_id, "website"))
    if not prev or not prev.get("last_success_at"):
        for it in res.items:
            it.is_baseline = True
        res.message = "First scan: links saved as baseline (hidden by default). " + res.message
        return
    existing = store.existing_ids([it.id for it in res.items])
    new = [it for it in res.items if it.id not in existing]
    if len(res.items) >= LAYOUT_CHANGE_MIN and len(new) / len(res.items) > LAYOUT_CHANGE_SHARE:
        for it in new:
            it.is_baseline = True
        res.message = (f"Most links ({len(new)}/{len(res.items)}) are new - the site was probably redesigned; "
                       "new links saved as baseline. ") + res.message


def health_row(res, prev, new_count, now):
    prev = prev or {}
    if res.skipped:
        status = "skipped"
    elif not res.ok:
        status = "error"
    elif any(w.lower() in res.message.lower() for w in WARN_WORDS) or (res.source == "website" and not res.items):
        status = "warning"
    else:
        status = "ok"
    ok = status in ("ok", "warning")
    return dict(
        pao_id=res.pao_id, source=res.source, status=status, message=res.message[:1000],
        last_run_at=iso(now),
        last_success_at=iso(now) if ok else prev.get("last_success_at"),
        last_new_at=iso(now) if new_count else prev.get("last_new_at"),
        items_found=len(res.items), items_new=new_count,
        consecutive_failures=0 if ok or res.skipped else (prev.get("consecutive_failures") or 0) + 1,
    )


def retry_in_browser(results, paos_by_id):
    """Second chance for websites that blocked us or need JavaScript."""
    todo = [i for i, r in enumerate(results) if r.source == "website" and r.needs_browser]
    if not todo:
        return
    if not browser.available():
        for i in todo:
            results[i].message += " (real-browser retry not available: Playwright not installed)"
        return
    try:
        with browser.Browser() as b:
            for i in todo:
                old = results[i]
                new = websites.collect(paos_by_id[old.pao_id], fetcher=b.fetch, browser_mode=True)
                if new.items:
                    new.message = "Read with a real browser. " + new.message
                    results[i] = new
                else:
                    old.message += f" | Real browser also failed: {new.message}"
    except Exception as e:  # noqa: BLE001
        log.warning("browser retry failed: %s", e)
        for i in todo:
            results[i].message += f" (real-browser retry crashed: {type(e).__name__})"


def run(only=None, sources=None, dry_run=False, workers=8):
    started = now_utc()
    sources = sources or ALL_SOURCES
    all_paos = load_paos()
    paos = [p for p in all_paos if p.is_active and (not only or p.id in only)]
    if only and not paos:
        sys.exit(f"No active PAO with id in {sorted(only)} - check config/paos.csv")
    store = get_store(dry_run)
    store.save_paos(pao_rows(all_paos))
    health = store.load_health()
    newsapi = news_search.NewsAPI()
    lock = threading.Lock()
    results = []

    def one(pao):
        out = []
        if "website" in sources:
            out.append(websites.collect(pao))
        if "google_news" in sources:
            out.append(news_search.collect_google(pao))
        if "newsapi" in sources:
            with lock:
                out.append(newsapi.collect(pao))
        return out

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for out in pool.map(one, paos):
            results.extend(out)

    retry_in_browser(results, {p.id: p for p in paos})

    email_items = []
    if "email" in sources:
        prev = health.get(("_inbox", "email"), {})
        since = datetime.fromisoformat(prev["last_success_at"]) if prev.get("last_success_at") else None
        inbox_res, email_items = email_inbox.collect(all_paos, since)
        if only:
            email_items = [i for i in email_items if i.pao_id in only]
        results.append(inbox_res)

    for res in results:
        apply_baseline(res, health, store)

    rows = [it.row() for res in results for it in res.items] + [it.row() for it in email_items]
    for r in rows:
        r["first_seen_at"] = iso(started)
    inserted = store.insert_items(rows) if rows else set()

    health_rows = []
    for res in results:
        new_count = sum(1 for it in res.items if it.id in inserted)
        if res.pao_id == "_inbox":
            new_count = sum(1 for it in email_items if it.id in inserted)
            res.items = email_items
        health_rows.append(health_row(res, health.get((res.pao_id, res.source)), new_count, started))
    store.save_health(health_rows)

    summary = {
        "paos": len(paos), "sources": sources, "found": len(rows), "new": len(inserted),
        "errors": sum(1 for h in health_rows if h["status"] == "error"),
        "warnings": sum(1 for h in health_rows if h["status"] == "warning"),
        "only": sorted(only) if only else None, "dry_run": dry_run,
    }
    store.log_run({"started_at": iso(started), "finished_at": iso(now_utc()), "summary": summary})

    # readable report in the GitHub Actions log
    print(f"\n{'PAO':<16}{'source':<13}{'status':<9}{'found':>6}{'new':>5}  message")
    for h in sorted(health_rows, key=lambda h: (h["pao_id"], h["source"])):
        print(f"{h['pao_id'][:15]:<16}{h['source']:<13}{h['status']:<9}{h['items_found']:>6}{h['items_new']:>5}  {h['message'][:110]}")
    print(f"\nDone: {summary}")
    return summary


def cli(argv=None):
    ap = argparse.ArgumentParser(description="PAO news collector")
    ap.add_argument("--dry-run", action="store_true", help="save to data/local.json instead of Supabase")
    ap.add_argument("--only", default="", help="comma-separated PAO ids from config/paos.csv")
    ap.add_argument("--sources", default="", help=f"comma-separated, from {ALL_SOURCES}")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING, format="%(levelname)s %(message)s")
    only = {x.strip() for x in a.only.split(",") if x.strip()} or None
    sources = [x.strip() for x in a.sources.split(",") if x.strip()] or None
    bad = [s for s in (sources or []) if s not in ALL_SOURCES]
    if bad:
        sys.exit(f"Unknown source(s) {bad}; choose from {ALL_SOURCES}")
    run(only=only, sources=sources, dry_run=a.dry_run)


if __name__ == "__main__":
    cli()
