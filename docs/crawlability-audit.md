# AI-bot crawlability audit (zero LLM cost)

Part of [`aeo-platform`](https://github.com/webappski/aeo-platform#readme) — moved out of the README so the npm page can show the README whole.

**The crawlability audit scores your domain against the 12-bot AI-crawler matrix (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, and 8 others) using ~3 HTTPS GETs against your `/robots.txt`, `/sitemap.xml`, and `/llms.txt`. No LLM calls, no auth, no cost. The composite **AI-Bot Crawl Readiness** score (0–100) weighs robots posture 30%, bots-not-blocked 25%, sitemap 25%, and whether your homepage content is in the served HTML 20%.**

`aeo-platform report` runs a pure-HTTP audit of your own domain against the AI-crawler matrix. No LLM calls. Roughly 3 HTTPS GETs.

| Bot | Owner | Purpose | Does blocking it cost citations? |
|---|---|---|---|
| `GPTBot` | OpenAI | Training crawl | No — training only |
| `OAI-SearchBot` | OpenAI | ChatGPT Search indexer | **Yes** — opted-out sites «will not be shown in ChatGPT search answers» |
| `ChatGPT-User` | OpenAI | On-demand fetch when a user pastes a URL | No — user-initiated, so robots rules may not apply anyway |
| `Google-Extended` | Google | Gemini training + grounding in other Google products | No — «does not impact a site's inclusion in Google Search» |
| `GoogleOther` | Google | General-purpose crawl | No — «doesn't affect any specific product» |
| `ClaudeBot` | Anthropic | Training crawl | No — training only |
| `Claude-Web` | Anthropic | Legacy UA, absent from Anthropic's current bot doc | No |
| `anthropic-ai` | Anthropic | Legacy UA, absent from Anthropic's current bot doc | No |
| `PerplexityBot` | Perplexity | Indexer for Perplexity's own ~200B-URL index | **Yes** — that index is Perplexity's own, so being in Google or Bing does not carry you into it (publisher content also arrives via third-party crawlers under agreements, but that route is not open to an ordinary site) |
| `Perplexity-User` | Perplexity | On-demand fetch | No — user-initiated, generally ignores robots.txt |
| `CCBot` | Common Crawl | Used by OpenAI, Anthropic, others as training data | No — training only |
| `Bytespider` | ByteDance | Doubao / China-market AI | No |

Two more crawlers **do** gate citations and this audit does **not** probe them yet: Anthropic's `Claude-SearchBot` and Google's `Googlebot` (for Google, the levers are `robots.txt`, `noindex` and `nosnippet` — not `Google-Extended`). Check those by hand.

Each bot is mapped to `allowed | blocked | partial | unspecified` from your `/robots.txt`. `sitemap.xml` and `llms.txt` presence are also checked. The composite **AI-Bot Crawl Readiness** score (0-100) weighs robots 30% · bots-not-blocked 25% · sitemap 25% · content in the served HTML 20%.

**`llms.txt` is measured but deliberately does not affect the score, and the report never tells you to add one.** Google states the file «isn't needed for AI Overviews, AI Mode, or other generative AI Search features»; a 2026 study across ~300,000 domains, reported by lumentir.com, found no relationship between having the file and how often a domain is cited; no major provider has confirmed support. It is reported as a fact so you can see the answer, nothing more. (Until 2026-08-02 the file carried 20% of this score and the report recommended creating one — that was wrong, and the change is written up in `CHANGELOG.md`, including why scores from before and after are not directly comparable.)

Note: this measures *technical access* — not actual answer-pool inclusion. Answer-pool inclusion is driven by off-page authority (Wikipedia, Reddit, listicles, review platforms) — covered in [Authority signals](https://github.com/webappski/aeo-platform/blob/main/README.md#authority-signals).
