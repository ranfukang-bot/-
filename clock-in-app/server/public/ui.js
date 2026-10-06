/* 星光打卡 · 共享界面工具（员工端 + 管理后台） */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '¥' + (Math.round((+n || 0) * 100) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const cnDs = ds => { const [y, m, d] = String(ds).split('-').map(Number); return `${y}年${m}月${d}日`; };
  const cnYm = ym => { const [y, m] = String(ym).split('-').map(Number); return `${y}年${m}月`; };
  const durTxt = ms => { const s = Math.max(0, Math.floor(ms / 1000)), p = n => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`; };
  const META = {
    normal: { c: 'st-normal', i: '✨' }, late: { c: 'st-late', i: '🌤️' }, undone: { c: 'st-undone', i: '⏳' },
    zero: { c: 'st-zero', i: '🌧️' }, absent: { c: 'st-absent', i: '💤' }, future: { c: 'st-future', i: '' },
    waiting: { c: 'st-pending', i: '⌛' }, working: { c: 'st-pending', i: '💼' }, na: { c: 'st-na', i: '' }
  };
  let modals = 0;

  function toast(msg, type = '') {
    let box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3000);
  }
  function openModal(html, { cls = '', wide = false, onClose, dismiss = true } = {}) {
    const m = document.createElement('div'); m.className = 'mask ' + cls;
    m.innerHTML = `<div class="dlg ${wide ? 'wide' : ''}">${dismiss ? '<button class="x" data-x>✕</button>' : ''}${html}</div>`;
    document.body.appendChild(m); modals++;
    let closed = false;
    const onKey = e => { if (e.key === 'Escape' && dismiss) close(null); };
    const close = v => {
      if (closed) return; closed = true; modals--;
      removeEventListener('keydown', onKey);
      m.classList.add('out'); setTimeout(() => m.remove(), 260); onClose && onClose(v);
    };
    m.addEventListener('click', e => { if (dismiss && (e.target === m || e.target.closest('[data-x]'))) close(null); });
    addEventListener('keydown', onKey);
    return { el: m, dlg: m.querySelector('.dlg'), close };
  }
  function askInput({ title, text = '', type = 'text', placeholder = '', okText = '确定', value = '', textarea = false, icon = '' }) {
    return new Promise(res => {
      const m = openModal(`
        ${icon ? `<div style="font-size:46px;text-align:center;margin-bottom:6px">${icon}</div>` : ''}
        <h2 ${icon ? 'style="text-align:center"' : ''}>${esc(title)}</h2>
        ${text ? `<p class="muted" style="line-height:1.7;margin:4px 0 14px">${text}</p>` : '<div style="height:10px"></div>'}
        ${textarea ? `<textarea class="inp" data-v placeholder="${esc(placeholder)}" maxlength="200">${esc(value)}</textarea>`
          : `<input class="inp" data-v type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off">`}
        <div class="row end" style="margin-top:16px"><button class="btn" data-x>取消</button><button class="btn primary" data-ok>${esc(okText)}</button></div>`,
        { onClose: v => res(v) });
      const inp = $('[data-v]', m.el); setTimeout(() => inp.focus(), 60);
      $('[data-ok]', m.el).onclick = () => m.close(inp.value);
      if (!textarea) inp.addEventListener('keydown', e => { if (e.key === 'Enter') m.close(inp.value); });
    });
  }
  function confirmBox({ title, text = '', okText = '确定', danger = false, icon = '' }) {
    return new Promise(res => {
      const m = openModal(`
        ${icon ? `<div style="font-size:46px;text-align:center;margin-bottom:6px">${icon}</div>` : ''}
        <h2 ${icon ? 'style="text-align:center"' : ''}>${esc(title)}</h2><p class="muted" style="line-height:1.7">${text}</p>
        <div class="row end" style="margin-top:18px"><button class="btn" data-x>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button></div>`,
        { onClose: v => res(!!v) });
      $('[data-ok]', m.el).onclick = () => m.close(true);
    });
  }
  function countUp(el, to, dur = 1300, fmt = money) {
    const t0 = performance.now();
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4); el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(name, text, type = 'text/csv;charset=utf-8', bom = true) {
    const b = new Blob([bom ? '﻿' + text : text], { type }), a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function moveInd() {
    const b = $('#tabs button.on'), ind = $('#tabInd'); if (!b || !ind) return;
    ind.style.left = b.offsetLeft + 'px'; ind.style.top = b.offsetTop + 'px'; ind.style.width = b.offsetWidth + 'px'; ind.style.height = b.offsetHeight + 'px';
  }
  addEventListener('resize', moveInd);
  // 卡片聚光灯 + 按钮涟漪
  document.addEventListener('pointermove', e => {
    const c = e.target.closest && e.target.closest('.card'); if (!c) return;
    const r = c.getBoundingClientRect(); c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest && e.target.closest('.btn,.pbtn'); if (!el) return;
    const r = el.getBoundingClientRect(), s = Math.max(r.width, r.height), rp = document.createElement('span');
    rp.className = 'ripple'; rp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    el.appendChild(rp); setTimeout(() => rp.remove(), 700);
  });

  window.UI = { $, $$, esc, money, pick, WEEK, cnDs, cnYm, durTxt, META, toast, openModal, askInput, confirmBox, countUp, csvCell, download, moveInd, get modalOpen() { return modals > 0; } };
})();
