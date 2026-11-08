// Calculator — glass keypad with keyboard support.
import { h } from '../util.js';
import { registerApp } from '../wm.js';
import { api } from '../sys.js';

registerApp({
  id: 'calculator', name: 'Calculator', size: [300, 470], minSize: [300, 470], resizable: false, overlayContent: true, hideTitle: true, className: 'calc-win',
  keywords: ['math', 'calc'],
  open(win) {
    let cur = '0', acc = null, op = null, fresh = true, exprText = '';
    const val = h('div.val', '0'), expr = h('div.expr');
    const keys = h('div.keys');
    const fmt = (n) => { if (!isFinite(n)) return 'Error'; const s = String(+n.toPrecision(12)); return s.length > 12 ? n.toExponential(6) : s; };
    const show = () => { val.textContent = cur.replace(/\B(?=(\d{3})+(?!\d))/g, (m, o) => (cur.indexOf('.') >= 0 && o > cur.indexOf('.') ? '' : ',')); val.style.fontSize = cur.length > 9 ? '38px' : '54px'; expr.textContent = exprText; for (const b of keys.querySelectorAll('.op')) b.classList.toggle('on', b.dataset.op === op && fresh); keys.querySelector('[data-k="AC"]').textContent = cur !== '0' && !fresh ? '⌫' : 'AC'; };
    const calc = (a, b, o) => ({ '+': a + b, '−': a - b, '×': a * b, '÷': a / b }[o]);
    const press = (k) => {
      if (/^[0-9]$/.test(k)) { cur = fresh || cur === '0' ? k : cur.length < 15 ? cur + k : cur; fresh = false; }
      else if (k === '.') { if (fresh) { cur = '0.'; fresh = false; } else if (!cur.includes('.')) cur += '.'; }
      else if (k === 'AC') { if (!fresh && cur !== '0') { cur = cur.length > 1 ? cur.slice(0, -1) : '0'; } else { cur = '0'; acc = null; op = null; exprText = ''; } }
      else if (k === '±') cur = cur.startsWith('-') ? cur.slice(1) : cur === '0' ? cur : '-' + cur;
      else if (k === '%') cur = fmt(parseFloat(cur) / 100);
      else if (['+', '−', '×', '÷'].includes(k)) {
        if (op && !fresh) { acc = calc(acc, parseFloat(cur), op); cur = fmt(acc); } else acc = parseFloat(cur);
        op = k; fresh = true; exprText = `${fmt(acc)} ${k}`;
      } else if (k === '=') {
        if (op) { const b = parseFloat(cur); exprText = `${fmt(acc)} ${op} ${fmt(b)} =`; cur = fmt(calc(acc, b, op)); acc = null; op = null; fresh = true; }
      }
      show();
    };
    const layout = [['AC', 'fn'], ['±', 'fn'], ['%', 'fn'], ['÷', 'op'], ['7'], ['8'], ['9'], ['×', 'op'], ['4'], ['5'], ['6'], ['−', 'op'], ['1'], ['2'], ['3'], ['+', 'op'], ['0', 'zero'], ['.'], ['=', 'op']];
    for (const [k, c] of layout) keys.append(h('button' + (c ? '.' + c : ''), { 'data-k': k, 'data-op': k, onclick: () => press(k) }, k));
    win.body.append(h('div.calc', h('div.disp', expr, val), keys));
    win.dragRegion(win.body.querySelector('.disp'));
    win.el.tabIndex = 0;
    win.el.addEventListener('keydown', (e) => {
      const map = { '+': '+', '-': '−', '*': '×', '/': '÷', Enter: '=', '=': '=', Escape: 'AC', Backspace: 'AC', '%': '%', '.': '.', ',': '.' };
      const k = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
      if (k) { e.preventDefault(); press(k); const b = keys.querySelector(`[data-k="${CSS.escape(k)}"]`); b?.animate([{ filter: 'brightness(1.6)' }, { filter: 'none' }], 160); }
      if (e.ctrlKey && e.key === 'c') api.clip.write(cur);
    });
    win.on('focus', () => win.el.focus());
    show();
  },
});
