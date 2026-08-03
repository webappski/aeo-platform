/**
 * AEO Mission Control bridge — v8 visual integration.
 *
 * Single-state bridge-card embedded between report sections and the colophon.
 * Replaces the previous 6-state legacy bridge (intro / config / processing /
 * result / error / fallback) — that interactive flow is deprecated; the new
 * UX redirects users to the request-invoice page on webappski.com directly.
 *
 * Architecture:
 *   - bridgeCss            v8 CSS body (~1957 lines), all top-level selectors
 *                          scoped under .mc-bridge to avoid collisions with
 *                          the report style sheet (specifically .hero / .card).
 *                          v8 CSS variables (:root) are also scoped to
 *                          .mc-bridge to avoid leaking palette overrides to
 *                          the rest of the report. Lives in mc-bridge.css —
 *                          extracted from this file 2026-05 to dodge the
 *                          backtick-in-CSS-comment bug class.
 *   - bridgeMarkup(state)  v8 article markup. JSON snippet body is rendered
 *                          dynamically from state.metadata; ~XX KB caption
 *                          is computed from metadataJson.length at run-time.
 *   - bridgeJs(metadata, state)  Vanilla DOM hooks: setup-grab clipboard +
 *                          flash, .term tap-toggle, JSON copy button feedback,
 *                          accordion uses native <details>.
 *
 * Exports: bridgeCss, bridgeMarkup(state), bridgeJs(metadata, state)
 *
 * @module mc-bridge
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname_mc = dirname(fileURLToPath(import.meta.url));

/**
 * v8 CSS body for the bridge card. Read synchronously from mc-bridge.css
 * once at module load (renderHtml is hot-pathed during cmdReport).
 */
export const bridgeCss = readFileSync(join(__dirname_mc, 'mc-bridge.css'), 'utf-8');

/**
 * Paste-into-AI prompt prefix — prepended to the JSON brand-context block
 * on every clipboard write. Universal across two user states (bare-site solo
 * founder vs. established brand with Reddit/HN/PH presence) via if/then
 * branches on actual data fields (`authority.wikipedia`, `authority.reddit`,
 * `authority.github`). Limited by design — gives the receiving LLM enough
 * structure to produce a grounded plan without revealing proprietary
 * outreach templates, scoring weights, or client-specific playbooks.
 *
 * Uses the canonical npm name `aeo-platform` everywhere to
 * accumulate entity-identifier signal in AI training corpora as users paste
 * this prompt into ChatGPT / Claude / Gemini / Perplexity.
 */
