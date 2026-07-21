// Focus Tracker background script.
// Model: on-task iff Firefox window is focused AND active tab's host matches whitelist.
// Otherwise off-task. Per-minute buckets stored per day: { on:[1440], off:[1440] } in seconds.

const TICK_SECONDS = 5;
const MAX_GAP_MS = 5 * 60 * 1000; // discard deltas larger than this (assume browser was closed)

let whitelistCache = [];

async function loadWhitelist() {
  const { whitelist } = await browser.storage.local.get('whitelist');
  whitelistCache = Array.isArray(whitelist) ? whitelist : [];
}

function matchesWhitelist(url) {
  if (!url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return whitelistCache.some(raw => {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) return false;
    return host === entry || host.endsWith('.' + entry);
  });
}

async function computeState() {
  try {
    const wins = await browser.windows.getAll({ populate: false });
    const focused = wins.find(w => w.focused);
    if (!focused) return 'off';
    const tabs = await browser.tabs.query({ active: true, windowId: focused.id });
    if (!tabs.length) return 'off';
    return matchesWhitelist(tabs[0].url) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

function dayKeyFor(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyDay() {
  return { on: new Array(1440).fill(0), off: new Array(1440).fill(0) };
}

// Attribute [fromT, toT) as `state` into per-minute buckets, splitting across
// minute and day boundaries as needed.
async function attribute(fromT, toT, state) {
  if (toT <= fromT) return;
  if (state !== 'on' && state !== 'off') return;

  // Group updates by day key to minimize storage reads/writes.
  const dayCache = {};
  const keysNeeded = new Set();

  // First pass: figure out which day keys we touch.
  let scan = fromT;
  while (scan < toT) {
    keysNeeded.add(dayKeyFor(scan));
    const d = new Date(scan);
    const nextMin = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                             d.getHours(), d.getMinutes() + 1, 0, 0).getTime();
    scan = nextMin;
  }

  // Load existing.
  const storageKeys = Array.from(keysNeeded).map(k => 'day_' + k);
  const stored = await browser.storage.local.get(storageKeys);
  for (const k of keysNeeded) {
    dayCache[k] = stored['day_' + k] || emptyDay();
    // Defensive: ensure arrays are proper length.
    if (!Array.isArray(dayCache[k].on) || dayCache[k].on.length !== 1440) {
      dayCache[k] = emptyDay();
    }
  }

  // Second pass: attribute seconds into buckets.
  let cursor = fromT;
  while (cursor < toT) {
    const d = new Date(cursor);
    const nextMin = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                             d.getHours(), d.getMinutes() + 1, 0, 0).getTime();
    const segEnd = Math.min(nextMin, toT);
    const seconds = (segEnd - cursor) / 1000;
    const key = dayKeyFor(cursor);
    const mo = d.getHours() * 60 + d.getMinutes();
    dayCache[key][state][mo] += seconds;
    cursor = segEnd;
  }

  // Persist.
  const toWrite = {};
  for (const k of Object.keys(dayCache)) {
    toWrite['day_' + k] = dayCache[k];
  }
  await browser.storage.local.set(toWrite);
}

async function tick() {
  const now = Date.now();
  const state = await computeState();
  const { lastCheckT, lastState } = await browser.storage.local.get(['lastCheckT', 'lastState']);
  if (typeof lastCheckT === 'number' && (lastState === 'on' || lastState === 'off')) {
    const delta = now - lastCheckT;
    if (delta > 0 && delta < MAX_GAP_MS) {
      await attribute(lastCheckT, now, lastState);
    }
  }
  await browser.storage.local.set({ lastCheckT: now, lastState: state });
}

// Event listeners.
browser.tabs.onActivated.addListener(() => { tick(); });
browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') tick();
});
browser.windows.onFocusChanged.addListener(() => { tick(); });

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.whitelist) {
    await loadWhitelist();
    tick(); // re-evaluate state immediately after whitelist change
  }
});

// Alarms fire even if the event page has been suspended; they wake it back up.
// Firefox enforces a ~30s minimum on alarm periods in MV3, so we combine:
//   - a 30s alarm as a keep-alive / wake-up
//   - a 5s setInterval for actual sampling while the page is running
browser.alarms.create('focus-tick', { periodInMinutes: 0.5 });
browser.alarms.onAlarm.addListener(a => {
  if (a.name === 'focus-tick') tick();
});
setInterval(tick, TICK_SECONDS * 1000);

browser.runtime.onStartup.addListener(async () => {
  await loadWhitelist();
  // Clear stale lastCheckT so we don't attribute browser-closed time.
  await browser.storage.local.remove(['lastCheckT', 'lastState']);
  tick();
});
browser.runtime.onInstalled.addListener(async () => {
  await loadWhitelist();
  tick();
});

// Cold start (event page waking).
(async () => {
  await loadWhitelist();
  tick();
})();
