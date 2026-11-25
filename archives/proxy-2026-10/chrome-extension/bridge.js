// AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
// Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
//
// Script de contenu (monde isolé) : relaie les demandes du script principal (interceptor.js) vers
// le service worker de l'extension, seul autorisé à joindre le proxy local http://127.0.0.1.
(() => {
  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__axiorhub !== "req") return;
    const { id, action, payload } = ev.data;
    let result;
    try {
      result = await chrome.runtime.sendMessage({ action, payload });
      if (result === undefined) result = { ok: false, error: "extension sans réponse (rechargez la page)" };
    } catch (e) {
      result = { ok: false, error: String((e && e.message) || e) };
    }
    window.postMessage({ __axiorhub: "res", id, result }, window.location.origin);
  });
})();
