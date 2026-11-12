import { resetAccountPassword } from '../api';
import { askConfirm, esc, toast } from '../ui';

// Sin letras ni números que se confundan al dictarla por teléfono
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function tempPassword(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(10)), (n) => ALPHABET[n % ALPHABET.length]).join('');
}

// Se muestra una sola vez. Va dentro de #app para que se borre si la sesión termina.
export function showCredentials(title: string, email: string, password: string) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="cred-title">
    <h2 id="cred-title">${esc(title)}</h2>
    <p style="overflow-wrap:anywhere">${esc(email)}<br>Contraseña temporal:<br><b class="num">${esc(password)}</b></p>
    <p class="small">Dísela a la persona; no se vuelve a mostrar. Al entrar tendrá que elegir una nueva.</p>
    <div class="modal-actions">
      <button class="btn" type="button" id="cred-copy">Copiar</button>
      <button class="btn primary" type="button" id="cred-ok">Listo</button>
    </div></div>`;
  document.getElementById('app')!.append(bg);
  bg.querySelector<HTMLButtonElement>('#cred-copy')!.onclick = () => {
    navigator.clipboard.writeText(password).then(() => toast('Copiada'), () => toast('No se pudo copiar'));
  };
  const ok = bg.querySelector<HTMLButtonElement>('#cred-ok')!;
  ok.onclick = () => bg.remove();
  ok.focus();
}

export async function askResetPassword(userId: string, email: string) {
  if (!await askConfirm(`¿Poner una contraseña temporal a ${email}?\n\nSu contraseña actual dejará de servir.`)) return;
  const password = tempPassword();
  try {
    await resetAccountPassword(userId, password);
    showCredentials('Contraseña restablecida', email, password);
  } catch (err) {
    toast((err as Error).message);
  }
}
