"""Source 1: each PAO's own website.

No per-site code. For each site, in order:
  1. use feed_url from paos.csv if set (RSS/Atom feed),
  2. otherwise look for a feed advertised on the homepage,
  3. otherwise read the news page(s) - news_url from paos.csv, or pages found
     automatically from homepage links like "News", "Press", "公告", "お知らせ" -
     and collect every article-looking link on them.

Every link not seen before becomes an item. Nothing is filtered by topic:
your team decides what matters in the web page.

If a site's results are too noisy, put a CSS selector in the link_selector
column of paos.csv (e.g. ".news-list a") and only those links are used.
"""
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

import feedparser
from bs4 import BeautifulSoup

from .common import (Item, SourceResult, base_domain, clean, fetch, guess_date, iso,
                     log, make_id, normalize_url)

SOURCE = "website"

# Words that mark a link to a news / announcements section (many languages).
NEWS_WORDS = [
    "news", "press", "media", "announcement", "notice", "circular", "update", "latest",
    "bulletin", "newsroom", "release", "events", "whats-new", "what's new",
    "新闻", "新聞", "公告", "通知", "动态", "動態", "资讯", "資訊", "最新",
    "お知らせ", "ニュース", "新着", "뉴스", "공지", "소식", "알림",
    "tin tức", "tin-tuc", "thông báo", "thong-bao",
    "actualité", "actualite", "communiqué", "communique", "presse",
    "мэдээ", "समाचार", "सूचना",
]
_NEWS_RX = re.compile("|".join(re.escape(w) for w in NEWS_WORDS), re.I)

# Links that are never news.
SKIP_RX = re.compile(
    r"login|log-in|signin|sign-in|register|cart|checkout|password|privacy|cookie|terms|"
    r"sitemap|contact|about-us|career|jobs|search|facebook\.com|twitter\.com|x\.com|"
    r"linkedin\.com|youtube\.com|instagram\.com|whatsapp|wa\.me|tel:|mailto:|javascript:",
    re.I)
SKIP_EXT = re.compile(r"\.(jpg|jpeg|png|gif|svg|webp|css|js|ico|zip|mp4|mp3)(\?|$)", re.I)
ARTICLE_HINT = re.compile(r"(20\d\d|/\d{3,}|news|press|media|notice|circular|announce|article|post|detail|view|\.pdf)", re.I)

MAX_LINKS_PER_PAGE = 80
MAX_NEWS_PAGES = 3
_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")


def _title_ok(text, relaxed=False):
    if not text:
        return False
    if _CJK.search(text):
        return len(text) >= (6 if relaxed else 5)
    if relaxed:  # no URL hint to lean on, so ask for a more headline-like title
        return len(text) >= 25 and len(text.split()) >= 4
    return len(text) >= 18 and len(text.split()) >= 3


def _same_site(url, site_domain):
    host = (urlsplit(url).hostname or "").lower()
    return bool(host) and (host.removeprefix("www.") == site_domain or host.endswith("." + site_domain))


def parse_feed(content, pao, base_url):
    feed = feedparser.parse(content)
    items = []
    for e in feed.entries[:100]:
        link = e.get("link") or ""
        title = clean(e.get("title"))
        if not link or not title:
            continue
        link = urljoin(base_url, link)
        published = None
        for key in ("published_parsed", "updated_parsed"):
            if e.get(key):
                published = datetime(*e[key][:6], tzinfo=timezone.utc)
                break
        summary = clean(BeautifulSoup(e.get("summary", ""), "lxml").get_text(" "), 500) if e.get("summary") else ""
        items.append(Item(id=make_id(pao.id, SOURCE, normalize_url(link)), pao_id=pao.id, source=SOURCE,
                          title=title, url=link, published_at=iso(published), snippet=summary,
                          source_name="Website feed", language=pao.language))
    return items


def find_feed_links(soup, base_url):
    out = []
    for link in soup.find_all("link", rel=lambda v: v and "alternate" in v):
        t = (link.get("type") or "").lower()
        if ("rss" in t or "atom" in t) and link.get("href"):
            out.append(urljoin(base_url, link["href"]))
    return out


def find_news_pages(soup, base_url, site_domain):
    found = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        text = clean(a.get_text(" "))
        if not _same_site(href, site_domain) or SKIP_RX.search(href) or SKIP_EXT.search(href):
            continue
        if len(text) <= 40 and (_NEWS_RX.search(text) or _NEWS_RX.search(urlsplit(href).path)):
            n = normalize_url(href)
            if n != normalize_url(base_url) and n not in [normalize_url(f) for f in found]:
                found.append(href)
    # prefer the most "newsy" looking ones
    found.sort(key=lambda u: (0 if re.search(r"news|press|media|公告|お知らせ|뉴스", u, re.I) else 1, len(u)))
    return found[:MAX_NEWS_PAGES]


