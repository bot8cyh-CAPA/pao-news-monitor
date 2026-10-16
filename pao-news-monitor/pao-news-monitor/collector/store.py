"""Where results are saved: Supabase (normal) or a local JSON file (--dry-run)."""
import json
import os
from pathlib import Path

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
        self.data = {"paos": {}, "items": {}, "health": {}, "runs": []}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")

    def load_health(self):
        return {tuple(k.split("::", 1)): v for k, v in self.data["health"].items()}

    def existing_ids(self, ids):
        return {i for i in ids if i in self.data["items"]}

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
