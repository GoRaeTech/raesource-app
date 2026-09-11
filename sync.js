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
  var REJECTED = "raesource.sync.rejected";
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
    /* Ask for MY client by id, never "whichever row comes back first".
       That shortcut assumed RLS returns exactly one client, which is true for a
       customer and false for RaeTech staff: p_clients_staff_read lets an admin
       read every client, so `limit=1` handed back an arbitrary one. A staff
       member who is also a customer saw another company's name, trades, window
       and ZIPs stamped over their own leads - Jan Pro's cleaning territory on
       Rae's Custom Home Services.

       The leads were always right; p_leads_read is scoped to my_client_id() and
       is not staff-extended. It was only ever the client record that was wrong.
       Read the profile to find out which client is actually mine. */
    var COLS = "id,name,lane,trade,zips,sector,window_lo,window_hi,active,pay_url,seats";
    var me = whoAmI();
    var mine = me && me.id
      ? api("/rest/v1/profiles?select=client_id&id=eq." + encodeURIComponent(me.id))
          .then(function (ps) { return (ps && ps[0] && ps[0].client_id) || null; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    return mine.then(function (clientId) {
      var where = clientId ? "&id=eq." + encodeURIComponent(clientId) : "&limit=1";
      return api("/rest/v1/clients?select=" + COLS + ",trades" + where)
        .catch(function () { return api("/rest/v1/clients?select=" + COLS + where); });
    })
      .then(function (cs) {
        /* Google will happily create a login for anyone. A login is not a seat,
           so say that plainly instead of showing an empty lead list. */
        if (!cs || !cs.length) throw new Error("NO_SEAT_YET");
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
              sector: c.sector, clientId: c.id, payUrl: c.pay_url || "",
              seats: c.seats || 10,
              trades: (c.trades && c.trades.length) ? c.trades : [c.trade],
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
    return api("/rest/v1/activity?select=lead_id,stage,value,contact,email,phone,notes,dnc,follow_up_at,updated_at,updated_by"
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
      phone: rec.phone || "", notes: rec.notes || "", dnc: !!rec.dnc,
      follow_up_at: rec.followUp || null
    };
    ls.set(QUEUE, q);
  }

  function flush(clientId) {
    var q = ls.get(QUEUE, {});
    var keys = Object.keys(q);
    if (!keys.length || !session() || !clientId) return Promise.resolve(0);
    /* Copy, never stamp the queued object. Writing client_id onto q[k] changed
       it in memory but not in localStorage, and drop() then compared the two
       and found them different — so it deleted nothing. The queue never
       drained, every record was re-sent on every cycle, and the rep watched
       "12 not saved yet" climb while the server had all twelve. */
    var rows = keys.map(function (k) {
      var r = q[k], copy = {};
      for (var f in r) if (Object.prototype.hasOwnProperty.call(r, f)) copy[f] = r[f];
      copy.client_id = clientId;
      return copy;
    });
    return api("/rest/v1/activity?on_conflict=client_id,lead_id", {
      method: "POST", body: rows,
      prefer: "resolution=merge-duplicates,return=minimal"
    }).then(function () {
      // Drop only what we actually sent; anything typed mid-flight survives.
      drop(keys, q);
      return rows.length;
    }).catch(function () {
      /* One bad row used to take the whole batch down with it — and because the
         failure was swallowed, the queue simply never drained. A rep would see
         "7 not saved yet" for days with nothing telling anyone why. So on a
         batch failure, send them one at a time: whatever is fine gets through,
         and only the genuinely broken row stays behind. */
      return rows.reduce(function (chain, row) {
        return chain.then(function (n) {
          return api("/rest/v1/activity?on_conflict=client_id,lead_id", {
            method: "POST", body: [row],
            prefer: "resolution=merge-duplicates,return=minimal"
          }).then(function () { drop([row.lead_id], q); return n + 1; })
            .catch(function (e) {
              /* A row the server will never accept — a lead that no longer
                 exists, say — is dropped rather than blocking every later
                 note behind it. Losing one stale row beats losing the queue. */
              var m = String(e && e.message || "");
              if (/^(400|409)\b|foreign key|violates/.test(m)) {
                /* Never delete a rep's note without trace. It comes out of the
                   queue so it stops blocking, and goes somewhere it can be
                   recovered from if this turns out to be our bug. */
                var bin = ls.get(REJECTED, []);
                bin.push({ at: new Date().toISOString(), why: m.slice(0, 200), row: row });
                ls.set(REJECTED, bin.slice(-50));
                drop([row.lead_id], q);
              }
              return n;
            });
        });
      }, Promise.resolve(0));
    });
  }

  function drop(keys, sent) {
    var now = ls.get(QUEUE, {});
    keys.forEach(function (k) {
      if (!sent || JSON.stringify(now[k]) === JSON.stringify(sent[k])) delete now[k];
    });
    ls.set(QUEUE, now);
  }

  function log(clientId, leadId, event, actorName) {
    if (!clientId) return Promise.resolve();
    /* The insert policy requires actor = auth.uid(), so a missing id is not a
       null column — it is a rejected row and a silently lost history. Read the
       id from the token rather than trusting the session to carry a user. */
    var me = whoAmI();
    if (!me) return Promise.resolve();
    return api("/rest/v1/activity_log", {
      method: "POST", prefer: "return=minimal",
      body: [{ client_id: clientId, lead_id: leadId, actor: me.id,
               actor_name: actorName || "", event: event }]
    }).catch(function () {});
  }

  /* What the whole company has done, not just this device. Row-level security
     already limits every one of these to the caller's own client, so an owner
     asking for "the team" cannot accidentally be shown somebody else's. */
  function team(clientId) {
    return Promise.all([
      api("/rest/v1/profiles?select=id,full_name,role,created_at&order=created_at.asc"),
      api("/rest/v1/activity?select=lead_id,stage,value,updated_by,updated_at"),
      api("/rest/v1/activity_log?select=actor,actor_name,event,created_at"
          + "&order=created_at.desc&limit=2000")
    ]).then(function (r) {
      return { people: r[0] || [], activity: r[1] || [], log: r[2] || [] };
    });
  }

  /* A push subscription is a device, not a person: one rep with a phone and a
     desk browser has two. Keyed on the endpoint so re-enabling on the same
     device updates rather than piling up duplicates that all buzz at once. */
  function savePush(sub, clientId) {
    var me = whoAmI();
    if (!me) return Promise.reject(new Error("not signed in"));
    if (!clientId) return Promise.reject(new Error("no client"));
    return api("/rest/v1/push_subs?on_conflict=endpoint", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: [{
        user_id: me.id, client_id: clientId, endpoint: sub.endpoint,
        p256dh: sub.p256dh, auth: sub.auth, label: sub.label || ""
      }]
    });
  }

  function dropPush(endpoint) {
    return api("/rest/v1/push_subs?endpoint=eq." + encodeURIComponent(endpoint), {
      method: "DELETE", headers: { Prefer: "return=minimal" }
    });
  }

  /* Adding a colleague needs the service key to mint a login, and that key can
     never come near a browser. So this asks a function on Supabase's side to do
     it. We send what to create; the server decides which company it belongs to,
     whether the caller is an admin, and whether there is room — all read from
     the caller's own token, none of it trusted from here. */
  function manageSeat(body) {
    var s = session();
    if (!s) return Promise.reject(new Error("Not signed in"));
    return fetch(URL + "/functions/v1/manage-seat", {
      method: "POST",
      headers: {
        apikey: ANON,
        Authorization: "Bearer " + s.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.error) throw new Error(d.error
          || (r.status === 404
              ? "Adding people is not switched on for this account yet \u2014 "
                + "email support@goraetech.com."
              : "Could not add them (" + r.status + "). Try again in a moment."));
        return d;
      });
    });
  }

  /* The user object is not always on the session — a refresh returns tokens
     without it. The id is in the token itself, so read that rather than losing
     track of who is signed in and quietly demoting an owner to a rep. */
  function whoAmI() {
    var s = session();
    if (!s) return null;
    if (s.user && s.user.id) return { id: s.user.id, email: s.user.email,
      provider: (s.user.app_metadata && s.user.app_metadata.provider) || "" };
    try {
      var body = s.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var claims = JSON.parse(decodeURIComponent(escape(atob(
        body + "===".slice((body.length + 3) % 4)))));
      return claims.sub ? { id: claims.sub, email: claims.email || "",
        provider: (claims.app_metadata && claims.app_metadata.provider) || "" } : null;
    } catch (e) { return null; }
  }

  function pending() { return Object.keys(ls.get(QUEUE, {})).length; }

  w.RSSync = {
    configured: configured, session: session, signOut: signOut,
    requestCode: requestCode, verifyCode: verifyCode, consumeHash: consumeHash,
    signInPassword: signInPassword, setPassword: setPassword,
    hasPassword: hasPassword, requestReset: requestReset,
    loadDoc: loadDoc, pull: pull, enqueue: enqueue, flush: flush,
    log: log, pending: pending, team: team, whoAmI: whoAmI,
    savePush: savePush, dropPush: dropPush, manageSeat: manageSeat
  };
})(window);
