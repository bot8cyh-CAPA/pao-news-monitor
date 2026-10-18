"""Where results are saved: Supabase (normal) or a local JSON file (--dry-run)."""
import json
import os
from pathlib import Path
from urllib.parse import quote

from .common import ROOT, clean, log, session


class SupabaseStore:
    """Talks to Supabase's REST API with the service key (server side only)."""

    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        # Own User-Agent: Supabase refuses secret keys from anything that looks like a browser
        self.headers = {"apikey": key, "Content-Type": "application/json", "User-Agent": "pao-news-monitor/1.0"}
        if key.startswith("eyJ"):  # legacy JWT-style key
            self.headers["Authorization"] = f"Bearer {key}"

    def _req(self, method, path, **kw):
        headers = {**self.headers, **kw.pop("headers", {})}
        r = session().request(method, self.base + path, headers=headers, timeout=60, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"Supabase {method} {path.split('?')[0]} failed {r.status_code}: {clean(r.text, 300)}")
        return r

    def load_health(self):
        rows = self._req("GET", "/source_health?select=*").json()
        return {(r["pao_id"], r["source"]): r for r in rows}

    def load_pao_rows(self):
        return self._req("GET", "/paos?select=*&order=sort_order").json()

    # ---- weekly brief ----
    def has_briefs(self):
        try:
            self._req("GET", "/briefs?select=id&limit=1")
            self._req("GET", "/items?select=ai_summary&limit=1")
            return True
        except RuntimeError:
            return False

    def items_since(self, since_iso):
        cols = "id,pao_id,source,title,url,published_at,snippet,language,is_baseline,first_seen_at,relevance,category,kind"
        since_iso = quote(since_iso.replace("+00:00", "Z"), safe=":-.TZ")
        rows = []
        for start in range(0, 20000, 1000):
            got = self._req("GET", f"/items?select={cols}&or=(first_seen_at.gte.{since_iso},published_at.gte.{since_iso})"
                                   "&order=first_seen_at.desc", headers={"Range": f"{start}-{start + 999}"}).json()
            rows += got
            if len(got) < 1000:
                break
        return rows

    def save_item_ai(self, rows):
        for i in range(0, len(rows), 200):
            self._req("POST", "/items?on_conflict=id", json=rows[i:i + 200],
                      headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def save_brief(self, row):
        """Save a new draft and remove older drafts for an overlapping period that nobody
        edited or approved (they're superseded). Edited or approved briefs are always kept."""
        self._req("POST", "/briefs", json=row, headers={"Prefer": "return=minimal"})
        start = quote(row["period_start"].replace("+00:00", "Z"), safe=":-.TZ")
        created = quote(row["created_at"].replace("+00:00", "Z"), safe=":-.TZ")
        self._req("DELETE", f"/briefs?status=eq.draft&edited_by=is.null&period_end=gt.{start}&created_at=lt.{created}",
                  headers={"Prefer": "return=minimal"})

    def schema_problems(self):
        """What's missing from the database (supabase/update-2.sql not run yet)."""
        problems = []
        for path, what in (("/items?select=kind&limit=1", "items.kind column"),
                           ("/paos?select=facebook,lang,search_terms,config_seeded&limit=1", "paos member-list columns"),
                           ("/watched_pages?select=url&limit=1", "watched_pages table")):
            try:
                self._req("GET", path)
            except RuntimeError:
                problems.append(what)
        return problems

    def load_pages(self):
        rows = []
        for start in range(0, 100000, 1000):
            got = self._req("GET", "/watched_pages?select=pao_id,url,kind,snapshot,first_seen_at",
                            headers={"Range": f"{start}-{start + 999}"}).json()
            rows += got
            if len(got) < 1000:
                break
        return {(r["pao_id"], r["url"], r["kind"]): r for r in rows}

    def save_pages(self, rows):
        # rows with different columns must go in separate requests
        groups = {}
        for r in rows:
            groups.setdefault(tuple(sorted(r)), []).append(r)
        for group in groups.values():
            for i in range(0, len(group), 200):
                self._req("POST", "/watched_pages?on_conflict=pao_id,url,kind", json=group[i:i + 200],
                          headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def existing_ids(self, ids):
        found = set()
        ids = list(ids)
        for i in range(0, len(ids), 150):
            chunk = ",".join(ids[i:i + 150])
            rows = self._req("GET", f"/items?select=id&id=in.({chunk})").json()
            found |= {r["id"] for r in rows}
        return found

    def save_paos(self, rows):
        self._req("POST", "/paos?on_conflict=id", json=rows,
                  headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def insert_items(self, rows):
        """Insert new items; rows that already exist are left untouched
        (so your team's tags are never overwritten). Returns inserted ids."""
        inserted = set()
        for i in range(0, len(rows), 200):
            r = self._req("POST", "/items?on_conflict=id&select=id", json=rows[i:i + 200],
                          headers={"Prefer": "resolution=ignore-duplicates,return=representation"})
            inserted |= {x["id"] for x in r.json()}
        return inserted

    def save_health(self, rows):
        if rows:
            self._req("POST", "/source_health?on_conflict=pao_id,source", json=rows,
                      headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def log_run(self, row):
        self._req("POST", "/runs", json=row, headers={"Prefer": "return=minimal"})


class JsonStore:
    """Dry-run store: everything goes to data/local.json so you can look at it."""

    def __init__(self, path=None):
        self.path = Path(path or ROOT / "data" / "local.json")
        self.data = {"paos": {}, "items": {}, "health": {}, "runs": [], "pages": {}}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        self.data.setdefault("pages", {})

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")

    def load_health(self):
        return {tuple(k.split("::", 1)): v for k, v in self.data["health"].items()}

    def existing_ids(self, ids):
        return {i for i in ids if i in self.data["items"]}

    def schema_problems(self):
        return []

    def load_pao_rows(self):
        return sorted(self.data["paos"].values(), key=lambda r: r.get("sort_order") or 0)

    def has_briefs(self):
        return True

    def items_since(self, since_iso):
        return [dict(r) for r in self.data["items"].values()
                if (r.get("first_seen_at") or "") >= since_iso or (r.get("published_at") or "") >= since_iso]

    def save_item_ai(self, rows):
        for r in rows:
            self.data["items"].setdefault(r["id"], {}).update(r)
        self._save()

    def save_brief(self, row):
        self.data["briefs"] = [b for b in self.data.get("briefs", [])
                               if b.get("status") != "draft" or b.get("edited_by") or b["period_end"] <= row["period_start"]]
        self.data["briefs"].append(row)
        self._save()

    def load_pages(self):
        return {tuple(k.split("::", 2)): v for k, v in self.data["pages"].items()}

    def save_pages(self, rows):
        for r in rows:
            key = f'{r["pao_id"]}::{r["url"]}::{r["kind"]}'
            self.data["pages"][key] = {**self.data["pages"].get(key, {}), **r}
        self._save()

    def save_paos(self, rows):
        for r in rows:
            self.data["paos"][r["id"]] = r
        self._save()

    def insert_items(self, rows):
        new = set()
        for r in rows:
            if r["id"] not in self.data["items"]:
                self.data["items"][r["id"]] = {**r, "first_seen_at": r.get("first_seen_at")}
                new.add(r["id"])
        self._save()
        return new

    def save_health(self, rows):
        for r in rows:
            self.data["health"][f'{r["pao_id"]}::{r["source"]}'] = r
        self._save()

    def log_run(self, row):
        self.data["runs"].append(row)
        self._save()


def get_store(dry_run=False):
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if dry_run or not (url and key):
        if not dry_run:
            log.warning("SUPABASE_URL / SUPABASE_SERVICE_KEY not set - saving to data/local.json instead")
        return JsonStore()
    return SupabaseStore(url, key)