def extract_links(html, page_url, pao, site_domain, selector="", relaxed=False):
    """Collect article-looking links. Strict mode wants a news-like URL
    (dates, ids, 'news', .pdf...). Relaxed mode drops that and relies on
    headline-like link text instead - used when strict finds almost nothing."""
    soup = BeautifulSoup(html, "lxml")
    for bad in soup(["script", "style", "noscript", "header", "footer", "nav"]):
        if not selector:
            bad.decompose()
    anchors = soup.select(selector) if selector else soup.find_all("a", href=True)
    items, seen = [], set()
    for a in anchors:
        if a.name != "a":
            a = a.find("a", href=True) or a
        href = a.get("href")
        if not href:
            continue
        url = urljoin(page_url, href)
        if not url.startswith("http") or SKIP_RX.search(url) or SKIP_EXT.search(url):
            continue
        is_pdf = url.lower().split("?")[0].endswith(".pdf")
        if not (_same_site(url, site_domain) or is_pdf):
            continue
        title = clean(a.get_text(" ")) or clean(a.get("title"))
        if not selector and not _title_ok(title, relaxed):
            continue
        if not selector and not relaxed and not ARTICLE_HINT.search(url) and not _CJK.search(title):
            continue
        key = normalize_url(url)
        if key in seen or key == normalize_url(page_url):
            continue
        seen.add(key)
        # look for a date in the link's surroundings (list item / card)
        ctx = a.find_parent(["li", "tr", "article", "div"]) or a
        date = guess_date(clean(ctx.get_text(" "), 400)) or guess_date(url)
        items.append(Item(id=make_id(pao.id, SOURCE, key), pao_id=pao.id, source=SOURCE,
                          title=title[:300] or url, url=url, published_at=iso(date),
                          source_name=urlsplit(page_url).netloc, language=pao.language))
        if len(items) >= MAX_LINKS_PER_PAGE:
            break
    return items


BLOCKED_STATUSES = {401, 403, 406, 429, 503}
MIN_STRICT_LINKS = 3


def collect(pao, fetcher=None, browser_mode=False):
    """fetcher: how pages are downloaded - plain requests by default, or a
    real browser (browser.py) for sites that block bots or need JavaScript."""
    fetcher = fetcher or fetch
    res = SourceResult(pao.id, SOURCE)
    if not pao.website and not pao.news_url and not pao.feed_url:
        res.skipped, res.message = True, "No website listed"
        return res
    notes = []
    try:
        # 1. explicit feed
        if not browser_mode:
            for feed_url in pao.split(pao.feed_url):
                r = fetch(feed_url)
                res.items += parse_feed(r.content, pao, r.url)
            if res.items:
                res.message = f"Feed: {len(res.items)} entries"
                return res

        home_url = pao.website or pao.split(pao.news_url)[0]
        try:
            home = fetcher(home_url)
        except Exception as e:  # noqa: BLE001  (timeouts, refused connections)
            res.ok, res.needs_browser = False, not browser_mode
            res.message = f"Website not reachable ({type(e).__name__}): {clean(str(e), 150)}"
            return res
        if home.status >= 400:
            res.ok = False
            res.needs_browser = not browser_mode and (home.status in BLOCKED_STATUSES)
            hint = " (site blocks automated visitors)" if home.status in BLOCKED_STATUSES else ""
            res.message = f"Website returned error {home.status}{hint}"
            return res
        if home.insecure:
            notes.append("site's security certificate is broken (read anyway)")
        if base_domain(home.url) != base_domain(home_url):
            notes.append(f"website now redirects to {urlsplit(home.url).netloc} - update the website column")
        site_domain = base_domain(home.url)
        soup = BeautifulSoup(home.text, "lxml")
        visible_text = len(clean(soup.get_text(" ")))

        # 2. advertised feed
        if not pao.link_selector and not browser_mode:
            for feed_url in find_feed_links(soup, home.url)[:2]:
                try:
                    r = fetch(feed_url)
                    got = parse_feed(r.content, pao, r.url)
                except Exception as e:  # noqa: BLE001
                    log.info("%s feed %s failed: %s", pao.id, feed_url, e)
                    continue
                if got:
                    res.items += got
                    notes.insert(0, f"Feed found automatically: {feed_url}")
                    break
            if res.items:
                res.message = "; ".join(notes)
                return res

        # 3. news pages
        explicit = pao.split(pao.news_url)
        pages = explicit or find_news_pages(soup, home.url, site_domain)
        fetched = []  # (url, html)
        for page_url in pages:
            try:
                r = fetcher(page_url)
                if r.status >= 400:
                    # a page we guessed can be a dead menu link - only flag pages you set yourself
                    notes.append(f"news page error {r.status}: {page_url}" if explicit
                                 else f"skipped a dead link ({r.status})")
                    continue
                fetched.append((r.url, r.text))
            except Exception as e:  # noqa: BLE001
                notes.append(f"news page failed ({type(e).__name__}): {page_url}")
        fetched.append((home.url, home.text))  # homepage itself often lists the latest news

        def gather(relaxed):
            out = {}
            for url, html in fetched:
                for it in extract_links(html, url, pao, site_domain, pao.link_selector, relaxed):
                    out.setdefault(it.id, it)
            return out

        found = gather(relaxed=False)
        if len(found) < MIN_STRICT_LINKS and not pao.link_selector:
            loose = gather(relaxed=True)
            if len(loose) > len(found):
                notes.append("used loose link matching (review for junk links)")
                found = {**loose, **found}
        res.items = list(found.values())

        if not res.items:
            if visible_text < 800:
                notes.append("page is nearly empty - the site needs JavaScript")
            elif browser_mode:
                notes.append("no article links found even in a real browser - set news_url (or link_selector) in paos.csv")
            else:
                notes.append("no article links found - set news_url (or link_selector) in paos.csv")
            res.needs_browser = not browser_mode
        n_news = len(fetched) - 1
        pages_note = f"Scanned {n_news} news page(s) + homepage" if n_news else "Scanned homepage only (no news page found)"
        res.message = "; ".join([pages_note] + notes)
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.message = f"{type(e).__name__}: {clean(str(e), 200)}"
    return res
