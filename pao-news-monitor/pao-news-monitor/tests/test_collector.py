"""Offline tests: fake websites, feeds and emails. Run with:  python -m pytest -q"""
import json
from email.message import EmailMessage

import pytest

from collector import common, email_inbox, main, news_search, websites
from collector.common import PAO, guess_date, base_domain, load_paos

HOME = """<html><head><title>ICAI</title></head><body>
<nav><a href="/login">Member Login</a><a href="/news">News &amp; Updates</a><a href="/about-us">About</a></nav>
<div class="latest"><ul>
 <li><a href="/post/new-president-elected-2026">CA Ranjeet Kumar elected President for 2026-27 term</a> <span>12 Feb 2026</span></li>
 <li><a href="https://www.facebook.com/icai">Follow us on Facebook today please</a></li>
</ul></div></body></html>"""

NEWS = """<html><body><h1>News</h1><ul>
 <li><a href="/post/announcement-cpd-hours-2026">Announcement regarding CPD hours for the year 2026</a> 03/03/2026</li>
 <li><a href="/post/new-president-elected-2026?utm_source=x">CA Ranjeet Kumar elected President for 2026-27 term</a></li>
 <li><a href="/docs/circular-12.pdf">Circular No. 12 on revised audit standards for members</a> 2026-03-10</li>
 <li><a href="/contact">Contact the institute secretariat office now</a></li>
</ul></body></html>"""

JP_NEWS = """<html><body><ul>
 <li><a href="/news/2026/0301.html">新会長の就任について</a><span>2026年3月1日</span></li>
 <li><a href="/news/2026/0215.html">お知らせ</a></li>
</ul></body></html>"""

