import type { Ctx } from '../main';
import { addMember, getRolePermissions, listMembers, listPosUsers, recentChanges, removeMember, saveCajaUser, saveRolePermissions, type Member, type PosUser, type RemoteChange, type RolePermissions } from '../api';
import { askConfirm, esc, fmtDate, icon, openSheet, paintIcons, toast } from '../ui';
import { askResetPassword } from './cuentas-ui';

// Mismas etiquetas que la pantalla de Permisos de la app (PERM_LABELS en src/index.html)
export const PERM_LABELS: Record<string, string> = {
  settings: 'Personalización / configuración general',
  catalogs: 'Catálogos (categorías, unidades, proveedores)',
  products: 'Agregar y editar productos',
  movements: 'Entradas, salidas y mermas',
  counts: 'Conteos de inventario',
  cashcut: 'Abrir caja y hacer cortes X/Z',
};
export const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', encargado: 'Encargado', cajero: 'Cajero' };
const MEMBER_LABEL: Record<string, string> = { owner: 'Dueño', gestor: 'Gestor (solo consulta)' };

export async function renderUsuarios(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Quién usa la caja y quién entra a este panel';
  el.innerHTML = '<div class="card empty">Cargando…</div>';
  let users: PosUser[] = [], canEdit = false, perms: RolePermissions | null = null, pending: RemoteChange[] = [];
  try {
    const [u, p, ch] = await Promise.all([listPosUsers(ctx.business.id), getRolePermissions(ctx.business.id), recentChanges(ctx.business.id)]);
    users = u.users; canEdit = u.canEdit && ctx.canManageDevices; perms = p;
    pending = ch.filter((x) => (x.type === 'user_save' || x.type === 'role_permissions') && x.status === 'pendiente');
  } catch (e) {
    el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    return;
  }
  const reload = () => void renderUsuarios(ctx, el);
  const waitFor = (u: PosUser) => pending.find((x) => x.type === 'user_save' && x.payload.uid === u.uid);
  const newWaiting = pending.filter((x) => x.type === 'user_save' && !x.payload.uid);
  const permsWaiting = pending.some((x) => x.type === 'role_permissions');
  const roles = ['encargado', 'cajero'];
  el.innerHTML = `
    <div class="section-title" style="margin-top:0">${icon('users')} Usuarios de la caja
      ${canEdit ? `<button class="btn primary" id="u-new" style="margin-left:auto">${icon('user-plus')} Nuevo usuario</button>` : ''}</div>
    ${newWaiting.map((x) => `<div class="banner wait small">${icon('history')}<span>Alta esperando a la caja: <b>${esc(x.payload.display_name)}</b></span></div>`).join('')}
    ${users.length ? `<ul class="list card">${users.map((u, i) => {
      const w = waitFor(u);
      return `<li class="assign">
        <div class="grow"><div><b>${esc(u.display_name || 'Sin nombre')}</b></div>
          ${w ? `<div class="small" style="color:var(--warn)">Cambio esperando a la caja</div>` : ''}</div>
        <span class="pill ${u.role === 'admin' ? 'ok' : 'off'}">${esc(ROLE_LABEL[u.role ?? ''] ?? u.role ?? '—')}</span>
        ${u.active === false ? '<span class="pill bad">Inactivo</span>' : ''}
        ${canEdit && !w ? `<button class="btn" data-u-edit="${i}">${icon('pencil')} Editar</button>
          <button class="btn" data-u-pin="${i}">${icon('key-round')} Cambiar PIN</button>
          <button class="btn" data-u-active="${i}">${icon(u.active === false ? 'eye' : 'eye-off')} ${u.active === false ? 'Activar' : 'Desactivar'}</button>` : ''}
      </li>`;
    }).join('')}</ul>`
      : '<div class="card empty small">La caja aún no ha enviado sus usuarios.</div>'}
    <p class="small muted">${canEdit
      ? 'Los cambios se envían a la caja, que los revisa y los aplica. El PIN nunca se muestra aquí. Para borrar un usuario, hazlo en la caja.'
      : ctx.canManageDevices && users.length
        ? 'Para manejar los usuarios desde aquí, la caja necesita la versión 0.2.17. Mientras tanto se cambian en la caja (Configuración → Usuarios).'
        : 'Los usuarios y su PIN se cambian en la caja (Configuración → Usuarios).'}</p>

    <div class="section-title">${icon('shield-check')} Permisos por rol</div>
    ${permsWaiting ? `<div class="banner wait small">${icon('history')}<span>Hay un cambio de permisos esperando a la caja.</span></div>` : ''}
    ${perms ? `<div class="card table-wrap"><table class="table">
        <thead><tr><th>Puede, sin pedir autorización</th>${roles.map((r) => `<th class="center">${ROLE_LABEL[r]}</th>`).join('')}</tr></thead>
        <tbody>${Object.entries(PERM_LABELS).map(([k, label]) => `<tr><td>${esc(label)}</td>${roles.map((r) => canEdit && !permsWaiting
          ? `<td class="center"><input type="checkbox" data-perm="${r}:${k}" aria-label="${esc(ROLE_LABEL[r])}: ${esc(label)}"${perms![r]?.[k] ? ' checked' : ''}></td>`
          : `<td class="center">${perms![r]?.[k] ? `<span class="pill ok">${icon('check')} Sí</span>` : '<span class="pill off">No</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        ${canEdit && !permsWaiting ? `<div class="modal-actions" style="margin-top:10px;justify-content:flex-start"><button class="btn primary" id="perm-save" style="flex:0 0 auto">Revisar cambios de permisos</button></div>` : ''}
        <p class="small muted">El administrador siempre tiene acceso completo. Todos los roles pueden cobrar.</p>`
      : '<div class="card empty small">La caja aún no ha enviado sus permisos.</div>'}

    ${ctx.canManageDevices ? '<div class="section-title">' + icon('key-round') + ' Accesos a este panel</div><div id="members"><div class="card empty small">Cargando…</div></div>' : ''}`;
  paintIcons();
  const pick = (attr: string) => (b: HTMLElement) => users[Number(b.getAttribute(attr))];
  el.querySelector<HTMLButtonElement>('#u-new')?.addEventListener('click', () => openUserForm(ctx, null, users, 'new', reload));
  el.querySelectorAll<HTMLButtonElement>('[data-u-edit]').forEach((b) => b.onclick = () => openUserForm(ctx, pick('data-u-edit')(b), users, 'edit', reload));
  el.querySelectorAll<HTMLButtonElement>('[data-u-pin]').forEach((b) => b.onclick = () => openUserForm(ctx, pick('data-u-pin')(b), users, 'pin', reload));
  el.querySelectorAll<HTMLButtonElement>('[data-u-active]').forEach((b) => b.onclick = () => openUserActive(ctx, pick('data-u-active')(b), users, reload));
  el.querySelector<HTMLButtonElement>('#perm-save')?.addEventListener('click', () => {
    const after: RolePermissions = {}, before: RolePermissions = {};
    const lines: string[] = [];
    el.querySelectorAll<HTMLInputElement>('[data-perm]').forEach((c) => {
      const [r, k] = c.dataset.perm!.split(':');
      const was = !!perms![r]?.[k];
      if (c.checked !== was) {
        (after[r] ??= {})[k] = c.checked; (before[r] ??= {})[k] = was;
        lines.push(`${ROLE_LABEL[r]} · ${PERM_LABELS[k]}: ${was ? 'Sí' : 'No'} → ${c.checked ? 'Sí' : 'No'}`);
      }
    });
    if (!lines.length) return toast('No cambiaste ningún permiso');
    const body = openSheet('Permisos por rol', '');
    const close = () => body.closest('.sheet-bg')?.remove();
    review(body, `¿Enviar estos permisos a la caja de ${esc(storeName(ctx))}?`,
      `<div class="card table-wrap"><table class="table"><tbody>${lines.map((l) => `<tr><td>${esc(l)}</td></tr>`).join('')}</tbody></table></div>`,
      after.cajero && Object.entries(after.cajero).some(([k, v]) => v && k !== 'cashcut') ? ['El cajero podrá hacer cambios que hoy necesitan autorización de un encargado.'] : [],
      close, async () => {
        await saveRolePermissions(ctx.business.id, before, after);
        toast('Enviado a la caja. Míralo en Modificados.');
        close(); reload();
      });
  });
  if (ctx.canManageDevices) await drawMembers(ctx, el.querySelector('#members')!);
}

const storeName = (ctx: Ctx) => ctx.business.name || ctx.business.license_key;
const activeAdmins = (users: PosUser[]) => users.filter((u) => u.role === 'admin' && u.active !== false);
const oldOf = (u: PosUser) => ({ display_name: u.display_name, role: u.role, active: u.active !== false });

function review(body: HTMLElement, intro: string, table: string, warns: string[], onBack: () => void, onSend: () => Promise<void>) {
  body.innerHTML = `<div class="small muted" style="margin-bottom:10px">${intro}</div>${table}
    ${warns.length ? `<div class="banner wait small" style="margin-top:12px">${icon('triangle-alert')}<div><b>¿Seguro?</b><br>${warns.map(esc).join('<br>')}</div></div>` : ''}
    <div class="modal-actions" style="margin-top:14px"><button class="btn" id="r-back">Corregir</button><button class="btn primary" id="r-send">Sí, enviar</button></div>`;
  paintIcons();
  body.querySelector<HTMLButtonElement>('#r-back')!.onclick = onBack;
  const send = body.querySelector<HTMLButtonElement>('#r-send')!;
  send.onclick = async () => {
    send.disabled = true;
    try { await onSend(); } catch (e) { send.disabled = false; toast((e as Error).message); }
  };
}

// Alta, editar nombre y rol, o cambiar PIN. El PIN se escribe dos veces y nunca se muestra después.
function openUserForm(ctx: Ctx, u: PosUser | null, users: PosUser[], mode: 'new' | 'edit' | 'pin', done: () => void) {
  const title = mode === 'new' ? 'Nuevo usuario de la caja' : mode === 'pin' ? `Cambiar PIN: ${u!.display_name ?? ''}` : `Editar: ${u!.display_name ?? ''}`;
  const body = openSheet(title, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  const d = { name: u?.display_name ?? '', role: u?.role ?? 'cajero', pin: '', pin2: '' };
  const form = () => {
    body.innerHTML = `<form class="edit-form" novalidate autocomplete="off">
      ${mode !== 'pin' ? `<label>Nombre<input id="u-name" required maxlength="80" value="${esc(d.name)}" autocomplete="off"></label>
        <label>Rol<select id="u-role">${(['cajero', 'encargado', 'admin'] as const).map((r) => `<option value="${r}"${r === d.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></label>` : ''}
      ${mode !== 'edit' ? `<label>${mode === 'pin' ? 'PIN nuevo' : 'PIN'}<input id="u-pin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" value="${esc(d.pin)}"></label>
        <label>Repite el PIN<input id="u-pin2" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" value="${esc(d.pin2)}"></label>
        <div class="small muted">De 4 a 12 números. Con este PIN entra a la caja. Díselo en persona; aquí no se vuelve a mostrar.</div>` : ''}
      <div class="err" role="alert"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" type="button" id="u-cancel">Cancelar</button><button class="btn primary" type="submit">Revisar</button></div>
    </form>`;
    const f = body.querySelector('form')!;
    f.querySelector<HTMLButtonElement>('#u-cancel')!.onclick = close;
    f.onsubmit = (ev) => {
      ev.preventDefault();
      const val = (id: string) => f.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value.trim() ?? '';
      if (mode !== 'pin') { d.name = val('u-name'); d.role = val('u-role'); }
      if (mode !== 'edit') { d.pin = val('u-pin'); d.pin2 = val('u-pin2'); }
      const err = f.querySelector('.err')!;
      if (mode !== 'pin' && !d.name) { err.textContent = 'Escribe el nombre.'; return; }
      if (mode !== 'edit') {
        if (!/^[0-9]{4,12}$/.test(d.pin)) { err.textContent = 'El PIN debe tener de 4 a 12 números.'; return; }
        if (d.pin !== d.pin2) { err.textContent = 'Los dos PIN no coinciden.'; return; }
        if (d.pin === d.name) { err.textContent = 'El nombre no puede ser igual al PIN.'; return; }
      }
      const dup = users.find((x) => x !== u && (x.display_name ?? '').trim().toLowerCase() === d.name.toLowerCase());
      const rows: [string, string, string][] = [];
      if (mode === 'new') rows.push(['Nombre', '', d.name], ['Rol', '', ROLE_LABEL[d.role]], ['PIN', '', '•'.repeat(d.pin.length)]);
      if (mode === 'edit') {
        if ((u!.display_name ?? '') !== d.name) rows.push(['Nombre', u!.display_name ?? '', d.name]);
        if (u!.role !== d.role) rows.push(['Rol', ROLE_LABEL[u!.role ?? ''] ?? '', ROLE_LABEL[d.role]]);
        if (!rows.length) { err.textContent = 'No cambiaste nada.'; return; }
      }
      if (mode === 'pin') rows.push(['PIN', '••••', '•'.repeat(d.pin.length)]);
      const warns: string[] = [];
      if (d.role === 'admin' && (mode === 'new' || u!.role !== 'admin')) warns.push('Un administrador puede hacer todo en la caja, incluido cambiar usuarios, permisos y productos.');
      if (mode === 'edit' && u!.role === 'admin' && d.role !== 'admin' && activeAdmins(users).length <= 1 && u!.active !== false) {
        err.textContent = 'Es el único administrador activo: la caja no puede quedarse sin administrador.'; return;
      }
      if (dup && mode !== 'pin') warns.push(`Ya hay otro usuario llamado "${dup.display_name}".`);
      if (mode === 'pin') warns.push('El PIN anterior dejará de servir y, si está dentro de la caja, se cerrará su sesión.');
      const table = `<div class="card table-wrap"><table class="table"><thead><tr><th>Dato</th>${mode === 'new' ? '' : '<th>Antes</th>'}<th>${mode === 'new' ? 'Valor' : 'Después'}</th></tr></thead><tbody>
        ${rows.map(([l, a, b]) => `<tr><td>${l}</td>${mode === 'new' ? '' : `<td>${esc(a || '—')}</td>`}<td><b>${esc(b)}</b></td></tr>`).join('')}</tbody></table></div>`;
      review(body, `¿Enviar este cambio a la caja de ${esc(storeName(ctx))}?`, table, warns, form, async () => {
        if (mode === 'new') await saveCajaUser(ctx.business.id, null, null, d.name, d.role, true, d.pin);
        else await saveCajaUser(ctx.business.id, u!.uid, oldOf(u!), mode === 'pin' ? u!.display_name ?? '' : d.name, mode === 'pin' ? u!.role ?? 'cajero' : d.role, null, mode === 'pin' ? d.pin : null);
        d.pin = ''; d.pin2 = '';
        toast('Enviado a la caja. Míralo en Modificados.');
        close(); done();
      });
    };
  };
  form();
}

function openUserActive(ctx: Ctx, u: PosUser, users: PosUser[], done: () => void) {
  const turnOn = u.active === false;
  if (!turnOn && u.role === 'admin' && activeAdmins(users).length <= 1) {
    toast('Es el único administrador activo: la caja no puede quedarse sin administrador.');
    return;
  }
  const body = openSheet(`${turnOn ? 'Activar' : 'Desactivar'}: ${u.display_name ?? ''}`, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  review(body, `¿Enviar este cambio a la caja de ${esc(storeName(ctx))}?`,
    `<div class="card pad small">${turnOn
      ? `<b>${esc(u.display_name)}</b> podrá volver a entrar a la caja con su PIN.`
      : `<b>${esc(u.display_name)}</b> ya no podrá entrar a la caja y, si está dentro, se cerrará su sesión. No se borra: sus ventas y su historial se conservan, y se puede volver a activar.`}</div>`,
    [], close, async () => {
      await saveCajaUser(ctx.business.id, u.uid, oldOf(u), u.display_name ?? '', u.role ?? 'cajero', turnOn, null);
      toast('Enviado a la caja. Míralo en Modificados.');
      close(); done();
    });
}

async function drawMembers(ctx: Ctx, box: HTMLElement) {
  let members: Member[] = [];
  try {
    members = await listMembers(ctx.business.id);
  } catch (e) {
    box.innerHTML = `<div class="card empty small">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    return;
  }
  const isSuper = ctx.role === 'superadmin';
  // El dueño solo puede quitar gestores; el superadmin, a cualquiera
  const canRemove = (m: Member) => isSuper || m.role === 'gestor';
  box.innerHTML = `
    ${members.length ? `<ul class="list card">${members.map((m) => `<li>
        <div class="grow"><div><b>${esc(m.email)}</b></div><div class="small muted">Desde ${fmtDate(m.created_at)}</div></div>
        ${isSuper
          ? `<select data-role="${m.user_id}" aria-label="Acceso de ${esc(m.email)}">${(['gestor', 'owner'] as const).map((r) =>
              `<option value="${r}"${m.role === r ? ' selected' : ''}>${MEMBER_LABEL[r]}</option>`).join('')}</select>`
          : `<span class="pill ${m.role === 'owner' ? 'ok' : 'off'}">${MEMBER_LABEL[m.role]}</span>`}
        ${isSuper ? `<button class="icon-btn" data-reset="${m.user_id}" aria-label="Restablecer contraseña" title="Restablecer contraseña">${icon('key-round')}</button>` : ''}
        ${canRemove(m) ? `<button class="icon-btn" data-remove="${m.user_id}" aria-label="Quitar acceso" title="Quitar acceso">${icon('trash-2')}</button>` : ''}
      </li>`).join('')}</ul>` : '<div class="card empty small">Nadie más tiene acceso todavía.</div>'}
    <form class="card pad" id="add" style="margin-top:12px">
      <div style="font-weight:600;margin-bottom:6px">${icon('user-plus')} Dar acceso</div>
      <p class="small muted" style="margin:0 0 10px">${isSuper ? 'Si la persona aún no tiene cuenta, créala en Tiendas → Crear cuenta.' : 'La persona ya debe tener cuenta; las crea el administrador del sistema.'}</p>
      <div class="filters" style="margin:0">
        <label class="grow-field">Correo<input type="email" id="m-email" required placeholder="correo@ejemplo.com" autocomplete="off"></label>
        <label>Acceso<select id="m-role">
          <option value="gestor">${MEMBER_LABEL.gestor}</option>
          ${isSuper ? `<option value="owner">${MEMBER_LABEL.owner}</option>` : ''}</select></label>
        <button class="btn primary" type="submit">${icon('user-plus')} Dar acceso</button>
      </div>
      <p class="small muted" style="margin:10px 0 0">El gestor ve ventas, cortes, inventario, movimientos y reportes, pero no aprueba cajas ni da accesos.${isSuper ? ' El dueño además aprueba cajas y da accesos a gestores.' : ''}</p>
    </form>`;
  paintIcons();
  box.querySelector<HTMLFormElement>('#add')!.onsubmit = async (e) => {
    e.preventDefault();
    const email = box.querySelector<HTMLInputElement>('#m-email')!.value.trim();
    const role = box.querySelector<HTMLSelectElement>('#m-role')!.value as 'owner' | 'gestor';
    if (!await askConfirm(`¿Dar acceso de ${MEMBER_LABEL[role]} a ${email} en "${ctx.business.name || ctx.business.license_key}"?`)) return;
    try {
      await addMember(ctx.business.id, email, role);
      toast('Acceso agregado');
      await drawMembers(ctx, box);
    } catch (err) {
      const text = (err as Error).message;
      toast(text.includes('aún no tiene cuenta') ? 'Ese correo aún no tiene cuenta. Las cuentas las crea el administrador del sistema.' : text);
    }
  };
  box.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach((b) => {
    b.onclick = () => {
      const m = members.find((x) => x.user_id === b.dataset.reset)!;
      void askResetPassword(m.user_id, m.email);
    };
  });
  // Cambiar de gestor a dueño o al revés (solo el superadmin ve el selector)
  box.querySelectorAll<HTMLSelectElement>('[data-role]').forEach((s) => {
    s.onchange = async () => {
      const m = members.find((x) => x.user_id === s.dataset.role)!;
      const role = s.value as Member['role'];
      if (!await askConfirm(`¿Cambiar a ${m.email} de ${MEMBER_LABEL[m.role]} a ${MEMBER_LABEL[role]}?`)) { s.value = m.role; return; }
      s.disabled = true;
      try {
        await addMember(ctx.business.id, m.email, role);
        toast('Acceso cambiado');
        await drawMembers(ctx, box);
      } catch (err) {
        s.value = m.role;
        s.disabled = false;
        toast((err as Error).message);
      }
    };
  });
  box.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const m = members.find((x) => x.user_id === b.dataset.remove)!;
      if (!await askConfirm(`¿Quitar el acceso de ${m.email}?\n\nYa no podrá ver este negocio en el panel. Su cuenta no se borra.`)) return;
      try {
        await removeMember(ctx.business.id, m.user_id);
        toast('Acceso quitado');
        await drawMembers(ctx, box);
      } catch (err) {
        toast((err as Error).message);
      }
    };
  });
}
