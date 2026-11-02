/* ============ EEBerater-Konto: eigener Server (Supabase, EU) ============
   Nur außerhalb von claude.ai aktiv (App aus dem Store, eigenständige Version).
   Stellt dieselbe Schnittstelle bereit wie der eingebaute Speicher (db.doc/collection, get/set/delete/onSnapshot),
   damit Kunden, Team und Rechte unverändert funktionieren. Offline-fähig: alles liegt zusätzlich im Gerätespeicher,
   Änderungen ohne Netz werden gesammelt und beim nächsten Kontakt übertragen. */
window.EEB_CLOUD = (function () {
  if (window.claude && window.claude.use) return null;
  const URL_ = "https://gxsugyrsvrnwzhujthbe.supabase.co", KEY = "sb_publishable_zcQ3hI_DgrvjbrTb8zPunA_tgGjf1qP";
  const LS = "eeb-konto-v1", LSB = "eeb-bereich-v1", LSZ = "eeb-sync-v1";
  const lies = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const schreib = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
  const kopie = o => o == null ? o : JSON.parse(JSON.stringify(o));
  let sess = lies(LS), bereich = null, letzterSync = null, status = { offen: 0, zuletzt: null, fehler: "" };

  /* ---------- Anmeldung ---------- */
  function fehlerText(j, st) {
    const m = String((j && (j.error_description || j.msg || j.message || j.error)) || ("Fehler " + st));
    if (/invalid login|invalid_credentials/i.test(m)) return "E-Mail oder Passwort ist falsch.";
    if (/not confirmed/i.test(m)) return "Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse – der Link steht in der Bestätigungs-Mail.";
    if (/already registered|already been registered|user_already_exists/i.test(m)) return "Für diese E-Mail gibt es schon ein Konto. Bitte melden Sie sich an.";
    if (/password should|weak_password|at least/i.test(m)) return "Das Passwort ist zu kurz oder zu einfach (mindestens 8 Zeichen).";
    if (/token.*(expired|invalid)|otp_expired/i.test(m)) return "Der Code ist falsch oder abgelaufen. Bitte prüfen oder neu anfordern.";
    if (/rate limit|too many/i.test(m)) return "Zu viele Versuche. Bitte warten Sie einige Minuten.";
    if (/invalid.*email|email_address_invalid/i.test(m)) return "Bitte eine gültige E-Mail-Adresse eingeben.";
    return m;
  }
  async function auth(pfad, body, mitToken) {
    const hd = { apikey: KEY, "Content-Type": "application/json" };
    if (mitToken && sess) hd.Authorization = "Bearer " + sess.at;
    const r = await fetch(URL_ + "/auth/v1/" + pfad, { method: "POST", headers: hd, body: JSON.stringify(body || {}) });
    const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { }
    if (!r.ok) { const e = new Error(fehlerText(j, r.status)); e.status = r.status; throw e; }
    return j;
  }
  function setz(j) {
    const u = j.user || {}, md = u.user_metadata || {};
    sess = { at: j.access_token, rt: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, uid: u.id || (sess && sess.uid), email: u.email || (sess && sess.email), name: md.name || (sess && sess.name) || "" };
    schreib(LS, sess);
  }
  let erneuern = null, abgelaufenGemeldet = false;
  // Anmeldung abgelaufen: deutlich melden – Änderungen bleiben im Gerätespeicher und werden nach der Anmeldung übertragen
  function abgelaufen() {
    if (abgelaufenGemeldet) return; abgelaufenGemeldet = true;
    try {
      const el = h("div", { role: "alert", style: "position:fixed;left:12px;right:12px;top:max(10px,env(safe-area-inset-top));z-index:400;max-width:560px;margin:0 auto;background:#FFF3CC;color:#5A4300;border:1px solid #F0D27A;border-radius:14px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
        h("span", { style: "flex:1 1 220px;font-size:14px" }, "Ihre Anmeldung ist abgelaufen. Änderungen bleiben auf diesem Gerät und werden nach der Anmeldung übertragen."),
        h("button", { class: "btn", style: "min-height:38px;padding:8px 14px", onclick: () => { el.remove(); anmeldeSheet(false); } }, "Anmelden"));
      document.body.append(el);
    } catch (e) { console.warn(e); }
  }
  async function token(zwingen) {
    if (!sess) throw Object.assign(new Error("Nicht angemeldet"), { status: 401 });
    if (zwingen || Date.now() > sess.exp - 60000) {
      if (!erneuern) erneuern = auth("token?grant_type=refresh_token", { refresh_token: sess.rt }).then(setz).finally(() => { erneuern = null; });
      try { await erneuern; } catch (e) { if (e.status === 400 || e.status === 401) { sess = null; schreib(LS, null); abgelaufen(); } throw e; }
    }
    return sess.at;
  }
  async function rest(method, pfad, body, prefer, nochmal) {
    const hd = { apikey: KEY, Authorization: "Bearer " + await token(), "Content-Type": "application/json" };
    if (prefer) hd.Prefer = prefer;
    const r = await fetch(URL_ + "/rest/v1/" + pfad, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401 && !nochmal) { await token(true); return rest(method, pfad, body, prefer, true); }
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
    if (!r.ok) { const e = new Error((j && (j.message || j.hint)) || ("Serverfehler " + r.status)); e.status = r.status; e.code = j && j.code; throw e; }
    return j;
  }
  const rpc = (name, args) => rest("POST", "rpc/" + name, args || {});

  /* ---------- Gerätespeicher (IndexedDB) ---------- */
  let idb = null;
  function idbAuf() {
    return new Promise((res) => {
      if (!window.indexedDB) return res(null);
      const r = indexedDB.open("eeb-cloud", 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("docs"); d.createObjectStore("queue", { autoIncrement: true }); d.createObjectStore("extra"); };
      r.onsuccess = () => { idb = r.result; res(idb); }; r.onerror = () => res(null);
    });
  }
  function idbReq(store, mode, fn) {
    return new Promise((res, rej) => { if (!idb) return res(null); const tx = idb.transaction(store, mode), st = tx.objectStore(store); const q = fn(st); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); });
  }
  const cacheKey = p => bereich + "|" + p;
  function cacheAlle() {
    return new Promise(res => {
      if (!idb) return res([]);
      const out = [], q = idb.transaction("docs", "readonly").objectStore("docs").openCursor(IDBKeyRange.bound(bereich + "|", bereich + "|￿"));
      q.onsuccess = () => { const c = q.result; if (c) { if (!/\/dateidaten\//.test(c.key)) out.push([c.key.slice(bereich.length + 1), c.value]); c.continue(); } else res(out); };
      q.onerror = () => res(out);
    });
  }
  const cachePut = (p, d) => idbReq("docs", "readwrite", st => d == null ? st.delete(cacheKey(p)) : st.put(d, cacheKey(p))).catch(() => { });
  const cacheGet = p => idbReq("docs", "readonly", st => st.get(cacheKey(p))).catch(() => null);
  const extraGet = k => idbReq("extra", "readonly", st => st.get(k)).catch(() => null);
  const extraPut = (k, v) => idbReq("extra", "readwrite", st => v == null ? st.delete(k) : st.put(v, k)).catch(() => { });
  function queueAlle() {
    return new Promise(res => {
      if (!idb) return res(MEMQ.slice());
      const out = [], q = idb.transaction("queue", "readonly").objectStore("queue").openCursor();
      q.onsuccess = () => { const c = q.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); }; q.onerror = () => res(out);
    });
  }
  const MEMQ = []; let memqId = 0;
  async function queueAdd(e) { if (!idb) { MEMQ.push([++memqId, e]); return; } await idbReq("queue", "readwrite", st => st.add(e)).catch(() => MEMQ.push([++memqId, e])); }
  async function queueDel(keys) { if (!idb) { for (const k of keys) { const i = MEMQ.findIndex(x => x[0] === k); if (i >= 0) MEMQ.splice(i, 1); } return; } await idbReq("queue", "readwrite", st => { keys.forEach(k => st.delete(k)); }).catch(() => { }); }

  /* ---------- Dokumente im Speicher ---------- */
  const DOCS = new Map(), OFFEN = new Map(); // OFFEN: Pfad → Anzahl noch nicht übertragener Änderungen
  const norm = p => String(p).split("/").filter(Boolean).join("/");
  const elternVon = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const istDatei = p => /\/dateidaten\/[^/]+$/.test(p);
  const snap = (p, d) => ({ exists: d != null, id: p.split("/").pop(), ref: { path: p }, data: () => d == null ? undefined : kopie(d) });
  function colSnap(p) {
    const docs = []; for (const [k, d] of DOCS) if (elternVon(k) === p) docs.push(snap(k, d));
    docs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { docs, empty: !docs.length, size: docs.length, forEach: f => docs.forEach(f) };
  }
  const HOERER = new Set(); let geaendert = new Set(), meldePlan = false;
  function melde(pfade) {
    pfade.forEach(p => geaendert.add(p));
    if (meldePlan) return; meldePlan = true;
    setTimeout(() => {
      meldePlan = false; const g = geaendert; geaendert = new Set();
      const eltern = new Set([...g].map(elternVon));
      for (const l of HOERER) { try { if (l.t === "d" ? g.has(l.p) : eltern.has(l.p)) l.cb(l.t === "d" ? snap(l.p, DOCS.get(l.p)) : colSnap(l.p)); } catch (e) { console.warn(e); } }
    }, 0);
  }
  function hoere(l) { HOERER.add(l); setTimeout(() => { if (HOERER.has(l)) try { l.cb(l.t === "d" ? snap(l.p, DOCS.get(l.p)) : colSnap(l.p)); } catch (e) { console.warn(e); } }, 0); return () => HOERER.delete(l); }
  async function schreibe(p, d) {
    if (d == null) DOCS.delete(p); else DOCS.set(p, d);
    OFFEN.set(p, (OFFEN.get(p) || 0) + 1); status.offen++;
    cachePut(p, d); await queueAdd({ b: bereich, p, d: d == null ? null : d });
    melde([p]); planeFlush();
  }
  async function holeEinzel(p) {
    const c = await cacheGet(p); if (c != null) return c;
    try { const r = await rest("GET", "bereich_doc?select=daten,geloescht&bereich=eq." + bereich + "&pfad=eq." + encodeURIComponent(p));
      const d = r && r[0] && !r[0].geloescht ? r[0].daten : null; if (d != null) cachePut(p, d); return d; } catch (e) { return null; }
  }
  function docRef(p) {
    p = norm(p);
    return { id: p.split("/").pop(), path: p,
      get: async () => { let d = DOCS.get(p); if (d === undefined && istDatei(p)) d = await holeEinzel(p); return snap(p, d); },
      set: async o => schreibe(p, kopie(o)),
      update: async o => schreibe(p, Object.assign(kopie(DOCS.get(p)) || {}, kopie(o))),
      delete: async () => schreibe(p, null),
      collection: n => colRef(p + "/" + n),
      onSnapshot: (cb, err) => hoere({ t: "d", p, cb, err }) };
  }
  async function dateienHolen(p) { // Datei-Teile werden nicht vorab geladen – bei Bedarf vom Server holen
    try { const rows = await rest("GET", "bereich_doc?select=pfad,daten&bereich=eq." + bereich + "&eltern=eq." + encodeURIComponent(p) + "&geloescht=is.false");
      for (const r of rows || []) if (!OFFEN.has(r.pfad)) { DOCS.set(r.pfad, r.daten); cachePut(r.pfad, r.daten); } } catch (e) { console.warn(e); }
    return colSnap(p);
  }
  function colRef(p) { p = norm(p); return { path: p, id: p.split("/").pop(), doc: id => docRef(p + "/" + (id || uidNeu())), get: async () => /\/dateidaten$/.test(p) ? dateienHolen(p) : colSnap(p), onSnapshot: (cb, err) => hoere({ t: "c", p, cb, err }) }; }
  const uidNeu = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "");
  const DB = { doc: docRef, collection: colRef };

  /* ---------- Abgleich mit dem Server ---------- */
  let flushLaeuft = false, flushTimer = null;
  function planeFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 400); }
  async function flush() {
    if (flushLaeuft || !sess) return; flushLaeuft = true;
    try {
      for (let runde = 0; runde < 50; runde++) {
        const q = await queueAlle(); if (!q.length) break;
        // nur Einträge des aktuellen Bereichs, pro Pfad zählt die letzte Änderung
        const fremd = q.filter(([, e]) => e.b !== bereich).map(([k]) => k); if (fremd.length) await queueDel(fremd);
        const eig = q.filter(([, e]) => e.b === bereich), last = new Map(); for (const [k, e] of eig) last.set(e.p, [k, e]);
        let paket = [], groesse = 0, keys = [];
        for (const [k, e] of eig) { if (last.get(e.p)[0] !== k) { keys.push(k); continue; } const s = e.d == null ? 50 : JSON.stringify(e.d).length; if (paket.length && (groesse + s > 1500000 || paket.length >= 40)) break; paket.push(e); keys.push(k); groesse += s; }
        if (!paket.length) { await queueDel(keys); continue; }
        try {
          await rest("POST", "bereich_doc?on_conflict=bereich,pfad", paket.map(e => ({ bereich, pfad: e.p, daten: e.d, geloescht: e.d == null })), "resolution=merge-duplicates,return=minimal");
        } catch (e) {
          if (e.status === 401 || e.status === 403 || e.code === "42501") {
            if (paket.length > 1) { // einzeln versuchen, damit nur die gesperrten verworfen werden
              for (const x of paket) { try { await rest("POST", "bereich_doc?on_conflict=bereich,pfad", [{ bereich, pfad: x.p, daten: x.d, geloescht: x.d == null }], "resolution=merge-duplicates,return=minimal"); } catch (e2) { if (!(e2.status === 401 || e2.status === 403 || e2.code === "42501")) throw e2; hinweis("Keine Berechtigung – eine Änderung wurde nicht gespeichert."); } }
            } else hinweis("Keine Berechtigung – die Änderung wurde nicht gespeichert.");
            letzterSync = "1970-01-01T00:00:00Z"; // Serverstand vollständig neu holen
          } else throw e;
        }
        await queueDel(keys);
        for (const e of paket) { const n = (OFFEN.get(e.p) || 1) - 1; n > 0 ? OFFEN.set(e.p, n) : OFFEN.delete(e.p); }
        status.offen = Math.max(0, status.offen - keys.length);
      }
      status.offen = (await queueAlle()).length; status.fehler = "";
    } catch (e) { status.fehler = navigator.onLine === false ? "offline" : (e.message || String(e)); }
    finally { flushLaeuft = false; }
  }
  let syncLaeuft = null;
  function sync() { if (!syncLaeuft) syncLaeuft = syncIntern().finally(() => { syncLaeuft = null; }); return syncLaeuft; }
  async function syncIntern() {
    if (!sess) return;
    const z = lies(LSZ) || {}; let ab = letzterSync || z[bereich] || "1970-01-01T00:00:00Z";
    const neu = [];
    for (let s = 0; s < 200; s++) {
      const rows = await rest("GET", "bereich_doc?select=pfad,daten,geloescht,geaendert&bereich=eq." + bereich + "&geaendert=gte." + encodeURIComponent(ab) + "&eltern=not.like.*dateidaten&order=geaendert.asc&limit=500");
      for (const r of rows) {
        if (OFFEN.has(r.pfad)) continue; // eigene, noch nicht übertragene Änderung hat Vorrang
        const alt = DOCS.get(r.pfad), d = r.geloescht ? null : r.daten;
        if (JSON.stringify(alt) !== JSON.stringify(d === null ? undefined : d)) { if (d == null) DOCS.delete(r.pfad); else DOCS.set(r.pfad, d); cachePut(r.pfad, d); neu.push(r.pfad); }
      }
      if (rows.length) ab = rows[rows.length - 1].geaendert;
      if (rows.length < 500) break;
    }
    letzterSync = ab; z[bereich] = ab; schreib(LSZ, z);
    status.zuletzt = new Date(); status.fehler = "";
    if (neu.length) melde(neu);
  }
  async function abgleichen() { try { await flush(); await sync(); } catch (e) { status.fehler = navigator.onLine === false ? "offline" : (e.message || String(e)); } }
  function hinweis(t) { try { toast(t); } catch (e) { console.warn(t); } }

  /* ---------- Start ---------- */
  async function verbinden() {
    if (!sess) return null;
    await idbAuf();
    try { await token(); } catch (e) { if (!sess) { setTimeout(() => hinweis("Bitte melden Sie sich erneut an (Einstellungen → Konto)."), 1500); return null; } }
    const bm = lies(LSB) || {}; bereich = bm[sess.uid] || sess.uid;
    for (const [p, d] of await cacheAlle()) DOCS.set(p, d);
    for (const [, e] of await queueAlle()) if (e.b === bereich) OFFEN.set(e.p, (OFFEN.get(e.p) || 0) + 1);
    status.offen = [...OFFEN.values()].reduce((a, b) => a + b, 0);
    // Noch Mitglied im Büro? Sonst zurück in den eigenen Bereich.
    if (bereich !== sess.uid) {
      try { const ok = await rpc("ist_mitglied_b", { b: bereich }); if (ok === false) { bm[sess.uid] = null; schreib(LSB, bm); bereich = sess.uid; DOCS.clear(); OFFEN.clear(); for (const [p, d] of await cacheAlle()) DOCS.set(p, d); setTimeout(() => hinweis("Sie sind nicht mehr Mitglied im Büro – Sie arbeiten wieder in Ihrem eigenen Bereich."), 1500); } } catch (e) { }
    }
    const erster = DOCS.size === 0;
    const p = abgleichen();
    if (erster) await Promise.race([p, new Promise(r => setTimeout(r, 25000))]); else await Promise.race([p, new Promise(r => setTimeout(r, 4000))]);
    setInterval(() => { if (document.visibilityState !== "hidden") abgleichen(); }, 30000);   // Abgleich mit dem Server alle 30 Sekunden
    window.addEventListener("online", abgleichen);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") abgleichen(); });
    setTimeout(umzugPruefen, 1500);
    // Team-Status erst prüfen, wenn die App im Konto-Modus läuft (der Team-Start käme sonst zu früh)
    const tw = setInterval(() => { if (S.mode === "cloud" && typeof teamInit === "function") { clearInterval(tw);
      teamInit().then(() => { try { if (teamRolle() === "fremd") teamOverlay(); render(); } catch (e) { } }).catch(e => console.warn(e)); } }, 100);
    const user = {
      id: async () => sess.uid,
      isOwner: async () => bereich === sess.uid,
      profiles: async ids => { const out = {}; try { const r = await rpc("namen", { ids: ids.filter(Boolean) }); for (const x of r || []) out[x.id] = { name: x.name }; } catch (e) { } if (ids.includes(sess.uid) && !out[sess.uid]) out[sess.uid] = { name: sess.name || "Ich" }; return out; }
    };
    return { db: DB, user, uid: sess.uid };
  }

  /* ---------- Bisherige Daten des Geräts übernehmen ---------- */
  async function umzugVorbereiten() {
    const echte = Object.values((typeof local !== "undefined" && local.data && local.data.kunden) || {}).filter(k => !k.beispiel);
    if (!echte.length) return false;
    const j = await sicherungDaten(); j.kunden = j.kunden.filter(k => !k.beispiel);
    await idbAuf(); await extraPut("umzug", JSON.stringify(j)); return true;
  }
  async function umzugPruefen() {
    const t = await extraGet("umzug"); if (!t) return;
    const warte = () => new Promise(r => { const i = setInterval(() => { if (S.mode === "cloud" && S.loading === false) { clearInterval(i); r(); } }, 200); setTimeout(() => { clearInterval(i); r(); }, 15000); });
    await warte();
    try { const j = JSON.parse(t); await sicherungUebernehmen(j); await extraPut("umzug", null); hinweis(j.kunden.length + " Kunden vom Gerät ins Konto übernommen"); }
    catch (e) { console.warn(e); hinweis("Übernahme der Gerätedaten fehlgeschlagen – bitte über „Sicherung einlesen“ wiederholen."); }
  }

  /* ---------- Aktionen ---------- */
  async function nachAnmeldung() {
    if (S.mode === "lokal") { try { await umzugVorbereiten(); } catch (e) { console.warn(e); } }
    location.reload();
  }
  async function anmelden(email, pw) { setz(await auth("token?grant_type=password", { email, password: pw })); await nachAnmeldung(); }
  async function registrieren(name, email, pw) {
    const j = await auth("signup", { email, password: pw, data: { name } });
    if (j.access_token) { setz(j); await nachAnmeldung(); return "ok"; }
    return "bestaetigen";
  }
  const passwortVergessen = email => auth("recover", { email });
  /** 6-stelliger Code aus der E-Mail (Registrierung bestätigen oder Passwort zurücksetzen) */
  async function codePruefen(email, code, art) {
    const typen = art === "recovery" ? ["recovery"] : ["email", "signup"]; let fehler = null;
    for (const type of typen) { try { const j = await auth("verify", { type, email, token: code }); if (j.access_token) { setz(j); return true; } } catch (e) { fehler = e; } }
    throw fehler || new Error("Der Code ist ungültig oder abgelaufen.");
  }
  async function neuesPasswort(pw) {
    const r = await fetch(URL_ + "/auth/v1/user", { method: "PUT", headers: { apikey: KEY, Authorization: "Bearer " + await token(), "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) { } throw new Error(fehlerText(j, r.status)); }
  }
  function codeSheet(email, art) {
    const msg = h("p", { class: "mut", style: "min-height:18px;margin:10px 0 0" });
    const [fc, iCode] = feld("ko_code6", "Code aus der E-Mail", "text", "one-time-code");
    iCode.setAttribute("inputmode", "numeric"); iCode.style.cssText = "font:700 22px ui-monospace,Menlo,monospace;letter-spacing:.3em;text-align:center";
    const [fp, iPw] = art === "recovery" ? feld("ko_pwneu", "Neues Passwort (mindestens 8 Zeichen)", "password", "new-password") : [null, null];
    sheet(art === "recovery" ? "Passwort zurücksetzen" : "E-Mail bestätigen", h("div", null,
      h("p", { class: "sub", style: "margin-top:0" }, "Wir haben eine E-Mail an " + email + " geschickt. Geben Sie den Code daraus ein" + (art === "recovery" ? " und wählen Sie ein neues Passwort." : ".") + " Keine Mail? Bitte auch im Spam-Ordner nachsehen."),
      fc, fp, msg),
      [{ t: "Abbrechen", cls: "sec", fn: () => { } }, { t: art === "recovery" ? "Passwort speichern" : "Bestätigen", fn: async () => {
        const c = iCode.value.replace(/\s/g, ""); if (c.length < 6) { msg.textContent = "Bitte den Code aus der E-Mail eingeben."; return false; }
        if (art === "recovery" && iPw.value.length < 8) { msg.textContent = "Das neue Passwort braucht mindestens 8 Zeichen."; return false; }
        msg.textContent = "Wird geprüft …";
        try { await codePruefen(email, c, art); if (art === "recovery") await neuesPasswort(iPw.value); msg.textContent = "Fertig – Daten werden geladen …"; await nachAnmeldung(); return false; }
        catch (e) { msg.textContent = navigator.onLine === false ? "Keine Internetverbindung." : e.message; return false; } } }]);
    setTimeout(() => iCode.focus(), 50);
  }
  async function abmelden(still) {
    try { if (sess) await auth("logout", {}, true); } catch (e) { }
    sess = null; schreib(LS, null); schreib(LSZ, null);
    try { if (idb) idb.close(); indexedDB.deleteDatabase("eeb-cloud"); } catch (e) { }
    if (!still) location.reload();
  }
  async function beitreten(code) {
    const b = await rpc("bereich_beitreten", { p_code: code });
    const bm = lies(LSB) || {}; bm[sess.uid] = b; schreib(LSB, bm);
    location.reload();
  }
  async function verlassen() {
    try { await rest("DELETE", "bereich_zugang?bereich=eq." + bereich + "&user_id=eq." + sess.uid); } catch (e) { }
    const bm = lies(LSB) || {}; bm[sess.uid] = null; schreib(LSB, bm); location.reload();
  }
  async function kontoLoeschen() { await flush(); await rpc("konto_loeschen"); await abmelden(true); location.reload(); }

  /* ---------- Einstellungen → Konto ---------- */
  function feld(id, label, typ, ac, wert) { const i = h("input", { class: "inp", id, type: typ, autocomplete: ac, value: wert || "" }); return [h("div", { class: "fld" }, h("label", { for: id }, label), i), i]; }
  function anmeldeSheet(neu) {
    const msg = h("p", { class: "mut", style: "min-height:18px;margin:10px 0 0" });
    const [fn, iName] = feld("ko_name", "Ihr Name (sehen Kollegen im Team)", "text", "name");
    const [fe, iMail] = feld("ko_mail", "E-Mail", "email", "username");
    const [fp, iPw] = feld("ko_pw", "Passwort" + (neu ? " (mindestens 8 Zeichen)" : ""), "password", neu ? "new-password" : "current-password");
    const vergessen = neu ? null : h("button", { type: "button", class: "linkbtn", onclick: async () => {
      if (!/\S+@\S+\.\S+/.test(iMail.value)) { msg.textContent = "Bitte zuerst Ihre E-Mail eintragen."; return; }
      try { const m = iMail.value.trim(); await passwortVergessen(m); codeSheet(m, "recovery"); } catch (e) { msg.textContent = e.message; } } }, "Passwort vergessen?");
    const body = h("div", null,
      h("p", { class: "sub", style: "margin-top:0" }, neu ? "Mit dem Konto liegen Ihre Daten verschlüsselt übertragen auf dem EEBerater-Server in der EU – auf Handy, Tablet und PC gleich und im Team gemeinsam nutzbar." : "Melden Sie sich mit Ihrem EEBerater-Konto an."),
      neu ? fn : null, fe, fp, vergessen, msg,
      S.mode === "lokal" ? h("p", { class: "mut", style: "font-size:12.5px" }, "Ihre bisherigen Kunden auf diesem Gerät werden nach der Anmeldung ins Konto übernommen.") : null);
    sheet(neu ? "Konto erstellen" : "Anmelden", body, [{ t: "Abbrechen", cls: "sec", fn: () => { } }, { t: neu ? "Konto erstellen" : "Anmelden", fn: async () => {
      const mail = iMail.value.trim(), pw = iPw.value;
      if (!/\S+@\S+\.\S+/.test(mail)) { msg.textContent = "Bitte eine gültige E-Mail-Adresse eingeben."; return false; }
      if (neu && pw.length < 8) { msg.textContent = "Das Passwort braucht mindestens 8 Zeichen."; return false; }
      if (neu && !iName.value.trim()) { msg.textContent = "Bitte Ihren Namen eingeben."; return false; }
      msg.textContent = neu ? "Konto wird erstellt …" : "Anmeldung läuft …";
      try {
        if (neu) { const r = await registrieren(iName.value.trim(), mail, pw); if (r === "bestaetigen") { codeSheet(mail, "signup"); return; } }
        else { try { await anmelden(mail, pw); } catch (e) { if (/bestätigen Sie zuerst/.test(e.message)) { try { await auth("resend", { type: "signup", email: mail }); } catch (e2) { } codeSheet(mail, "signup"); return; } throw e; } }
        msg.textContent = "Angemeldet – Daten werden geladen …"; return false;
      } catch (e) { msg.textContent = navigator.onLine === false ? "Keine Internetverbindung." : e.message; return false; }
    } }]);
    setTimeout(() => (neu ? iName : iMail).focus(), 50);
  }
  function beitretenSheet() {
    const inp = h("input", { class: "inp", id: "ko_code", placeholder: "XXXX-XXXX", autocomplete: "off", style: "font:700 20px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-align:center;text-transform:uppercase" });
    const msg = h("p", { class: "mut", style: "min-height:18px" });
    sheet("Büro beitreten", h("div", null, h("p", { class: "sub", style: "margin-top:0" }, "Geben Sie den Einladungscode ein, den Sie vom Inhaber des Büros bekommen haben. Danach arbeiten Sie mit den gemeinsamen Kunden des Büros – mit den Rechten, die der Inhaber festlegt."),
      h("div", { class: "fld" }, h("label", { for: "ko_code" }, "Einladungscode"), inp), msg),
      [{ t: "Abbrechen", cls: "sec", fn: () => { } }, { t: "Beitreten", fn: async () => {
        const c = inp.value.toUpperCase().replace(/\s+/g, ""); if (c.length < 8) { msg.textContent = "Bitte den vollständigen Code eingeben."; return false; }
        msg.textContent = "Wird geprüft …";
        try { await flush(); await beitreten(c); return false; } catch (e) { msg.textContent = navigator.onLine === false ? "Keine Internetverbindung." : e.message; return false; } } }]);
    setTimeout(() => inp.focus(), 50);
  }
  function karte() {
    const sec = (...k) => h("section", { class: "card fsec" }, h("h4", null, "Konto"), ...k);
    if (!sess) return sec(
      h("p", { class: "sub" }, "Mit einem EEBerater-Konto liegen Ihre Kunden, Fotos und Dateien sicher auf dem Server in der EU: auf Handy, Tablet und PC gleich, ohne Netz weiter nutzbar und im Tarif Büro gemeinsam mit Ihren Mitarbeitern."),
      h("div", { class: "btnrow", style: "margin-top:8px" }, h("button", { class: "btn", onclick: () => anmeldeSheet(false) }, ic("lock"), "Anmelden"), h("button", { class: "btn sec", onclick: () => anmeldeSheet(true) }, ic("plus"), "Konto erstellen")));
    const imBuero = bereich && bereich !== sess.uid;
    const st = h("p", { class: "mut", style: "font-size:13px;margin:6px 0 0" });
    const zeig = () => { st.textContent = (status.fehler === "offline" || navigator.onLine === false ? "Offline – Änderungen werden übertragen, sobald wieder Internet da ist. " : status.fehler ? "Abgleich gestört: " + status.fehler + ". " : "") + (status.offen ? status.offen + " Änderung(en) noch nicht übertragen. " : "Alles übertragen. ") + (status.zuletzt ? "Zuletzt abgeglichen " + status.zuletzt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr." : ""); };
    zeig(); const iv = setInterval(() => { if (!document.body.contains(st)) clearInterval(iv); else zeig(); }, 2000);
    return sec(
      h("div", { class: "kv", style: "padding:6px 0" }, h("span", null, "Angemeldet als"), h("b", null, (sess.name ? sess.name + " · " : "") + (sess.email || "")),
        h("span", null, "Bereich"), h("b", null, imBuero ? "Büro-Team (Mitarbeiter)" : "Eigenes Büro")),
      st,
      h("div", { class: "btnrow", style: "margin-top:10px;flex-wrap:wrap" },
        h("button", { class: "btn sec", onclick: async () => { st.textContent = "Wird abgeglichen …"; await abgleichen(); zeig(); toast("Abgleich fertig"); } }, ic("upload"), "Jetzt abgleichen"),
        imBuero ? h("button", { class: "btn sec", onclick: () => ask("Büro verlassen?", "Sie arbeiten danach wieder in Ihrem eigenen Bereich. Die Kunden des Büros bleiben beim Büro.", "Verlassen", verlassen, true) }, "Büro verlassen")
          : h("button", { class: "btn sec", onclick: beitretenSheet }, ic("plus"), "Büro beitreten"),
        h("button", { class: "btn sec", onclick: () => ask("Abmelden?", status.offen ? "Achtung: " + status.offen + " Änderung(en) sind noch nicht übertragen und gehen beim Abmelden verloren. Bitte erst mit Internet abgleichen." : "Ihre Daten bleiben im Konto. Auf diesem Gerät werden sie entfernt, bis Sie sich wieder anmelden.", "Abmelden", () => abmelden(), true) }, "Abmelden")),
      h("button", { type: "button", class: "linkbtn", style: "color:var(--r);margin-top:8px", onclick: () => ask("Konto endgültig löschen?", imBuero ? "Ihr Konto wird gelöscht. Die Kunden des Büros bleiben beim Büro." : "Ihr Konto und alle Daten in Ihrem Bereich (Kunden, Fotos, Dateien, Belege) werden endgültig vom Server gelöscht. Erstellen Sie vorher eine Sicherung, wenn Sie die Daten behalten möchten.", "Endgültig löschen", async () => { try { await kontoLoeschen(); } catch (e) { toast("Löschen fehlgeschlagen: " + e.message); } }, true) }, "Konto löschen"));
  }
  /* ---------- Abo (PayPal, Beta-Codes, Freischaltung) ---------- */
  const LSA = "eeb-abo-v1";
  async function fn(name, body) {
    const r = await fetch(URL_ + "/functions/v1/" + name, { method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + await token(), "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { }
    if (!r.ok || j.fehler) throw new Error(j.fehler || ("Serverfehler " + r.status));
    return j;
  }
  const aboMerken = a => { schreib(LSA, { uid: sess.uid, abo: a, stand: Date.now() }); return a; };
  function aboCache() { const a = lies(LSA); return a && sess && a.uid === sess.uid ? a.abo : null; }
  async function abo(pruefen) {
    if (!sess) return null;
    let a = await rpc("mein_abo");
    if (a && a.paypal && (pruefen || !a.tarif)) { try { await fn("paypal-abo", { aktion: "pruefen" }); a = await rpc("mein_abo"); } catch (e) { console.warn(e); } }
    return aboMerken(a);
  }
  const betaEinloesen = async code => aboMerken(await rpc("beta_einloesen", { p_code: code }));
  const paypalAktivieren = async sub => { await fn("paypal-abo", { aktion: "aktivieren", sub }); return abo(); };
  const paypalEinrichten = () => fn("paypal-abo", { aktion: "einrichten" });
  const config = async () => Object.fromEntries(((await rest("GET", "app_config?select=k,v")) || []).map(x => [x.k, x.v]));

  return { verbinden, karte, abgleichen, status, angemeldet: () => !!sess, uid: () => sess && sess.uid, anmeldeSheet,
    abo, aboCache, betaEinloesen, paypalAktivieren, paypalEinrichten, config };
})();
