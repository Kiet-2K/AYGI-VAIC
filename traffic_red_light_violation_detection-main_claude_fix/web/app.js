// app.js – Cap nhat dashboard giao thong Da Nang theo thoi gian thuc.
// Poll /api/state (den + so xe) va /api/violations (bien so vi pham).

const STATE_MS = 1000;
const VIOL_MS  = 3000;
const STATS_MS = 5000;

// ---- Theme sang/toi ----
const themeBtn = document.getElementById('theme-btn');
const themeIcon = document.getElementById('theme-icon');
function applyTheme(t) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  themeIcon.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', t);
}
applyTheme(localStorage.getItem('theme') || 'light');
themeBtn.onclick = () => applyTheme(
  document.documentElement.classList.contains('dark') ? 'light' : 'dark');

// ---- Den: 3 bong, sang bong dang bat ----
const LABEL = { red: 'DỪNG LẠI', yellow: 'CHUẨN BỊ', green: 'ĐƯỢC ĐI', unknown: 'CHƯA RÕ' };
const STATE_COLOR = { red: '#ef4444', yellow: '#eab308', green: '#22c55e', unknown: '#94a3b8' };

function renderLights(containerId, active) {
  const c = document.getElementById(containerId);
  if (c.children.length !== 3) {
    c.innerHTML = '<div class="bulb"></div><div class="bulb"></div><div class="bulb"></div>';
  }
  const [r, y, g] = c.children;
  r.className = 'bulb' + (active === 'red' ? ' on-red' : '');
  y.className = 'bulb' + (active === 'yellow' ? ' on-yellow' : '');
  g.className = 'bulb' + (active === 'green' ? ' on-green' : '');
}

function setState(prefix, state, t) {
  const st = (state || 'unknown').toLowerCase();
  renderLights('lights-' + prefix, st);
  document.getElementById('time-' + prefix).textContent =
    (typeof t === 'number' && t >= 0) ? String(t).padStart(2, '0') : '--';
  const el = document.getElementById('state-' + prefix);
  el.textContent = LABEL[st] || 'CHƯA RÕ';
  el.style.color = STATE_COLOR[st] || '#94a3b8';
}

function setConn(ok, note) {
  const dot = document.getElementById('conn-dot');
  dot.style.background = ok ? '#22c55e' : '#ef4444';
  dot.style.boxShadow = `0 0 0 3px ${ok ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.25)'}`;
  document.getElementById('conn-text').textContent = note;
}

// ---- Bien so kieu VN ----
function plateHTML(plate, extraClass) {
  const has = plate && plate !== 'Không đọc được' && plate.toLowerCase() !== 'unknown';
  const cls = 'plate' + (has ? '' : ' na') + (extraClass ? ' ' + extraClass : '');
  return `<span class="${cls}"><span class="flag">VN</span><span class="txt">${esc(has ? plate : '??')}</span></span>`;
}

async function pollState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const d = await r.json();
    if (!d.available) {
      setConn(false, 'Hệ thống chưa chạy');
      setState('v', 'unknown', null);
      setState('h', 'unknown', null);
      document.getElementById('green-v').textContent = '⚡ Xanh thích ứng: -- s';
      document.getElementById('green-h').textContent = '⚡ Xanh thích ứng: -- s';
    } else {
      const mega = d.arduino_connected;
      setConn(mega, mega ? 'Mega: Đã kết nối' : 'Mega: Ngoại tuyến');
      setState('v', d.vertical, d.t_v);
      setState('h', d.horizontal, d.t_h);
      document.getElementById('cnt-v').textContent = `🚗 ${d.count_v ?? 0} xe`;
      document.getElementById('cnt-h').textContent = `🚗 ${d.count_h ?? 0} xe`;
      const gv = d.green_v ?? 0, gh = d.green_h ?? 0;
      document.getElementById('green-v').textContent =
        gv > 0 ? `⚡ Xanh thích ứng: ${gv} s` : '⚡ Xanh thích ứng: -- s';
      document.getElementById('green-h').textContent =
        gh > 0 ? `⚡ Xanh thích ứng: ${gh} s` : '⚡ Xanh thích ứng: -- s';
      document.getElementById('stat-cars').textContent = d.count_v ?? 0;
      document.getElementById('stat-motor').textContent = d.count_h ?? 0;
      document.getElementById('stat-fps').textContent = Math.round(d.fps ?? 0);
    }
  } catch (e) {
    setConn(false, 'Mất kết nối server');
  }
}

function renderHero(v) {
  const hero = document.getElementById('hero');
  if (!v) { hero.classList.add('hidden'); return; }
  hero.classList.remove('hidden');
  const img = document.getElementById('hero-img');
  if (v.image) {
    const src = '/violations/' + encodeURIComponent(v.image);
    img.src = src; img.className = 'hero-photo';
    img.onclick = () => openModal(src);
    img.onerror = () => { img.className = 'hero-photo none'; img.removeAttribute('src'); img.textContent = 'Không có ảnh'; };
  } else {
    img.className = 'hero-photo none'; img.removeAttribute('src');
  }
  const p = document.getElementById('hero-plate');
  const has = v.plate && v.plate !== 'Không đọc được' && v.plate.toLowerCase() !== 'unknown';
  p.className = 'plate' + (has ? '' : ' na');
  p.querySelector('.txt').textContent = has ? v.plate : '??';
  document.getElementById('hero-type').textContent = v.type || '--';
  document.getElementById('hero-lane').textContent = v.lane || '--';
  document.getElementById('hero-time').textContent = v.time || '--';
}

