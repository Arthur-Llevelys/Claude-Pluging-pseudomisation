// AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
// Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
//
// Script injecté dans le monde principal de claude.ai (world: MAIN).
// Il enveloppe window.fetch :
//  - avant l'envoi d'un message (…/chat_conversations/<id>/completion), le texte saisi et les
//    pièces collées sont pseudonymisés par le proxy local (via bridge.js -> service worker) ;
//  - la réponse en flux (SSE) est restituée à la volée, en retenant les marqueurs coupés ;
//  - le chargement d'une conversation (GET …/chat_conversations/<id>) est restitué pour que
//    l'historique s'affiche avec les vraies valeurs tant que la table est en mémoire.
// En mode strict, si le proxy est injoignable, le message n'est PAS envoyé.
(() => {
  if (window.__axiorhubPseudoInstalled) return;
  window.__axiorhubPseudoInstalled = true;

  const LABELS = new Set([
    "PERSONNE", "SOCIETE", "EMAIL", "TEL", "ADRESSE", "NIR", "IBAN", "CB", "SIREN", "SIRET",
    "DATE_NAISSANCE", "ID_CLIENT", "URL", "UTILISATEUR", "IP", "RG", "PORTALIS", "RPPS", "SINISTRE", "IMMATRICULATION",
  ]);
  const MARKER_RE = /\[\s*([A-Z][A-Z_\\]{1,30}?)\\?[ _\-](\d{1,6})\s*\]/g;
  const PREFIX_RE = /\[\s*(?:[A-Z][A-Z_\\]{0,30}(?:\\?[ _\-]\d{0,6}\s*)?)?$/;
  const MAX_PENDING = 48;
  const COMPLETION_RE = /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/(completion|retry_completion)(\?|$)/;
  const CONVERSATION_RE = /\/api\/organizations\/[^/]+\/chat_conversations\/[0-9a-zA-Z-]{16,}(\?|$)/;

  // ------------------------------------------------------------------ pont vers l'extension
  const pending = new Map();
  let seq = 0;
  function bridge(action, payload, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, error: "délai dépassé" });
        }
      }, timeoutMs);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      window.postMessage({ __axiorhub: "req", id, action, payload }, window.location.origin);
    });
  }
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__axiorhub !== "res") return;
    const cb = pending.get(ev.data.id);
    if (cb) {
      pending.delete(ev.data.id);
      cb(ev.data.result);
    }
  });

  // ------------------------------------------------------------------ restitution
  const mapping = new Map(); // "[PERSONNE_1]" -> valeur réelle
  let mappingLoadedAt = 0;

  function mergeMapping(obj) {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) mapping.set(k, v);
  }
  async function refreshMapping(force = false) {
    if (!force && Date.now() - mappingLoadedAt < 3000) return;
    const res = await bridge("mapping", {});
    if (res && res.ok) {
      mergeMapping(res.mapping);
      mappingLoadedAt = Date.now();
    }
  }
  function restoreText(text) {
    if (!text || text.indexOf("[") < 0) return text;
    return text.replace(MARKER_RE, (whole, rawLabel, num) => {
      const label = rawLabel.replace(/\\/g, "");
      if (!LABELS.has(label)) return whole;
      const value = mapping.get(`[${label}_${parseInt(num, 10)}]`);
      return value === undefined ? whole : value;
    });
  }
  class StreamRestorer {
    constructor() {
      this.pending = "";
    }
    feed(chunk) {
      let buf = this.pending + chunk;
      this.pending = "";
      const idx = buf.lastIndexOf("[");
      if (idx >= 0) {
        const tail = buf.slice(idx);
        MARKER_RE.lastIndex = 0;
        const full = new RegExp("^" + MARKER_RE.source + "$").test(tail);
        if (!full && PREFIX_RE.test(tail) && tail.length <= MAX_PENDING) {
          this.pending = tail;
          buf = buf.slice(0, idx);
        }
      }
      return restoreText(buf);
    }
    flush() {
      const buf = this.pending;
      this.pending = "";
      return restoreText(buf);
    }
  }
  function deepRestore(node) {
    if (typeof node === "string") return restoreText(node);
    if (Array.isArray(node)) return node.map(deepRestore);
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) node[k] = deepRestore(node[k]);
    }
    return node;
  }

  // ------------------------------------------------------------------ bandeau d'information
  function banner(message, level) {
    try {
      let el = document.getElementById("axiorhub-pseudo-banner");
      if (!el) {
        el = document.createElement("div");
        el.id = "axiorhub-pseudo-banner";
        el.style.cssText =
          "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:720px;" +
          "padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.25);" +
          "color:#fff;cursor:pointer";
        el.addEventListener("click", () => el.remove());
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.background = level === "error" ? "#b3261e" : level === "warn" ? "#b26a00" : "#1b5e20";
      el.textContent = "AxiorHub Pseudonymisation : " + message;
      clearTimeout(el.__timer);
      el.__timer = setTimeout(() => el.remove(), level === "error" ? 15000 : 6000);
    } catch (e) {
      /* la page n'est peut-être pas prête */
    }
  }

  // ------------------------------------------------------------------ enveloppes de réponse
  function copyHeaders(headers) {
    const h = new Headers(headers);
    h.delete("content-length");
    h.delete("content-encoding");
    return h;
  }

  function wrapSSE(response, mode) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const restorers = new Map(); // index -> StreamRestorer
    let buffer = "";
    let lastFormat = null; // "completion" | "delta"
    let lastIndex = 0;

    function processEvent(raw) {
      const lines = raw.replace(/\r\n/g, "\n").split("\n");
      const dataLines = [];
      const others = [];
      for (const line of lines) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        else if (line.trim()) others.push(line);
      }
      if (!dataLines.length) return raw;
      let obj;
      try {
        obj = JSON.parse(dataLines.join("\n"));
      } catch (e) {
        return raw;
      }
      if (!obj || typeof obj !== "object") return raw;
      let changed = false;
      if (typeof obj.completion === "string") {
        lastFormat = "completion";
        const r = restorers.get("c") || restorers.set("c", new StreamRestorer()).get("c");
        obj.completion = r.feed(obj.completion);
        changed = true;
      } else if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.text === "string") {
        lastFormat = "delta";
        lastIndex = obj.index || 0;
        const key = "d" + lastIndex;
        const r = restorers.get(key) || restorers.set(key, new StreamRestorer()).get(key);
        obj.delta.text = r.feed(obj.delta.text);
        changed = true;
      } else if (obj.type === "content_block_stop") {
        const key = "d" + (obj.index || 0);
        const r = restorers.get(key);
        if (r) {
          restorers.delete(key);
          const tail = r.flush();
          if (tail) return synthetic(tail, "delta", obj.index || 0) + raw;
        }
        return raw;
      }
      if (!changed) return raw;
      const head = others.length ? others.join("\n") + "\n" : "";
      return head + "data: " + JSON.stringify(obj) + "\n\n";
    }
    function synthetic(text, format, index) {
      if (format === "completion") {
        return "event: completion\ndata: " + JSON.stringify({ type: "completion", completion: text }) + "\n\n";
      }
      return (
        "event: content_block_delta\ndata: " +
        JSON.stringify({ type: "content_block_delta", index: index || 0, delta: { type: "text_delta", text } }) +
        "\n\n"
      );
    }
    const ts = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, idx + 2);
          buffer = buffer.slice(idx + 2);
          controller.enqueue(encoder.encode(processEvent(event)));
        }
      },
      flush(controller) {
        if (buffer.trim()) controller.enqueue(encoder.encode(processEvent(buffer)));
        for (const [key, r] of restorers) {
          const tail = r.flush();
          if (tail) controller.enqueue(encoder.encode(synthetic(tail, key === "c" ? "completion" : "delta", lastIndex)));
        }
        restorers.clear();
      },
    });
    return new Response(response.body.pipeThrough(ts), {
      status: response.status,
      statusText: response.statusText,
      headers: copyHeaders(response.headers),
    });
  }

  async function wrapJSON(response) {
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return new Response(text, { status: response.status, statusText: response.statusText, headers: copyHeaders(response.headers) });
    }
    if (text.indexOf("[") >= 0) {
      await refreshMapping();
      deepRestore(data);
    }
    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers: copyHeaders(response.headers),
    });
  }

  // ------------------------------------------------------------------ pseudonymisation du corps
  async function pseudonymizeBody(bodyText) {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      return { bodyText, status: "skip" };
    }
    const targets = [];
    if (typeof body.prompt === "string" && body.prompt.trim()) targets.push([body, "prompt"]);
    if (Array.isArray(body.attachments)) {
      for (const att of body.attachments) {
        if (att && typeof att.extracted_content === "string" && att.extracted_content.trim()) targets.push([att, "extracted_content"]);
      }
    }
    if (!targets.length) return { bodyText, status: "skip" };
    let total = 0;
    for (const [obj, key] of targets) {
      const res = await bridge("pseudonymize", { text: obj[key] });
      if (!res || !res.ok) return { bodyText, status: res && res.strict === false ? "unprotected" : "blocked", error: res && res.error };
      if (res.disabled) return { bodyText, status: "disabled" };
      obj[key] = res.text;
      mergeMapping(res.mapping);
      for (const n of Object.values(res.stats || {})) total += n;
    }
    return { bodyText: JSON.stringify(body), status: "ok", replacements: total };
  }

  function errorResponse(message) {
    return new Response(JSON.stringify({ type: "error", error: { type: "axiorhub_proxy_unreachable", message } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  // ------------------------------------------------------------------ fetch enveloppé
  const originalFetch = window.fetch;
  window.fetch = async function axiorhubFetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

      if (method === "POST" && COMPLETION_RE.test(url)) {
        let bodyText = null;
        if (init && typeof init.body === "string") bodyText = init.body;
        else if (input instanceof Request && !(init && init.body)) bodyText = await input.clone().text();
        if (bodyText !== null) {
          const result = await pseudonymizeBody(bodyText);
          if (result.status === "blocked") {
            banner("proxy local injoignable, message NON envoyé (mode strict). Démarrez le proxy : python -m pseudo_proxy start", "error");
            return errorResponse("AxiorHub : proxy de pseudonymisation injoignable, message non envoyé.");
          }
          if (result.status === "unprotected") banner("proxy injoignable, message envoyé EN CLAIR (mode strict désactivé)", "warn");
          if (result.status === "ok") {
            if (result.replacements > 0) banner(result.replacements + " donnée(s) pseudonymisée(s) avant envoi", "ok");
            if (input instanceof Request && !(init && init.body)) {
              input = new Request(input, { body: result.bodyText, method: "POST" });
            } else {
              init = Object.assign({}, init, { body: result.bodyText });
            }
          }
        }
        const response = await originalFetch.call(this, input, init);
        const ctype = (response.headers.get("content-type") || "").toLowerCase();
        if (response.ok && response.body && ctype.indexOf("text/event-stream") >= 0) {
          await refreshMapping();
          return wrapSSE(response);
        }
        return response;
      }

      if (method === "GET" && CONVERSATION_RE.test(url)) {
        const response = await originalFetch.call(this, input, init);
        const ctype = (response.headers.get("content-type") || "").toLowerCase();
        if (response.ok && ctype.indexOf("application/json") >= 0) return await wrapJSON(response);
        return response;
      }
    } catch (e) {
      console.warn("[AxiorHub Pseudonymisation] interception impossible :", e);
    }
    return originalFetch.call(this, input, init);
  };

  console.info("[AxiorHub Pseudonymisation Claude] interception active sur claude.ai (Timo RAINIO Avocat, AGPL-3.0).");
})();
