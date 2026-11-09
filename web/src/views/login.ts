import { sb } from '../supabase';
import { esc, icon, paintIcons } from '../ui';
import { markActive } from '../inactividad';

// Las cuentas y las contraseñas olvidadas las atiende solo el administrador del sistema
const CONTACT_EMAIL = 'jag2261236@gmail.com';

// Aviso que se muestra una vez en la pantalla de entrada (p. ej. sesión cerrada por inactividad)
let notice = '';
export function setLoginNotice(text: string) { notice = text; }

const MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'Correo o contraseña incorrectos.',
  'Email not confirmed': 'Tu cuenta aún no está confirmada. Contacta al administrador.',
  'Password should be at least 6 characters.': 'La contraseña debe tener al menos 8 caracteres.',
  'New password should be different from the old password.': 'La contraseña nueva debe ser distinta de la anterior.',
};
const msg = (m: string, fallback: string) => MESSAGES[m] ?? (/rate limit/i.test(m) ? 'Demasiados intentos. Espera unos minutos.' : fallback);

export function renderLogin(app: HTMLElement, onDone: () => void) {
  app.innerHTML = `<div class="login-wrap"><form class="card login" novalidate>
    <h1>${icon('store')} Tienda POS</h1>
    <p>Panel de administración</p>
    ${notice ? `<div class="banner info small">${esc(notice)}</div>` : ''}
    <label>Correo<input name="email" type="email" autocomplete="username" required placeholder="nombre@correo.com"></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">${icon('log-in')} Entrar</button>
    <div class="err" role="alert"></div>
    <div class="small login-help">¿Necesitas una cuenta o no recuerdas tu contraseña? Contacta al administrador: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></div>
  </form></div>`;
  notice = '';
  paintIcons();
  const form = app.querySelector('form')!;
  const err = form.querySelector('.err')!;
  const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const val = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
  form.addEventListener('input', () => { err.textContent = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = val('email').trim();
    const password = val('password');
    if (!email || !password) { err.textContent = 'Escribe tu correo y tu contraseña.'; return; }
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) { err.textContent = msg(error.message, 'No se pudo entrar. Revisa tu conexión e intenta de nuevo.'); return; }
    markActive();
    onDone();
  });
}

// Para quien entra con una contraseña temporal o con un enlace de recuperación enviado desde Supabase
export function renderNewPassword(app: HTMLElement, onDone: () => void, note = 'Escribe tu contraseña nueva') {
  app.innerHTML = `<div class="login-wrap"><form class="card login" novalidate>
    <h1>${icon('store')} Tienda POS</h1>
    <p>${esc(note)}</p>
    <label>Contraseña nueva<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
    <label>Repítela<input name="password2" type="password" autocomplete="new-password" required></label>
    <button class="btn primary" type="submit">Guardar contraseña</button>
    <div class="err" role="alert"></div>
  </form></div>`;
  paintIcons();
  const form = app.querySelector('form')!;
  const err = form.querySelector('.err')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = (form.elements.namedItem('password') as HTMLInputElement).value;
    const p2 = (form.elements.namedItem('password2') as HTMLInputElement).value;
    if (p1.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; return; }
    if (p1 !== p2) { err.textContent = 'Las contraseñas no coinciden.'; return; }
    const { error } = await sb.auth.updateUser({ password: p1, data: { must_change_password: false } });
    if (error) { err.textContent = msg(error.message, 'No se pudo guardar. Intenta de nuevo.'); return; }
    markActive();
    onDone();
  });
}
