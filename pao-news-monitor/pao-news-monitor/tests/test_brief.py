"""Weekly brief: AI fallback chain + brief assembly (offline, fake AI)."""
import json
from datetime import datetime, timezone

import pytest

from collector import ai, brief
from collector.store import JsonStore


class FakeResp:
    def __init__(self, status, payload=None, text=""):
        self.status_code, self._payload, self.text = status, payload, text or json.dumps(payload or {})

    def json(self):
        if self._payload is None:
            raise ValueError
        return self._payload


def answer(text):
    return FakeResp(200, {"choices": [{"message": {"content": text}}]})


class FakeHTTP:
    """Replies by model name: a list of responses per model (popped in order)."""
    def __init__(self, plan):
        self.plan, self.calls = plan, []

    def post(self, url, json=None, **kw):
        self.calls.append(json["model"])
        q = self.plan.get(json["model"]) or [FakeResp(404, text="unknown model")]
        return q.pop(0) if len(q) > 1 else q[0]


ENV = {"GITHUB_TOKEN": "t", "AI_MODELS_FAST": "github:m1,github:m2,gemini:g1", "AI_MODELS_SMART": "github:big,github:m2"}


def test_chain_falls_back_on_quota_and_remembers():
    http = FakeHTTP({"m1": [FakeResp(429, text="rate limited")], "m2": [answer("hello")]})
    c = ai.Chain(env=ENV, session=http, sleep=lambda s: None)
    assert c.ask("fast", "s", "u") == ("hello", "github:m2")
    assert c.ask("fast", "s", "u") == ("hello", "github:m2")
    assert http.calls == ["m1", "m2", "m2"]          # m1 not retried after its quota ran out
    assert "github:m1" in c.dead and c.used == ["github:m2", "github:m2"]


def test_chain_skips_providers_without_keys_and_retries_5xx_once():
    http = FakeHTTP({"m1": [FakeResp(503, text="busy"), answer("ok")]})
    c = ai.Chain(env=ENV, session=http, sleep=lambda s: None)   # no GEMINI_API_KEY: g1 not in chain
    assert [s for s, *_ in c.chain("fast")] == ["github:m1", "github:m2"]
    assert c.ask("fast", "s", "u") == ("ok", "github:m1")


def test_chain_all_fail():
    c = ai.Chain(env={"GITHUB_TOKEN": "t", "AI_MODELS_FAST": "github:x"}, session=FakeHTTP({}), sleep=lambda s: None)
    with pytest.raises(ai.AIUnavailable):
        c.ask("fast", "s", "u")
    with pytest.raises(ai.AIUnavailable, match="no keys"):
        ai.Chain(env={}, session=FakeHTTP({})).ask("fast", "s", "u")


def test_parse_json_tolerates_fences():
    assert ai.parse_json('```json\n[{"n": 1}]\n```') == [{"n": 1}]
    assert ai.parse_json('Sure! Here it is: [{"n": 2}] hope that helps') == [{"n": 2}]
    assert ai.parse_json("nonsense") is None


# ---------- brief ----------
NOW = datetime(2026, 10, 19, 0, 0, tzinfo=timezone.utc)


def make_store(tmp_path):
    s = JsonStore(tmp_path / "local.json")
    s.data["paos"] = {
        "icai": dict(id="icai", grp="Member", jurisdiction="India", name="ICAI", abbr="ICAI", active=True, sort_order=1),
        "iesba": dict(id="iesba", grp="Stakeholder", jurisdiction="Global", name="IESBA", abbr="IESBA", active=True, sort_order=2),
        "sia": dict(id="sia", grp="Member", jurisdiction="Samoa", name="Samoa Institute", abbr="SIA", active=True, sort_order=3),
    }
    def item(i, pao, title, **kw):
        return {"id": i, "pao_id": pao, "source": "website", "title": title, "url": f"https://x.org/{i}",
                "first_seen_at": "2026-10-16T00:00:00+00:00", "published_at": "2026-10-15T00:00:00+00:00",
                "is_baseline": False, "relevance": None, "kind": "news", **kw}
    s.data["items"] = {
        "a": item("a", "icai", "ICAI launches AI audit toolkit for members"),
        "b": item("b", "iesba", "IESBA consultation on technology-related ethics, comments due 30 Nov"),
        "c": item("c", "icai", "Exam dates announced", relevance="not_relevant"),
        "d": item("d", "icai", "Old link", is_baseline=True),
        "e": item("e", "icai", "Leadership changed on website: + CA X | President", source="page_watch", kind="leadership"),
        "old": item("old", "icai", "Last month", first_seen_at="2026-09-01T00:00:00+00:00", published_at="2026-09-01T00:00:00+00:00"),
    }
    return s


# items reach the tagger newest first; equal dates keep their order: a, b, e
TAGS = json.dumps([
    {"n": 1, "summary": "ICAI launched an AI audit toolkit.", "themes": ["ai_digital"], "importance": 3, "leadership": False},
    {"n": 2, "summary": "IESBA consults on technology ethics; comments due 30 Nov.", "themes": ["ethics_standards", "ai_digital"], "importance": 3},
    {"n": 3, "summary": "ICAI announced a new president on its website.", "themes": ["other"], "importance": 3, "leadership": True},
])
BRIEF = "# Title the model added\n## Headlines\n- ICAI launched an AI audit toolkit [2]\n## Sources\n[1] junk the model made up"


def test_brief_with_ai(tmp_path):
    store = make_store(tmp_path)
    http = FakeHTTP({"m1": [answer(TAGS)], "big": [answer(BRIEF)]})
    row = brief.build(store, days=7, chain=ai.Chain(env=ENV, session=http, sleep=lambda s: None), now=NOW)
    c = row["content"]
    assert row["status"] == "draft" and row["stats"]["items"] == 3          # not_relevant, baseline and old excluded
    assert row["stats"]["tagged"] == 3 and row["models_used"] == "github:m1, github:big"
    assert c.startswith("# CAPA weekly intelligence brief") and "Title the model added" not in c
    assert "## Headlines" in c and "junk the model made up" not in c
    assert "## No news found this week\nSIA." in c                         # quiet PAOs by code, not AI
    assert "## Sources" in c and "https://x.org/a" in c
    # leadership item ranked into the brief, and AI tags saved on items
    assert {s["item_id"] for s in row["sources"]} == {"a", "b", "e"}
    assert store.data["items"]["a"]["ai_themes"] == ["ai_digital"]
    assert store.data["items"]["b"]["ai_summary"].startswith("IESBA consults")


def test_brief_without_ai_is_a_plain_list(tmp_path):
    store = make_store(tmp_path)
    row = brief.build(store, days=7, chain=ai.Chain(env={}, session=FakeHTTP({})), now=NOW)
    c = row["content"]
    assert row["models_used"] == "none (plain list)"
    assert "No AI model was available" in c and "### ICAI" in c and "### IESBA" in c
    assert "ICAI launches AI audit toolkit for members [" in c
    assert any("stopped" in n for n in row["stats"]["notes"])


def test_brief_when_writer_fails_after_tagging(tmp_path):
    store = make_store(tmp_path)
    http = FakeHTTP({"m1": [answer(TAGS)], "big": [FakeResp(429, text="quota")], "m2": [FakeResp(429, text="quota")]})
    row = brief.build(store, days=7, chain=ai.Chain(env=ENV, session=http, sleep=lambda s: None), now=NOW)
    assert "This week's items by organisation" in row["content"] and row["stats"]["tagged"] == 3
