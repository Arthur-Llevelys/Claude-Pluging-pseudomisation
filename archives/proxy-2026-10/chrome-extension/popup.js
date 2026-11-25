// AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
// Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
const $ = (id) => document.getElementById(id);

function send(action, payload) {
  return chrome.runtime.sendMessage({ action, payload: payload || {} });
}

function setDot(state) {
  const dot = $("dot");
  dot.className = "dot " + state;
}

async function refreshStatus() {
  const res = await send("status");
  $("enabled").checked = Boolean(res.settings && res.settings.enabled);
  if (!res.settings.enabled) {
    setDot("warn");
    $("statusText").textContent = "Pseudonymisation désactivée : vos messages partent en clair vers claude.ai.";
    $("statusDetail").textContent = "";
    return;
  }
  if (!res.ok) {
    setDot("err");
    $("statusText").textContent = `Proxy local injoignable sur 127.0.0.1:${res.settings.port}.`;
    $("statusDetail").textContent = res.settings.strict
      ? "Mode strict : les messages ne seront PAS envoyés tant que le proxy est arrêté. Lancez : python -m pseudo_proxy start"
      : "Mode strict désactivé : les messages partiront EN CLAIR. Lancez : python -m pseudo_proxy start";
    return;
  }
  const h = res.health;
  setDot("ok");
  $("statusText").textContent = `Proxy actif (v${h.version}) · ${h.mappings_alive} correspondance(s) en mémoire.`;
  $("statusDetail").textContent =
    (res.settings.restore ? "Restitution des valeurs dans les réponses activée." : "Restitution désactivée : les réponses affichent les marqueurs.") +
    (res.settings.strict ? " Mode strict." : "");
  await refreshStats();
}

async function refreshStats() {
  const res = await send("stats");
  const tbody = $("statsTable").querySelector("tbody");
  tbody.innerHTML = "";
  if (!res.ok) return;
  const rep = res.stats.replacements || {};
  const alive = res.stats.alive_by_category || {};
  const cats = Object.keys(rep).sort();
  $("statsEmpty").hidden = cats.length > 0;
  for (const c of cats) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = c;
    const td2 = document.createElement("td");
    td2.textContent = `${rep[c]} remplacement(s) · ${alive[c] || 0} en mémoire`;
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
  if (res.stats.restorations) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = "Restitutions";
    const td2 = document.createElement("td");
    td2.textContent = String(res.stats.restorations);
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
}

$("enabled").addEventListener("change", async (ev) => {
  await send("setEnabled", { enabled: ev.target.checked });
  await refreshStatus();
});

$("previewBtn").addEventListener("click", async () => {
  const text = $("previewIn").value;
  const out = $("previewOut");
  out.hidden = false;
  if (!text.trim()) {
    out.textContent = "(collez un texte)";
    return;
  }
  const res = await send("preview", { text });
  if (!res.ok) {
    out.textContent = "Proxy injoignable : " + res.error;
    return;
  }
  const stats = Object.entries(res.stats || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "aucune donnée détectée";
  out.textContent = res.text + "\n\n— catégories : " + stats;
  await refreshStats();
});

$("selftestBtn").addEventListener("click", async () => {
  const line = $("selftestLine");
  line.hidden = false;
  line.className = "selftest";
  line.textContent = "Autotest en cours…";
  const res = await send("selftest");
  if (!res.ok) {
    line.className = "selftest warn";
    line.textContent = "Autotest impossible : proxy injoignable.";
    return;
  }
  const r = res.result;
  line.textContent = r.line;
  line.className = "selftest " + (r.ok ? "ok" : "warn");
  if (!r.ok) {
    line.textContent += " — ne transmettez rien à une IA externe et prévenez l'auteur de l'outil.";
    line.title = (r.failures || []).join("\n");
  }
});

$("optionsLink").addEventListener("click", (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

refreshStatus();
