const $ = id => document.getElementById(id);

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtSec(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function getDayData(dateStr) {
  const key = 'day_' + dateStr;
  const stored = await browser.storage.local.get(key);
  const d = stored[key];
  if (d && Array.isArray(d.on) && d.on.length === 1440) return d;
  return { on: new Array(1440).fill(0), off: new Array(1440).fill(0) };
}

function drawChart(data, startMin, endMin, yMaxSec) {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 560;
  const cssH = canvas.clientHeight || 180;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 34, padR = 8, padT = 8, padB = 20;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;

  // Clamp range.
  startMin = Math.max(0, Math.min(1440, startMin | 0));
  endMin   = Math.max(startMin + 1, Math.min(1440, endMin | 0));
  const nBins = endMin - startMin;

  // Resolve Y-max. yMaxSec === null means auto.
  let yMax = yMaxSec;
  if (yMax == null) {
    let peak = 0;
    for (let m = startMin; m < endMin; m++) {
      const total = Math.min((data.off[m] || 0) + (data.on[m] || 0), 60);
      if (total > peak) peak = total;
    }
    yMax = Math.max(1, Math.ceil(peak));
  }

  // Y grid + labels.
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const yTickCount = 4;
  for (let i = 0; i <= yTickCount; i++) {
    const frac = i / yTickCount;
    const y = padT + h - h * frac;
    if (i > 0 && i < yTickCount) {
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    }
    const val = (frac * yMax);
    const lbl = val >= 10 ? `${Math.round(val)}s` : `${val.toFixed(1)}s`;
    ctx.fillText(i === 0 ? '0' : lbl, padL - 3, y);
  }

  // Vertical hour gridlines within visible range.
  ctx.strokeStyle = '#e8e8e8';
  const firstHr = Math.ceil(startMin / 60);
  const lastHr  = Math.floor(endMin / 60);
  for (let hr = firstHr; hr <= lastHr; hr++) {
    const m = hr * 60;
    if (m <= startMin || m >= endMin) continue;
    const x = padL + ((m - startMin) / nBins) * w;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
  }

  // Axes.
  ctx.strokeStyle = '#bbb';
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + h); ctx.lineTo(padL + w, padT + h);
  ctx.stroke();

  // X-axis labels — pick a sensible hour step so we don't overcrowd.
  const rangeHours = nBins / 60;
  let step;
  if (rangeHours <= 2)      step = 0.25;   // 15-min ticks
  else if (rangeHours <= 6) step = 1;
  else if (rangeHours <= 12) step = 2;
  else                       step = 3;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const firstTick = Math.ceil((startMin / 60) / step) * step;
  for (let t = firstTick; t <= endMin / 60 + 1e-9; t += step) {
    const mins = t * 60;
    if (mins < startMin || mins > endMin) continue;
    const x = padL + ((mins - startMin) / nBins) * w;
    const hh = Math.floor(t);
    const mm = Math.round((t - hh) * 60);
    const lbl = mm === 0 ? String(hh) : `${hh}:${String(mm).padStart(2, '0')}`;
    ctx.fillText(lbl, x, padT + h + 4);
  }

  // Per-minute stacked area over [startMin, endMin).
  const xOf = m => padL + ((m - startMin + 0.5) / nBins) * w;
  const yOf = sec => padT + h - Math.min(Math.max(sec / yMax, 0), 1) * h;

  const offSec = new Array(nBins);
  const topSec = new Array(nBins);
  for (let i = 0; i < nBins; i++) {
    const m = startMin + i;
    const off = Math.min(data.off[m] || 0, 60);
    const on  = Math.min(data.on[m]  || 0, 60);
    const total = Math.min(off + on, 60);
    offSec[i] = off;
    topSec[i] = total;
  }

  // Off layer.
  ctx.beginPath();
  ctx.moveTo(padL, padT + h);
  for (let i = 0; i < nBins; i++) ctx.lineTo(xOf(startMin + i), yOf(offSec[i]));
  ctx.lineTo(padL + w, padT + h);
  ctx.closePath();
  ctx.fillStyle = '#e57373';
  ctx.fill();

  // On layer (stacked above off).
  ctx.beginPath();
  ctx.moveTo(xOf(startMin), yOf(topSec[0]));
  for (let i = 1; i < nBins; i++) ctx.lineTo(xOf(startMin + i), yOf(topSec[i]));
  for (let i = nBins - 1; i >= 0; i--) ctx.lineTo(xOf(startMin + i), yOf(offSec[i]));
  ctx.closePath();
  ctx.fillStyle = '#81c784';
  ctx.fill();
}

