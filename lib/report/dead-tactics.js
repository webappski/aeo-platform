/**
 * Dead-tactic filter for LLM-generated recommendations.
 *
 * WHY THIS EXISTS. Most of the report's advice is hardcoded copy we control, so
 * removing a bad recommendation is an edit. But `llmActions` is written by a
 * model at report time from a prompt, and "add an /llms.txt file" / "add FAQ
 * schema" sit near the top of any 2024-vintage AEO prior. Prompt rules reduce
 * that; they do not eliminate it. Since these recommendations are printed in a
 * report a client pays for, the guarantee has to be MECHANICAL: whatever the
 * model returns, a dead tactic never reaches the page.
 *
 * THE TACTICS AND WHY THEY ARE DEAD (first-party sources first; full trail in
 * webappski-ops/resources/aeo/bp-refresh/2026-08-01.md, verified 2026-08-01/02):
 *
 *   - /llms.txt — Google: «For Google Search, llms.txt isn't needed for AI
 *     Overviews, AI Mode, or other generative AI Search features», and the
 *     2026-06-15 changelog clarifies the files «aren't required for Google
 *     Search visibility or rankings». No other major provider has confirmed
 *     support. A 2026 study across ~300,000 domains, reported by lumentir.com,
 *     found no relationship between having the file and how often a domain is
 *     cited (reported finding — the page does not name who ran the study).
 *   - FAQPage markup — the FAQ rich result stopped appearing in Google Search
 *     on 2026-05-07 and its documentation was removed on 2026-06-15.
 *   - HowTo markup — dead since 2023.
 *   - «Add schema to get cited» in general — Google: «Structured data isn't
 *     required for generative AI search, and there's no special schema.org
 *     markup you need to add.» The only controlled measurement (Ahrefs,
 *     2026-05-11: 1,885 pages adding JSON-LD vs ~4,000 controls) found no
 *     uplift on any platform and −4.6% in AI Overviews.
 *   - «Unblock GPTBot / Google-Extended / ClaudeBot / CCBot so AI can cite
 *     you» — those are training and non-product crawlers. OpenAI documents that
 *     only an OAI-SearchBot opt-out removes a site from ChatGPT search answers;
 *     Google documents that Google-Extended «does not impact a site's inclusion
 *     in Google Search». The real levers are OAI-SearchBot, PerplexityBot,
 *     Claude-SearchBot and Googlebot + robots.txt/noindex/nosnippet.
 *
 * WHAT THIS DOES NOT DO. It never tells anyone to REMOVE markup they already
 * have (R39: do not make a client's site worse on a report's say-so), and it
 * does not touch the crawlability audit, which still MEASURES and reports
 * /llms.txt as a plain fact. It only stops us from BILLING advice that does
 * nothing.
 *
 * Conservative by design: the verb and the tactic must sit in the SAME CLAUSE,
 * with the verb first — «add an llms.txt» is advice, «your llms.txt is already
 * fine, add a call-to-action» is not. A false drop costs the client a real
 * recommendation (and silently reshuffles the top-10 that feeds a paid plan),
 * so the bar is "this sentence is telling them to go and do it".
 *
 * HOW THE CLAUSE BOUND WORKS, and why the first version was wrong. Until
 * review it ran two INDEPENDENT `.test()` calls over the whole title+detail —
 * "does a dead tactic appear anywhere?" AND "does a verb appear anywhere?" —
 * which flagged every one of these:
 *   «Your llms.txt is already fine as-is — no changes needed. Add a clear CTA…»
 *   «You already have FAQPage schema in place; add more product photos…»
 *   «Your robots.txt correctly blocks GPTBot for training; instead, allow more…»
 *   «Publish a new blog post… Separately, llms.txt has no effect on citations.»
 * The first one is the worst: text saying DON'T was cut as if it said DO. The
 * gap between verb and tactic is now bounded AND may not cross a clause
 * boundary — `.`, `!`, `?`, `;`, a newline, or an ellipsis (either «…» or
 * «...»), which is what separated the verb from the tactic in all four. Those
 * four probes are pinned as regression cases in
 * `test/e2e/no-dead-tactic-advice.test.js`.
 *
 * KNOWN LIMITATION — advice split across two sentences is NOT caught, and that
 * is a deliberate trade, not an unfinished edge. «We recommend adding a
 * dedicated machine-readable file. This is commonly called llms.txt.» slips
 * through, because catching it would mean letting the gap cross a full stop.
 * The very first false positive we had to fix is the same shape in reverse —
 * «Your llms.txt is already fine as-is, no changes needed. Add a clear CTA…» —
 * where the sentence next to the tactic says DON'T. One regex cannot tell those
 * two apart, and of the two errors, cutting a recommendation that says «do not
 * bother» is the one that reaches the client as a wrong report. A second, much
 * narrower miss falls out of the same rule: a gap that has to span a filename
 * containing a dot («…disallowing in your robots.txt file, starting with
 * GPTBot») is cut by the `.` exclusion.
 *
 * The third miss is the length cap, and it is the same trade again: advice
 * whose verb sits more than 60 characters from the tactic INSIDE one sentence
 * («Add a short plain-text summary of your key product facts at the root of the
 * domain, commonly referred to as llms.txt») is not caught. Raising the cap to
 * cover it was tried and reverted, because that range is full of honest
 * sentences that describe or reject the tactic at length — the note on GAP
 * below has the probes. The cap is load-bearing, not leftover.
 *
 * All of these are pinned as executable KNOWN_MISSES in the test file, so a
 * future widening of the rule trips a test and forces the trade to be
 * re-decided on purpose instead of by accident.
 *
 * The backstops for what this filter misses are the prompt rule in
 * `bin/aeo-tracker.js` (which tells the model not to produce the advice in the
 * first place) and the hardcoded copy, which contains none of it. This filter
 * is the third line, not the only one — and it does not claim to be a parser.
 */

