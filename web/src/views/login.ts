import { sb } from '../supabase';
import { esc, icon, paintIcons } from '../ui';
import { markActive } from '../inactividad';

// Aviso que se muestra una vez en la pantalla de entrada (p. ej. sesión cerrada por inactividad)
let notice = '';
export function setLoginNotice(text: string) { notice = text; }

const MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'Correo o contraseña incorrectos.',
  'Email not confirmed': 'Tu correo aún no está confirmado. Abre el enlace que te llegó por correo.',
  'User already registered': 'Ese correo ya tiene cuenta. Entra con tu contraseña.',
  'Signups not allowed for this instance': 'Por ahora no se pueden crear cuentas. Pide ayuda al administrador.',
  'Password should be at least 6 characters.': 'La contraseña debe tener al menos 8 caracteres.',
};
const msg = (m: string, fallback: string) => MESSAGES[m] ?? (/rate limit/i.test(m) ? 'Demasiados intentos. Espera unos minutos.' : fallback);

type Mode = 'entrar' | 'crear' | 'olvide';

export function renderLogin(app: HTMLElement, onDone: () => void, mode: Mode = 'entrar') {
  const titles: Record<Mode, string> = { entrar: 'Panel de administración', crear: 'Crear cuenta', olvide: 'Recuperar contraseña' };
  app.innerHTML = `<div class="login-wrap"><form class="card login" novalidate>
    <h1>${icon('store')} Tienda POS</h1>
    <p>${titles[mode]}</p>
    ${notice ? `<div class="banner info small">${esc(notice)}</div>` : ''}
    <label>Correo<input name="email" type="email" autocomplete="username" required placeholder="nombre@correo.com"></label>
    ${mode !== 'olvide' ? `<label>Contraseña<input name="password" type="password" autocomplete="${mode === 'crear' ? 'new-password' : 'current-password'}" required${mode === 'crear' ? ' minlength="8"' : ''}></label>` : ''}
    ${mode === 'crear' ? '<label>Repite la contraseña<input name="password2" type="password" autocomplete="new-password" required></label>' : ''}
    <button class="btn primary" type="submit">${mode === 'entrar' ? `${icon('log-in')} Entrar` : mode === 'crear' ? `${icon('user-plus')} Crear cuenta` : 'Enviar enlace'}</button>
    <div class="err" role="alert"></div>
    <div class="small login-links">
      ${mode === 'entrar' ? '<a href="#" data-mode="crear">Crear cuenta</a><a href="#" data-mode="olvide">Olvidé mi contraseña</a>' : '<a href="#" data-mode="entrar">Ya tengo cuenta, entrar</a>'}
    </div>
  </form></div>`;
  notice = '';
  paintIcons();
  const form = app.querySelector('form')!;
  const err = form.querySelector('.err')!;
  const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const val = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '';
  const done = (html: string) => {
    form.innerHTML = `<h1>${icon('store')} Tienda POS</h1><p>${html}</p>
      <button class="btn" type="button" id="back">Volver a entrar</button>`;
    paintIcons();
    form.querySelector<HTMLButtonElement>('#back')!.onclick = () => renderLogin(app, onDone);
  };
  form.querySelectorAll<HTMLAnchorElement>('[data-mode]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); renderLogin(app, onDone, a.dataset.mode as Mode); };
  });
  form.addEventListener('input', () => { err.textContent = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = val('email').trim();
    const password = val('password');
    if (!email || (mode !== 'olvide' && !password)) { err.textContent = 'Escribe tu correo y tu contraseña.'; return; }
    if (mode === 'crear') {
      if (password.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; return; }
      if (password !== val('password2')) { err.textContent = 'Las contraseñas no coinciden.'; return; }
    }
    btn.disabled = true;
    if (mode === 'entrar') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      if (error) { err.textContent = msg(error.message, 'No se pudo entrar. Revisa tu conexión e intenta de nuevo.'); return; }
      markActive();
      onDone();
    } else if (mode === 'crear') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
      btn.disabled = false;
      if (error) { err.textContent = msg(error.message, 'No se pudo crear la cuenta. Intenta de nuevo.'); return; }
      if (data.session) { markActive(); onDone(); return; }
      done(`Listo. Te enviamos un correo a <b>${email.replace(/</g, '&lt;')}</b>: abre el enlace para confirmar tu cuenta.<br><br>
        Después avisa al administrador (o al dueño de la tienda) para que te dé acceso a tu negocio.`);
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      btn.disabled = false;
      if (error) { err.textContent = msg(error.message, 'No se pudo enviar. Intenta de nuevo.'); return; }
      done('Si ese correo tiene cuenta, te llegará un enlace para poner una contraseña nueva.');
    }
  });
}

// Al abrir el enlace de "Olvidé mi contraseña", Supabase entra con una sesión de recuperación
export function renderNewPassword(app: HTMLElement, onDone: () => void) {
  app.innerHTML = `<div class="login-wrap"><form class="card login" novalidate>
    <h1>${icon('store')} Tienda POS</h1>
    <p>Escribe tu contraseña nueva</p>
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
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { err.textContent = msg(error.message, 'No se pudo guardar. Intenta de nuevo.'); return; }
    markActive();
    onDone();
  });
}