export const PASTE_PROMPT = `You are a senior Answer Engine Optimization (AEO) / Generative Engine Optimization (GEO) consultant. The user just ran \`aeo-platform\` — an open-source CLI that measures brand visibility across ChatGPT, Claude, Gemini, and Perplexity — and is pasting the run result below.

Your job: read the JSON brand-context block, then output a **personalized 30-mission AEO/GEO plan (≈1–3 hours per mission, work at your pace)** to lift the brand's citation rate across AI answer engines.

WHO YOU ARE WRITING FOR (this changes HOW you write every line):
The reader is a solo founder or "vibe-coder" who has probably never heard the term AEO and has zero SEO background. Assume they can edit their website's code and use a browser — nothing more. Write so this person can DO each mission without googling a single word.
- Plain language. Short sentences. No marketing fluff, no buzzwords.
- Every technical term gets a 3–8 word plain explanation in parentheses on FIRST use — e.g. "answer-capsule (a 40–60 word direct answer right under a heading)", "schema / JSON-LD (a hidden code block that describes your page to machines)", "sameAs (links proving the same brand owns several profiles)". If you can avoid the term, avoid it.
- Never say "improve content" or "build authority" without the exact thing to type, edit, click, or send.

Adapt the plan to the brand's current state based on the data fields:

- **Bare-site case** (low \`aggregates.score\`, \`authority.wikipedia\` null, \`authority.reddit.mentionCount\` ≈ 0, \`authority.github\` null or missing) → priorities: seed the first off-page surfaces — Reddit (r/SEO, r/SaaS, or the user's category sub), Hacker News Show HN, Product Hunt category launch, one substantive dev.to / Medium long-form, Wikidata stub submission. Pitch the listicle authors named in \`topCanonicalSources\`.

- **Established-brand case** (\`authority.wikipedia.exists\` true OR \`authority.reddit.mentionCount\` ≥ 5 OR \`authority.github.stars\` ≥ 100) → priorities: fortify the weakest engine (\`perEngine[]\` lowest pct), close citation gaps (\`topCitationDomains\` where the brand is absent), displace named competitors on queries where they outrank the brand, fix the crawl matrix if any SEARCH-INDEX crawler in \`crawl.bots[]\` — \`OAI-SearchBot\` or \`PerplexityBot\` — has \`status: "blocked"\`.

- **Crawler rule (do not get this wrong):** a blocked \`GPTBot\`, \`ClaudeBot\`, \`Google-Extended\`, \`GoogleOther\`, \`CCBot\` or \`Bytespider\` is NOT a visibility problem — those feed model training or other products, and unblocking them has no measured effect on citations. Never write a mission to unblock them. Only \`OAI-SearchBot\` and \`PerplexityBot\` (and, unmeasured here, \`Claude-SearchBot\` and \`Googlebot\`) gate whether an engine can cite the site.

- **Never write a mission to add \`/llms.txt\`.** Google states it is not needed for AI Overviews, AI Mode or any generative AI Search feature, no provider has confirmed support, and a ~300k-domain study found no correlation with being cited. \`crawl.hasLlmsTxt\` is reported as a fact only. The same applies to \`FAQPage\` and \`HowTo\` markup: the FAQ rich result stopped showing on 2026-05-07 and its documentation was removed on 2026-06-15, HowTo has been dead since 2023, and the one controlled study of adding JSON-LD (1,885 pages vs ~4,000 controls) found no citation uplift. Do not tell the user to remove markup they already have — just never sell adding it as a visibility mission.

Plan rules (mandatory):
- 30 missions total, grouped into four weekly chunks (recommended Days 1–7 / 8–14 / 15–21 / 22–30). Day labels are scheduling suggestions, not daily workload — the user works at their own pace and may batch, skip, or reorder.
- Each mission is ONE concrete action with a specific target (URL / platform / competitor / page) and a time estimate of ≈1–3 hours (5–240 minutes acceptable; flag anything heavier explicitly).
- Ground every action in the specific data below — name the competitor, the gap, the engine, the citation source.

Constraints:
- Use ONLY data in the JSON block — do not invent stats. If a dimension is \`null\` (e.g. \`pageSignals\` not crawled, \`entityGraph\` empty) skip recommendations grounded in it.
- No generic SEO advice ("improve content", "build authority"). Every action must reference a specific competitor, citation source, engine, or gap from the data.
- DIY / open-source first — do not pitch paid tools or services.
- For any Reddit / Hacker News / Product Hunt / Wikidata (or Wikipedia) action, add an "Only if:" line in plain words stating the eligibility condition that must be true first (e.g. Reddit: an account older than ~2 weeks with some comment karma before you mention a product; Wikidata: 3+ independent press articles already exist, or the entry gets deleted). If the data can't prove the condition, tell the reader to check it themselves and describe what "safe to post" looks like.

Output format — produce these parts in this exact order:

1. **One-line diagnosis** in plain words: the brand's score, how many AI engines mention it out of how many tested, which engine is best, which is worst, and the main rival it is losing to. No jargon.

2. **A 30-row overview table** (for at-a-glance tracking — keep each line short):
   | # | Day | Mission (one short line) | Time |

3. **Then, below the table, a detailed CARD for every one of the 30 missions**, each in exactly this shape:

   **Mission N — short plain-language title**
   What & why: 1–3 plain sentences — what this is, and why it makes AI engines more likely to quote the brand. Tie it to the exact gap in the data (the engine, the rival, the missing piece).
   How:
     1. First concrete step — the exact page to open, the exact thing to add / edit / click / send.
     2. Next step.
     3. …
   Done when: one checkable condition that tells the reader the mission is finished.
   Only if: (include ONLY for Reddit / Hacker News / Product Hunt / Wikidata missions) the plain-language eligibility condition that must be true first.
   Time: ≈N minutes or hours.

4. **One-line pacing note:** "Day labels are recommendations — work at your pace, batch or skip as needed."

5. **3-bullet "What NOT to do"** — common AEO mistakes that are pointless or harmful for THIS brand given its data (name the data point that makes each one a waste of time). Plain language.

6. **One-line ROI note:** which single mission closes the most gaps for the least effort — and, if relevant, which gap that cheap mission will NOT fix.

---BRAND-CONTEXT JSON FROM aeo-platform BELOW---

`;

