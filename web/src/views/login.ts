import { sb } from '../supabase';
import { icon, paintIcons } from '../ui';

const MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'Correo o contraseña incorrectos.',
  'Email not confirmed': 'Tu correo aún no está confirmado.',
};

export function renderLogin(app: HTMLElement, onDone: () => void) {
  app.innerHTML = `<div class="login-wrap"><form class="card login" novalidate>
    <h1>${icon('store')} Tienda POS</h1>
    <p>Panel de administración</p>
    <label>Correo<input name="email" type="email" autocomplete="username" required placeholder="nombre@correo.com"></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">${icon('log-in')} Entrar</button>
    <div class="err" role="alert"></div>
  </form></div>`;
  paintIcons();
  const form = app.querySelector('form')!;
  const err = form.querySelector('.err')!;
  const btn = form.querySelector('button')!;
  form.addEventListener('input', () => { err.textContent = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    if (!email || !password) { err.textContent = 'Escribe tu correo y tu contraseña.'; return; }
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) { err.textContent = MESSAGES[error.message] ?? 'No se pudo entrar. Revisa tu conexión e intenta de nuevo.'; return; }
    onDone();
  });
}
