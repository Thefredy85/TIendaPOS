#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const IVA_RATE: f64 = 0.16;

#[derive(Clone)]
struct Session {
    username: String,
    expires_at: i64,
}

struct DbConn(Mutex<Connection>);
struct SessionStore(Mutex<HashMap<String, Session>>);

// ---------- utilidades basicas ----------

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn random_text() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{:x}{:x}{:x}", nanos, c, std::process::id())
}

fn random_suffix() -> String {
    random_text().chars().rev().take(6).collect()
}

fn clean_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn num_of(v: Option<&Value>) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn not_false(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Bool(false)))
}

fn truthy_opt(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true)))
}

fn is_username(v: &str) -> bool {
    v.len() >= 4 && v.chars().all(|c| c.is_ascii_digit())
}

fn normalize_role(v: &str) -> String {
    let v = v.to_lowercase();
    if ["admin", "encargado", "cajero"].contains(&v.as_str()) {
        v
    } else {
        "cajero".to_string()
    }
}

fn display_or_username(u: &Value) -> String {
    let d = clean_text(u.get("displayName"));
    if !d.is_empty() {
        d
    } else {
        clean_text(u.get("username"))
    }
}

fn first_nonempty(payload: &Value, keys: &[&str]) -> String {
    for k in keys {
        let v = clean_text(payload.get(*k));
        if !v.is_empty() {
            return v;
        }
    }
    String::new()
}

fn slug(value: &str) -> String {
    let mut s = value.trim().to_lowercase();
    for (a, b) in [
        ("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"),
        ("ü", "u"), ("ñ", "n"),
    ] {
        s = s.replace(a, b);
    }
    let mut out = String::new();
    let mut last_us = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_us = false;
        } else if !last_us && !out.is_empty() {
            out.push('_');
            last_us = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        format!("item_{}", now_millis())
    } else {
        out
    }
}

fn hash_password(password: &str, salt: &str) -> String {
    let text = format!("{}|{}", salt, password);
    let mut a: u32 = 2166136261;
    let mut b: u32 = 16777619;
    let mut c: u32 = 3735928559;
    let mut d: u32 = 1103547991;
    for (i, ch) in text.encode_utf16().enumerate() {
        let ch = ch as u32;
        let i = i as u32;
        a ^= ch;
        a = a.wrapping_mul(16777619);
        b ^= ch.wrapping_add(i);
        b = b.wrapping_mul(2166136261);
        c = (c ^ ch).wrapping_mul(2654435761);
        d = (d.wrapping_add(ch).wrapping_add(a >> 7)).wrapping_mul(1597334677);
    }
    format!("{:08x}{:08x}{:08x}{:08x}", a, b, c, d)
}

fn iva_parts(gross: f64) -> (f64, f64) {
    let iva = (gross * IVA_RATE * 100.0).round() / 100.0;
    let without = ((gross - iva) * 100.0).round() / 100.0;
    (iva, without)
}

