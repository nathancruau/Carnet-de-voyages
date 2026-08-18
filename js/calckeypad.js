/* ============================================================
   CARNET DE VOYAGES — Calculator keypad for montant fields
   Replaces the native keyboard on a money <input> with an in-app keypad
   limited to digits + basic operators (+ − × ÷), matching the Tricount
   app's own UX: the field shows the live expression as you type it, a
   small preview line shows the running result, and once validated only
   the final number remains — no calculator, no expression, just the
   montant, exactly as if it had been typed directly.
   ============================================================ */

let _kpOv    = null;
let _kpInput = null;
let _kpExpr  = '';
let _kpFresh = false; // true = next key continues from the field's existing value, not from _kpExpr

/**
 * Turn a montant <input> into a calculator-keypad-only field: no native
 * keyboard (readonly + inputmode="none"), tap/focus opens the on-screen
 * keypad instead. Idempotent — safe to call again on the same element.
 * Callers that re-render their HTML (participant split rows, currency
 * change…) must call this again on the fresh nodes since attaching is
 * per-element, not delegated.
 */
export function attachCalcKeypad(input) {
  if (!input || input._calcKp) return;
  input._calcKp = true;
  input.readOnly = true;
  input.setAttribute('inputmode', 'none');
  const open = () => {
    // Blur immediately: a focused input (even readonly/inputmode=none) can
    // still make iOS Safari scroll it into view / resize the dynamic
    // toolbar right after our fixed-position keypad has already painted —
    // a known WebKit desync between the visual viewport and the layout
    // used for touch hit-testing (same bug family as this app's other
    // position:fixed iOS issues, see CLAUDE.md v103/v156/v192). That left
    // the keypad's buttons visually one row off from where taps actually
    // landed. Blurring before opening means the viewport never moves.
    input.blur();
    _open(input);
  };
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
}

function _open(input) {
  if (_kpInput === input) return;
  if (_kpInput) _commit(); // defensive: shouldn't happen since the overlay covers everything while open

  _kpInput = input;
  _kpExpr  = (input.value || '').toString();
  _kpFresh = _kpExpr !== '';

  if (!_kpOv) _build();
  _kpOv.classList.add('open');
  _render();
}

function _build() {
  _kpOv = document.createElement('div');
  _kpOv.className = 'calc-kp-ov';
  _kpOv.innerHTML = `
    <div class="calc-kp-sheet">
      <div class="calc-kp-display">
        <div class="calc-kp-expr" id="calc-kp-expr"></div>
        <div class="calc-kp-preview" id="calc-kp-preview"></div>
      </div>
      <div class="calc-kp-ops">
        <button type="button" data-k="÷" class="calc-kp-op">÷</button>
        <button type="button" data-k="×" class="calc-kp-op">×</button>
        <button type="button" data-k="-" class="calc-kp-op">−</button>
        <button type="button" data-k="+" class="calc-kp-op">+</button>
      </div>
      <div class="calc-kp-grid">
        <button type="button" data-k="7">7</button>
        <button type="button" data-k="8">8</button>
        <button type="button" data-k="9">9</button>
        <button type="button" data-k="4">4</button>
        <button type="button" data-k="5">5</button>
        <button type="button" data-k="6">6</button>
        <button type="button" data-k="1">1</button>
        <button type="button" data-k="2">2</button>
        <button type="button" data-k="3">3</button>
        <button type="button" data-k="del" class="calc-kp-del">⌫</button>
        <button type="button" data-k="0">0</button>
        <button type="button" data-k=".">,</button>
      </div>
      <button type="button" class="calc-kp-ok" data-k="ok">✓ Valider</button>
    </div>`;
  document.body.appendChild(_kpOv);

  _kpOv.addEventListener('click', ev => {
    if (ev.target === _kpOv) { _commit(); return; } // tap on backdrop = validate & close
    const btn = ev.target.closest('button[data-k]');
    if (btn) _key(btn.dataset.k);
  });
}

