"""Source 4: press releases emailed to the monitor inbox (Gmail via IMAP).

Needs two secrets: GMAIL_ADDRESS and GMAIL_APP_PASSWORD (a Google
"app password", not the normal password). Read-only: nothing is deleted
or marked as read.

Each email is matched to a PAO by:
  1. the sender's domain matching the PAO's website domain, otherwise
  2. the PAO's full name or abbreviation appearing in the subject/body.
Emails that match nobody go to the "Unmatched emails" section.
"""
import email
import imaplib
import os
import re
from datetime import timedelta
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from urllib.parse import quote

from bs4 import BeautifulSoup

from .common import Item, SourceResult, base_domain, clean, iso, log, make_id, now_utc

SOURCE = "email"
UNMATCHED_ID = "_unmatched_email"
MAX_MESSAGES = 300
FIRST_RUN_DAYS = 35


def _decode(value):
    try:
        return str(make_header(decode_header(value or "")))
    except Exception:  # noqa: BLE001
        return value or ""


def body_text(msg):
    plain, html = [], []
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.get_content_maintype() == "multipart" or part.get("Content-Disposition", "").startswith("attachment"):
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")
        (plain if ctype == "text/plain" else html).append(text)
    if plain:
        return "\n".join(plain)
    if html:
        return BeautifulSoup("\n".join(html), "lxml").get_text("\n")
    return ""


def match_paos(sender, subject, body, paos):
    domain = base_domain(sender.split("@")[-1]) if "@" in sender else ""
    by_domain = [p for p in paos if p.website and domain and base_domain(p.website) == domain]
    if by_domain:
        return by_domain
    hay = f"{subject}\n{body[:20000]}"
    hits = []
    for p in paos:
        if p.name and len(p.name) > 8 and p.name.lower() in hay.lower():
            hits.append(p)
        elif p.abbr and len(p.abbr) >= 4 and re.search(rf"(?<![A-Za-z]){re.escape(p.abbr)}(?![A-Za-z])", hay):
            hits.append(p)
    return hits


def parse_message(raw, paos):
    msg = email.message_from_bytes(raw)
    subject = clean(_decode(msg.get("Subject"))) or "(no subject)"
    from_name, sender = parseaddr(_decode(msg.get("From")))
    msgid = (msg.get("Message-ID") or "").strip()
    try:
        date = parsedate_to_datetime(msg.get("Date"))
    except Exception:  # noqa: BLE001
        date = None
    text = clean(body_text(msg))
    targets = match_paos(sender, subject, text, paos) or [None]
    link = f"https://mail.google.com/mail/#search/rfc822msgid%3A{quote(msgid.strip('<>'))}" if msgid else ""
    items = []
    for p in targets:
        pid = p.id if p else UNMATCHED_ID
        items.append(Item(
            id=make_id(pid, SOURCE, msgid or f"{sender}|{subject}|{date}"), pao_id=pid, source=SOURCE,
            title=subject, url=link, published_at=iso(date), snippet=text[:600],
            content=text[:20000], source_name=f"{from_name} <{sender}>".strip(),
            language=p.language if p else ""))
    return items


def collect(paos, since=None):
    """Returns one SourceResult per PAO that got mail, plus an overall status."""
    address = os.environ.get("GMAIL_ADDRESS", "").strip()
    password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    overall = SourceResult("_inbox", SOURCE)
    if not address or not password:
        overall.skipped, overall.message = True, "GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set"
        return overall, []
    since = since or (now_utc() - timedelta(days=FIRST_RUN_DAYS))
    since = since - timedelta(days=2)  # small overlap; duplicates are ignored
    items = []
    try:
        imap = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        imap.login(address, password)
        imap.select("INBOX", readonly=True)
        status, data = imap.search(None, "SINCE", since.strftime("%d-%b-%Y"))
        ids = data[0].split()[-MAX_MESSAGES:] if status == "OK" and data and data[0] else []
        for num in ids:
            status, parts = imap.fetch(num, "(BODY.PEEK[])")
            if status != "OK" or not parts or not isinstance(parts[0], tuple):
                continue
            try:
                items += parse_message(parts[0][1], paos)
            except Exception as e:  # noqa: BLE001
                log.info("email %s parse failed: %s", num, e)
        imap.logout()
        overall.message = f"Read {len(ids)} email(s) since {since.date()}"
    except imaplib.IMAP4.error as e:
        overall.ok = False
        overall.message = f"Gmail login/read failed: {clean(str(e), 200)} (check the app password)"
    except Exception as e:  # noqa: BLE001
        overall.ok = False
        overall.message = f"{type(e).__name__}: {clean(str(e), 200)}"
    return overall, items