async function pollViolations() {
  try {
    const r = await fetch('/api/violations', { cache: 'no-store' });
    const list = await r.json();
    document.getElementById('stat-viol').textContent = list.length;
    document.getElementById('viol-count').textContent = `${list.length} vi phạm`;

    renderHero(list.length ? list[0] : null);

    const grid = document.getElementById('viol-grid');
    if (!list.length) {
      grid.innerHTML = '<div class="viol-empty"><div class="big">✅</div>Chưa có vi phạm nào được ghi nhận.</div>';
      return;
    }
    grid.innerHTML = list.map(v => {
      const imgCell = v.image
        ? `<img class="vimg" src="/violations/${encodeURIComponent(v.image)}" onclick="openModal('/violations/${encodeURIComponent(v.image)}')" onerror="this.className='vimg none';this.removeAttribute('src');this.textContent='Không có ảnh'" />`
        : `<div class="vimg none">Không có ảnh</div>`;
      const clipBtn = v.clip
        ? `<button class="clip-btn" onclick="openClip('/violations/${encodeURIComponent(v.clip)}')">▶ Xem clip</button>`
        : '';
      return `<div class="vcard">
        ${imgCell}
        <div class="vbody">
          ${plateHTML(v.plate)}
          <div class="vrow"><span>${esc(v.type)}</span><span class="tag">${esc(v.lane)}</span></div>
          <div class="vrow"><span>${esc(v.time)}</span>${clipBtn}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) { /* giu nguyen khi loi tam thoi */ }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

window.openModal = (src) => {
  document.getElementById('modal-img').src = src;
  const m = document.getElementById('modal');
  m.classList.remove('hidden');
};
window.closeModal = () => document.getElementById('modal').classList.add('hidden');

// ---- Modal clip video vi pham ----
window.openClip = (src) => {
  const vid = document.getElementById('modal-vid');
  vid.src = src;
  document.getElementById('modal-video').classList.remove('hidden');
  vid.play().catch(() => {});
};
window.closeClip = () => {
  const vid = document.getElementById('modal-vid');
  vid.pause();
  vid.removeAttribute('src');
  vid.load();
  document.getElementById('modal-video').classList.add('hidden');
};

// ---- Bieu do thong ke (Feature #3): ve bang CSS thuan, khong can thu vien ----
const TYPE_VI = { car: 'Ô tô', motorcycle: 'Xe máy', motorbike: 'Xe máy',
                  bus: 'Xe buýt', truck: 'Xe tải', bicycle: 'Xe đạp' };

function renderHourChart(byHour) {
  const box = document.getElementById('chart-hour');
  if (!box) return;
  const arr = Array.isArray(byHour) ? byHour : [];
  const max = Math.max(1, ...arr);
  box.innerHTML = arr.map((v, h) => {
    const pct = Math.round((v / max) * 100);
    return `<div class="bh" title="${h}h: ${v} vi phạm">
      <span class="hv">${v || ''}</span>
      <div class="fill${v ? '' : ' zero'}" style="height:${v ? pct : 0}%"></div>
      <span class="hl">${h % 3 === 0 ? h : ''}</span>
    </div>`;
  }).join('');
}

function renderBarsV(elId, obj) {
  const box = document.getElementById(elId);
  if (!box) return;
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    box.innerHTML = '<div class="chart-empty">Chưa có dữ liệu</div>';
    return;
  }
  const max = Math.max(1, ...entries.map(e => e[1]));
  box.innerHTML = entries.map(([k, v]) => {
    const pct = Math.round((v / max) * 100);
    const label = TYPE_VI[k.toLowerCase()] || k;
    return `<div class="bv">
      <span class="lb">${esc(label)}</span>
      <div class="track"><div class="fv" style="width:${pct}%"></div></div>
      <span class="vv">${v}</span>
    </div>`;
  }).join('');
}

async function pollStats() {
  try {
    const r = await fetch('/api/stats', { cache: 'no-store' });
    const d = await r.json();
    renderHourChart(d.by_hour);
    renderBarsV('chart-type', d.by_type);
    renderBarsV('chart-lane', d.by_lane);
    const totalEl = document.getElementById('stats-total');
    if (totalEl) totalEl.textContent = `Tổng: ${d.total ?? 0}`;
  } catch (e) { /* giu nguyen khi loi tam thoi */ }
}

// ---- QR link tu /api/telegram ----
async function loadTelegramLink() {
  try {
    const r = await fetch('/api/telegram', { cache: 'no-store' });
    const d = await r.json();
    if (d.link) {
      document.getElementById('qr-link').href = d.link;
      if (d.name) document.getElementById('qr-caption').textContent = d.name;
    }
  } catch (e) { /* bo qua */ }
}

// ---- Camera video: lam moi /frame.jpg lien tuc de thanh video ----
function refreshCamera() {
  const img = document.getElementById('cam-img');
  if (!img) return;
  const next = new Image();
  next.onload = () => {
    img.src = next.src;
    img.style.display = 'block';
    document.getElementById('cam-fallback').style.display = 'none';
  };
  next.onerror = () => {
    document.getElementById('cam-fallback').style.display = 'flex';
    img.style.display = 'none';
  };
  next.src = '/frame.jpg?t=' + Date.now();
}

loadTelegramLink();
pollState(); pollViolations(); pollStats();
setInterval(pollState, STATE_MS);
setInterval(pollViolations, VIOL_MS);
setInterval(pollStats, VIOL_MS);
setInterval(refreshCamera, 200);
refreshCamera();