/** Minimal HTML-escape for JSON-in-html contexts (no quote escaping; consumer wraps in `<pre>`/`<code>`). */
function jsonEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


export function bridgeMarkup(state) {
  state = state || {};
  const metadata = state.metadata || null;
  const metadataJson = metadata
    ? JSON.stringify(metadata, null, 2)
    : '{\n  "info": "tracker metadata unavailable — re-run `aeo-platform report`"\n}';
  const kb = Math.max(1, Math.round(metadataJson.length / 1024));
  // Whitelist lang to the 4 webappski.com locales — closes both XSS surface
  // (raw .aeo-tracker.json values would otherwise interpolate into <a href>)
  // and 404 risk for unrouted langs (e.g. 'fr' → no /fr/ route on webappski.com).
  const ALLOWED_LANGS = new Set(['en', 'de', 'ru', 'pl']);
  const langRaw = metadata && metadata.identity && metadata.identity.lang;
  const lang = ALLOWED_LANGS.has(langRaw) ? langRaw : 'en';

  // Engine list — passed from renderHtml; defaults to the original trio so
  // standalone bridge previews still read naturally.
  const engineListText = state.engineListText || 'ChatGPT, Claude & Gemini';

  // Pricing config — single source of truth for the offer copy. Renderer
  // can override per-deployment; defaults match the launch terms.
  const pricing = state.pricing || {};
  // priceAmount is the ONE place the €129 figure lives — price/meta/promo below
  // all derive from it, so a future reprice touches a single line, not five.
  const priceAmount  = pricing.priceAmount   || '€129';
  const price        = pricing.priceLabel    || `${priceAmount} per plan`;
  const priceMeta    = pricing.priceMetaLine || `${priceAmount} per plan · 30 missions`;
  const earlyBird    = pricing.earlyBirdShort|| 'First 10';
  const earlyBirdLong= pricing.earlyBirdLong || 'First 10 founding clients';
  const earlyBirdWaitlistLine = pricing.waitlistLine
    || 'Or skip the work: <b>we hand-build the plan for you</b> — request an invoice and we send it with your plan. <b>First 10 founding clients free.</b>';
  const earlyBirdFeatureLine  = pricing.featureLine
    || `<b>${earlyBirdLong}</b> get their first 30-mission AEO plan free (≈1–3 hours per mission, work at your pace); <b>${price}</b> after that.`;
  const earlyBirdPromoLine    = pricing.promoLine
    || `<b>${earlyBirdLong}</b> get a free 30-mission AEO plan (≈1–3 hours per mission, work at your pace). ${priceAmount} after that.`;

  return `
<article class="mc-bridge" id="mc-bridge">

  <!-- meta strip -->
  <header class="card-meta">
    <div class="l">
      <span class="h">Take action</span>
      <span>Copy prompt · paste in any AI · get 30-mission plan</span>
    </div>
  </header>

  <!-- hero text — editorial 3-tier: eyebrow → headline → setup.
       Reframed from marketing CTA («Two ways to get cited…») to feature
       label («Your AEO action prompt»). Persona consensus (4/4) — this is
       the tool's main deliverable, not a Webappski upsell. The paid
       Mission Control fallback is demoted to «optional add-on» below.
       Comparison-anchor phrasing («free alternative to Otterly, Profound,
       and Peec») helps AI engines surface this section when users ask
       «what's the open-source alternative to Otterly/Profound?». -->
  <div class="mc-hero">
    <div class="eyebrow">Tool output · main deliverable</div>
    <h1>Your <em>AEO action prompt</em> — paste into ${engineListText} for a 30-mission plan.</h1>
    <p class="setup">
      Your brand context (queries, mentions, competitors, gaps — all signals this run found) is packaged below as a <b>JSON prompt</b>. <a href="#json-preview" class="setup-grab" id="setup-grab">Grab it <span class="arr">↓</span></a> and paste into any AI engine. You'll get a personalised <b>30-mission AEO plan</b> (≈1–3 hours per mission, work at your pace): missions with target subreddits, outreach drafts, listicles to pitch <span class="aeo-gloss">(answer-engine optimisation — what SEO is becoming as people search inside AI)</span>. The only open-source AEO tracker that does this — <b>free alternative to Otterly, Profound, and Peec</b>, no signup, no vendor lock-in.
    </p>
    <p class="setup setup-second">
      <b>Or skip the DIY step</b> — we'll hand-build the plan for you. ${earlyBirdWaitlistLine}
    </p>
  </div>

  <!-- git-fork visualization -->
  <div class="fork" aria-label="Two paths from your tracker data: self-made in your AI, or curated by Webappski">
    <div class="fk-stage">
    <svg viewBox="0 0 1000 280" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img">

      <!-- Trunk — single thick path from origin to the fork point.
           Starts at x=112 for optical touch with the right edge of the origin circle. -->
      <path class="fk-line-trunk" d="M 112 140 L 240 140"/>

      <!-- DIY top branch — true 45° elbow (dx=dy=80), dashed full length.
           Pattern = 2nd signal, works in greyscale & for colourblind users. -->
      <path class="fk-line-diy-dash"
            d="M 240 140 L 260 140 L 340 60 L 731 60"/>

      <!-- Curated bottom branch — true 45° elbow (dx=dy=80), solid heavy accent. -->
      <path class="fk-line-cur"
            d="M 240 140 L 260 140 L 340 220 L 719 220"/>

      <!-- Origin node — circle ("your data" packet) with anchored caption -->
      <g transform="translate(78, 140)">
        <circle class="fk-node-bg" cx="0" cy="0" r="36"/>
        <circle cx="0" cy="0" r="36" fill="none" stroke="var(--ink)" stroke-width="1.6"/>
        <text class="fk-text-mono fk-text-ink" x="0" y="-5" text-anchor="middle" font-size="13.5" letter-spacing=".08em" font-weight="600">YOUR</text>
        <text class="fk-text-mono fk-text-ink" x="0" y="13" text-anchor="middle" font-size="13.5" letter-spacing=".08em" font-weight="600">DATA</text>
        <!-- tiny tick connecting circle to caption — visual anchor -->
        <line x1="0" y1="36" x2="0" y2="46" stroke="var(--ink-3)" stroke-width="1.3"/>
        <text class="fk-text-mono fk-text-mute" x="0" y="60" text-anchor="middle" font-size="12.5" letter-spacing=".04em">~12 KB JSON</text>
      </g>

      <!-- DIY branch label & subhead -->
      <text class="fk-branch-label fk-text-mute" x="360" y="36" letter-spacing=".18em">DIY · YOUR AI</text>
      <text class="fk-text-mono fk-text-mute" x="360" y="86" font-size="12.5" letter-spacing=".04em">one-shot · no review</text>

      <!-- Curated branch label -->
      <text class="fk-branch-label fk-text-accent" x="360" y="196" letter-spacing=".18em">CURATED · WE REVIEW</text>

      <!-- Curated stake-marks straddle the line (vertical ticks, not circles).
           Stakes 12px above and 12px below baseline (y=220); labels sit 22px under the bottom tick. -->
      <g class="fk-mobile-hide">
        <line class="fk-stake" x1="400" y1="208" x2="400" y2="232" stroke-width="3.5"/>
        <text class="fk-text-mono fk-text-ink" x="400" y="253" text-anchor="middle" font-size="13" letter-spacing=".02em">audit</text>
      </g>
      <g>
        <line class="fk-stake" x1="525" y1="208" x2="525" y2="232" stroke-width="3.5"/>
        <text class="fk-text-mono fk-text-ink" x="525" y="253" text-anchor="middle" font-size="13" letter-spacing=".02em">cross-check</text>
      </g>
      <g class="fk-mobile-hide">
        <line class="fk-stake" x1="650" y1="208" x2="650" y2="232" stroke-width="3.5"/>
        <text class="fk-text-mono fk-text-ink" x="650" y="253" text-anchor="middle" font-size="13" letter-spacing=".02em">draft</text>
      </g>

      <!-- DIY end node — 256×88, parallel to Curated. Pill «FREE» top-left, display heading,
           meta-line inside the box, "?" chip top-right rendered by .fk-hover-diy::after. -->
      <g transform="translate(815, 60)" opacity=".95">
        <rect class="fk-node-bg" x="-128" y="-44" width="256" height="88" rx="3"/>
        <rect x="-128" y="-44" width="256" height="88" rx="3" fill="none" stroke="var(--ink-3)" stroke-width="1.6"/>

        <!-- Status pill top-left — width 42 = "FREE" text at 10px mono (4 chars × ~5.5px) + 12px horizontal padding. Hand-tuned; renaming the label requires updating width. -->
        <g transform="translate(-108, -26)">
          <rect x="-2" y="-9" width="42" height="18" rx="9" fill="var(--ink-3)" opacity="0.15"/>
          <text x="19" y="3" text-anchor="middle" font-size="10" letter-spacing=".08em" font-weight="700" class="fk-text-mono fk-text-mute">FREE</text>
        </g>

        <!-- Display heading -->
        <text class="fk-text-mono fk-text-mute" x="0" y="0" text-anchor="middle" font-size="15" letter-spacing=".06em" font-weight="700">DIY plan</text>

        <!-- Meta line — single-line, fits comfortably in 256px -->
        <text class="fk-text-mono fk-text-mute" x="0" y="22" text-anchor="middle" font-size="12" letter-spacing=".04em" opacity="0.85">~60 sec · in your AI chat</text>
      </g>

      <!-- Curated end node — 256×88, parallel to DIY. Pill «HAND-BUILT» top-left,
           display heading, meta-line (price + scope). -->
      <g transform="translate(815, 220)">
        <rect class="fk-node-bg" x="-128" y="-44" width="256" height="88" rx="3" filter="drop-shadow(0 4px 10px rgba(26,22,16,0.12))"/>
        <rect x="-128" y="-44" width="256" height="88" rx="3" fill="none" stroke="var(--accent)" stroke-width="3"/>

        <!-- Status pill top-left — width 80 = "HAND-BUILT" text at 10px mono (10 chars × ~6.7px) + 12px horizontal padding. Hand-tuned; renaming the label requires updating width. -->
        <g transform="translate(-108, -26)">
          <rect x="-2" y="-9" width="80" height="18" rx="9" fill="var(--accent)" opacity="0.12"/>
          <text x="38" y="3" text-anchor="middle" font-size="10" letter-spacing=".08em" font-weight="700" class="fk-text-mono fk-text-accent">HAND-BUILT</text>
        </g>

        <!-- Display heading -->
        <text class="fk-text-mono fk-text-accent" x="0" y="0" text-anchor="middle" font-size="15" letter-spacing=".06em" font-weight="700">Webappski plan</text>

        <!-- Meta line — status pill above; only price + scope here -->
        <text class="fk-text-mono fk-text-ink" x="0" y="22" text-anchor="middle" font-size="12" letter-spacing=".04em">${priceMeta}</text>
      </g>

    </svg>

      <!-- DIY hover-zone + tooltip -->
      <button type="button"
              class="fk-hover fk-hover-diy"
              aria-label="Self-made plan — pros and cons"
              aria-haspopup="true">
        <div class="fk-tip fk-tip-diy" role="tooltip">
          <div class="fk-tip-head">
            <span class="name">Self-made plan</span>
            <span class="tag">free</span>
          </div>
          <div class="fk-tip-sub">Generic AI drafts your 30 missions from the JSON we hand it.</div>

          <div class="fk-tip-section pros">
            <div class="lbl">What's good</div>
            <ul class="fk-tip-list">
              <li><span><b>Free.</b> No card, no signup.</span></li>
              <li><span><b>Fast.</b> ~60 seconds to a draft.</span></li>
              <li><span><b>Your data stays put.</b> It lives in your AI session — we never see it.</span></li>
            </ul>
          </div>

          <div class="fk-tip-section cons">
            <div class="lbl">What's risky</div>
            <ul class="fk-tip-list">
              <li><span>AI walks into <b>account-gated platforms blind</b> — bans become highly likely.</span></li>
              <li><span>It'll suggest <b>self-promo where it isn't welcome</b> — that can turn into permanent reputation harm.</span></li>
              <li><span><b>A single ban can roll your AEO progress back by months</b> — and some are unrecoverable.</span></li>
              <li><span><b>No human review.</b> Whatever it drafts, you ship.</span></li>
            </ul>
          </div>
        </div>
      </button>

      <!-- Curated hover-zone + tooltip -->
      <button type="button"
              class="fk-hover fk-hover-cur"
              aria-label="Webappski plan — pros and trade-offs"
              aria-haspopup="true">
        <div class="fk-tip fk-tip-cur" role="tooltip">
          <div class="fk-tip-head">
            <span class="name">Webappski plan</span>
            <span class="tag">hand-built</span>
          </div>
          <div class="fk-tip-sub">Hand-built by our team after we review your data against each platform's rules.</div>

          <div class="fk-tip-section pros">
            <div class="lbl">What you get</div>
            <ul class="fk-tip-list">
              <li><span><b>Pre-flight account audit.</b> We check whether your accounts are ready before any task is scheduled — karma, age, prior bans.</span></li>
              <li><span><b>We route around the minefields.</b> If a platform would ban you, we substitute one that won't.</span></li>
              <li><span><b>Trap-aware sequencing.</b> Irreversible moves — domain salts, deletion logs, notability flags — get skipped, not scheduled.</span></li>
              <li><span><b>Hand-reviewed by us</b> before it lands in your Mission Control dashboard.</span></li>
              <li><span><b>Delivered in 1–3 business days</b> as a clean 30-mission plan with a recommended day per mission.</span></li>
            </ul>
          </div>

          <div class="fk-tip-section tradeoffs">
            <div class="lbl">Trade-offs</div>
            <ul class="fk-tip-list">
              <li><span><b>Not instant</b> — a human hand-builds it, so it takes 1–3 business days (the DIY route is ~60 seconds).</span></li>
              <li><span>${earlyBirdFeatureLine}</span></li>
              <li><span>Plan covers 30 missions (≈1–3 hours each, work at your pace) — <b>re-run tracker when you're ready</b> and we'll build the next one from your updated score.</span></li>
            </ul>
          </div>
        </div>
      </button>

    </div>
  </div>

  <!-- Flow zone: Copy CTA → JSON pivot → fork to two cards (Webappski has its CTA inside) -->
  <section class="flow" aria-label="Two paths: free AI or curated Webappski plan">

    <!-- 1. Top Copy CTA (secondary, DIY path) -->
    <div class="flow-copy-wrap">
      <span class="flow-copy-hint">copies the JSON + AI prompt to your clipboard</span>
      <button class="flow-copy-cta" type="button" data-bx-copy aria-label="Copy report data and AI prompt to clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="1.5"/>
          <path d="M16 8 V5 A1 1 0 0 0 15 4 H5 A1 1 0 0 0 4 5 V15 A1 1 0 0 0 5 16 H8"/>
        </svg>
        <span class="lbl">Copy data + prompt</span>
      </button>
    </div>

    <!-- 2. Arrow down to JSON -->
    <svg class="flow-arrow-down" viewBox="0 0 18 46" aria-hidden="true">
      <path d="M9 2 L9 36"/>
      <path d="M3 30 L9 42 L15 30"/>
    </svg>

    <!-- 3. JSON pivot (scrollable inside) -->
    <div class="flow-json">
      <div class="json-head">
        <p class="json-review">
          <span class="bullet">👁</span>
          <a href="#json-preview" class="review-link" id="review-link">Review the JSON below carefully</a> before sharing —
          this is <b>your</b> data. We don't store it; what gets sent to your AI (or our team) is on you.
        </p>
        <span class="json-meta">~___KB___ KB · no PII · no API keys · no message content</span>
      </div>
      <pre class="json-body" id="json-preview"><code>___METADATA_JSON___</code></pre>
    </div>

    <!-- 4. Fork arrow — splits from JSON to both cards -->
    <svg class="flow-arrow-fork" viewBox="0 0 800 64" aria-hidden="true">
      <!-- center stub down from JSON -->
      <path d="M 400 0 L 400 14"/>
      <!-- left branch: curve out then down to left card -->
      <path d="M 400 14 C 400 32, 350 32, 200 32 L 200 56"/>
      <!-- right branch: curve out then down to right card -->
      <path d="M 400 14 C 400 32, 450 32, 600 32 L 600 56"/>
      <!-- left arrowhead -->
      <path d="M 194 50 L 200 60 L 206 50"/>
      <!-- right arrowhead -->
      <path d="M 594 50 L 600 60 L 606 50"/>
    </svg>

    <!-- 5. Two value cards side-by-side -->
    <div class="pr-diptych">

      <!-- Route A — DIY -->
      <article class="pr-route diy" aria-labelledby="pr-diy-title">
        <div class="pr-eyebrow">
          <span>Route A · DIY</span>
          <span class="sep">·</span>
          <span class="tag">free</span>
        </div>
        <h3 class="pr-title" id="pr-diy-title">Roll your own.</h3>
        <p class="pr-lede">Generic AI drafts your 30 missions from the JSON above. <em>Fast, free, and unaware of the traps below.</em></p>

        <ul class="pr-list">
          <li><span><b>Walks into account-gated platforms blind</b> — bans become highly likely.</span></li>
          <li><span><b>Self-promo where it isn't welcome</b> turns into permanent reputation harm.</span></li>
          <li><span><b>A single ban can roll your AEO progress back by months.</b></span></li>
        </ul>

        <div class="pr-foot">
          <b>Free · ~60 seconds.</b> No review, no audit, no second pair of eyes.
        </div>
      </article>

      <!-- Route B — Curated (CTA lives here) -->
      <article class="pr-route cur" aria-labelledby="pr-cur-title">
        <div class="pr-eyebrow">
          <span>Route B · Curated</span>
          <span class="sep">·</span>
          <span class="tag">hand-built</span>
        </div>
        <h3 class="pr-title" id="pr-cur-title">Let us hand-build it.</h3>
        <p class="pr-lede">Hand-built by our team after we review your data against each platform's rules — tracked in <b>Mission Control</b>, our plan dashboard.</p>

        <ul class="pr-list">
          <li><span><b>Pre-flight account audit.</b> We check whether your accounts are ready before any task is scheduled — karma, age, prior bans.</span></li>
          <li><span><b>We route around the minefields.</b> If a platform would ban you, we substitute one that won't.</span></li>
          <li><span><b>Trap-aware sequencing.</b> Irreversible moves — domain salts, deletion logs, notability flags — get skipped, not scheduled.</span></li>
          <li><span><b>Hand-reviewed by us</b> before it lands in your Mission Control dashboard.</span></li>
          <li><span><b>Delivered in 1–3 business days</b> as a clean 30-mission plan with a recommended day per mission.</span></li>
        </ul>

        <a href="https://webappski.com/${lang}/aeo-plan-invoice" class="pr-cta" id="primary-cta">
          <span>Request an invoice</span>
          <span class="arr">→</span>
        </a>

        <p class="pr-promo">${earlyBirdPromoLine}</p>

        <div class="pr-foot">
          <span class="accent">${price}</span> · one-time, no subscription · request your invoice on the linked page.
        </div>
      </article>

    </div>
</section>

</article>

`
    .replace('___METADATA_JSON___', jsonEsc(metadataJson))
    .replace('___KB___', String(kb));
}