GOOGLE_RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>ICAI announces new president - The Hindu</title><link>https://news.google.com/rss/articles/abc</link>
<guid>abc</guid><pubDate>Tue, 10 Mar 2026 08:00:00 GMT</pubDate><source url="https://thehindu.com">The Hindu</source></item>
<item><title>ICAI exam dates out - Mint</title><link>https://news.google.com/rss/articles/def</link>
<guid>def</guid><pubDate>Wed, 11 Mar 2026 08:00:00 GMT</pubDate><source url="https://livemint.com">Mint</source></item>
</channel></rss>"""

RSS_FEED = """<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title>PICPA welcomes new national president</title><link>https://picpa.com.ph/news/1</link>
<pubDate>Mon, 28 Jul 2026 00:00:00 GMT</pubDate><description>&lt;p&gt;Hello&lt;/p&gt;</description></item>
</channel></rss>"""


class FakeResp:
    def __init__(self, url, body, status=200):
        self.url, self.status_code = url, status
        self.content = body.encode("utf-8")
        self.encoding = "utf-8"
        self.apparent_encoding = "utf-8"
        self.text = body


def fake_fetch(pages):
    def _fetch(url, **kw):
        for key, body in pages.items():
            if url.startswith(key):
                return common.FetchResult(FakeResp(url, body))
        return common.FetchResult(FakeResp(url, "not found", 404))
    return _fetch


def pao(**kw):
    base = dict(id="icai", group="Member", jurisdiction="India", name="Institute of Chartered Accountants of India",
                abbr="ICAI", website="https://www.icai.org", search_terms='"Institute of Chartered Accountants of India"',
                news_locale="en-IN")
    base.update(kw)
    return PAO(**base)


def test_pao_file_loads():
    paos = load_paos()
    assert len(paos) >= 50
    ids = {p.id for p in paos}
    assert {"icai", "picpa", "jicpa", "acca", "icaew", "ifac"} <= ids
    acca = next(p for p in paos if p.id == "acca")
    assert acca.abbr == "ACCA" and acca.name.startswith("Association")


def test_dates():
    assert guess_date("12 Feb 2026").day == 12
    assert guess_date("March 3, 2026").month == 3
    assert guess_date("2026年3月1日").month == 3
    assert guess_date("posted 03/03/2026").year == 2026
    assert guess_date("nothing here") is None


def test_base_domain():
    assert base_domain("https://www.icmab.gov.bd/x") == "icmab.gov.bd"
    assert base_domain("http://www.cpaaustralia.com.au") == "cpaaustralia.com.au"
    assert base_domain("mail.icai.org") == "icai.org"


def test_website_news_page(monkeypatch):
    monkeypatch.setattr(websites, "fetch", fake_fetch({"https://www.icai.org/news": NEWS, "https://www.icai.org": HOME}))
    res = websites.collect(pao())
    titles = {i.title for i in res.items}
    assert res.ok
    assert "Announcement regarding CPD hours for the year 2026" in titles
    assert "Circular No. 12 on revised audit standards for members" in titles
    assert not any("Facebook" in t or "Contact" in t or "Login" in t for t in titles)
    # same article on homepage and news page (one with utm tag) -> one item
    assert sum("Ranjeet" in t for t in titles) == 1
    pdf = next(i for i in res.items if i.url.endswith(".pdf"))
    assert pdf.published_at.startswith("2026-03-10")


def test_website_selector_and_cjk(monkeypatch):
    p = pao(id="jicpa", website="https://jicpa.or.jp", news_url="https://jicpa.or.jp/news/", news_locale="ja-JP")
    monkeypatch.setattr(websites, "fetch", fake_fetch({"https://jicpa.or.jp/news/": JP_NEWS, "https://jicpa.or.jp": "<html></html>"}))
    res = websites.collect(p)
    assert [i.title for i in res.items] == ["新会長の就任について"]
    assert res.items[0].language == "ja" and res.items[0].published_at.startswith("2026-03-01")


def test_website_feed(monkeypatch):
    p = pao(id="picpa", website="https://picpa.com.ph", feed_url="https://picpa.com.ph/feed")
    monkeypatch.setattr(websites, "fetch", fake_fetch({"https://picpa.com.ph/feed": RSS_FEED}))
    res = websites.collect(p)
    assert len(res.items) == 1 and res.items[0].snippet == "Hello"


def test_website_down(monkeypatch):
    monkeypatch.setattr(websites, "fetch", fake_fetch({}))
    res = websites.collect(pao())
    assert not res.ok and "404" in res.message


def test_google_news(monkeypatch):
    assert news_search.google_params("zh-HK") == ("zh-HK", "HK", "HK:zh-Hant")
    assert news_search.google_params("en-IN") == ("en-IN", "IN", "IN:en")
    assert news_search.google_params("ja-JP") == ("ja", "JP", "JP:ja")
    assert news_search.parse_term('zh-HK>香港會計師公會', "en-HK") == ("zh-HK", "香港會計師公會")
    assert news_search.parse_term('"A>B" thing', "en-US") == ("en-US", '"A>B" thing')
    monkeypatch.setattr(news_search, "fetch", fake_fetch({"https://news.google.com": GOOGLE_RSS}))
    res = news_search.collect_google(pao(search_terms='"ICAI" president|"Institute of Chartered Accountants of India"'))
    assert res.ok and len(res.items) == 2  # same articles from 2 searches -> deduped
    assert res.items[0].title == "ICAI announces new president" and res.items[0].source_name == "The Hindu"


def test_newsapi_budget_and_errors(monkeypatch):
    calls = []

    class S:
        def get(self, url, **kw):
            calls.append(kw["params"]["q"])
            body = {"status": "ok", "articles": [{"url": "https://x.com/a", "title": "ICAI news", "source": {"name": "X"},
                                                  "publishedAt": "2026-03-01T00:00:00Z", "description": "d"}]}
            return type("R", (), {"json": lambda self: body})()
    monkeypatch.setattr(news_search, "session", lambda: S())
    api = news_search.NewsAPI(key="k")
    res = api.collect(pao(search_terms='zh-HK>中文|"Institute of Chartered Accountants of India"'))
    assert calls == ['"Institute of Chartered Accountants of India"'] and len(res.items) == 1
    assert news_search.NewsAPI(key="").collect(pao()).skipped


def make_email(sender, subject, body):
    m = EmailMessage()
    m["From"], m["Subject"], m["Message-ID"] = sender, subject, "<abc123@mail.example>"
    m["Date"] = "Tue, 28 Jul 2026 10:00:00 +0800"
    m.set_content(body)
    return m.as_bytes()


def test_email_matching():
    paos = [pao(), pao(id="picpa", name="Philippine Institute of Certified Public Accountants", abbr="PICPA",
                        website="https://picpa.com.ph")]
    by_domain = email_inbox.parse_message(make_email("Comms <press@picpa.com.ph>", "Press release", "New president"), paos)
    assert [i.pao_id for i in by_domain] == ["picpa"]
    by_name = email_inbox.parse_message(make_email("x@gmail.com", "Update", "The PICPA board met today"), paos)
    assert [i.pao_id for i in by_name] == ["picpa"]
    nobody = email_inbox.parse_message(make_email("x@gmail.com", "Hello", "nothing relevant"), paos)
    assert [i.pao_id for i in nobody] == [email_inbox.UNMATCHED_ID]
    assert "rfc822msgid" in nobody[0].url and nobody[0].published_at.startswith("2026-07-28")


def test_email_without_credentials(monkeypatch):
    monkeypatch.delenv("GMAIL_ADDRESS", raising=False)
    res, items = email_inbox.collect([])
    assert res.skipped and items == []


def test_full_run_baseline_then_new(monkeypatch, tmp_path):
    """First run: website links are baseline. Second run: only genuinely new links appear, not as baseline."""
    from collector import store as store_mod
    monkeypatch.setattr(store_mod, "ROOT", tmp_path)
    monkeypatch.setattr(main, "load_paos", lambda: [pao()])
    monkeypatch.delenv("GMAIL_ADDRESS", raising=False)
    monkeypatch.delenv("NEWSAPI_KEY", raising=False)
    pages = {"https://www.icai.org/news": NEWS, "https://www.icai.org": HOME, "https://news.google.com": GOOGLE_RSS}
    monkeypatch.setattr(websites, "fetch", fake_fetch(pages))
    monkeypatch.setattr(news_search, "fetch", fake_fetch(pages))
    from collector import pagewatch
    monkeypatch.setattr(pagewatch, "fetch", fake_fetch(pages))

    s1 = main.run(dry_run=True)
    data = json.loads((tmp_path / "data" / "local.json").read_text())
    web = [i for i in data["items"].values() if i["source"] == "website"]
    assert web and all(i["is_baseline"] for i in web)
    gn = [i for i in data["items"].values() if i["source"] == "google_news"]
    assert gn and not any(i["is_baseline"] for i in gn)
    assert "_unmatched_email" in data["paos"] and data["health"]["icai::website"]["status"] == "ok"

    pages["https://www.icai.org/news"] = NEWS.replace(
        "<ul>", '<ul><li><a href="/post/council-election-results-2026">Results of the Council election 2026 announced today</a></li>', 1)
    s2 = main.run(dry_run=True)
    data = json.loads((tmp_path / "data" / "local.json").read_text())
    new = [i for i in data["items"].values() if "Council election" in i["title"]]
    assert len(new) == 1 and new[0]["is_baseline"] is False
    assert s2["new"] == 1 and data["health"]["icai::website"]["items_new"] == 1
    assert data["health"]["icai::google_news"]["items_new"] == 0
