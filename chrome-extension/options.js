// AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
// Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
const DEFAULTS = { enabled: true, strict: true, restore: true, port: 8080, token: "" };
const $ = (id) => document.getElementById(id);

async function load() {
  const s = Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS)));
  $("port").value = s.port;
  $("token").value = s.token;
  $("strict").checked = s.strict;
  $("restore").checked = s.restore;
}

$("save").addEventListener("click", async () => {
  const port = parseInt($("port").value, 10);
  await chrome.storage.local.set({
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
    token: $("token").value.trim(),
    strict: $("strict").checked,
    restore: $("restore").checked,
  });
  $("saved").hidden = false;
});

load();