function computeInterval(data, fromMin, toMin) {
  let off = 0, on = 0;
  const lo = Math.max(0, Math.min(1440, fromMin));
  const hi = Math.max(0, Math.min(1440, toMin));
  for (let m = lo; m < hi; m++) {
    off += data.off[m] || 0;
    on  += data.on[m] || 0;
  }
  return { off, on };
}

async function refresh() {
  const dateStr = $('date').value || fmtDate(new Date());
  const data = await getDayData(dateStr);

  const fromParts = $('from').value.split(':').map(Number);
  const toParts   = $('to').value.split(':').map(Number);
  const fromMin = (fromParts[0] || 0) * 60 + (fromParts[1] || 0);
  const toMinInclusive = (toParts[0] || 0) * 60 + (toParts[1] || 0);
  const toMin = Math.min(toMinInclusive + 1, 1440); // treat "to" as inclusive minute

  // Chart range: full day or interval.
  const rangeMode = $('rangeMode').value;
  const chartStart = rangeMode === 'interval' ? fromMin : 0;
  const chartEnd   = rangeMode === 'interval' ? toMin   : 1440;

  // Y-max: fixed value in seconds, or null for auto.
  const yVal = $('yScale').value;
  const yMax = yVal === 'auto' ? null : Number(yVal);

  drawChart(data, chartStart, chartEnd, yMax);

  const { off, on } = computeInterval(data, fromMin, toMin);
  const total = off + on;
  if (total > 0) {
    $('pctOff').textContent = (off / total * 100).toFixed(1) + '%';
    $('pctOn').textContent  = (on  / total * 100).toFixed(1) + '%';
  } else {
    $('pctOff').textContent = '--%';
    $('pctOn').textContent  = '--%';
  }
  $('totals').textContent = `Off ${fmtSec(off)} · On ${fmtSec(on)} · Tracked ${fmtSec(total)}`;
}

async function loadWhitelist() {
  const { whitelist = [] } = await browser.storage.local.get('whitelist');
  const ul = $('wl');
  ul.innerHTML = '';
  if (!whitelist.length) {
    const li = document.createElement('li');
    li.textContent = '(empty)';
    li.style.color = '#888';
    ul.appendChild(li);
    return;
  }
  whitelist.forEach((d, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = 'Remove';
    btn.addEventListener('click', async () => {
      const { whitelist: wl = [] } = await browser.storage.local.get('whitelist');
      wl.splice(i, 1);
      await browser.storage.local.set({ whitelist: wl });
      loadWhitelist();
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

$('addBtn').addEventListener('click', async () => {
  const raw = $('newDomain').value.trim().toLowerCase();
  if (!raw) return;
  // Strip protocol/path if pasted as URL.
  let cleaned = raw;
  try {
    if (raw.includes('://')) cleaned = new URL(raw).hostname;
  } catch { /* keep raw */ }
  cleaned = cleaned.replace(/^www\./, '');
  const { whitelist = [] } = await browser.storage.local.get('whitelist');
  if (!whitelist.includes(cleaned)) {
    whitelist.push(cleaned);
    await browser.storage.local.set({ whitelist });
  }
  $('newDomain').value = '';
  loadWhitelist();
});

$('newDomain').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('addBtn').click();
});

$('resetBtn').addEventListener('click', async () => {
  if (!confirm('Delete all recorded on/off history? Whitelist will be kept. This cannot be undone.')) return;
  const all = await browser.storage.local.get(null);
  const toRemove = Object.keys(all).filter(k => k.startsWith('day_') || k === 'lastCheckT' || k === 'lastState');
  if (toRemove.length) await browser.storage.local.remove(toRemove);
  refresh();
});

['date', 'from', 'to', 'rangeMode', 'yScale'].forEach(id => $(id).addEventListener('change', refresh));

// Init.
$('date').value = fmtDate(new Date());
loadWhitelist();
refresh();
// Live refresh while popup is open.
setInterval(refresh, 5000);
