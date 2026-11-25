/*
 * AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
 * Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
 */
/*
 * Prototype — reconnaissance des noms de personnes et d'organisations par un petit modèle de langue local (Ollama).
 * Destiné à remplacer spaCy dans une version autonome de l'extension (sans serveur Python).
 *
 * Garde-fous :
 *  - seule une adresse locale ou du réseau privé est acceptée (127.0.0.1, ::1, localhost, 10.x, 172.16-31.x, 192.168.x) ;
 *  - les modèles « cloud » d'Ollama (qui envoient le texte à l'extérieur) sont refusés ;
 *  - un nom proposé par le modèle n'est retenu que s'il figure mot pour mot dans le texte (pas d'invention).
 */
"use strict";

const SCHEMA = {
  type: "object",
  properties: {
    personnes: { type: "array", items: { type: "string" } },
    organisations: { type: "array", items: { type: "string" } },
  },
  required: ["personnes", "organisations"],
};

const CONSIGNE =
  "Tu repères les noms propres dans un texte juridique français. Réponds uniquement en JSON.\n" +
  "- personnes : noms de personnes physiques (prénom et/ou nom de famille), recopiés exactement comme dans le texte, sans civilité (M., Mme, Maître, Me, Dr).\n" +
  "- organisations : noms de sociétés, entreprises, associations, cabinets, agences privées, recopiés exactement comme dans le texte, sans la forme juridique (SAS, SARL…).\n" +
  "N'inclus jamais : villes, pays, régions, rues, juridictions (tribunal, cour…), administrations et institutions publiques, lois, codes, articles, dates, mois, montants, fonctions (président, gérant…), mots courants (Objet, Montant, Créance, Madame…).\n" +
  "Si aucun nom n'est présent, renvoie des listes vides.";

function adresseAutorisee(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const h = u.hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

function modeleAutorise(modele) {
  return !!modele && !/(^|[:\-])cloud\b/i.test(modele);
}

/** Découpe le texte en morceaux d'environ `taille` caractères, sur des fins de paragraphe ou de ligne. */
function morceaux(texte, taille = 1500) {
  const out = [];
  let pos = 0;
  while (pos < texte.length) {
    let fin = Math.min(texte.length, pos + taille);
    if (fin < texte.length) {
      const coupe = Math.max(texte.lastIndexOf("\n", fin), texte.lastIndexOf(". ", fin));
      if (coupe > pos + taille / 3) fin = coupe + 1;
    }
    out.push({ debut: pos, texte: texte.slice(pos, fin) });
    pos = fin;
  }
  return out;
}

function echapper(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Toutes les occurrences, mot entier, d'un nom proposé (espaces souples). */
function occurrences(texte, nom) {
  const motif = nom.trim().split(/\s+/).map(echapper).join("[\\s\\u00a0]+");
  if (!motif) return [];
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])${motif}(?![\\p{L}\\p{N}])`, "gu");
  const out = [];
  let m;
  while ((m = rx.exec(texte))) out.push([m.index, m.index + m[0].length]);
  return out;
}

async function appeler(url, modele, texte, delaiMs) {
  const rep = await fetch(url.replace(/\/+$/, "") + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(delaiMs),
    body: JSON.stringify({
      model: modele,
      stream: false,
      think: false,
      format: SCHEMA,
      keep_alive: "10m",
      options: { temperature: 0, num_ctx: 4096, seed: 1 },
      messages: [{ role: "system", content: CONSIGNE }, { role: "user", content: texte }],
    }),
  });
  if (!rep.ok) throw new Error(`Ollama a répondu ${rep.status} : ${(await rep.text()).slice(0, 200)}`);
  const corps = await rep.json();
  try { return JSON.parse(corps.message.content); } catch { return { personnes: [], organisations: [] }; }
}

/**
 * Propositions du modèle : [[début, fin, "PER"|"ORG"], …] (même forme que les propositions de spaCy).
 * Retourne aussi des statistiques : noms proposés, noms écartés car absents du texte, durée.
 */
async function candidatsOllama(texte, { url = "http://127.0.0.1:11434", modele, delaiMs = 120000 } = {}) {
  if (!adresseAutorisee(url)) throw new Error("Adresse Ollama refusée : seules les adresses locales ou du réseau privé sont acceptées.");
  if (!modeleAutorise(modele)) throw new Error("Modèle refusé : les modèles « cloud » envoient le texte hors du poste.");
  const debut = Date.now();
  const candidats = [], stats = { proposes: 0, inventes: 0, duree_ms: 0 };
  for (const m of morceaux(texte)) {
    if (!m.texte.trim()) continue;
    const r = await appeler(url, modele, m.texte, delaiMs);
    for (const [cle, etiquette] of [["personnes", "PER"], ["organisations", "ORG"]]) {
      for (const nom of new Set((Array.isArray(r[cle]) ? r[cle] : []).filter(x => typeof x === "string" && x.trim().length >= 2))) {
        stats.proposes++;
        const occ = occurrences(m.texte, nom);
        if (!occ.length) { stats.inventes++; continue; }
        for (const [a, b] of occ) candidats.push([m.debut + a, m.debut + b, etiquette]);
      }
    }
  }
  stats.duree_ms = Date.now() - debut;
  return { candidats, stats };
}

module.exports = { candidatsOllama, adresseAutorisee, modeleAutorise, occurrences, morceaux, CONSIGNE };