// Gap allowed between a recommendation verb and the tactic it recommends: same
// clause only. Excludes sentence-enders and the semicolon, so «…; instead,
// allow…» cannot reach back to a tactic named in the previous clause. The
// literal `.` exclusion is safe here: the gap never has to span «llms.txt»
// itself, only the words leading up to it.
//
// BOTH HALVES CARRY WEIGHT — the excluded characters AND the 60-character cap.
// This was tested the hard way. The cap was briefly raised to 140 on the
// argument that the character class does all the work, since the first four
// false-positive probes are each stopped by a boundary character. That argument
// was wrong, and the mistake is worth keeping written down: those four probes
// have verb→tactic gaps of 1-15 characters, so they could never have revealed
// what happens at 61-140. Three probes written specifically for that range —
// «…found nothing worth adding beyond what you already serve to the major
// search and answer engines today, so llms.txt stays off the list», and two
// like it — contain no boundary character at all and are honest, often
// NEGATIVE, descriptions of the tactic. At 140 all three were falsely cut. At
// 60 all three survive. They are pinned in MUST_SURVIVE.
//
// So the cap stays at 60, and the price is paid knowingly: real advice with a
// long gap inside one sentence is not caught (see KNOWN LIMITATION above). Of
// the two errors, a missed recommendation is one extra card in a report that
// argues against it elsewhere, while a false cut silently deletes true text and
// silently reshuffles the top-10 that feeds a paid plan. Neither number nor
// character class may be widened without re-running MUST_SURVIVE.
const GAP = '[^.!?;\\n…]{0,60}';

// Verbs that turn a mention into an instruction, with their common inflections.
const DO_VERB = '(?:add(?:ing|s)?|creat(?:e|es|ing)|publish(?:ing|es)?|generat(?:e|es|ing)|implement(?:ing|s)?|introduc(?:e|es|ing)|deploy(?:ing|s)?|set ?up|host(?:ing|s)?|writ(?:e|es|ing)|ship(?:ping|s)?|includ(?:e|es|ing)|expos(?:e|es|ing)|mark ?up|appl(?:y|ies|ying)|roll out)';

// Phrases that make an instruction out of a tactic named FIRST («llms.txt is
// worth adding»). Kept narrow — a descriptive «llms.txt has no effect» must not
// match anything here.
const SELL_PHRASE = '(?:should be (?:added|created|implemented)|needs? to be (?:added|created)|is worth (?:adding|creating)|would (?:give|help|take)|gives? (?:engines|ai|llms)|takes? (?:only )?\\d+ ?(?:min|minute)|is a (?:quick|easy) win|5 ?min)';

