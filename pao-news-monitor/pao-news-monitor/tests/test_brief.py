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


# items reach the tagger most useful first: page-watch change (e), then website items a, b
TAGS = json.dumps([
    {"n": 1, "summary": "ICAI announced a new president on its website.", "themes": ["other"], "importance": 3, "leadership": True},
    {"n": 2, "summary": "ICAI launched an AI audit toolkit.", "themes": ["ai_digital"], "importance": 3, "leadership": False},
    {"n": 3, "summary": "IESBA consults on technology ethics; comments due 30 Nov.", "themes": ["ethics_standards", "ai_digital"], "importance": 3},
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


def test_unreadable_200_skips_model():
    """A retired endpoint answering 200 'OK' must not be retried all run."""
    class Plain(FakeResp):
        headers = {"content-type": "text/plain"}
    http = FakeHTTP({"m1": [Plain(200, None, text="OK")], "m2": [answer("fine")]})
    c = ai.Chain(env=ENV, session=http, sleep=lambda s: None)
    assert c.ask("fast", "s", "u") == ("fine", "github:m2")
    assert c.ask("fast", "s", "u") == ("fine", "github:m2")
    assert http.calls == ["m1", "m2", "m2"]


def test_default_chain_uses_free_providers_with_keys():
    c = ai.Chain(env={"GEMINI_API_KEY": "g", "GROQ_API_KEY": "q", "CF_ACCOUNT_ID": "a", "CF_AI_TOKEN": "t", "OPENROUTER_API_KEY": "o"})
    order = [s.split(":")[0] for s, *_ in c.chain("smart")]
    firsts = [p for i, p in enumerate(order) if p not in order[:i]]
    assert firsts == ["gemini", "groq", "cloudflare", "openrouter"]     # OpenRouter is the last resort
    assert "github" not in order


def test_cut_off_answer_retried_with_more_room_then_next_model():
    cut = FakeResp(200, {"choices": [{"message": {"content": "## Headlines\n- half"}, "finish_reason": "length"}]})
    http = FakeHTTP({"big": [cut, cut], "m2": [answer("complete brief")]})
    c = ai.Chain(env=ENV, session=http, sleep=lambda s: None)
    assert c.ask("smart", "s", "u", max_tokens=100) == ("complete brief", "github:m2")
    assert http.calls == ["big", "big", "m2"]
    assert any("cut off at 100" in l for l in c.log) and any("cut off at 300" in l for l in c.log)


def test_duplicate_headlines_merged_and_old_drafts_replaced(tmp_path):
    store = make_store(tmp_path)
    store.data["items"]["dup"] = dict(store.data["items"]["a"], id="dup", source="google_news")
    assert len(brief.gather(store, NOW - __import__("datetime").timedelta(days=7))) == 3
    chain = lambda: ai.Chain(env={}, session=FakeHTTP({}))
    store.save_brief(brief.build(store, chain=chain(), now=NOW))
    store.data["briefs"][0]["edited_by"] = None
    kept = dict(brief.build(store, chain=chain(), now=NOW), edited_by="me@capa")
    store.save_brief(kept)
    store.save_brief(brief.build(store, chain=chain(), now=NOW))
    assert len(store.data["briefs"]) == 2 and store.data["briefs"][0]["edited_by"] == "me@capa"


def test_ai_check_reports_each_model(monkeypatch):
    calls = []

    def fake_post(self, url, json=None, **kw):
        calls.append(json["model"])
        return answer("OK") if json["model"] == "gemini-3.8-flash" else FakeResp(429, text="quota")
    monkeypatch.setattr(ai.requests.Session, "post", fake_post)
    rows = ai.check(env={"GEMINI_API_KEY": "g", "AI_MODELS_SMART": "gemini:gemini-3.8-flash,gemini:x", "AI_MODELS_FAST": "gemini:x"})
    assert ("gemini:gemini-3.8-flash", True, "OK") in rows
    assert any(spec == "gemini:x" and not ok for spec, ok, _ in rows)


def test_only_items_published_in_the_week(tmp_path):
    store = make_store(tmp_path)
    # found this week, but published in June -> out; found this week with no date -> in
    store.data["items"]["june"] = dict(store.data["items"]["a"], id="june", title="ICAB elects leaders",
                                       published_at="2026-06-10T00:00:00+00:00", first_seen_at="2026-10-17T00:00:00+00:00")
    store.data["items"]["nodate"] = dict(store.data["items"]["a"], id="nodate", title="Undated notice",
                                         published_at=None, first_seen_at="2026-10-17T00:00:00+00:00")
    got = {i["id"] for i in brief.gather(store, NOW - __import__("datetime").timedelta(days=7))}
    assert "june" not in got and "nodate" in got and "a" in got


def test_staff_tags_steer_the_brief(tmp_path):
    store = make_store(tmp_path)
    store.data["items"]["a"]["relevance"] = "relevant"
    store.data["items"]["b"]["relevance"] = "country"
    lines, _ = brief.numbered(brief.pick_for_brief(brief.gather(store, NOW - __import__("datetime").timedelta(days=7))),
                              store.data["paos"])
    text = "\n".join(lines)
    assert "staff: REGIONAL" in text and "staff: COUNTRY-SPECIFIC" in text
    assert "## Country updates" in brief.BRIEF_SYSTEM