function _key(k) {
  if (k === 'ok')  { _commit(); return; }
  if (k === 'del') { _kpExpr = _kpExpr.slice(0, -1); _kpFresh = false; _render(); return; }

  const isDigit = k >= '0' && k <= '9';
  const isDot   = k === '.';
  const isOp    = k === '+' || k === '-' || k === '×' || k === '÷';

  if (_kpFresh) {
    // Field already showed a committed value: a digit/dot starts typing a
    // brand new number over it (like a calculator right after "="), while
    // an operator continues the calculation from that existing value.
    _kpExpr  = isOp ? _kpExpr + k : k;
    _kpFresh = false;
    _render();
    return;
  }

  if (isOp) {
    if (_kpExpr === '') return; // no leading operator on an empty expression
    // Replace a trailing operator instead of stacking one ("12+" + "-" → "12-")
    _kpExpr = /[+\-×÷]$/.test(_kpExpr) ? _kpExpr.slice(0, -1) + k : _kpExpr + k;
  } else if (isDot) {
    const seg = _kpExpr.split(/[+\-×÷]/).pop();
    if (!seg.includes('.')) _kpExpr += seg === '' ? '0.' : '.';
  } else if (isDigit) {
    const seg = _kpExpr.split(/[+\-×÷]/).pop();
    _kpExpr = seg === '0' ? _kpExpr.slice(0, -1) + k : _kpExpr + k;
  }
  _render();
}

function _render() {
  const exprEl = document.getElementById('calc-kp-expr');
  const prevEl = document.getElementById('calc-kp-preview');
  if (!exprEl || !prevEl) return;
  exprEl.textContent = (_kpExpr || '0').replace(/\./g, ',');

  const hasOp = /[+\-×÷]/.test(_kpExpr);
  const val   = hasOp ? _evalExpr(_kpExpr) : null;
  prevEl.textContent = val === null ? ''
    : '= ' + val.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * Evaluate a simple "12+5×2" style expression: standard × ÷ before + −
 * precedence, both passes left-to-right. Manual tokenizer/parser (never
 * eval()) — the string only ever contains digits, '.', and the four
 * operator characters typed via the keypad above, but a hand-rolled
 * evaluator keeps it that way by construction. Division by zero returns 0
 * (a money field showing Infinity/NaN would be worse) rather than
 * throwing. Returns null for an expression with no complete number yet.
 */
function _evalExpr(expr) {
  const clean = expr.replace(/[+\-×÷]$/, ''); // drop a dangling trailing operator
  if (clean === '') return null;
  const tokens = clean.match(/\d+\.?\d*|[+\-×÷]/g);
  if (!tokens || tokens.length === 0) return null;

  const pass1 = [tokens[0]];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i], rhs = tokens[i + 1];
    if (rhs === undefined) break; // dangling operator already stripped, but stay defensive
    if (op === '×' || op === '÷') {
      const a = Number(pass1.pop());
      const b = Number(rhs);
      pass1.push(String(op === '×' ? a * b : (b === 0 ? 0 : a / b)));
    } else {
      pass1.push(op, rhs);
    }
  }

  let result = Number(pass1[0]);
  for (let i = 1; i < pass1.length; i += 2) {
    const rhs = Number(pass1[i + 1]);
    result = pass1[i] === '+' ? result + rhs : result - rhs;
  }
  return Math.round(result * 100) / 100;
}

function _commit() {
  if (!_kpInput) return;
  const val = _kpFresh ? (parseFloat(_kpExpr) || 0) : (_evalExpr(_kpExpr) ?? 0);
  const input = _kpInput;
  _close();
  input.value = val ? String(val) : '';
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function _close() {
  if (_kpOv) _kpOv.classList.remove('open');
  _kpInput = null;
  _kpExpr  = '';
  _kpFresh = false;
}
