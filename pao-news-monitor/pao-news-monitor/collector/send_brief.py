"""Email approved weekly briefs to the mailing list.

    python -m collector.send_brief

Runs every 10 minutes (.github/workflows/send.yml). Picks up briefs an admin has
asked to send (Send to mailing list > Send now), emails them from the monitor's Gmail
(GMAIL_ADDRESS / GMAIL_APP_PASSWORD) with everyone in BCC, and records the result.
Replies go to the admin who pressed Send.
"""
import html
import os
import re
import smtplib
import sys
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from .common import iso, now_utc
from .store import get_store

SENDER_NAME = os.environ.get("BRIEF_SENDER_NAME", "CAPA News Monitor")
BCC_PER_MESSAGE = 90          # Gmail accepts up to 100 recipients per message
AI_NOTE = re.compile(r"^>\s*(Draft written by AI|No AI model was available).*$", re.M)
FOOTER = ("This briefing was prepared with AI assistance from public sources and reviewed by CAPA staff. "
          "Numbers in [brackets] link to the sources.")


def for_sending(md):
    """Drop the 'draft written by AI - please review' banner meant for staff."""
    return re.sub(r"\n{3,}", "\n\n", AI_NOTE.sub("", md or "")).strip()


def _inline(text, sources):
    h = html.escape(text, quote=True)
    h = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", h)
    h = re.sub(r"(^|[^*])\*(?!\s)(.+?)\*(?!\*)", r"\1<em>\2</em>", h)
    h = re.sub(r"\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})+)\]", lambda m: "".join(f"[{n.strip()}]" for n in re.split(r"[,;]", m.group(1))), h)

    def cite(m):
        s = sources.get(int(m.group(1)))
        if s and s.get("url"):
            return (f'<a href="{html.escape(s["url"], quote=True)}" style="color:#0e5a57;text-decoration:none;font-size:80%;'
                    f'vertical-align:super" title="{html.escape(s.get("pao", "") + ": " + s.get("title", ""), quote=True)}">[{m.group(1)}]</a>')
        return f'<span style="font-size:80%;vertical-align:super">[{m.group(1)}]</span>'
    h = re.sub(r"\[(\d{1,3})\]", cite, h)
    h = re.sub(r"(^|\s)(https?://[^\s<]+)", lambda m: f'{m.group(1)}<a href="{m.group(2)}" style="color:#0e5a57">'
               f'{m.group(2) if len(m.group(2)) <= 70 else m.group(2)[:67] + "…"}</a>', h)
    return h


def to_html(md, source_list):
    """Same simple Markdown the web page renders, as email-safe HTML (inline styles)."""
    sources = {s["n"]: s for s in (source_list or []) if "n" in s}
    out, items, para = [], None, []
    sizes = {2: "20px", 3: "17px", 4: "15px", 5: "14px"}

    def flush_para():
        nonlocal para
        if para:
            out.append(f'<p style="margin:6px 0">{_inline(" ".join(para), sources)}</p>')
            para = []

    def flush_list():
        nonlocal items
        if items is not None:
            out.append('<ul style="margin:4px 0 10px;padding-left:20px">' + "".join(items) + "</ul>")
            items = None

    for raw in (md or "").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            flush_para(); flush_list(); continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            flush_para(); flush_list()
            lv = min(5, len(m.group(1)) + 1)
            border = "border-bottom:1px solid #ddd;padding-bottom:3px;" if lv == 3 else ""
            out.append(f'<h{lv} style="font-size:{sizes[lv]};margin:16px 0 6px;{border}">{_inline(m.group(2), sources)}</h{lv}>')
            continue
        m = re.match(r"^\s*[-*•]\s+(.*)$", line)
        if m:
            flush_para()
            items = (items or []) + [f'<li style="margin:3px 0">{_inline(m.group(1), sources)}</li>']
            continue
        m = re.match(r"^\[(\d+)\]\s+(.*)$", line)
        if m:
            flush_para()
            items = (items or []) + [f'<li style="margin:2px 0;list-style:none;margin-left:-20px;font-size:12px;color:#666">'
                                     f'{_inline("[" + m.group(1) + "] " + m.group(2), sources)}</li>']
            continue
        m = re.match(r"^>\s?(.*)$", line)
        if m:
            flush_para(); flush_list()
            out.append(f'<p style="margin:8px 0;padding:6px 10px;background:#f6f1e4;border-radius:4px;font-size:13px">{_inline(m.group(1), sources)}</p>')
            continue
        flush_list()
        para.append(line.strip())
    flush_para(); flush_list()
    body = "\n".join(out)
    return (f'<div style="font-family:Calibri,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1c1a;max-width:760px">'
            f'{body}<hr style="border:0;border-top:1px solid #ddd;margin:18px 0 8px">'
            f'<p style="font-size:12px;color:#777">{html.escape(FOOTER)}</p></div>')


def subject(brief):
    def d(iso_):
        from datetime import datetime
        return datetime.fromisoformat(iso_.replace("Z", "+00:00")).strftime("%d %b %Y") if iso_ else ""
    return f"CAPA weekly intelligence brief: {d(brief.get('period_start'))} – {d(brief.get('period_end'))}"


def build_messages(brief, recipients, sender):
    md = for_sending(brief.get("content"))
    html_body = to_html(md, brief.get("sources"))
    text_body = md + "\n\n" + FOOTER
    msgs = []
    for i in range(0, len(recipients), BCC_PER_MESSAGE):
        m = EmailMessage()
        m["Subject"] = subject(brief)
        m["From"] = formataddr((SENDER_NAME, sender))
        m["To"] = formataddr((SENDER_NAME, sender))        # everyone else in BCC
        if brief.get("send_requested_by"):
            m["Reply-To"] = brief["send_requested_by"]
        m["Message-ID"] = make_msgid(domain=sender.split("@")[-1])
        m.set_content(text_body)
        m.add_alternative(html_body, subtype="html")
        msgs.append((m, recipients[i:i + BCC_PER_MESSAGE]))
    return msgs


def send_pending(store, smtp_factory=None, env=None):
    env = env if env is not None else os.environ
    pending = store.briefs_to_send()
    if not pending:
        return []
    sender = env.get("GMAIL_ADDRESS", "").strip()
    password = env.get("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    results = []
    for brief in pending:
        recipients = [r["email"] for r in store.mailing_list() if r.get("active", True)]
        try:
            if not (sender and password):
                raise RuntimeError("GMAIL_ADDRESS / GMAIL_APP_PASSWORD secrets are not set")
            if not recipients:
                raise RuntimeError("the mailing list is empty")
            factory = smtp_factory or (lambda: smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60))
            with factory() as smtp:
                smtp.login(sender, password)
                for msg, bcc in build_messages(brief, recipients, sender):
                    smtp.send_message(msg, from_addr=sender, to_addrs=[sender] + bcc)
            store.update_brief(brief["id"], {"sent_at": iso(now_utc()), "sent_by": brief.get("send_requested_by"),
                                             "sent_to": len(recipients), "send_error": None})
            results.append((brief["id"], True, f"sent to {len(recipients)}"))
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}"[:300]
            store.update_brief(brief["id"], {"send_error": msg, "send_requested_at": None})
            results.append((brief["id"], False, msg))
    return results


def cli():
    store = get_store(False)
    if not hasattr(store, "briefs_to_send"):
        sys.exit("No database configured")
    for bid, ok, detail in send_pending(store):
        print(f"::{'notice' if ok else 'error'} title=Send brief::brief {bid}: {detail}")


if __name__ == "__main__":
    cli()