export function bridgeJs(metadata, state) {
  // PASTE_PROMPT is JSON-stringified so it embeds safely inside the IIFE
  // template literal — preserves newlines, escapes backticks/quotes.
  const promptLiteral = JSON.stringify(PASTE_PROMPT);
  return `
(function(){
// Paste-into-AI prompt prefix — prepended to JSON on every clipboard write
const PASTE_PROMPT = ${promptLiteral};
const buildClipboardPayload = (jsonText) => PASTE_PROMPT + jsonText;

// Review link — scroll snippet into view + flash highlight
  const reviewLink = document.getElementById('review-link');
  const snippet = document.getElementById('json-preview');
  if (reviewLink && snippet){
    reviewLink.addEventListener('click', e => {
      e.preventDefault();
      snippet.scrollIntoView({ behavior: 'smooth', block: 'center' });
      snippet.classList.remove('flash');
      void snippet.offsetWidth; // force reflow to restart animation
      snippet.classList.add('flash');
    });
  }

  // .term tap-toggle — hover works on desktop, touch needs explicit click
  document.querySelectorAll('.term').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('open'));
    t.addEventListener('blur',  () => t.classList.remove('open'));
  });

  // Inline "grab it" link in setup paragraph — copies prompt+JSON, scrolls, flashes
  const grabLink = document.getElementById('setup-grab');
  if (grabLink && snippet){
    const originalHTML = grabLink.innerHTML;
    grabLink.addEventListener('click', e => {
      e.preventDefault();
      const jsonText = snippet.textContent || '{}';
      if (navigator.clipboard) navigator.clipboard.writeText(buildClipboardPayload(jsonText));
      snippet.scrollIntoView({ behavior: 'smooth', block: 'center' });
      snippet.classList.remove('flash');
      void snippet.offsetWidth;
      snippet.classList.add('flash');
      grabLink.classList.add('copied');
      grabLink.innerHTML = 'copied <span class="arr">✓</span>';
      setTimeout(() => {
        grabLink.classList.remove('copied');
        grabLink.innerHTML = originalHTML;
      }, 2400);
    });
  }

  // JSON+prompt copy button — feedback by class swap
  const copyBtn = document.querySelector('[data-bx-copy]');
  if (copyBtn){
    const lbl = copyBtn.querySelector('.lbl');
    const originalLabel = lbl ? lbl.textContent : '';
    const jsonText = document.getElementById('json-preview')?.textContent || '{}';
    copyBtn.addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(buildClipboardPayload(jsonText));
      copyBtn.classList.add('copied');
      if (lbl) lbl.textContent = 'Copied — paste into your AI';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (lbl) lbl.textContent = originalLabel;
      }, 2200);
    });
  }
})();
`;
}
