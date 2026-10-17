// The album: every garden saved on this device, newest first. Runs as an extension page, so it
// talks to the background over runtime messages like the content scripts do.
const api = globalThis.browser ?? globalThis.chrome;
const send = (msg) => api.runtime.sendMessage(msg);
const grid = document.getElementById('grid'), count = document.getElementById('count');
const empty = document.getElementById('empty'), forgetAllBtn = document.getElementById('forget-all');

function fmtDate(t) { try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return ''; } }

async function render() {
  const index = (await send({ type: 'dirt:list' })) || [];
  grid.replaceChildren();
  count.textContent = index.length === 1 ? '1 garden' : `${index.length} gardens`;
  empty.hidden = index.length > 0;
  forgetAllBtn.hidden = index.length === 0;
  for (const e of index) {
    const card = document.createElement('article'); card.className = 'card';
    const a = document.createElement('a'); a.className = 'shot'; a.href = e.url; a.target = '_blank'; a.rel = 'noopener'; a.title = 'Open this page';
    if (e.hasThumb) {
      send({ type: 'dirt:thumb', url: e.url }).then(src => { if (src) { const img = new Image(); img.src = src; img.alt = ''; a.replaceChildren(img); } }).catch(() => {});
    }
    const meta = document.createElement('div'); meta.className = 'meta';
    const title = document.createElement('div'); title.className = 'title'; title.textContent = e.title || e.host || e.url;
    const sub = document.createElement('div'); sub.className = 'sub';
    const biome = document.createElement('span'); biome.className = 'biome'; biome.textContent = e.biome || '';
    const when = document.createElement('span'); when.textContent = fmtDate(e.savedAt);
    sub.append(biome, when);
    const host = document.createElement('div'); host.className = 'sub'; host.textContent = e.host || '';
    const actions = document.createElement('div'); actions.className = 'actions';
    const open = document.createElement('button'); open.textContent = 'Visit'; open.onclick = () => { window.open(e.url, '_blank', 'noopener'); };
    const forget = document.createElement('button'); forget.textContent = 'Forget'; forget.className = 'danger';
    forget.onclick = async () => { await send({ type: 'dirt:forget', url: e.url }); render(); };
    actions.append(open, forget);
    meta.append(title, sub, host, actions);
    card.append(a, meta);
    grid.append(card);
  }
}

forgetAllBtn.onclick = async () => {
  if (!confirm('Forget every garden saved in this browser?')) return;
  await send({ type: 'dirt:forget-all' });
  render();
};

render();
