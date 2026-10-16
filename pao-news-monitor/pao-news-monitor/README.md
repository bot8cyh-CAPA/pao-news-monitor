# PAO News Monitor

Every morning this tool checks the CAPA member bodies and stakeholders for news, and puts what it finds on a web page grouped by organisation. Every organisation is listed, even when nothing was found. Your team decides what's relevant: mark items **Relevant** or **Not relevant**, give them a category, add notes, then export to CSV for the newsletter.

**Where the news comes from**

| Source | What it catches |
|---|---|
| **Websites** | New links on each PAO's own news, announcements or press pages. No per-site setup is needed, and non-English pages work. |
| **Google News** | Coverage *about* each PAO in other outlets, including local and non-English press. |
| **NewsAPI** | A second news search (free plan). |
| **Email** | Press releases sent to the monitor inbox (`bot8cyh@gmail.com`). |
| **Added by team** | Anything you find yourselves, e.g. on LinkedIn. Use **+ Add item** on the page. |

LinkedIn is not scraped, because that's against LinkedIn's terms. Each PAO has a **LinkedIn** button that opens a LinkedIn search so you can check by hand.

---

## One-time setup (about 30–45 minutes)

### 1. Put these files in GitHub
On your repository page, choose **Add file → Upload files**. Drag in *everything inside* this folder, including the hidden `.github` folder (show hidden files if you can't see it). Then click **Commit changes**.

### 2. Create the database (Supabase, free)
1. Go to <https://supabase.com>, sign up and click **New project**. Pick the **Singapore** region and any strong database password.
2. When the project is ready, open **SQL Editor → New query**. Paste the whole of `supabase/schema.sql` and click **Run**.
3. Go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up", so only invited people can get in.
4. Go to **Project Settings → API Keys** and keep this tab open. You need:
   - the **Project URL** (also under Project Settings → Data API), like `https://abcd1234.supabase.co`
   - the **publishable** key (or the legacy **anon** key), which is safe to put in the web page
   - the **secret** key (or the legacy **service_role** key), which must **never** go in any file

### 3. Add the secret keys to GitHub
In your repo go to **Settings → Secrets and variables → Actions → New repository secret** and add each of these:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 2 |
| `SUPABASE_SERVICE_KEY` | the **secret** / service_role key |
| `NEWSAPI_KEY` | your NewsAPI key |
| `GMAIL_ADDRESS` | `bot8cyh@gmail.com` |
| `GMAIL_APP_PASSWORD` | the 16-letter Google app password |

Secrets are encrypted. Nobody, including you, can read them back from GitHub, and they never appear in the code.

### 4. Connect the web page to the database
In GitHub, open `web/config.js`, click the pencil icon, and fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the **publishable** key). Commit.

### 5. Run the first collection
Go to **Actions → Collect news → Run workflow → Run workflow**. It takes a few minutes. Click the run to see a table of every PAO and source with what it found.

> The first scan of each website saves its existing links as **"first scan"** and hides them by default, so you don't get 80 old links per site on day one. From the next run onward, only genuinely new links show up. Tick **Include first-scan links** on the page to see the hidden ones.

### 6. Publish the page (Cloudflare Pages, free)
1. Go to <https://dash.cloudflare.com>, then **Workers & Pages → Create → Pages → Connect to Git**, and choose this repository.
2. Framework preset: **None**. Build command: *(leave empty)*. Build output directory: **`web`**.
3. Click **Save and Deploy**. You'll get an address like `https://pao-news-monitor.pages.dev`.

### 7. Tell Supabase the page's address
In Supabase, go to **Authentication → URL Configuration**. Set **Site URL** to your Cloudflare address and add the same address under **Redirect URLs**. Sign-in links won't work without this.

### 8. Invite your team and sign in
In Supabase, go to **Authentication → Users → Invite user** and invite each teammate's email, including your own. (Do this *after* step 7 so the invite links point to the right page.) Then open the Cloudflare address, enter your email, and click the link that arrives. Done. To add someone later, invite them the same way. To remove someone, delete them from that list.

### Getting press releases into the inbox
- Ask each PAO's communications team to add `bot8cyh@gmail.com` to their press or media list.
- If a press release reaches *your* inbox, just **forward it** to `bot8cyh@gmail.com`. It's matched to the right PAO by name.
- Emails that can't be matched to a PAO appear under **Inbox → Unmatched emails**.

---

## Day to day

- The collection runs automatically every day at about **5:40am Malaysia time**.
- The **coloured dots** in the sidebar show health: green means fine, amber means needs a look, red means a source failed. The red/amber notes inside each PAO's box say exactly what's wrong.
- An amber "**No new links for 60+ days**" note means that site may have changed in a way that hides new posts. Open the site and check.
- **Export CSV** downloads exactly what's on screen. Set "Show: Relevant only" and the period first to get your newsletter shortlist.

## Fixing things yourself (no coding)

All of these are edits to **`config/paos.csv`**. Open it in GitHub, click the pencil, edit, and commit. To re-check just one PAO afterwards, use **Actions → Collect news → Run workflow** and type its id (e.g. `icai`) in the first box.

| Problem | Fix |
|---|---|
| A PAO changed its website address | Update the `website` column. (If the old address redirects, the health note will tell you the new one.) |
| Site found no news / grabbed the wrong page | Put the exact news page address in `news_url`. Separate several pages with `\|`. |
| Site has an RSS feed | Put the feed address in `feed_url`. This is the most reliable option. |
| Too many junk links from one site | Put a CSS selector in `link_selector` (e.g. `.news-list a`). Only those links are used. Ask Claude if unsure. |
| Google News results are off-target | Edit `search_terms`. Terms are separated by `\|`, and quotes mean an exact phrase. Start a term with a locale such as `zh-HK>` to search another country's edition. |
| Add a new PAO | Add a row with a new short `id` (lowercase, no spaces). Copy another row's format. |
| Stop monitoring one | Set `active` to `no`. Don't delete the row. |

**Columns:** `id`, `group` (Member / Associate / Affiliate / Stakeholder), `jurisdiction`, `name`, `abbr`, `website`, `news_url`, `feed_url`, `search_terms`, `news_locale` (Google News edition, e.g. `en-IN`, `ja-JP`, `zh-CN`), `link_selector`, `active`, `notes`.

**Send to Claude instead** if a site needs JavaScript to show its news (the health note says so), a whole source keeps failing for every PAO, or anything involving the code itself. Include the error text from the Actions run.

## Known limits
- Some sites only show their news with JavaScript, and the collector can't read those yet. They're flagged amber.
- NewsAPI's free plan is officially for development use, and articles appear 24 hours late. Google News is the main news search; NewsAPI is just a bonus.
- The **Translate** button uses Google Translate. Machine translation is fine for skimming, but verify before quoting.
- Supabase's free plan pauses projects after a week with no activity. The daily collection counts as activity, so this won't happen while it's running.

## For developers
```
pip install -r requirements.txt pytest
python -m pytest -q                         # offline tests
python -m collector --dry-run --only icai   # real fetch, saves to data/local.json
python tests/make_demo_data.py              # rebuild web/demo-data.json
```
With `web/config.js` left empty, the page runs in demo mode with sample data (`cd web && python -m http.server`).
