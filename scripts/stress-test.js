#!/usr/bin/env node

// Pincer Stress Test — simulates concurrent load on pincerweb.com
// Usage: node scripts/stress-test.js [--quick]

const QUICK = process.argv.includes('--quick');
const BASE_URL = 'https://pincerweb.com';
const SUPABASE_URL = 'https://tcwujslibopzfyufhjsr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ib1XEv6lNe5jYXULeUo6tg_dcO0hRMt';
const SLUG = 'squareone';
const TIMEOUT_MS = 30000;

const sbHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
};

// ── Helper: timed fetch with timeout ──
async function timedFetch(url, options = {}) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, ms: Date.now() - start, error: null };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - start, error: e.message };
  }
}

// ── Helper: run N concurrent requests and collect metrics ──
async function runScenario(name, count, requestFn) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`  ${count} concurrent requests`);
  console.log('='.repeat(60));

  const totalStart = Date.now();
  const promises = Array.from({ length: count }, (_, i) => requestFn(i));
  const results = await Promise.all(promises);
  const totalMs = Date.now() - totalStart;

  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);
  const times = results.map(r => r.ms);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const successRate = ((successes.length / count) * 100).toFixed(1);

  console.log(`  Total time:     ${totalMs}ms`);
  console.log(`  Avg response:   ${avg}ms`);
  console.log(`  Min response:   ${min}ms`);
  console.log(`  Max response:   ${max}ms`);
  console.log(`  Success rate:   ${successRate}% (${successes.length}/${count})`);

  if (failures.length > 0) {
    const errorGroups = {};
    for (const f of failures) {
      const key = f.error || `HTTP ${f.status}`;
      errorGroups[key] = (errorGroups[key] || 0) + 1;
    }
    console.log(`  Errors:`);
    for (const [err, cnt] of Object.entries(errorGroups)) {
      console.log(`    - ${err}: ${cnt}x`);
    }
  }

  return { name, count, totalMs, avg, min, max, successRate, successes: successes.length, failures: failures.length };
}

// ── Scenario 1: Concurrent menu page loads ──
async function testMenuLoads() {
  const count = QUICK ? 10 : 50;
  return runScenario('Menu Page Loads (GET /' + SLUG + ')', count, () =>
    timedFetch(`${BASE_URL}/${SLUG}`)
  );
}

// ── Scenario 2: Concurrent order creation ──
async function testOrderCreation() {
  const count = QUICK ? 10 : 20;
  return runScenario('Order Creation (POST to Supabase orders)', count, (i) => {
    const order = {
      items: JSON.stringify([
        { id: 'stress_test_' + i, name: 'Stress Test Item', qty: 1, notes: null }
      ]),
      total: 100,
      status: 'stress_test',
      phone: '0000000000',
      restaurant_slug: SLUG,
      order_type: 'dine_in',
      customer_name: 'STRESS_TEST_' + Date.now(),
    };
    return timedFetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify(order),
    });
  });
}

// ── Scenario 3: Concurrent chatbot requests ──
async function testChatbot() {
  const count = QUICK ? 5 : 10;
  return runScenario('Chatbot Requests (POST /api/waiter-chat)', count, () =>
    timedFetch(`${BASE_URL}/api/waiter-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hola, que me recomiendas?' }],
        menuData: 'Hamburguesas: [id:test1] Smash Burger - RD$350 - Doble carne smash',
        restaurant_slug: SLUG,
        restaurant_name: 'Square One',
        browserLanguage: 'es',
        welcome: false,
      }),
    })
  );
}

// ── Scenario 4: Dashboard polling (Supabase orders query) ──
async function testDashboardPolling() {
  const count = QUICK ? 5 : 5;
  return runScenario('Dashboard Polling (GET orders from Supabase)', count, () =>
    timedFetch(
      `${SUPABASE_URL}/rest/v1/orders?restaurant_slug=eq.${SLUG}&status=neq.stress_test&order=created_at.desc&limit=50`,
      { headers: sbHeaders }
    )
  );
}

// ── Cleanup: delete stress test orders ──
async function cleanup() {
  console.log('\nCleaning up stress test orders...');
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.stress_test`,
      { method: 'DELETE', headers: sbHeaders }
    );
    console.log(`  Cleanup: ${res.ok ? 'done' : 'failed (' + res.status + ')'}`);
  } catch (e) {
    console.log(`  Cleanup error: ${e.message}`);
  }
}

// ── Main ──
async function main() {
  console.log('');
  console.log('  PINCER STRESS TEST');
  console.log(`  Mode: ${QUICK ? 'QUICK' : 'FULL'}`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Restaurant: ${SLUG}`);
  console.log('');

  const results = [];

  results.push(await testMenuLoads());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await testOrderCreation());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await testChatbot());
  await new Promise(r => setTimeout(r, 2000));

  results.push(await testDashboardPolling());

  await cleanup();

  // ── Summary ──
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  console.log('');
  console.log(
    'Scenario'.padEnd(45) +
    'Avg'.padStart(7) +
    'Min'.padStart(7) +
    'Max'.padStart(7) +
    'OK%'.padStart(7)
  );
  console.log('-'.repeat(73));
  for (const r of results) {
    console.log(
      `${r.name} (${r.count})`.padEnd(45) +
      `${r.avg}ms`.padStart(7) +
      `${r.min}ms`.padStart(7) +
      `${r.max}ms`.padStart(7) +
      `${r.successRate}%`.padStart(7)
    );
  }
  console.log('');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
