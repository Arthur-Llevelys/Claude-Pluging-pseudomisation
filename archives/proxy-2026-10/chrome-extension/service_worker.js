// AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
// Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
//
// Service worker : seul point de contact avec le proxy local (http://127.0.0.1:<port>).
// Rien n'est envoyé ailleurs. Les réglages sont dans chrome.storage.local.

const DEFAULTS = { enabled: true, strict: true, restore: true, port: 8080, token: "" };

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return Object.assign({}, DEFAULTS, stored);
}

async function api(path, options = {}) {
  const s = await getSettings();
  const headers = { "content-type": "application/json" };
  if (s.token) headers["x-axiorhub-token"] = s.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}${path}`, Object.assign({}, options, { headers, signal: controller.signal }));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function handle(msg) {
  const s = await getSettings();
  const payload = msg.payload || {};
  switch (msg.action) {
    case "config":
      return { ok: true, enabled: s.enabled, strict: s.strict, restore: s.restore, port: s.port, tokenSet: Boolean(s.token) };

    case "pseudonymize": {
      if (!s.enabled) return { ok: true, disabled: true, text: payload.text, mapping: {}, stats: {} };
      try {
        const r = await api("/api/pseudonymize", { method: "POST", body: JSON.stringify({ text: payload.text, include_mapping: s.restore }) });
        return { ok: true, text: r.text, mapping: s.restore ? r.mapping || {} : {}, stats: r.stats || {} };
      } catch (e) {
        return { ok: false, unreachable: true, strict: s.strict, error: String((e && e.message) || e) };
      }
    }

    case "mapping": {
      if (!s.enabled || !s.restore) return { ok: true, mapping: {} };
      try {
        const r = await api("/api/mapping");
        return { ok: true, mapping: r.mapping || {} };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case "status": {
      try {
        const health = await api("/health");
        return { ok: true, health, settings: { enabled: s.enabled, strict: s.strict, restore: s.restore, port: s.port } };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), settings: { enabled: s.enabled, strict: s.strict, restore: s.restore, port: s.port } };
      }
    }

    case "stats": {
      try {
        return { ok: true, stats: await api("/api/stats") };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case "selftest": {
      try {
        return { ok: true, result: await api("/api/selftest") };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case "preview": {
      try {
        const r = await api("/api/pseudonymize", { method: "POST", body: JSON.stringify({ text: payload.text, include_mapping: false }) });
        return { ok: true, text: r.text, stats: r.stats || {} };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case "setEnabled": {
      await chrome.storage.local.set({ enabled: Boolean(payload.enabled) });
      return { ok: true };
    }

    default:
      return { ok: false, error: "action inconnue : " + msg.action };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // réponse asynchrone
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await chrome.storage.local.set(s);
});
