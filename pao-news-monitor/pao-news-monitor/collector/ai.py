"""AI with a fallback chain: when one model runs out of free quota (or fails),
the next one is tried. All providers speak the same (OpenAI-style) language.

Order (each step only if its key is available):
  1. GitHub Models  - free, no key needed inside GitHub Actions (GITHUB_TOKEN)
  2. Google Gemini  - free tier, secret GEMINI_API_KEY
  3. Cloudflare Workers AI - free daily allowance, secrets CF_ACCOUNT_ID + CF_AI_TOKEN
  4. OpenRouter free models - secret OPENROUTER_API_KEY
If all fail, callers fall back to a no-AI result (e.g. a plain list).

Model lists can be changed without code via the AI_MODELS_FAST / AI_MODELS_SMART
environment variables ("provider:model,provider:model,...").
"""
import json
import os
import re
import time

import requests

from .common import log

GITHUB_URL = "https://models.github.ai/inference/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
CF_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# "fast" = tagging many items (cheap models, bigger free quotas); "smart" = writing the brief
DEFAULT_CHAINS = {
    "fast": ["github:openai/gpt-4.1-mini", "github:openai/gpt-4o-mini", "github:meta/Llama-3.3-70B-Instruct",
             "gemini:gemini-3.8-flash", "gemini:gemini-flash-latest",
             "cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare:@cf/meta/llama-3.1-8b-instruct",
             "openrouter:meta-llama/llama-3.3-70b-instruct:free"],
    "smart": ["github:openai/gpt-4.1", "github:openai/gpt-4o", "github:openai/gpt-4.1-mini",
              "github:meta/Llama-3.3-70B-Instruct", "gemini:gemini-3.8-flash", "gemini:gemini-flash-latest",
              "cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast", "openrouter:meta-llama/llama-3.3-70b-instruct:free"],
}


class AIUnavailable(Exception):
    """Every model in the chain failed or ran out of quota."""


class Chain:
    def __init__(self, env=None, session=None, sleep=time.sleep):
        self.env = env if env is not None else os.environ
        self.http = session or requests.Session()
        self.sleep = sleep
        self.dead = set()     # "provider:model" that failed for good this run (quota, no access, unknown model)
        self.used = []        # models that answered, in order
        self.log = []         # what happened, for the run summary

    # ---- configuration ----
    def chain(self, kind):
        custom = self.env.get(f"AI_MODELS_{kind.upper()}", "").strip()
        specs = [s.strip() for s in custom.split(",") if s.strip()] if custom else DEFAULT_CHAINS[kind]
        out = []
        for spec in specs:
            provider, _, model = spec.partition(":")
            target = self._target(provider, model)
            if target:
                out.append((spec, *target))
        return out

    def _target(self, provider, model):
        e = self.env
        if provider == "github" and e.get("GITHUB_TOKEN"):
            return GITHUB_URL, e["GITHUB_TOKEN"], model
        if provider == "gemini" and e.get("GEMINI_API_KEY"):
            return GEMINI_URL, e["GEMINI_API_KEY"], model
        if provider == "cloudflare" and e.get("CF_ACCOUNT_ID") and e.get("CF_AI_TOKEN"):
            return CF_URL.format(account=e["CF_ACCOUNT_ID"]), e["CF_AI_TOKEN"], model
        if provider == "openrouter" and e.get("OPENROUTER_API_KEY"):
            return OPENROUTER_URL, e["OPENROUTER_API_KEY"], model
        return None

    # ---- calling ----
    def ask(self, kind, system, user, max_tokens=1500, temperature=0.2):
        """Returns (text, model_spec). Raises AIUnavailable if nothing answers."""
        tried = []
        for spec, url, key, model in self.chain(kind):
            if spec in self.dead:
                continue
            tried.append(spec)
            for attempt in range(2):
                try:
                    r = self.http.post(url, timeout=120, headers={
                        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                        "User-Agent": "pao-news-monitor/1.0"},
                        json={"model": model, "temperature": temperature, "max_tokens": max_tokens,
                              "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
                except requests.RequestException as e:
                    self.log.append(f"{spec}: {type(e).__name__}")
                    if attempt == 0:
                        self.sleep(5)
                        continue
                    break
                if r.status_code == 200:
                    try:
                        text = r.json()["choices"][0]["message"]["content"] or ""
                    except (ValueError, KeyError, IndexError, TypeError):
                        ct = r.headers.get("content-type", "") if hasattr(r, "headers") else ""
                        self.log.append(f"{spec}: unreadable answer ({ct}) {r.text[:160]!r} via {getattr(r, 'url', url)}")
                        break
                    if text.strip():
                        self.used.append(spec)
                        return text, spec
                    self.log.append(f"{spec}: empty answer")
                    break
                if r.status_code >= 500 and attempt == 0:
                    self.sleep(5)
                    continue
                # 429 = free quota used up; 401/403/404/400 = no access or unknown model: skip for the rest of the run
                self.log.append(f"{spec}: HTTP {r.status_code} {r.text[:120]!r}")
                if r.status_code in (400, 401, 403, 404, 413, 422, 429) or r.status_code >= 500:
                    self.dead.add(spec)
                break
        raise AIUnavailable("no AI model answered (tried: " + (", ".join(tried) or "none - no keys available") + ")")


def parse_json(text):
    """JSON from a model answer, tolerating ```json fences and chatter around it."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        pass
    for open_, close in (("[", "]"), ("{", "}")):
        a, b = t.find(open_), t.rfind(close)
        if a != -1 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except ValueError:
                continue
    log.info("could not parse AI JSON: %s", t[:200])
    return None