const LLMS_TXT   = '(?:llms?[-_ .]?txt|llmstxt\\.org)';
const FAQ_MARKUP = '(?:faq ?page|faq (?:schema|markup|structured data|json-?ld)|schema (?:markup )?for (?:your )?faqs?)';
const HOWTO      = '(?:how-?to (?:schema|markup|structured data|json-?ld))';
const NON_GATING_BOT = '(?:gptbot|google-extended|claudebot|ccbot|bytespider|googleother)';

/** verb → …same clause… → tactic, or tactic → …same clause… → selling phrase. */
function advises(tactic, verb = DO_VERB) {
  const forward = new RegExp(`\\b${verb}\\b${GAP}${tactic}`, 'i');
  const backward = new RegExp(`${tactic}${GAP}\\b${SELL_PHRASE}`, 'i');
  return (t) => forward.test(t) || backward.test(t);
}

/**
 * Each rule: { id, reason, test(text) } where `text` is the lower-cased
 * concatenation of an action's title + detail.
 *
 * Patterns are kept as small readable regexes rather than one mega-regex so a
 * future reader can see exactly which sentence shape is being rejected.
 */
const RULES = [
  {
    id: 'llms-txt',
    reason: 'llms.txt is not used by any major engine for visibility (Google: not needed for AI Overviews / AI Mode)',
    test: advises(LLMS_TXT),
  },
  {
    id: 'faqpage-schema',
    reason: 'the FAQ rich result was removed from Google Search on 2026-05-07 and its documentation deleted on 2026-06-15',
    test: advises(FAQ_MARKUP),
  },
  {
    id: 'howto-schema',
    reason: 'the HowTo rich result has been dead since 2023',
    test: advises(HOWTO),
  },
  {
    id: 'unblock-training-bot',
    reason: 'blocking GPTBot / Google-Extended / ClaudeBot / CCBot costs no citations — only OAI-SearchBot, PerplexityBot, Claude-SearchBot and Googlebot gate answers',
    test: (t) => advises(NON_GATING_BOT, '(?:unblock(?:ing|s)?|allow(?:ing|s)?|whitelist(?:ing|s)?|permit(?:ting|s)?|stop blocking|un-?disallow)')(t)
      // …unless the action ALSO names a bot that genuinely gates citations, in
      // which case it is real advice with a stray extra name in the list.
      && !/\b(oai-?searchbot|perplexitybot|claude-?searchbot|googlebot)\b/i.test(t),
  },
];

/**
 * Does this text recommend a dead tactic? Returns the matching rule (with its
 * `reason`) or null. Exported so tests and the CLI can explain a drop.
 * @param {string} text
 */
export function deadTacticRule(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();
  return RULES.find(r => r.test(t)) || null;
}

/**
 * Split LLM actions into the ones we will print and the ones we refuse to.
 *
 * @param {Array<{title?:string, detail?:string}>} actions
 * @returns {{kept: Array, dropped: Array<{action: Object, ruleId: string, reason: string}>}}
 */
export function filterDeadTactics(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const kept = [];
  const dropped = [];
  for (const a of list) {
    const rule = deadTacticRule(`${a?.title || ''} ${a?.detail || ''}`);
    if (rule) dropped.push({ action: a, ruleId: rule.id, reason: rule.reason });
    else kept.push(a);
  }
  return { kept, dropped };
}

/**
 * Filter AND announce. A silent drop is the dangerous shape of this feature:
 * `recommendations()` filters and then takes the top 10, so one wrong drop
 * quietly changes the payload that feeds a paid plan, and nobody would know to
 * look. Every call site therefore goes through here, which writes a line per
 * drop to stderr — visible in the CLI run, absent from the report artefact.
 *
 * @param {Array} actions
 * @param {string} where  call-site label, e.g. 'report HTML' / 'Mission Control payload'
 * @returns {Array} the kept actions
 */
export function withoutDeadTactics(actions, where = 'report') {
  const { kept, dropped } = filterDeadTactics(actions);
  for (const d of dropped) {
    // eslint-disable-next-line no-console
    console.error(
      `  ! dropped a recommendation from the ${where}: "${d.action?.title || '(untitled)'}" — ${d.reason} [${d.ruleId}]`,
    );
  }
  return kept;
}
