/* =====================================================================
 * Acceso seguro y conexión a Supabase (sin librerías de terceros)
 * - Solo usuarios invitados; correo confirmado; segundo factor TOTP obligatorio.
 * - La sesión vive en esta pestaña: token de acceso en memoria y token de
 *   renovación en sessionStorage (se borra al cerrar la pestaña).
 * - Cierre automático por 30 min de inactividad.
 * - Los datos solo se piden con sesión aal2; la base los filtra con RLS por
 *   organización, rol y licencia (aunque alguien manipule este código).
 * ===================================================================== */
(function () {
  'use strict';
  const CFG = { url: 'https://aqpbthffuoegawxswwhf.supabase.co', key: 'sb_publishable__M6yykWLOeu456A-u-6ExA_r4Nnreok' };
  const SITE = location.origin + location.pathname;
  const IDLE_MS = 30 * 60 * 1000;
  const RK = 'osm.rt.v1', ORGK = 'osm.org.v1';
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {} } };
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let sess = null;           // {access_token, refresh_token, expires_at, user}
  let refreshTimer = null, idleTimer = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  /* ---------------- HTTP ---------------- */
  const claims = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } };
  async function call(path, { method = 'GET', body, auth = true, headers = {}, raw = false } = {}) {
    const h = Object.assign({ apikey: CFG.key, 'Content-Type': 'application/json' }, headers);
    if (auth && sess) h.Authorization = 'Bearer ' + sess.access_token;
    let res = await fetch(CFG.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
    if (res.status === 401 && auth && sess && !path.startsWith('/auth/v1/token')) {
      if (await refresh()) { h.Authorization = 'Bearer ' + sess.access_token; res = await fetch(CFG.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' }); }
    }
    if (raw) return res;
    const txt = await res.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!res.ok) { const e = new Error(friendly(data, res.status)); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  function friendly(d, st) {
    const m = (d && (d.msg || d.message || d.error_description || d.error || d.hint)) || '';
    const code = (d && (d.error_code || d.code)) || '';
    if (/invitaci|Database error saving new user|unexpected_failure/i.test(m + code)) return 'Este correo no tiene una invitación vigente. Pida acceso al administrador de su organización.';
    if (/invalid login credentials|invalid_credentials/i.test(m + code)) return 'Correo o contraseña incorrectos.';
    if (/email not confirmed/i.test(m + code)) return 'Confirme su correo con el enlace que le enviamos antes de ingresar.';
    if (/invalid.*(code|totp)|mfa_verification_failed/i.test(m + code)) return 'El código no es válido. Use el código actual de su aplicación autenticadora.';
    if (/rate limit|too many/i.test(m) || st === 429) return 'Demasiados intentos. Espere unos minutos y vuelva a intentar.';
    if (/weak|password should|at least/i.test(m)) return 'La contraseña no cumple la política de seguridad.';
    if (/row-level security|permission denied|42501/i.test(m + code)) return 'Su rol o la licencia de su organización no permiten esta acción.';
    return m || 'Error ' + st;
  }

  /* ---------------- Sesión ---------------- */
  function setSession(s) {
    sess = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: s.user || (sess && sess.user) };
    ss.set(RK, sess.refresh_token);
    clearTimeout(refreshTimer);
    const ms = Math.max(30000, (sess.expires_at - 60) * 1000 - Date.now());
    refreshTimer = setTimeout(refresh, ms);
  }
  async function refresh() {
    const rt = (sess && sess.refresh_token) || ss.get(RK);
    if (!rt) return false;
    try { setSession(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rt }, auth: false })); return true; }
    catch (e) { clear(); return false; }
  }
  function clear() { sess = null; ss.set(RK, null); clearTimeout(refreshTimer); }
  const aal = () => (sess ? claims(sess.access_token).aal || 'aal1' : null);
  async function logout(reason) {
    try { if (sess) await call('/auth/v1/logout?scope=local', { method: 'POST' }); } catch (e) {}
    clear(); if (reason) ss.set('osm.msg', reason); location.replace(SITE);
  }
  function armIdle() {
    const reset = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => logout('Sesión cerrada por 30 minutos de inactividad.'), IDLE_MS); };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, reset, { passive: true }));
    reset();
  }

  /* ---------------- Pantalla de acceso ---------------- */
  let gate;
  function showGate(html) {
    if (!gate) {
      gate = document.createElement('div'); gate.id = 'authGate'; gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true');
      document.body.appendChild(gate);
    }
    const w = document.querySelector('.wrap'); if (w) w.hidden = true;
    gate.hidden = false;
    gate.innerHTML = `<div class="ag-card"><div class="ag-brand">Oil Static Measure<small>Acceso seguro · solo usuarios invitados</small></div><div id="agMsg" class="msgs"></div>${html}</div>`;
    const f = gate.querySelector('input'); if (f) f.focus();
  }
  function hideGate() { if (gate) gate.hidden = true; const w = document.querySelector('.wrap'); if (w) w.hidden = false; }
  function msg(text, kind = 'bad') { const m = document.getElementById('agMsg'); if (m) m.innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`; }
  const field = (id, label, type = 'text', extra = '') => `<label class="f"><span>${label}</span><input id="${id}" type="${type}" ${extra}></label>`;
  const busy = (b, on) => { if (b) { b.disabled = on; b.dataset.t = b.dataset.t || b.textContent; b.textContent = on ? 'Verificando…' : b.dataset.t; } };

  function vLogin() {
    showGate(`<form id="agLogin" class="ag-form" novalidate>
      ${field('agEmail', 'Correo', 'email', 'autocomplete="username" required maxlength="160"')}
      ${field('agPass', 'Contraseña', 'password', 'autocomplete="current-password" required maxlength="128"')}
      <button class="b p" id="agGo" type="submit">Ingresar</button></form>
      <div class="ag-links"><button class="b s" data-ag="signup" type="button">Activar mi invitación</button><button class="b s" data-ag="forgot" type="button">Olvidé mi contraseña</button><button class="b s" data-ag="demo" type="button">Ver demostración sin cuenta</button></div>
      <p class="note">El acceso exige un código de una aplicación autenticadora (Google Authenticator, Microsoft Authenticator, Authy u otra). La sesión se cierra tras 30 minutos sin actividad o al cerrar la pestaña.</p>`);
    const m = ss.get('osm.msg'); if (m) { msg(m, 'info'); ss.set('osm.msg', null); }
  }
  function vSignup() {
    showGate(`<form id="agSignup" class="ag-form" novalidate>
      <p class="note">Use el mismo correo al que llegó la invitación. Sin invitación vigente, el sistema rechaza el registro.</p>
      ${field('agEmail', 'Correo invitado', 'email', 'autocomplete="username" required maxlength="160"')}
      ${field('agPass', 'Nueva contraseña (mínimo 12 caracteres, con letras y números)', 'password', 'autocomplete="new-password" required minlength="12" maxlength="128"')}
      ${field('agPass2', 'Repita la contraseña', 'password', 'autocomplete="new-password" required minlength="12" maxlength="128"')}
      <button class="b p" id="agGo" type="submit">Crear acceso</button></form><div class="ag-links"><button class="b s" data-ag="login" type="button">Volver</button></div>`);
  }
  function vForgot() {
    showGate(`<form id="agForgot" class="ag-form" novalidate>${field('agEmail', 'Correo', 'email', 'autocomplete="username" required maxlength="160"')}
      <button class="b p" id="agGo" type="submit">Enviar enlace</button></form><div class="ag-links"><button class="b s" data-ag="login" type="button">Volver</button></div>`);
  }
  function vNewPass() {
    showGate(`<form id="agNewPass" class="ag-form" novalidate><p class="note">Defina su nueva contraseña.</p>
      ${field('agPass', 'Nueva contraseña (mínimo 12 caracteres, con letras y números)', 'password', 'autocomplete="new-password" required minlength="12" maxlength="128"')}
      ${field('agPass2', 'Repita la contraseña', 'password', 'autocomplete="new-password" required minlength="12" maxlength="128"')}
      <button class="b p" id="agGo" type="submit">Guardar contraseña</button></form>`);
  }
  function vMfaVerify(factor, then) {
    showGate(`<form id="agMfa" class="ag-form" novalidate data-f="${esc(factor.id)}"><p class="note">Escriba el código de 6 dígitos de su aplicación autenticadora.</p>
      ${field('agCode', 'Código', 'text', 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required')}
      <button class="b p" id="agGo" type="submit">Verificar</button></form><div class="ag-links"><button class="b s" data-ag="logout" type="button">Cancelar</button></div>`);
    pendingThen = then;
  }
  async function vMfaEnroll(then) {
    showGate('<p class="note">Preparando el segundo factor…</p>');
    try {
      const u = await call('/auth/v1/user');
      for (const f of (u.factors || []).filter((x) => x.status !== 'verified')) await call('/auth/v1/factors/' + f.id, { method: 'DELETE' });
      const f = await call('/auth/v1/factors', { method: 'POST', body: { factor_type: 'totp', friendly_name: 'OSM ' + new Date().toISOString().slice(0, 16), issuer: 'Oil Static Measure' } });
      showGate(`<form id="agMfa" class="ag-form" novalidate data-f="${esc(f.id)}"><p><b>Active el segundo factor (obligatorio).</b> Escanee el código con su aplicación autenticadora y escriba el código que muestra.</p>
        <img class="ag-qr" alt="Código QR para la aplicación autenticadora" src="${esc(f.totp.qr_code)}">
        <p class="note">¿No puede escanear? Clave: <code class="ag-secret">${esc(f.totp.secret)}</code></p>
        ${field('agCode', 'Código de 6 dígitos', 'text', 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required')}
        <button class="b p" id="agGo" type="submit">Activar y continuar</button></form><div class="ag-links"><button class="b s" data-ag="logout" type="button">Cancelar</button></div>`);
      pendingThen = then;
    } catch (e) { showGate(''); msg(e.message); }
  }
  let pendingThen = null;

  /* ---------------- Flujo posterior al login ---------------- */
  async function afterPassword() {
    const u = await call('/auth/v1/user'); sess.user = u;
    const verified = (u.factors || []).filter((f) => f.factor_type === 'totp' && f.status === 'verified');
    if (aal() === 'aal2') return chooseOrg();
    if (verified.length) return vMfaVerify(verified[0], chooseOrg);
    return vMfaEnroll(chooseOrg);
  }
  async function chooseOrg() {
    const rows = await call('/rest/v1/memberships?select=org_id,role,display_name,email,organizations(name)&user_id=eq.' + encodeURIComponent(sess.user.id));
    const admin = await call('/rest/v1/rpc/am_platform_admin', { method: 'POST', body: {} }).catch(() => false);
    if (!rows.length && !admin) {
      showGate('<p>Su cuenta está activa pero aún no pertenece a ninguna organización. Pida al administrador de su organización que lo agregue.</p><div class="ag-links"><button class="b s" data-ag="logout" type="button">Salir</button></div>');
      return;
    }
    let pick = rows.find((r) => r.org_id === ls.get(ORGK)) || rows[0];
    if (rows.length > 1 && !rows.some((r) => r.org_id === ls.get(ORGK))) {
      showGate(`<p>Elija la organización con la que va a trabajar.</p><div class="ag-links" style="flex-direction:column;align-items:stretch">${rows.map((r) => `<button class="b" data-org="${esc(r.org_id)}" type="button">${esc(r.organizations?.name || r.org_id)} · ${esc(roleLabel(r.role))}</button>`).join('')}</div>`);
      pendingOrgs = { rows, admin }; return;
    }
    finish(pick, admin, rows);
  }
  let pendingOrgs = null;
  const roleLabel = (r) => ({ owner: 'Propietario', admin: 'Administrador', analyst: 'Analista', viewer: 'Visor' }[r] || 'Sin rol');
  const rank = (r) => ({ viewer: 1, analyst: 2, admin: 3, owner: 4 }[r] || 0);

  function finish(m, admin, rows) {
    const orgId = m ? m.org_id : null;
    if (orgId) ls.set(ORGK, orgId);
    hideGate(); armIdle();
    window.OSM_SESSION = {
      orgId, role: m ? m.role : null, platformAdmin: !!admin, email: sess.user.email, memberOrgs: rows.map((r) => r.org_id),
      logout: () => logout(), call,
      async members() { return call('/rest/v1/memberships?select=user_id,role,display_name,email,created_at&org_id=eq.' + orgId + '&order=display_name'); },
      async invitations() { return call('/rest/v1/invitations?select=id,email,display_name,role,expires_at,accepted_at&org_id=eq.' + orgId + '&accepted_at=is.null&order=created_at.desc'); },
      async invite(email, name, role) { return call('/rest/v1/invitations', { method: 'POST', body: { org_id: orgId, email: String(email).trim().toLowerCase(), display_name: name, role } }); },
      async revoke(id) { return call('/rest/v1/invitations?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }); },
      async setRole(uid, role) { const r = await call('/rest/v1/memberships?org_id=eq.' + orgId + '&user_id=eq.' + encodeURIComponent(uid), { method: 'PATCH', body: { role }, headers: { Prefer: 'return=representation' } }); if (!r.length) throw new Error('No tiene permiso para cambiar ese rol.'); },
      async remove(uid) { const r = await call('/rest/v1/memberships?org_id=eq.' + orgId + '&user_id=eq.' + encodeURIComponent(uid), { method: 'DELETE', headers: { Prefer: 'return=representation' } }); if (!r.length) throw new Error('No tiene permiso para quitar a ese usuario.'); },
      switchOrg(id) { ls.set(ORGK, id); location.replace(SITE); }
    };
    resolveReady({ demo: false, db: makeDb(orgId, admin), me: { id: sess.user.id, name: m ? m.display_name : sess.user.email }, roleLabel: roleLabel(m && m.role), canWrite: rank(m && m.role) >= 2, mode: 'servidor' });
  }

  /* ---------------- Adaptador de datos (misma interfaz que usa la app) ---------------- */
  const APP_COLS = ['tanks', 'tabs', 'products', 'vehicles', 'ops', 'pl'];
  function makeDb(orgId, admin) {
    const q = encodeURIComponent;
    async function pageAll(path) {
      const out = []; const step = 1000;
      for (let from = 0; ; from += step) {
        const res = await call(path, { raw: true, headers: { Range: from + '-' + (from + step - 1), 'Range-Unit': 'items' } });
        if (!res.ok) { const t = await res.text(); let d = null; try { d = JSON.parse(t); } catch (e) {} throw new Error(friendly(d, res.status)); }
        const rows = await res.json(); out.push(...rows); if (rows.length < step) break;
      }
      return out;
    }
    const wrap = (rows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => r.data })) });
    async function getPlatform() {
      const orgs = await call('/rest/v1/organizations?select=id,name,nit,org_type&order=name');
      const lic = await call('/rest/v1/licenses?select=org_id,module,seats,valid_to');
      const mine = window.OSM_SESSION ? window.OSM_SESSION.memberOrgs : [orgId];
      return orgs.map((o) => { const L = lic.filter((l) => l.org_id === o.id);
        return { id: o.id, data: { id: o.id, name: o.name, nit: o.nit || '', type: o.org_type, modules: L.filter((l) => !l.valid_to || l.valid_to >= new Date().toISOString().slice(0, 10)).map((l) => l.module),
          seats: L.reduce((a, l) => Math.max(a, l.seats), 0), validTo: L.map((l) => l.valid_to).filter(Boolean).sort()[0] || '', member: mine.includes(o.id) } }; });
    }
    return {
      collection(c) {
        return { async get() {
          if (!orgId && c !== 'platform') return { docs: [] };
          if (APP_COLS.includes(c)) return wrap((await pageAll('/rest/v1/app_docs?select=doc_id,data&org_id=eq.' + orgId + '&collection=eq.' + q(c) + '&order=doc_id')).map((r) => ({ id: r.doc_id, data: r.data })));
          if (c === 'audit') return wrap((await pageAll('/rest/v1/audit_log?select=id,ts,user_id,user_name,action,entity,detail,prev_hash,hash&org_id=eq.' + orgId + '&order=id')).map((r) => ({ id: 'a' + String(r.id).padStart(12, '0'), data: { ts: r.ts, user: r.user_name, uid: r.user_id, action: r.action, entity: r.entity, detail: r.detail, prev: r.prev_hash, hash: r.hash } })));
          if (c === 'platform') return wrap(await getPlatform());
          return { docs: [] };
        } };
      },
      doc(path) {
        const i = path.indexOf('/'), c = path.slice(0, i), id = path.slice(i + 1);
        return {
          async set(data) {
            if (APP_COLS.includes(c)) return call('/rest/v1/app_docs?on_conflict=org_id,collection,doc_id', { method: 'POST', body: { org_id: orgId, collection: c, doc_id: id, data }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
            if (c === 'audit') {
              const r = await call('/rest/v1/audit_log?select=id,ts,user_id,user_name,prev_hash,hash', { method: 'POST', body: { org_id: orgId, action: data.action, entity: data.entity, detail: data.detail }, headers: { Prefer: 'return=representation' } });
              // El servidor fija usuario, fecha y huella: se reflejan en la copia local
              if (r && r[0]) Object.assign(data, { ts: r[0].ts, user: r[0].user_name, uid: r[0].user_id, prev: r[0].prev_hash, hash: r[0].hash });
              return;
            }
            if (c === 'platform') {
              if (!admin) throw new Error('Solo el administrador de la plataforma gestiona organizaciones y licencias.');
              let oid = data.id;
              const isNew = !/^[0-9a-f-]{36}$/.test(oid);
              const body = { name: data.name, nit: data.nit || null, org_type: data.type || 'Operadora' };
              if (isNew) { const r = await call('/rest/v1/organizations?select=id', { method: 'POST', body, headers: { Prefer: 'return=representation' } }); oid = r[0].id; data.id = oid; }
              else await call('/rest/v1/organizations?id=eq.' + oid, { method: 'PATCH', body });
              const have = await call('/rest/v1/licenses?select=module&org_id=eq.' + oid);
              for (const mod of ['static', 'pipeline']) {
                const on = (data.modules || []).includes(mod), exists = have.some((h) => h.module === mod);
                if (on) await call('/rest/v1/licenses?on_conflict=org_id,module', { method: 'POST', body: { org_id: oid, module: mod, seats: Math.max(1, Number(data.seats) || 1), valid_to: data.validTo || null }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
                else if (exists) await call('/rest/v1/licenses?org_id=eq.' + oid + '&module=eq.' + mod, { method: 'DELETE' });
              }
              return;
            }
            throw new Error('Colección no permitida: ' + c);
          },
          async delete() {
            if (APP_COLS.includes(c)) return call('/rest/v1/app_docs?org_id=eq.' + orgId + '&collection=eq.' + q(c) + '&doc_id=eq.' + q(id), { method: 'DELETE' });
            throw new Error('Este registro no se puede eliminar.');
          }
        };
      }
    };
  }

  /* ---------------- Eventos de la pantalla de acceso ---------------- */
  const strong = (p) => p.length >= 12 && /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(p) && /\d/.test(p);
  document.addEventListener('submit', async (e) => {
    const f = e.target; if (!gate || !gate.contains(f)) return; e.preventDefault();
    const b = f.querySelector('button[type=submit]'); busy(b, true);
    const v = (id) => (document.getElementById(id) || {}).value || '';
    try {
      if (f.id === 'agLogin') {
        setSession(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: v('agEmail').trim().toLowerCase(), password: v('agPass') }, auth: false }));
        await afterPassword();
      } else if (f.id === 'agSignup') {
        if (!strong(v('agPass'))) throw new Error('La contraseña debe tener al menos 12 caracteres, con letras y números.');
        if (v('agPass') !== v('agPass2')) throw new Error('Las contraseñas no coinciden.');
        await call('/auth/v1/signup?redirect_to=' + encodeURIComponent(SITE), { method: 'POST', body: { email: v('agEmail').trim().toLowerCase(), password: v('agPass') }, auth: false });
        vLogin(); msg('Si el correo tiene invitación, recibirá un enlace de confirmación. Ábralo y luego ingrese aquí.', 'ok');
      } else if (f.id === 'agForgot') {
        await call('/auth/v1/recover?redirect_to=' + encodeURIComponent(SITE), { method: 'POST', body: { email: v('agEmail').trim().toLowerCase() }, auth: false }).catch(() => {});
        vLogin(); msg('Si el correo está registrado, recibirá un enlace para restablecer la contraseña.', 'ok');
      } else if (f.id === 'agNewPass') {
        if (!strong(v('agPass'))) throw new Error('La contraseña debe tener al menos 12 caracteres, con letras y números.');
        if (v('agPass') !== v('agPass2')) throw new Error('Las contraseñas no coinciden.');
        await call('/auth/v1/user', { method: 'PUT', body: { password: v('agPass') } });
        recovering = false; msg('Contraseña actualizada.', 'ok'); await chooseOrg();
      } else if (f.id === 'agMfa') {
        const code = v('agCode').replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) throw new Error('Escriba los 6 dígitos del código.');
        const fid = f.dataset.f;
        const ch = await call('/auth/v1/factors/' + fid + '/challenge', { method: 'POST', body: {} });
        setSession(await call('/auth/v1/factors/' + fid + '/verify', { method: 'POST', body: { challenge_id: ch.id, code } }));
        if (recovering) return vNewPass();
        const t = pendingThen; pendingThen = null; await (t || chooseOrg)();
      }
    } catch (err) { msg(err.message || String(err)); }
    finally { busy(b, false); }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'osmLogout') return logout('Sesión cerrada.');
    if (!gate || !gate.contains(b)) return;
    const a = b.dataset.ag;
    if (a === 'signup') vSignup(); if (a === 'forgot') vForgot(); if (a === 'login') vLogin();
    if (a === 'logout') logout();
    if (a === 'demo') { hideGate(); window.OSM_SESSION = null; resolveReady({ demo: true }); }
    if (b.dataset.org && pendingOrgs) { const p = pendingOrgs; pendingOrgs = null; finish(p.rows.find((r) => r.org_id === b.dataset.org), p.admin, p.rows); }
  });

  /* ---------------- Arranque ---------------- */
  let recovering = false;
  async function boot() {
    // Retorno desde un enlace del correo (confirmación o recuperación)
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('error_description')) { history.replaceState(null, '', SITE); vLogin(); return msg(h.get('error_description').replace(/\+/g, ' ')); }
    if (h.get('access_token')) {
      const type = h.get('type');
      history.replaceState(null, '', SITE);   // quita los tokens de la barra de direcciones
      setSession({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: Number(h.get('expires_in')) || 3600 });
      try {
        if (type === 'recovery') {
          recovering = true;
          const u = await call('/auth/v1/user'); sess.user = u;
          const vf = (u.factors || []).find((f) => f.factor_type === 'totp' && f.status === 'verified');
          return vf ? vMfaVerify(vf, vNewPass) : vNewPass();
        }
        return await afterPassword();
      } catch (e) { clear(); vLogin(); return msg(e.message); }
    }
    if (ss.get(RK) && (await refresh())) {
      try { return await afterPassword(); } catch (e) { clear(); }
    }
    vLogin();
  }
  window.OSM_BACKEND = { ready };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
