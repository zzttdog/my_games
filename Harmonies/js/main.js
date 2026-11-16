/* ============================================================
 * 设置界面
 * ============================================================ */
function offerSpiritChoice(a, b) {
  const ov = document.getElementById('spiritOv');
  const wrap = document.getElementById('spiritPick');
  wrap.innerHTML = '';
  [a, b].forEach(def => {
    const d = cardHtml({ def, placed: 0, done: false });
    d.onclick = () => {
      G.players[0].spirit = def;
      G.players[0].cards.push(mkCardInst(def));
      log(`你选择了自然之灵「${def.name}」`, 0);
      ov.classList.add('hidden');
      beginTurn();
    };
    wrap.appendChild(d);
  });
  ov.classList.remove('hidden');
}

document.querySelectorAll('#sideOpts .opt, #numOpts .opt, #firstOpts .opt').forEach(btn => {
  btn.onclick = () => {
    const row = btn.parentElement;
    row.querySelectorAll('.opt').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    if (row.id === 'sideOpts') renderAidPreview(); // 切换版图面 → 显示对应提示卡
  };
});

document.getElementById('btnStart').onclick = () => {
  G.side = document.querySelector('#sideOpts .opt.on').dataset.v;
  G.n = +document.querySelector('#numOpts .opt.on').dataset.v;
  G.firstChoice = document.querySelector('#firstOpts .opt.on').dataset.v;
  G.mods.pulse = document.getElementById('modPulse').checked;
  G.mods.spirit = document.getElementById('modSpirit').checked;
  G.mods.cres = document.getElementById('modCres').checked;
  G.mods.sanct = document.getElementById('modSanct').checked;
  document.getElementById('setupOv').classList.add('hidden');
  setup();
};

document.getElementById('btnAgain').onclick = () => {
  document.getElementById('endOv').classList.add('hidden');
  document.getElementById('btnEndFloat').classList.add('hidden');
  document.getElementById('setupOv').classList.remove('hidden');
};
/* 查看战局:收起结算面板,右下角浮出「结算/重新开始」可随时返回 */
document.getElementById('btnView').onclick = () => {
  document.getElementById('endOv').classList.add('hidden');
  document.getElementById('btnEndFloat').classList.remove('hidden');
};
document.getElementById('btnEndFloat').onclick = () => {
  document.getElementById('btnEndFloat').classList.add('hidden');
  document.getElementById('endOv').classList.remove('hidden');
};

/* ---- 整体缩放:右上角 +/- 调节(50%~150%),记忆上次选择 ----
   窄屏(<=899px)上限锁到 100%:桌面端存过 150% 的话,手机上会被放得横向溢出,
   而手机上 #zoomCtl 已隐藏、没法调回来。 */
let zoomPct = Math.max(50, Math.min(150, +(localStorage.getItem('hc_zoom') || 100) || 100));
function zoomMax() { return window.innerWidth <= 899 ? 100 : 150; }
function applyZoom() {
  if (zoomPct > zoomMax()) zoomPct = zoomMax();
  document.body.style.zoom = zoomPct + '%';
  document.getElementById('zoomVal').textContent = zoomPct + '%';
  try { localStorage.setItem('hc_zoom', zoomPct); } catch (e) {}
}
document.getElementById('zoomIn').onclick = () => { zoomPct = Math.min(zoomMax(), zoomPct + 10); applyZoom(); };
document.getElementById('zoomOut').onclick = () => { zoomPct = Math.max(50, zoomPct - 10); applyZoom(); };
window.addEventListener('resize', () => { if (zoomPct > zoomMax()) applyZoom(); });
applyZoom();

/* ---- 卡面预览:悬停临时显示在左上角预览框,点选卡面常驻;设置弹窗打开时沿用跟随式放大 ---- */
const zoomEl = document.getElementById('cardZoom');
const zoomImg = document.getElementById('cardZoomImg');
const previewBox = document.getElementById('cardPreview');
let zoomCard = null;
let pinnedSrc = null;
const setupOpen = () => !document.getElementById('setupOv').classList.contains('hidden');
function showPreview(src) { previewBox.innerHTML = `<img src="${src}" alt="" draggable="false">`; }
function resetPreview() { previewBox.innerHTML = pinnedSrc ? `<img src="${pinnedSrc}" alt="" draggable="false">` : '<div class="pv-ph">悬停或点选右侧卡面<br>(市场/提示卡/动物卡)<br>在此预览</div>'; }
resetPreview();
function moveZoom(e) {
  const w = zoomEl.offsetWidth, h = zoomEl.offsetHeight;
  let x = e.clientX + 18, y = e.clientY + 18;
  if (x + w > innerWidth - 8) x = e.clientX - w - 18;
  if (y + h > innerHeight - 8) y = innerHeight - h - 8;
  zoomEl.style.left = Math.max(8, x) + 'px';
  zoomEl.style.top = Math.max(8, y) + 'px';
}
document.addEventListener('mouseover', e => {
  const c = e.target.closest && e.target.closest('.acard');
  if (!c || c === zoomCard) return;
  const img = c.querySelector('img.aimg');
  if (!img) return;
  zoomCard = c;
  const src = img.getAttribute('src');
  if (setupOpen()) { zoomImg.src = src; zoomEl.style.display = 'block'; moveZoom(e); }
  else showPreview(src);
});
document.addEventListener('mouseout', e => {
  const c = e.target.closest && e.target.closest('.acard');
  if (!c || c !== zoomCard) return;
  if (e.relatedTarget && c.contains(e.relatedTarget)) return;
  zoomCard = null;
  zoomEl.style.display = 'none';
  if (!setupOpen()) resetPreview();
});
document.addEventListener('mousemove', e => { if (zoomCard && setupOpen()) moveZoom(e); });
/* 点选卡面 → 常驻显示;点预览框本身 → 取消常驻 */
document.addEventListener('click', e => {
  const c = e.target.closest && e.target.closest('.acard');
  if (!c) return;
  const img = c.querySelector('img.aimg');
  if (img) { pinnedSrc = img.getAttribute('src'); showPreview(pinnedSrc); }
});
document.getElementById('previewCard').addEventListener('click', () => { pinnedSrc = null; resetPreview(); });

