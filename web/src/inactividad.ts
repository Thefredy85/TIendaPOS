// Cierre de sesión por inactividad: a los 5 minutos sin tocar el panel aparece una
// cuenta regresiva de 30 segundos (Terminar / Continuar); si nadie responde, se cierra.
// La última actividad se guarda en localStorage para que todas las pestañas cuenten
// juntas y para que, al abrir el enlace después de un rato, se pida entrar de nuevo.

const KEY = 'panel.lastActivity';
// En desarrollo se puede acortar para probar: localStorage['panel.idleMs'] = '10000'
const devMs = import.meta.env.DEV ? Number(safeGet('panel.idleMs')) : 0;
const IDLE_MS = devMs > 0 ? devMs : 5 * 60_000;
const WARN_MS = 30_000;
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove'] as const;

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: cuenta solo esta pestaña */ }
}

let last = 0;
let written = 0;
let timer = 0;
let modal: HTMLElement | null = null;
let onExpire: (() => void) | null = null;

// Última actividad conocida (esta pestaña u otra)
function lastActivity(): number {
  return Math.max(last, Number(safeGet(KEY)) || 0);
}

// Para llamar justo al entrar (contraseña correcta, cuenta nueva o contraseña nueva)
export function markActive() {
  last = Date.now();
  written = last;
  safeSet(KEY, String(last));
}

// ¿La sesión guardada ya venció? (se revisa al abrir el panel)
export function idleExpired(): boolean {
  const l = lastActivity();
  return !l || Date.now() - l >= IDLE_MS + WARN_MS;
}

function activity() {
  if (modal) return; // con la cuenta regresiva abierta solo cuentan sus botones
  last = Date.now();
  if (last - written > 5_000) { written = last; safeSet(KEY, String(last)); }
}

function hideModal() {
  modal?.remove();
  modal = null;
}

function showModal(secondsLeft: number) {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-bg';
    modal.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-text">
      <h2 id="idle-title">¿Sigues ahí?</h2>
      <p id="idle-text">La sesión terminará en <b class="num" id="idle-s"></b> segundos.</p>
      <div class="modal-actions">
        <button class="btn" id="idle-end">Terminar</button>
        <button class="btn primary" id="idle-go">Continuar</button>
      </div></div>`;
    document.body.append(modal);
    modal.querySelector<HTMLButtonElement>('#idle-go')!.onclick = () => { hideModal(); markActive(); };
    modal.querySelector<HTMLButtonElement>('#idle-end')!.onclick = () => expire();
    modal.querySelector<HTMLButtonElement>('#idle-go')!.focus();
  }
  modal.querySelector('#idle-s')!.textContent = String(secondsLeft);
}

function expire() {
  const fn = onExpire;
  stopIdleWatch();
  fn?.();
}

function tick() {
  const idle = Date.now() - lastActivity();
  if (idle >= IDLE_MS + WARN_MS) return expire();
  if (idle >= IDLE_MS) showModal(Math.ceil((IDLE_MS + WARN_MS - idle) / 1000));
  else hideModal(); // hubo actividad en otra pestaña
}

const onVisible = () => { if (document.visibilityState === 'visible') tick(); };

export function startIdleWatch(expired: () => void) {
  stopIdleWatch();
  onExpire = expired;
  if (!lastActivity()) markActive();
  EVENTS.forEach((e) => window.addEventListener(e, activity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', onVisible);
  timer = window.setInterval(tick, 1000);
}

export function stopIdleWatch() {
  EVENTS.forEach((e) => window.removeEventListener(e, activity, { capture: true }));
  document.removeEventListener('visibilitychange', onVisible);
  clearInterval(timer);
  hideModal();
  onExpire = null;
}
