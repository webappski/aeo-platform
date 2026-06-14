// fail-branch #10: the report must never recommend pitching a DIRECT
// competitor's own site to «add you alongside» a rival. Tests the pure
// host-filter helpers + that sectionActionableGaps drops competitor hosts.

import assert from 'node:assert/strict';
import {
  competitorOwnedHosts,
  isCompetitorOwnedHost,
  sectionActionableGaps,
} from '../lib/report/sections.js';
import { filterOwnDomainFromTopDomains } from '../lib/report/outreach-templates.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ncompetitor-owned-host filter (fail-branch #10)');

test('competitorOwnedHosts derives normalised apexes from competitorPricing', () => {
  const hosts = competitorOwnedHosts({
    competitorPricing: [
      { name: 'AeoEngine', domain: 'https://www.aeoengine.ai/' },
      { name: 'Ryze', domain: 'get-ryze.ai' },
      { name: 'NoDomain' },
    ],
  });
  assert.equal(hosts.has('aeoengine.ai'), true);
  assert.equal(hosts.has('get-ryze.ai'), true);
  assert.equal(hosts.size, 2);
});

test('isCompetitorOwnedHost matches apex and subdomains, www-insensitive', () => {
  const hosts = competitorOwnedHosts({ competitorPricing: [{ name: 'X', domain: 'aeoengine.ai' }] });
  assert.equal(isCompetitorOwnedHost('aeoengine.ai', hosts), true);
  assert.equal(isCompetitorOwnedHost('www.aeoengine.ai', hosts), true);
  assert.equal(isCompetitorOwnedHost('blog.aeoengine.ai', hosts), true);
  assert.equal(isCompetitorOwnedHost('notaeoengine.ai', hosts), false);
  assert.equal(isCompetitorOwnedHost('publisher.com', hosts), false);
});

test('isCompetitorOwnedHost on empty set never matches', () => {
  assert.equal(isCompetitorOwnedHost('anything.com', new Set()), false);
  assert.equal(isCompetitorOwnedHost('anything.com', undefined), false);
});

test('filterOwnDomainFromTopDomains drops competitor-owned hosts', () => {
  const hosts = competitorOwnedHosts({ competitorPricing: [{ name: 'X', domain: 'aeoengine.ai' }] });
  const filtered = filterOwnDomainFromTopDomains(
    [{ host: 'aeoengine.ai' }, { host: 'techcrunch.com' }, { host: 'ours.com' }],
    'ours.com',
    hosts,
  );
  assert.deepEqual(filtered.map(d => d.host), ['techcrunch.com']);
});

test('sectionActionableGaps does NOT pitch a competitor-owned cited host', () => {
  const latest = {
    brand: 'Webappski',
    domain: 'webappski.com',
    competitorPricing: [{ name: 'AeoEngine', domain: 'aeoengine.ai' }],
    topDomains: [{ host: 'aeoengine.ai', count: 5, share: 0.5 }],
    results: [{
      query: 'best aeo tool',
      queryText: 'best aeo tool',
      provider: 'openai',
      mention: 'no',
      competitors: ['AeoEngine'],
      competitorsUnverified: [],
      canonicalCitations: ['https://aeoengine.ai/blog/post'],
    }],
  };
  const md = sectionActionableGaps([latest]);
  // The cited host (aeoengine.ai) is competitor-owned → must not appear as a
  // «Pitch aeoengine.ai» action. With no other host, it falls back to the
  // comparison-page action instead.
  assert.equal(/Pitch \*\*aeoengine\.ai\*\*/.test(md), false, 'must not pitch competitor host');
  assert.equal(/Get listed on \*\*aeoengine\.ai\*\*/.test(md), false, 'must not list-on competitor host');
});

// Mutation-sanity: a NON-competitor cited host SHOULD still produce a pitch —
// proves the filter is selective, not a blanket suppressor.
test('mutation-sanity: a non-competitor cited host is still pitched', () => {
  const latest = {
    brand: 'Webappski',
    domain: 'webappski.com',
    competitorPricing: [{ name: 'AeoEngine', domain: 'aeoengine.ai' }],
    topDomains: [{ host: 'techcrunch.com', count: 5, share: 0.5 }],
    results: [{
      query: 'best aeo tool',
      queryText: 'best aeo tool',
      provider: 'openai',
      mention: 'no',
      competitors: ['AeoEngine'],
      competitorsUnverified: [],
      canonicalCitations: ['https://techcrunch.com/article'],
    }],
  };
  const md = sectionActionableGaps([latest]);
  assert.equal(/Pitch \*\*techcrunch\.com\*\*/.test(md), true, 'should pitch a real publisher');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
