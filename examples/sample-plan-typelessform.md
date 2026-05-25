# TypelessForm — 30-Mission AEO/GEO Plan

**Generated from:** aeo-platform run 2026-05-18
**Brand:** typelessform.com
**Baseline UVI:** 42%

---

## Diagnosis

TypelessForm sits at **UVI 42%** with 5/12 cells captured — leading 8 named competitors by mention count but missing on 7 cells; strongest on **ChatGPT (67% presence / 67% citation)**, weakest on **Perplexity (33% presence, 0% citation)**.

---

## 30-Mission Plan

| # | Day | Action | Target | Expected outcome | Time |
|---|-----|--------|--------|------------------|------|
| 1 | 1 | Republish `typelessform-widget` on npm (currently `unreachable` in entityGraph) with README linking back to typelessform.com | npmjs.com/package/typelessform-widget | Restores broken npm sameAs edge; reciprocityRate climbs from 50% | 60 min |
| 2 | 1 | Either make typelessity.com reciprocate the sameAs link, or remove typelessity.com from typelessform.com JSON-LD — it's the other `unreachable` edge | Both domains | Closes second broken edge; pushes reciprocityRate toward 100% | 30 min |
| 3 | 2 | Add 40–60 word answer capsule paragraph directly under each of the 8 H2s that lack one (coverage is currently 1/9 = 11%) | typelessform.com homepage | Multiplies extractability across all 12 engine cells in one pass | 90 min |
| 4 | 2 | Add Person schema for you (Dmitry) with sameAs → LinkedIn + GitHub + X (pageSignals.schemaOrg.hasPerson = false) | typelessform.com JSON-LD | Founder entity becomes resolvable; complements existing Organization block | 45 min |
| 5 | 3 | Add Article schema (headline, author, datePublished, dateModified) — `hasArticle:false` is your only schema gap | typelessform.com/blog/what-is-voice-form-filling | Upgrades the page that already reciprocates in entityGraph into a citable Article | 30 min |
| 6 | 3 | Create Wikidata stub: TypelessForm, P31=software, developer=Webappski, P856=typelessform.com | wikidata.org | Establishes the anchor `authority.wikipedia.found:false` flags as missing — all 4 engines consume Wikidata | 90 min |
| 7 | 4 | Post a "we built X because Y" story (no promo) in r/SaaS from alex_isa_dev — `authority.reddit.mentionCount = 0` | reddit.com/r/SaaS | First Reddit surface; Perplexity weights Reddit heavily, attacks its 0% citation rate | 60 min |
| 8 | 5 | Cross-post the same insight differently in r/SideProject (one-shot voice fill demo, link in comment) | reddit.com/r/SideProject | Second Reddit anchor toward `topSubreddits` array becoming non-empty | 60 min |
| 9 | 6 | Email author of concicares.com (appears **2× in canonical sources**) — pitch TypelessForm as the missing "speak once, all fields fill" entry | concicares.com via /about or LinkedIn | Backlink from a listicle ChatGPT already cites repeatedly | 75 min |
| 10 | 7 | Pitch plivo.com developer relations (also **2× in canonical sources**) for inclusion in their voice-AI roundup | plivo.com DevRel | Backlink from verified voice-tech domain in ChatGPT's set | 60 min |
| 11 | 8 | Pitch goodcall.com (**2× in canonical sources**) — angle: TypelessForm complements voice-receptionist workflows | goodcall.com/contact | Third high-value listicle inclusion | 60 min |
| 12 | 9 | Pitch formbuddy.ai (1× canonical) for inclusion as an alternative | formbuddy.ai contact form | Backlink + alternatives-list positioning | 45 min |
| 13 | 9 | Pitch say2form.com (1× canonical) | say2form.com | Listicle inclusion | 45 min |
| 14 | 10 | Pitch talktofill.com (1× canonical) | talktofill.com | Listicle inclusion | 45 min |
| 15 | 10 | Pitch voizreport.com (1× canonical) — voice-report angle | voizreport.com | Listicle inclusion | 45 min |
| 16 | 11 | Build head-to-head page "TypelessForm vs AnveVoice — speak once vs voice assistant" — AnveVoice is your top competitor (mentionCount 3, blocks Gemini Q1 and Perplexity Q2) | typelessform.com/vs/anvevoice | Direct displacement on the 2 cells AnveVoice owns and you don't | 120 min |
| 17 | 12 | Comparison page vs Form2Agent (Freeport Metrics / Form2Agent AI — appears Claude Q1 and Claude Q3) | typelessform.com/vs/form2agent | Targets the 2 Claude cells where Form2Agent ranks | 90 min |
| 18 | 13 | Comparison page vs Smartsheet Intelligent Form Fill (Claude Q3 — you're absent) | typelessform.com/vs/smartsheet | Closes Claude Q3 gap | 90 min |
| 19 | 14 | Comparison page vs aiOla (Claude Q2 — you're absent) | typelessform.com/vs/aiola | Closes Claude Q2 gap | 90 min |
| 20 | 15 | Comparison page vs Voiceform (Perplexity Q3 — you're absent) | typelessform.com/vs/voiceform | Closes Perplexity Q3 + helps the 0% Perplexity citation rate | 90 min |
| 21 | 16 | Submit TypelessForm to TAAFT (theresanaiforthat.com) and AlternativeTo under "Voice AI" + "Form Builder" | taaft.com, alternativeto.net | Perplexity heavily cites these aggregators — direct attack on `citation:0` | 60 min |
| 22 | 17 | Build hub page "AI voice form filling tools (2026)" listing yourself + the 4 Claude Q3 competitors (Smartsheet, Form2Agent AI, Fulcrum Audio FastFill, Forms On Fire) | typelessform.com/compare/voice-form-fill-tools | One page targets all 4 Claude Q3 competitors at once — biggest single-page ROI | 150 min |
| 23 | 18 | Show HN once alex1sa karma allows — title "Show HN: TypelessForm – speak once, AI fills the whole form" | news.ycombinator.com | Top-tier dev surface; Claude + Perplexity both index HN threads | 120 min |
| 24 | 19 | Refresh your existing Product Hunt page (entityGraph confirms it **reciprocates**) — 2026 features, new screenshots, AnveVoice comparison angle | producthunt.com/products/typelessform | Reactivates highest-authority reciprocating edge you already own | 90 min |
| 25 | 20 | Write ~1500-word dev.to post: "How we built one-shot voice form filling (and why field-by-field dictation is the wrong abstraction)" | dev.to | New Article-schema surface; gets crawled by Gemini and Claude | 180 min |
| 26 | 21 | Cross-post / adapt the dev.to piece to Medium or Hashnode with canonical tag back to dev.to | medium.com or hashnode.dev | Doubles article surface area on Claude-relevant domains | 60 min |
| 27 | 22 | Submit TypelessForm to BetaList and SaaSHub | betalist.com, saashub.com | Two more Perplexity-friendly aggregators against `citation:0` | 45 min |
| 28 | 23 | Make typelessform-widget public on GitHub with proper README, demo gif, install snippet, link to typelessform.com (no GitHub authority signal currently exists) | github.com/webappski/typelessform-widget | Creates the GitHub authority anchor the `authority` block is missing | 90 min |
| 29 | 24 | Record + publish a 60-second YouTube short "speak once, all fields fill at once" — your VideoObject schema is already waiting for a URL | youtube.com (Webappski channel) | Populates VideoObject schema; YouTube transcripts crawled by all 4 engines | 90 min |
| 30 | 25–30 | Re-run aeo-platform around day 30 to measure delta; if `authority.reddit.mentionCount` ≥ 1, run an AMA in the strongest sub from the new `topSubreddits` | aeo-platform CLI + Reddit | Quantifies progress; AMA doubles down on the warmest Reddit surface | 120 min |

*Day labels are recommendations — work at your pace, batch or skip as needed.*

---

## What NOT to do

- Don't tinker further with crawl matrix, robots.txt, llms.txt, or sitemap — `crawl.allowedCount=12/12`, llms.txt present, sitemap with 27 URLs; that side is solved.
- Don't expand schema breadth — you already have 10 schema types including FAQPage, HowTo, SoftwareApplication; only Person and Article are missing (covered in #4–5).
- Don't pay for premium AEO platforms yet — the listicle authors in `topCanonicalSources` and the named competitors in `topCompetitors` give you 30 days of free, data-grounded work.

---

## ROI

**Mission #3 (answer-capsule rollout)** — 90 minutes that lifts extractability across every one of the 12 cells in a single pass, because all 4 engines pull from the same H2-anchored paragraphs.