/* ---- 版图提示卡:仅在选择版图面时显示对应面的计分卡(C/D 待补图,后续把路径填入即可) ---- */
const AID_CARDS = {
  A: 'Images/aid/score_side_A.jpg',
  B: 'Images/aid/score_side_B.jpg',
  C: 'Images/aid/score_side_C.jpg',
  D: 'Images/aid/score_side_D.jpg',
};
function renderAidPreview() {
  const el = document.getElementById('aidPreview');
  if (!el) return;
  el.innerHTML = '';
  const side = document.querySelector('#sideOpts .opt.on').dataset.v;
  const img = AID_CARDS[side];
  const d = document.createElement('div');
  d.className = 'acard aid';
  if (img) d.innerHTML = `<img class="aimg" src="${img}" alt="${side}面提示卡" draggable="false"><div class="nm">${side}面计分</div>`;
  else d.innerHTML = `<div class="aid-ph">${side}面提示卡<br>待补图</div>`;
  el.appendChild(d);
}
renderAidPreview();

/* 游戏内顶排左侧的提示卡:显示开局所选面对应的计分卡(C/D 待补图) */
function renderGameAid() {
  const el = document.getElementById('gameAid');
  if (!el) return;
  el.innerHTML = '';
  const img = AID_CARDS[G.side];
  const d = document.createElement('div');
  d.className = 'acard aid';
  if (img) d.innerHTML = `<img class="aimg" src="${img}" alt="${G.side}面提示卡" draggable="false"><div class="nm">${G.side}面计分</div>`;
  else d.innerHTML = `<div class="aid-ph">${G.side}面提示卡<br>待补图</div>`;
  el.appendChild(d);
}

/* ---- 自测(开发用):await runSelfTest(轮数, 选项) 自动对局并返回报告 ---- */
window.runSelfTest = async function (maxRounds = 6, opts = {}) {
  const errors = [];
  const oldErr = window.onerror, oldRej = window.onunhandledrejection;
  window.onerror = m => { errors.push(String(m)); };
  window.onunhandledrejection = e => { errors.push('promise: ' + String(e.reason && e.reason.stack || e.reason)); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const report = [];
  try {
    document.getElementById('modPulse').checked = !!opts.pulse;
    document.getElementById('modSpirit').checked = !!opts.spirit;
    document.getElementById('modCres').checked = !!opts.cres;
    document.getElementById('modSanct').checked = !!opts.sanct;
    const num = String(opts.players || 2);
    document.querySelectorAll('#numOpts .opt').forEach(b => b.classList.toggle('on', b.dataset.v === num));
    document.querySelectorAll('#firstOpts .opt').forEach(b => b.classList.remove('on'));
    document.querySelector('#firstOpts .opt[data-v="me"]').classList.add('on'); // 自测固定你先手
    document.getElementById('setupOv').classList.remove('hidden');
    document.getElementById('btnStart').click();
    if (opts.spirit) { const c = document.querySelector('#spiritPick .acard'); if (c) c.click(); }
    const t0 = Date.now();
    while (!G.over && G.round <= maxRounds && Date.now() - t0 < 120000) {
      if (G.cur === 0) {
        const gi = G.supply.findIndex(g => g.length); if (gi < 0) break;
        takeGroup(gi);
        const p = G.players[0];
        for (const h of G.hand) {
          const k = Object.keys(p.board).find(kk => canPlace(p.board, kk, h.type, p));
          if (k) { lockSanctSite(p.board, k, h.type, p); placeToken(p.board, k, h.type); checkSanctComplete(p.board, k, p); }
          h.placed = true;
        }
        G.hand = [];
        endTurn(); // 直接调用:按钮在放置期间被 renderStats 禁用,click 会静默无效
      }
      await sleep(300);
    }
    const scores = G.players.map(p => scoreBoard(p));
    report.push(`n=${G.n} round=${G.round} over=${G.over} cur=${G.cur} pouch=${G.pouch.length}`);
    G.players.forEach((p, i) => report.push(`${p.name}=${JSON.stringify(scores[i])}`));
    report.push('cells ' + G.players.map(p => `${p.name}:${Object.values(p.board).filter(c => c.stack.length).length}`).join(' '));
    report.push('cards ' + G.players.map(p => `[${p.cards.map(c => c.def.name + ':' + c.placed).join(',')}]`).join(' '));
    report.push(errors.length ? 'ERRORS: ' + errors.slice(0, 3).join(' | ') : 'no js errors');
  } catch (e) { report.push('SELFTEST EXCEPTION: ' + (e && e.stack || e)); }
  window.onerror = oldErr; window.onunhandledrejection = oldRej;
  return report.join('\n');
};