fn is_valid_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn color_or(v: Option<&Value>, fallback: &str) -> String {
    let s = clean_text(v);
    if is_valid_color(&s) {
        s
    } else {
        fallback.to_string()
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

// ---------- almacenamiento generico (SQLite) ----------

fn list_items(conn: &Connection, store: &str) -> Vec<Value> {
    let mut stmt = match conn.prepare("SELECT data FROM store_data WHERE store = ?1") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = match stmt.query_map(params![store], |row| row.get::<_, String>(0)) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    rows.filter_map(|r| r.ok())
        .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
        .collect()
}

fn get_item(conn: &Connection, store: &str, id: &str) -> Option<Value> {
    let raw: Result<String, _> = conn.query_row(
        "SELECT data FROM store_data WHERE store = ?1 AND id = ?2",
        params![store, id],
        |row| row.get(0),
    );
    raw.ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn create_item(conn: &Connection, store: &str, id: &str, record: &Value) -> Result<(), String> {
    conn.execute(
        "INSERT INTO store_data (store, id, data) VALUES (?1, ?2, ?3)
         ON CONFLICT(store, id) DO UPDATE SET data = excluded.data",
        params![store, id, record.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn patch_item(conn: &Connection, store: &str, id: &str, patch: &Value) -> Result<(), String> {
    let mut current = get_item(conn, store, id).unwrap_or_else(|| json!({}));
    if let (Value::Object(cur_map), Value::Object(patch_map)) = (&mut current, patch) {
        for (k, v) in patch_map {
            cur_map.insert(k.clone(), v.clone());
        }
    }
    create_item(conn, store, id, &current)
}

fn delete_item(conn: &Connection, store: &str, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM store_data WHERE store = ?1 AND id = ?2",
        params![store, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- configuracion (settings) ----------

fn normalize_settings(source: &Value) -> Value {
    let g = |k: &str| source.get(k);
    let text_or = |k: &str, fallback: &str| {
        let s = clean_text(g(k));
        if s.is_empty() { fallback.to_string() } else { s }
    };
    let font_or = |k: &str, fallback: &str| {
        let s = clean_text(g(k));
        let allowed = ["Arial", "Courier New", "Tahoma", "Verdana"];
        if allowed.contains(&s.as_str()) { s } else { fallback.to_string() }
    };
    json!({
        "storeTitle": text_or("storeTitle", "Tienda de Conveniencia"),
        "storeSubtitle": text_or("storeSubtitle", "Venta, entradas, salidas, mermas, conteos y reportes"),
        "authTitle": text_or("authTitle", "Acceso a tienda"),
        "authHelp": text_or("authHelp", "Ingresa con tu usuario de tienda."),
        "showAuthHelp": not_false(g("showAuthHelp")),
        "accessFontSize": clamp(if g("accessFontSize").is_some() { num_of(g("accessFontSize")) } else { 16.0 }, 14.0, 24.0),
        "accent": color_or(g("accent"), "#125f56"),
        "accent2": color_or(g("accent2"), "#cf7f2a"),
        "blue": color_or(g("blue"), "#276b9f"),
        "green": color_or(g("green"), "#317448"),
        "danger": color_or(g("danger"), "#bd4438"),
        "bg": color_or(g("bg"), "#f2f4f1"),
        "panel": color_or(g("panel"), "#fffefb"),
        "soft": color_or(g("soft"), "#f8f1e7"),
        "confirmPayLabel": text_or("confirmPayLabel", "Confirmar cobro y descontar inventario"),
        "ticketTitle": text_or("ticketTitle", "Ticket de venta"),
        "ticketFooter": text_or("ticketFooter", "Gracias por su compra"),
        "ticketTaxLabel": text_or("ticketTaxLabel", "IVA 16%"),
        "ticketShowStore": not_false(g("ticketShowStore")),
        "ticketShowDate": not_false(g("ticketShowDate")),
        "ticketShowCashier": not_false(g("ticketShowCashier")),
        "ticketShowPayment": not_false(g("ticketShowPayment")),
        "ticketShowSku": not_false(g("ticketShowSku")),
        "ticketShowIva": not_false(g("ticketShowIva")),
        "ticketShowLogo": truthy_opt(g("ticketShowLogo")),
        "ticketLogoData": ({ let s = clean_text(g("ticketLogoData")); if s.len() > 250000 { s[..250000].to_string() } else { s } }),
        "ticketFontFamily": font_or("ticketFontFamily", "Arial"),
        "ticketFontSize": clamp(if g("ticketFontSize").is_some() { num_of(g("ticketFontSize")) } else { 11.0 }, 9.0, 18.0),
        "ticketBold": truthy_opt(g("ticketBold")),
        "ticketAutoPrint": truthy_opt(g("ticketAutoPrint")),
        "ticketPreviewBeforePrint": not_false(g("ticketPreviewBeforePrint")),
        "ticketShowReceiptDialog": not_false(g("ticketShowReceiptDialog")),
        "cashCutTitle": text_or("cashCutTitle", "Corte de caja"),
        "cashCutFooter": text_or("cashCutFooter", "Corte generado por el sistema"),
        "cashCutFontFamily": font_or("cashCutFontFamily", "Arial"),
        "cashCutFontSize": clamp(if g("cashCutFontSize").is_some() { num_of(g("cashCutFontSize")) } else { 11.0 }, 9.0, 18.0),
        "cashCutBold": not_false(g("cashCutBold")),
        "cashCutShowLogo": truthy_opt(g("cashCutShowLogo")),
        "cashCutShowProducts": not_false(g("cashCutShowProducts")),
        "cashCutShowPayments": not_false(g("cashCutShowPayments"))
    })
}

fn default_settings() -> Value {
    normalize_settings(&json!({}))
}

fn read_settings(conn: &Connection) -> Value {
    let rows = list_items(conn, "settings");
    if let Some(row) = rows.iter().find(|r| clean_text(r.get("key")) == "app") {
        if let Some(val_str) = row.get("value").and_then(|v| v.as_str()) {
            if let Ok(parsed) = serde_json::from_str::<Value>(val_str) {
                return normalize_settings(&parsed);
            }
        }
    }
    default_settings()
}

// ---------- usuarios y sesiones ----------

fn public_user(u: &Value) -> Value {
    json!({
        "username": clean_text(u.get("username")),
        "displayName": clean_text(u.get("displayName")),
        "role": clean_text(u.get("role")),
        "active": not_false(u.get("active")),
        "createdAt": clean_text(u.get("createdAt")),
        "lastLogin": clean_text(u.get("lastLogin")),
    })
}

fn create_user_record(conn: &Connection, input: &Value, role_fallback: &str) -> Result<Value, String> {
    let username = {
        let a = clean_text(input.get("loginCode"));
        if !a.is_empty() { a } else { clean_text(input.get("username")) }
    };
    let password = clean_text(input.get("password"));
    if !is_username(&username) {
        return Err("El usuario debe tener al menos 4 digitos numericos".into());
    }
    if password.len() < 4 {
        return Err("La contrasena debe tener al menos 4 caracteres".into());
    }
    let users = list_items(conn, "users");
    if users.iter().any(|u| clean_text(u.get("username")) == username) {
        return Err("Ese usuario ya existe".into());
    }
    let salt = random_text();
    let display_name = { let d = clean_text(input.get("displayName")); if d.is_empty() { username.clone() } else { d } };
    let role = { let r = clean_text(input.get("role")); if r.is_empty() { role_fallback.to_string() } else { r } };
    let active = input.get("active").map(truthy).unwrap_or(true);
    let record = json!({
        "username": username,
        "displayName": display_name,
        "passwordHash": hash_password(&password, &salt),
        "salt": salt,
        "role": normalize_role(&role),
        "pin": "",
        "active": active,
        "createdAt": now_iso(),
        "lastLogin": ""
    });
    create_item(conn, "users", &username, &record)?;
    Ok(public_user(&record))
}

fn current_user(
    required: bool,
    conn: &Connection,
    sessions: &mut HashMap<String, Session>,
    token: &str,
) -> Result<Option<Value>, String> {
    let now = now_millis();
    let sess = sessions.get(token).cloned();
    let sess = match sess {
        Some(s) if s.expires_at >= now => s,
        _ => {
            if required { return Err("Sesion expirada".into()); }
            return Ok(None);
        }
    };
    let users = list_items(conn, "users");
    let user = users.into_iter().find(|u| {
        clean_text(u.get("username")) == sess.username && not_false(u.get("active"))
    });
    let user = match user {
        Some(u) => u,
        None => {
            if required { return Err("Usuario inactivo".into()); }
            return Ok(None);
        }
    };
    sessions.insert(
        token.to_string(),
        Session { username: sess.username, expires_at: now + 1000 * 60 * 60 * 14 },
    );
    Ok(Some(user))
}

fn assert_role(user: &Value, roles: &[&str]) -> Result<(), String> {
    let role = clean_text(user.get("role"));
    if roles.contains(&role.as_str()) { Ok(()) } else { Err("No autorizado".into()) }
}

fn verify_supervisor(conn: &Connection, input: &Value) -> Result<Value, String> {
    let code = first_nonempty(input, &["code", "loginCode", "pin"]);
    let username = { let u = clean_text(input.get("username")); if !u.is_empty() { u } else { code.clone() } };
    let password = { let p = clean_text(input.get("password")); if !p.is_empty() { p } else { code.clone() } };
    let users = list_items(conn, "users");
    let mut user = users.iter().find(|u| clean_text(u.get("username")) == username && not_false(u.get("active"))).cloned();
    let ok = user.as_ref().map(|u| {
        hash_password(&password, &clean_text(u.get("salt"))) == clean_text(u.get("passwordHash"))
    }).unwrap_or(false);
    if !ok {
        let single_key = if !code.is_empty() { code.clone() }
            else if !username.is_empty() && username == password { username.clone() }
            else { String::new() };
        let matches: Vec<Value> = if !single_key.is_empty() {
            users.iter().filter(|u| {
                not_false(u.get("active")) && hash_password(&single_key, &clean_text(u.get("salt"))) == clean_text(u.get("passwordHash"))
            }).cloned().collect()
        } else { vec![] };
        user = if matches.len() == 1 { Some(matches[0].clone()) } else { None };
    }
    let user = user.ok_or_else(|| "Permiso superior incorrecto".to_string())?;
    let role = clean_text(user.get("role"));
    if !["admin", "encargado"].contains(&role.as_str()) {
        return Err("Ese usuario no tiene permiso superior".into());
    }
    Ok(user)
}

// ---------- operaciones ----------

fn op_bootstrap(conn: &Connection) -> Result<Value, String> {
    let users = list_items(conn, "users");
    let settings = read_settings(conn);
    Ok(json!({"ok": true, "needsSetup": users.is_empty(), "userCount": users.len(), "settings": settings}))
}

fn op_setup_admin(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let users = list_items(conn, "users");
    if !users.is_empty() {
        return Ok(json!({"ok": false, "error": "La tienda ya tiene usuarios configurados"}));
    }
    let mut input = payload.clone();
    if let Value::Object(m) = &mut input {
        m.insert("role".into(), json!("admin"));
        m.insert("active".into(), json!(true));
    }
    let user = create_user_record(conn, &input, "admin")?;
    Ok(json!({"ok": true, "user": user}))
}

fn op_login(conn: &Connection, sessions: &mut HashMap<String, Session>, payload: &Value) -> Result<Value, String> {
    let code = first_nonempty(payload, &["code", "loginCode", "pin"]);
    let username = { let u = clean_text(payload.get("username")); if !u.is_empty() { u } else { code.clone() } };
    let password = { let p = clean_text(payload.get("password")); if !p.is_empty() { p } else { code.clone() } };
    let users = list_items(conn, "users");

    let mut candidates: Vec<(String, String)> = vec![(username.clone(), password.clone()), (password.clone(), username.clone())];
    if !code.is_empty() { candidates.push((code.clone(), code.clone())); }

    let mut user: Option<Value> = None;
    let mut matched_username = String::new();
    for (cu, cp) in &candidates {
        if let Some(found) = users.iter().find(|u| clean_text(u.get("username")) == *cu && not_false(u.get("active"))) {
            if hash_password(cp, &clean_text(found.get("salt"))) == clean_text(found.get("passwordHash")) {
                user = Some(found.clone());
                matched_username = cu.clone();
                break;
            }
        }
    }
    if user.is_none() {
        let single_key = if !code.is_empty() { code.clone() }
            else if !username.is_empty() && username == password { username.clone() }
            else { String::new() };
        if !single_key.is_empty() {
            let matches: Vec<&Value> = users.iter().filter(|u| {
                not_false(u.get("active")) && hash_password(&single_key, &clean_text(u.get("salt"))) == clean_text(u.get("passwordHash"))
            }).collect();
            if matches.len() == 1 {
                user = Some(matches[0].clone());
                matched_username = clean_text(matches[0].get("username"));
            } else if matches.len() > 1 {
                return Ok(json!({"ok": false, "error": "Clave duplicada. Cambia una de las claves desde Usuarios."}));
            }
        }
    }
    let mut user = match user {
        Some(u) => u,
        None => return Ok(json!({"ok": false, "error": "Usuario o contrasena incorrectos"})),
    };
    let token = random_text();
    sessions.insert(token.clone(), Session { username: matched_username.clone(), expires_at: now_millis() + 1000 * 60 * 60 * 14 });
    patch_item(conn, "users", &matched_username, &json!({"lastLogin": now_iso()}))?;
    user["lastLogin"] = json!(now_iso());
    Ok(json!({"ok": true, "sessionToken": token, "user": public_user(&user)}))
}

fn op_logout(sessions: &mut HashMap<String, Session>, token: &str) -> Value {
    sessions.remove(token);
    json!({"ok": true})
}

fn op_data(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    let role = clean_text(user.get("role"));
    let admin = role == "admin";
    let manager = admin || role == "encargado";
    let products = list_items(conn, "products");
    let moves = if manager { list_items(conn, "moves") } else { vec![] };
    let counts = if manager { list_items(conn, "counts") } else { vec![] };
    let sales = if manager { list_items(conn, "sales") } else { vec![] };
    let settings = read_settings(conn);
    let categories = list_items(conn, "categories");
    let units = list_items(conn, "units");
    let suppliers = list_items(conn, "suppliers");
    let presentations = list_items(conn, "presentations");
    let users: Vec<Value> = if admin { list_items(conn, "users").iter().map(public_user).collect() } else { vec![] };
    Ok(json!({
        "ok": true, "user": public_user(&user), "products": products, "moves": moves,
        "counts": counts, "sales": sales, "users": users, "settings": settings,
        "categories": categories, "units": units, "suppliers": suppliers, "presentations": presentations
    }))
}

fn op_save_user(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin"])?;
    let editing_username = clean_text(payload.get("editingUsername"));
    let username = clean_text(payload.get("username"));
    if !is_username(&username) {
        return Err("El usuario debe tener al menos 4 digitos numericos".into());
    }
    let users = list_items(conn, "users");
    let existing = if !editing_username.is_empty() {
        users.iter().find(|u| clean_text(u.get("username")) == editing_username).cloned()
    } else { None };
    if existing.is_none() {
        if !clean_text(payload.get("password")).is_empty() {
            let new_user = create_user_record(conn, payload, "cajero")?;
            return Ok(json!({"ok": true, "user": new_user}));
        }
        return Err("Usuario no encontrado".into());
    }
    let existing = existing.unwrap();
    if editing_username != username && users.iter().any(|u| clean_text(u.get("username")) == username) {
        return Err("Ese usuario ya existe".into());
    }
    let mut record = existing.clone();
    record["username"] = json!(username);
    let display_name_value = { let d = clean_text(payload.get("displayName")); if d.is_empty() { username.clone() } else { d } };
    record["displayName"] = json!(display_name_value);
    record["role"] = json!(normalize_role(&clean_text(payload.get("role"))));
    record["active"] = json!(payload.get("active").map(truthy).unwrap_or(true));
    let new_password = { let a = clean_text(payload.get("newPassword")); if !a.is_empty() { a } else { clean_text(payload.get("password")) } };
    if !new_password.is_empty() {
        if new_password.len() < 4 {
            return Err("La contrasena debe tener al menos 4 caracteres".into());
        }
        let salt = random_text();
        record["salt"] = json!(salt.clone());
        record["passwordHash"] = json!(hash_password(&new_password, &salt));
    }
    if editing_username != username {
        create_item(conn, "users", &username, &record)?;
        delete_item(conn, "users", &editing_username)?;
    } else {
        create_item(conn, "users", &username, &record)?;
    }
    sessions.retain(|_, s| s.username != editing_username);
    Ok(json!({"ok": true, "user": public_user(&record)}))
}

fn op_delete_user(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin"])?;
    let username = clean_text(payload.get("username"));
    if username.is_empty() { return Err("Falta usuario".into()); }
    if username == clean_text(user.get("username")) {
        return Err("No puedes eliminar el usuario activo".into());
    }
    delete_item(conn, "users", &username)?;
    sessions.retain(|_, s| s.username != username);
    Ok(json!({"ok": true}))
}

fn op_save_settings(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let settings = normalize_settings(payload);
    let record = json!({"key": "app", "value": settings.to_string()});
    create_item(conn, "settings", "app", &record)?;
    Ok(json!({"ok": true, "settings": settings}))
}

fn catalog_store(kind: &str) -> Option<&'static str> {
    match kind {
        "category" => Some("categories"),
        "unit" => Some("units"),
        "supplier" => Some("suppliers"),
        "presentation" => Some("presentations"),
        _ => None,
    }
}

fn op_save_catalog(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let kind = clean_text(payload.get("kind"));
    let store = catalog_store(&kind).ok_or_else(|| "Catalogo no reconocido".to_string())?;
    let name = clean_text(payload.get("name"));
    if name.is_empty() { return Err("Falta nombre".into()); }
    let id = { let i = clean_text(payload.get("id")); if !i.is_empty() { i } else { slug(&name) } };
    let rows = list_items(conn, store);
    let mut record = json!({
        "id": id,
        "name": name,
        "active": payload.get("active").map(truthy).unwrap_or(true),
        "sortOrder": payload.get("sortOrder").and_then(|v| v.as_f64()).unwrap_or((rows.len() + 1) as f64)
    });
    match kind.as_str() {
        "category" => record["description"] = json!(clean_text(payload.get("description"))),
        "unit" => {
            let abbreviation_value = { let a = clean_text(payload.get("abbreviation")); if a.is_empty() { name.clone() } else { a } };
            record["abbreviation"] = json!(abbreviation_value);
        }
        "supplier" => {
            record["phone"] = json!(clean_text(payload.get("phone")));
            record["notes"] = json!(clean_text(payload.get("notes")));
        }
        "presentation" => record["description"] = json!(clean_text(payload.get("description"))),
        _ => {}
    }
    create_item(conn, store, &id, &record)?;
    Ok(json!({"ok": true, "item": record}))
}

fn op_delete_catalog(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let kind = clean_text(payload.get("kind"));
    let id = clean_text(payload.get("id"));
    let store = catalog_store(&kind);
    let store = match store {
        Some(s) if !id.is_empty() => s,
        _ => return Err("Catalogo no reconocido".into()),
    };
    delete_item(conn, store, &id)?;
    Ok(json!({"ok": true}))
}

fn op_save_product(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let rec = payload.get("record").cloned().unwrap_or_else(|| payload.clone());
    let products = list_items(conn, "products");
    let editing_sku = { let a = clean_text(payload.get("editingSku")); if !a.is_empty() { a } else { clean_text(rec.get("editingSku")) } };
    let existing = if !editing_sku.is_empty() {
        products.iter().find(|p| clean_text(p.get("sku")) == editing_sku).cloned()
    } else { None };
    let mut sku = clean_text(rec.get("sku"));
    if sku.is_empty() {
        if let Some(e) = &existing { sku = clean_text(e.get("sku")); }
    }
    if sku.is_empty() {
        let cat_source = { let c = clean_text(rec.get("category")); if c.is_empty() { "producto".to_string() } else { c } };
        let mut cat_slug = slug(&cat_source).replace('_', "").to_uppercase();
        if cat_slug.len() > 4 { cat_slug.truncate(4); }
        if cat_slug.is_empty() { cat_slug = "PROD".to_string(); }
        let count = products.iter().filter(|p| clean_text(p.get("category")) == clean_text(rec.get("category"))).count() + 1;
        let mut candidate = format!("{}-{:04}", cat_slug, count);
        let mut next = count;
        while products.iter().any(|p| clean_text(p.get("sku")) == candidate) {
            next += 1;
            candidate = format!("{}-{:04}", cat_slug, next);
        }
        sku = candidate;
    }
    let exists = products.iter().any(|p| clean_text(p.get("sku")) == sku);
    let cost = num_of(rec.get("cost"));
    let price = num_of(rec.get("price"));
    let (cost_iva, cost_wo) = iva_parts(cost);
    let (price_iva, price_wo) = iva_parts(price);
    let stock = if let Some(e) = &existing { num_of(e.get("stock")) } else { num_of(rec.get("stock")) };
    let record = json!({
        "sku": sku,
        "barcode": clean_text(rec.get("barcode")),
        "name": clean_text(rec.get("name")),
        "category": clean_text(rec.get("category")),
        "presentation": clean_text(rec.get("presentation")),
        "supplier": clean_text(rec.get("supplier")),
        "unit": ({ let u = clean_text(rec.get("unit")); if u.is_empty() { "pieza".to_string() } else { u } }),
        "cost": cost, "price": price,
        "costIva": cost_iva, "priceIva": price_iva,
        "costWithoutIva": cost_wo, "priceWithoutIva": price_wo,
        "stock": stock, "minStock": num_of(rec.get("minStock")),
        "description": clean_text(rec.get("description")),
        "active": not_false(rec.get("active"))
    });
    if let Some(e) = &existing {
        let existing_sku = clean_text(e.get("sku"));
        if existing_sku != sku {
            if exists { return Err("Ese SKU ya existe".into()); }
            create_item(conn, "products", &sku, &record)?;
            delete_item(conn, "products", &existing_sku)?;
        } else {
            create_item(conn, "products", &sku, &record)?;
        }
    } else {
        create_item(conn, "products", &sku, &record)?;
    }
    Ok(json!({"ok": true, "product": record}))
}

fn op_delete_product(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let sku = clean_text(payload.get("sku"));
    if sku.is_empty() { return Err("Falta SKU".into()); }
    let products = list_items(conn, "products");
    if !products.iter().any(|p| clean_text(p.get("sku")) == sku) {
        return Err("Producto no encontrado".into());
    }
    delete_item(conn, "products", &sku)?;
    Ok(json!({"ok": true}))
}

fn op_movement(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let products = list_items(conn, "products");
    let sku = clean_text(payload.get("sku"));
    let product = products.iter().find(|p| clean_text(p.get("sku")) == sku).cloned()
        .ok_or_else(|| "Producto no encontrado".to_string())?;
    let mtype = { let t = clean_text(payload.get("type")); if t.is_empty() { "entrada_compra".to_string() } else { t } };
    let mut qty = num_of(payload.get("quantity")).abs();
    if ["salida_manual", "merma"].contains(&mtype.as_str()) { qty = -qty; }
    let before = num_of(product.get("stock"));
    let after = before + qty;
    let cost = num_of(product.get("cost"));
    patch_item(conn, "products", &sku, &json!({"stock": after}))?;
    let id = format!("MOV-{}-{}", now_millis(), random_suffix());
    let rec = json!({
        "id": id, "timestamp": now_iso(), "type": mtype, "sku": sku,
        "productName": clean_text(product.get("name")),
        "quantity": qty, "stockBefore": before, "stockAfter": after,
        "unitCost": cost, "totalCost": qty * cost,
        "reason": clean_text(payload.get("reason")), "reference": clean_text(payload.get("reference")),
        "user": display_or_username(&user), "authorizedBy": "", "notes": ""
    });
    create_item(conn, "moves", &id, &rec)?;
    Ok(json!({"ok": true, "movement": rec}))
}

fn op_delete_movement(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let mut admin_user = user.clone();
    if let Some(admin_input) = payload.get("admin") {
        if !clean_text(admin_input.get("username")).is_empty() {
            admin_user = verify_supervisor(conn, admin_input)?;
        }
    }
    let id = clean_text(payload.get("id"));
    if id.is_empty() { return Err("Falta movimiento".into()); }
    let moves = list_items(conn, "moves");
    let mv = moves.iter().find(|m| clean_text(m.get("id")) == id).cloned()
        .ok_or_else(|| "Movimiento no encontrado".to_string())?;
    let products = list_items(conn, "products");
    let mv_sku = clean_text(mv.get("sku"));
    let product = products.iter().find(|p| clean_text(p.get("sku")) == mv_sku).cloned();
    let mv_qty = num_of(mv.get("quantity"));
    let (stock_before, stock_after) = if let Some(p) = &product {
        let current = num_of(p.get("stock"));
        let corrected = current - mv_qty;
        patch_item(conn, "products", &mv_sku, &json!({"stock": corrected}))?;
        (json!(current), json!(corrected))
    } else { (json!(""), json!("")) };
    delete_item(conn, "moves", &id)?;
    let del_id = format!("MOV-DEL-{}-{}", now_millis(), random_suffix());
    let rec = json!({
        "id": del_id, "timestamp": now_iso(), "type": "eliminacion_movimiento", "sku": mv_sku,
        "productName": clean_text(mv.get("productName")),
        "quantity": -mv_qty, "stockBefore": stock_before, "stockAfter": stock_after,
        "unitCost": num_of(mv.get("unitCost")), "totalCost": -num_of(mv.get("totalCost")),
        "reason": format!("Eliminacion de {}", id), "reference": id,
        "user": display_or_username(&user), "authorizedBy": display_or_username(&admin_user), "notes": ""
    });
    create_item(conn, "moves", &del_id, &rec)?;
    Ok(json!({"ok": true}))
}

fn op_count(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let products = list_items(conn, "products");
    let sku = clean_text(payload.get("sku"));
    let product = products.iter().find(|p| clean_text(p.get("sku")) == sku).cloned()
        .ok_or_else(|| "Producto no encontrado".to_string())?;
    let counted = num_of(payload.get("countedStock"));
    let before = num_of(product.get("stock"));
    let diff = counted - before;
    let id = format!("CNT-{}-{}", now_millis(), random_suffix());
    let inventory_id = { let i = clean_text(payload.get("inventoryId")); if !i.is_empty() { i } else { format!("INV-{}", now_millis()) } };
    let auth_or_user = { let a = clean_text(payload.get("authorizedBy")); if !a.is_empty() { a } else { display_or_username(&user) } };
    let rec = json!({
        "id": id, "inventoryId": inventory_id, "timestamp": now_iso(), "sku": sku,
        "productName": clean_text(product.get("name")),
        "barcode": clean_text(product.get("barcode")), "category": clean_text(product.get("category")),
        "presentation": clean_text(product.get("presentation")), "unit": clean_text(product.get("unit")),
        "supplier": clean_text(product.get("supplier")),
        "systemStock": before, "countedStock": counted, "difference": diff,
        "user": auth_or_user, "authorizedBy": clean_text(payload.get("authorizedBy")), "notes": clean_text(payload.get("notes"))
    });
    create_item(conn, "counts", &id, &rec)?;
    patch_item(conn, "products", &sku, &json!({"stock": counted}))?;
    if diff != 0.0 {
        let mov_id = format!("MOV-{}-{}", now_millis(), sku);
        let mov = json!({
            "id": mov_id, "timestamp": now_iso(), "type": "ajuste_conteo", "sku": sku,
            "productName": clean_text(product.get("name")),
            "quantity": diff, "stockBefore": before, "stockAfter": counted,
            "unitCost": num_of(product.get("cost")), "totalCost": diff * num_of(product.get("cost")),
            "reason": "Conteo fisico", "reference": id,
            "user": auth_or_user, "authorizedBy": clean_text(payload.get("authorizedBy")), "notes": clean_text(payload.get("notes"))
        });
        create_item(conn, "moves", &mov_id, &mov)?;
    }
    Ok(json!({"ok": true, "count": rec}))
}

fn op_checkout(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado", "cajero"])?;
    let items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if items.is_empty() { return Err("Ticket vacio".into()); }
    let products = list_items(conn, "products");
    let requested_id = { let a = clean_text(payload.get("clientId")); if !a.is_empty() { a } else { clean_text(payload.get("id")) } };
    let id = if !requested_id.is_empty() { requested_id } else { format!("SALE-{}", now_millis()) };
    let existing_sales = list_items(conn, "sales");
    if let Some(existing) = existing_sales.iter().find(|s| clean_text(s.get("id")) == id) {
        return Ok(json!({"ok": true, "sale": existing, "duplicate": true}));
    }
    let timestamp = now_iso();
    let mut subtotal = 0.0;
    let mut profit = 0.0;
    for line in &items {
        let sku = clean_text(line.get("sku"));
        let product = products.iter().find(|p| clean_text(p.get("sku")) == sku)
            .ok_or_else(|| format!("Producto no encontrado: {}", sku))?;
        let qty = num_of(line.get("qty"));
        if qty <= 0.0 { return Err("Cantidad invalida".into()); }
        let stock = num_of(product.get("stock"));
        if stock < qty { return Err(format!("Stock insuficiente: {}", clean_text(product.get("name")))); }
        let price = num_of(product.get("price"));
        let cost = num_of(product.get("cost"));
        subtotal += price * qty;
        profit += (price - cost) * qty;
    }
    let discount = 0.0;
    let total = subtotal;
    for line in &items {
        let sku = clean_text(line.get("sku"));
        let product = products.iter().find(|p| clean_text(p.get("sku")) == sku).unwrap();
        let qty = num_of(line.get("qty"));
        let before = num_of(product.get("stock"));
        let after = before - qty;
        patch_item(conn, "products", &sku, &json!({"stock": after}))?;
        let mov_id = format!("MOV-{}-{}", now_millis(), sku);
        let cost = num_of(product.get("cost"));
        let mov = json!({
            "id": mov_id, "timestamp": timestamp, "type": "venta", "sku": sku,
            "productName": clean_text(product.get("name")),
            "quantity": -qty, "stockBefore": before, "stockAfter": after,
            "unitCost": cost, "totalCost": -cost * qty,
            "reason": "Venta POS", "reference": id, "user": display_or_username(&user), "notes": ""
        });
        create_item(conn, "moves", &mov_id, &mov)?;
    }
    let items_json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
    let payment_method = { let p = clean_text(payload.get("paymentMethod")); if p.is_empty() { "Efectivo".to_string() } else { p } };
    let sale = json!({
        "id": id, "timestamp": timestamp, "itemsJson": items_json, "subtotal": subtotal,
        "discount": discount, "total": total, "paymentMethod": payment_method,
        "user": display_or_username(&user), "notes": "", "profit": profit
    });
    create_item(conn, "sales", &id, &sale)?;
    Ok(json!({"ok": true, "sale": sale}))
}

fn op_sync_batch(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado", "cajero"])?;
    let items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut results = vec![];
    for item in items {
        let op = clean_text(item.get("op"));
        if op == "checkout" {
            let sub_payload = item.get("payload").cloned().unwrap_or_else(|| json!({}));
            match op_checkout(conn, sessions, token, &sub_payload) {
                Ok(v) => results.push(v),
                Err(e) => results.push(json!({"ok": false, "error": e})),
            }
        } else {
            results.push(json!({"ok": false, "error": "Operacion de cola no soportada"}));
        }
    }
    Ok(json!({"ok": true, "results": results}))
}

fn dispatch(op: &str, payload: &Value, token: &str, conn: &Connection, sessions: &mut HashMap<String, Session>) -> Result<Value, String> {
    match op {
        "bootstrap" => op_bootstrap(conn),
        "setup_admin" => op_setup_admin(conn, payload),
        "login" => op_login(conn, sessions, payload),
        "logout" => Ok(op_logout(sessions, token)),
        "data" => op_data(conn, sessions, token),
        "save_user" => op_save_user(conn, sessions, token, payload),
        "delete_user" => op_delete_user(conn, sessions, token, payload),
        "save_settings" => op_save_settings(conn, sessions, token, payload),
        "save_catalog" => op_save_catalog(conn, sessions, token, payload),
        "delete_catalog" => op_delete_catalog(conn, sessions, token, payload),
        "save_product" => op_save_product(conn, sessions, token, payload),
        "delete_product" => op_delete_product(conn, sessions, token, payload),
        "movement" => op_movement(conn, sessions, token, payload),
        "delete_movement" => op_delete_movement(conn, sessions, token, payload),
        "count" => op_count(conn, sessions, token, payload),
        "checkout" => op_checkout(conn, sessions, token, payload),
        "sync_batch" => op_sync_batch(conn, sessions, token, payload),
        _ => Ok(json!({"ok": false, "error": "Operacion no reconocida"})),
    }
}

#[tauri::command]
fn backend_call(
    op: String,
    payload: Value,
    session_token: String,
    db: tauri::State<DbConn>,
    sessions: tauri::State<SessionStore>,
) -> Value {
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return json!({"ok": false, "error": "Error de base de datos local"}),
    };
    let mut sess = match sessions.0.lock() {
        Ok(s) => s,
        Err(_) => return json!({"ok": false, "error": "Error de sesion"}),
    };
    match dispatch(&op, &payload, &session_token, &conn, &mut sess) {
        Ok(v) => v,
        Err(msg) => json!({"ok": false, "error": msg}),
    }
}

fn init_db(conn: &Connection) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS store_data (
            store TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (store, id)
        )",
        [],
    )
    .expect("no se pudo crear la tabla store_data");
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();
            let data_dir = handle
                .path_resolver()
                .app_data_dir()
                .expect("no se pudo resolver el directorio de datos de la app");
            fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("tienda_pos.sqlite");
            let conn = Connection::open(db_path).expect("no se pudo abrir la base de datos");
            init_db(&conn);
            app.manage(DbConn(Mutex::new(conn)));
            app.manage(SessionStore(Mutex::new(HashMap::new())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_call])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicacion Tauri");
}
