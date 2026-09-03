/* RaeSource sync.
 *
 * The app stays offline-first: localStorage is what the UI reads, so a rep in a
 * basement or a truck with one bar never waits on the network. Writes go into a
 * durable queue and drain when there is signal. Reads poll every 20s, which is
 * fast enough that two reps do not double-call a GC and costs a fraction of the
 * code a websocket would.
 *
 * Conflicts resolve last-write-wins per row, decided by the server's
 * updated_at. Nothing is lost even when a write is overwritten: activity_log is
 * append-only and holds who did what.
 */
(function (w) {
  var C = w.RS_CONFIG || {};
  var URL = (C.SUPABASE_URL || "").replace(/\/+$/, "");
  var ANON = C.SUPABASE_ANON_KEY || "";
  var SESS = "raesource.session";
  var QUEUE = "raesource.queue";
  var CURSOR = "raesource.cursor";

  var ls = {
    get: function (k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  function configured() { return !!(URL && ANON); }
  function session() { return ls.get(SESS, null); }

  function api(path, opts) {
    opts = opts || {};
    var s = session();
    var h = { apikey: ANON, "Content-Type": "application/json" };
    h.Authorization = "Bearer " + ((opts.anon ? null : s && s.access_token) || ANON);
    if (opts.prefer) h.Prefer = opts.prefer;
    return fetch(URL + path, {
      method: opts.method || "GET",
      headers: h,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401 && !opts.retry && s && s.refresh_token) return refresh().then(function () {
        opts.retry = true; return api(path, opts);
      });
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + " " + t.slice(0, 300)); });
      return r.status === 204 ? null : r.json();
    });
  }

  function refresh() {
    var s = session();
    return fetch(URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("session expired")); })
      .then(function (j) { ls.set(SESS, j); return j; });
  }

  /* --- sign in --------------------------------------------------------------
     Supabase mails whichever of these its template supports. The built-in
     mailer can only send a LINK; a 6-digit CODE needs custom SMTP, because
     Supabase will not let you edit templates without it. So the app accepts
     both: the code box is there when SMTP is configured, and landing back from
     a link is handled by consumeHash() below. */
  function requestCode(email) {
    return fetch(URL + "/auth/v1/otp", {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email, create_user: false,
        options: { email_redirect_to: location.origin + location.pathname },
        email_redirect_to: location.origin + location.pathname
      })
    }).then(function (r) {
      if (r.ok) return true;
      return r.text().then(function (t) {
        var j = {}; try { j = JSON.parse(t); } catch (e) {}
        var code = j.error_code || j.code || r.status;
        /* Say what actually happened. The old catch-all blamed the address,
           which sent people hunting for a problem that was not there. */
        if (r.status === 429 || code === "over_email_send_rate_limit")
          throw new Error("RATE_LIMIT");
        if (r.status === 422 || /not found|signups not allowed/i.test(j.msg || ""))
          throw new Error("NO_SEAT");
        throw new Error(j.msg || j.error_description || ("Sign-in failed (" + code + ")."));
      });
    });
  }
  function verifyCode(email, code) {
    return fetch(URL + "/auth/v1/verify", {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email", email: email, token: code })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("That code did not work."); });
      return r.json();
    }).then(function (j) { ls.set(SESS, j); return j; });
  }
  /* A magic link returns here with the tokens in the URL fragment. Consume
     them, then scrub the address bar so a shared screenshot or a browser
     history entry cannot hand somebody else a live session. */
  function consumeHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (!h || h.indexOf("access_token=") === -1) return Promise.resolve(null);
    var p = {};
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("="); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    var recovery = p.type === "recovery";
    history.replaceState(null, "", location.pathname + location.search);
    if (!p.access_token) return Promise.resolve(null);
    var sess = { access_token: p.access_token, refresh_token: p.refresh_token || "",
                 token_type: p.token_type || "bearer", expires_in: +(p.expires_in || 3600) };
    ls.set(SESS, sess);
    // The hash carries no user object, and log() needs the id.
    return fetch(URL + "/auth/v1/user", {
      headers: { apikey: ANON, Authorization: "Bearer " + sess.access_token }
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) { if (u) { sess.user = u; ls.set(SESS, sess); }
                           sess.recovery = recovery; return sess; })
      .catch(function () { sess.recovery = recovery; return sess; });
  }

  /* --- password ------------------------------------------------------------
     Once somebody has a password, signing in costs no email at all. That is
     the point: the mailer is rate limited, and a sales floor that cannot get
     in because six people opened the app in one hour is not a product. Email
     is now only the first handshake and the reset path. */
  function signInPassword(email, password) {
    return fetch(URL + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (t) {
        var j = {}; try { j = JSON.parse(t); } catch (e) {}
        if (r.status === 400 || r.status === 401) throw new Error("BAD_LOGIN");
        if (r.status === 429) throw new Error("RATE_LIMIT");
        throw new Error(j.msg || j.error_description || "Sign-in failed.");
      });
    }).then(function (j) { ls.set(SESS, j); return j; });
  }

  /* Setting a password needs a live session, not an email — so it works even
     when the mailer is exhausted. The flag on user_metadata is what lets the
     app tell "never set one" from "has one and just used a link today". */
  function setPassword(password) {
    return api("/auth/v1/user", {
      method: "PUT",
      body: { password: password, data: { has_password: true } }
    }).then(function (u) {
      var s = session();
      if (s) { s.user = u; ls.set(SESS, s); }
      return u;
    });
  }

  function hasPassword() {
    var s = session();
    return !!(s && s.user && s.user.user_metadata && s.user.user_metadata.has_password);
  }

  function requestReset(email) {
    return fetch(URL + "/auth/v1/recover", {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email,
        options: { redirect_to: location.origin + location.pathname },
        redirect_to: location.origin + location.pathname
      })
    }).then(function (r) {
      if (r.ok) return true;
      return r.text().then(function (t) {
        var j = {}; try { j = JSON.parse(t); } catch (e) {}
        if (r.status === 429 || j.error_code === "over_email_send_rate_limit")
          throw new Error("RATE_LIMIT");
        throw new Error(j.msg || "Could not send the reset email.");
      });
    });
  }

  function signOut() { ls.del(SESS); ls.del(QUEUE); ls.del(CURSOR); }

  /* --- reads ------------------------------------------------------------- */
  var SEL = "id,gc,person,phone,job,descr,addr,zip,day,issued,taken,sector,link";

  function loadDoc() {
    // RLS means "my client" is the only client these queries can return.
    return api("/rest/v1/clients?select=id,name,lane,trade,zips,sector,window_lo,window_hi,active&limit=1")
      .then(function (cs) {
        if (!cs || !cs.length) throw new Error("This sign-in has no territory assigned yet.");
        var c = cs[0];
        /* PostgREST hard-caps a response at 1000 rows and ignores a larger
           limit without complaint. Taking the first page would have handed a
           cabinet shop the newest thousand permits — days 0-30 — when the
           trade is not hired until day 75. Page until the server runs out. */
        var all = [], PAGE = 1000;
        function page(from) {
          return api("/rest/v1/leads?select=" + SEL + "&order=issued.desc"
                     + "&offset=" + from + "&limit=" + PAGE)
            .then(function (rows) {
              all = all.concat(rows || []);
              return (rows && rows.length === PAGE) ? page(from + PAGE) : all;
            });
        }
        return page(0)
          .then(function (rows) {
            return {
              client: c.name, lane: c.lane, trade: c.trade,
              window: [c.window_lo, c.window_hi], zips: c.zips || [],
              sector: c.sector, clientId: c.id,
              leads: (rows || []).map(function (r) {
                /* Age is recomputed here, never trusted from the row. The
                   stored value is only correct on the day it was written, and
                   the whole product is "call this trade at the right week". */
                var day = r.day;
                if (r.issued) {
                  var d = Math.floor((Date.now() - Date.parse(r.issued + "T12:00:00Z"))
                                     / 86400000);
                  if (isFinite(d)) day = d;
                }
                return {
                  id: r.id, gc: r.gc, person: r.person, phone: r.phone, job: r.job,
                  desc: r.descr, addr: r.addr, zip: r.zip, day: day,
                  issued: r.issued, taken: r.taken || [], sector: r.sector, link: r.link
                };
              })
            };
          });
      });
  }

  /* Pull only what changed since last time, so the poll stays cheap. */
  function pull() {
    var since = ls.get(CURSOR, "1970-01-01T00:00:00Z");
    return api("/rest/v1/activity?select=lead_id,stage,value,contact,email,phone,notes,dnc,updated_at"
      + "&updated_at=gt." + encodeURIComponent(since) + "&order=updated_at.asc&limit=1000")
      .then(function (rows) {
        if (rows && rows.length) ls.set(CURSOR, rows[rows.length - 1].updated_at);
        return rows || [];
      });
  }

  /* --- writes ------------------------------------------------------------ */
  function enqueue(leadId, rec) {
    var q = ls.get(QUEUE, {});
    q[leadId] = {
      lead_id: leadId, stage: rec.stage, value: rec.value || 0,
      contact: rec.contact || "", email: rec.email || "",
      phone: rec.phone || "", notes: rec.notes || "", dnc: !!rec.dnc
    };
    ls.set(QUEUE, q);
  }

  function flush(clientId) {
    var q = ls.get(QUEUE, {});
    var keys = Object.keys(q);
    if (!keys.length || !session() || !clientId) return Promise.resolve(0);
    var rows = keys.map(function (k) {
      var r = q[k]; r.client_id = clientId; return r;
    });
    return api("/rest/v1/activity?on_conflict=client_id,lead_id", {
      method: "POST", body: rows,
      prefer: "resolution=merge-duplicates,return=minimal"
    }).then(function () {
      // Drop only what we actually sent; anything typed mid-flight survives.
      var now = ls.get(QUEUE, {});
      keys.forEach(function (k) { if (JSON.stringify(now[k]) === JSON.stringify(q[k])) delete now[k]; });
      ls.set(QUEUE, now);
      return rows.length;
    }).catch(function () { return 0; });   // stays queued, retried next tick
  }

  function log(clientId, leadId, event, actorName) {
    if (!session() || !clientId) return Promise.resolve();
    var s = session();
    return api("/rest/v1/activity_log", {
      method: "POST", prefer: "return=minimal",
      body: [{ client_id: clientId, lead_id: leadId, actor: s.user && s.user.id,
               actor_name: actorName || "", event: event }]
    }).catch(function () {});
  }

  function pending() { return Object.keys(ls.get(QUEUE, {})).length; }

  w.RSSync = {
    configured: configured, session: session, signOut: signOut,
    requestCode: requestCode, verifyCode: verifyCode, consumeHash: consumeHash,
    signInPassword: signInPassword, setPassword: setPassword,
    hasPassword: hasPassword, requestReset: requestReset,
    loadDoc: loadDoc, pull: pull, enqueue: enqueue, flush: flush,
    log: log, pending: pending
  };
})(window);
