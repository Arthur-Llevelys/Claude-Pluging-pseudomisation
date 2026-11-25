/*
 * AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
 * Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
 */
/*
 * Détection des données identifiantes — portage JavaScript des règles du serveur 1.1.0 (app/detect.py).
 * Même comportement que le serveur : les tests de comparaison (tests/comparer-moteurs.js) le vérifient.
 *
 * Différences d'écriture avec Python, toutes traitées ici :
 *  - \b et \w de JavaScript ne connaissent que l'ASCII : remplacés par des équivalents Unicode (helper rx) ;
 *  - pas de groupes « (?i:…) » portables : les parties insensibles à la casse sont écrites lettre par lettre (ci).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const TYPES = ["PERSONNE", "SOCIETE", "ADRESSE", "DATE_NAISSANCE", "LIEU_NAISSANCE", "SIRET", "SIREN", "TVA", "EMAIL",
  "TELEPHONE", "IBAN", "NIR", "DATE", "AUTRE"];
const TYPES_PAR_DEFAUT = TYPES.filter(t => t !== "DATE");

const P_IMPOSE = 100, P_CONNU = 90, P_IDENTIFIANT = 80, P_DATE_NAISSANCE = 75, P_ADRESSE = 70, P_LIEU_NAISSANCE = 65,
  P_CIVILITE = 60, P_SOCIETE = 55, P_PRENOM_NOM = 50, P_PROPAGATION = 45, P_NER = 40, P_DATE = 30;

function span(start, end, type, priority, source, canonical = null) {
  return { start, end, type, priority, source, value: "", canonical };
}

// ---------------------------------------------------------------------------- outils d'écriture des motifs
const W = "\\p{L}\\p{N}_";
const WB = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;

/** Motif « à la Python » -> RegExp Unicode : \b et \w Unicode, (?P<nom> -> (?<nom>. */
function rx(source, flags = "") {
  let out = "", dansClasse = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const n = source[i + 1];
      if (n === "w") out += dansClasse ? W : `[${W}]`;
      else if (n === "b" && !dansClasse) out += WB;
      else out += c + n;
      i++;
      continue;
    }
    if (c === "[" && !dansClasse) dansClasse = true;
    else if (c === "]" && dansClasse) dansClasse = false;
    out += c;
  }
  out = out.replace(/\(\?P</g, "(?<");
  return new RegExp(out, (flags.includes("u") ? flags : flags + "u"));
}

/** Rend insensible à la casse un morceau de motif (lettres hors séquences d'échappement). */
function ci(source) {
  let out = "", dansClasse = false;
  const lettre = c => !!c && c.toUpperCase() !== c.toLowerCase() && c.toUpperCase().length === 1 && c.toLowerCase().length === 1;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      // ’ : séquence complète recopiée telle quelle
      const n = source[i + 1];
      const long = n === "u" ? 5 : 1;
      out += source.slice(i, i + 1 + long);
      i += long;
      continue;
    }
    if (c === "[" && !dansClasse) { dansClasse = true; out += c; continue; }
    if (c === "]" && dansClasse) { dansClasse = false; out += c; continue; }
    if (dansClasse && lettre(c) && source[i + 1] === "-" && lettre(source[i + 2])) {
      // plage « a-d » : a-dA-D
      const fin = source[i + 2];
      out += `${c.toLowerCase()}-${fin.toLowerCase()}${c.toUpperCase()}-${fin.toUpperCase()}`;
      i += 2;
      continue;
    }
    if (lettre(c)) out += dansClasse ? c.toLowerCase() + c.toUpperCase() : `[${c.toLowerCase()}${c.toUpperCase()}]`;
    else out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------- utilitaires
const UP = "A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ";
const LOW = "a-zàâäçéèêëîïôöùûüÿæœß";

function sansAccents(s) {
  return s.normalize("NFKD").replace(/\p{M}/gu, "");
}
function fold(s) {
  return sansAccents(s).toLowerCase();
}

function normaliser(valeur, type = null) {
  let v = fold(valeur);
  if (["SIRET", "SIREN", "TVA", "IBAN", "NIR", "TELEPHONE", "RCS"].includes(type)) {
    v = v.replace(/[^0-9a-z]/g, "");
    if (type === "TELEPHONE" && v.startsWith("0033")) v = "0" + v.slice(4);
    if (type === "TELEPHONE" && v.startsWith("33") && v.length === 11) v = "0" + v.slice(2);
    return v;
  }
  v = v.replace(/[’`´]/g, "'").replace(/\s+/g, " ");
  return strip(v, " .,;:«»\"'()[]");
}

function strip(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
function rstrip(s, chars) {
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1])) b--;
  return s.slice(0, b);
}

function luhnOk(chiffres) {
  let total = 0;
  [...chiffres].reverse().forEach((ch, i) => {
    let n = parseInt(ch, 10);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    total += n;
  });
  return total % 10 === 0;
}
function siretOk(d) {
  if (d.length !== 14) return false;
  if (d.startsWith("356000000")) return [...d].reduce((a, c) => a + parseInt(c, 10), 0) % 5 === 0;
  return luhnOk(d);
}
function ibanOk(iban) {
  let s = iban.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  s = s.slice(4) + s.slice(0, 4);
  const num = [...s].map(c => parseInt(c, 36).toString()).join("");
  return BigInt(num) % 97n === 1n;
}
function nirOk(nir) {
  const s = nir.replace(/\s/g, "").toUpperCase();
  if (s.length === 13) return true;
  if (s.length !== 15) return false;
  const corps = s.slice(0, 13).replace("2A", "19").replace("2B", "18"), cle = s.slice(13);
  if (!/^\d+$/.test(corps) || !/^\d+$/.test(cle)) return false;
  return 97n - (BigInt(corps) % 97n) === BigInt(cle);
}

function ligneEnMajuscules(texte, pos) {
  const debut = texte.lastIndexOf("\n", pos - 1) + 1;
  let fin = texte.indexOf("\n", pos);
  if (fin === -1) fin = texte.length;
  const lettres = [...texte.slice(debut, fin)].filter(c => /\p{L}/u.test(c));
  if (lettres.length < 12) return false;
  return lettres.filter(c => c === c.toUpperCase() && c !== c.toLowerCase()).length / lettres.length > 0.8;
}
function contexteAvant(texte, pos, n = 45) {
  return fold(texte.slice(Math.max(0, pos - n), pos));
}
function estMajuscules(s) {
  return s === s.toUpperCase() && s !== s.toLowerCase();
}

// ---------------------------------------------------------------------------- listes de mots
const FORMES = "SASU|SAS|SARL|EURL|SA|SNC|SCI|SCP|SCM|SCS|SCA|SELARL|SELAS|SELASU|SELAFA|SELCA|SPFPL|SCEA|EARL|GAEC|GIE|SCOP|SEM|SPL|EIRL|SEL";
const FORMES_SET = new Set(FORMES.split("|"));
const CIVILITES = String.raw`(?:M\.|MM\.|Mme|Mmes|Mlle|Mlles|Monsieur|Messieurs|Madame|Mesdames|Mademoiselle|Me|Maître|Maitre|Dr|Docteur|Pr|Professeur)`;

const MOTS_VIDES = new Set(("le la les l un une des du de d et ou entre par pour avec contre chez dont mais ce cette ces cet en a au aux " +
  "selon suivant attendu considerant vu sur sous dans objet fait monsieur madame mademoiselle maitre me societe ladite ledit lesdites " +
  "lesdits article articles alinea tribunal cour conseil chambre code loi decret arrete ordonnance jugement arret dossier reference ref " +
  "affaire president presidente juge procureur batonnier greffier greffe directeur directrice gerant gerante ministre maire prefet conseiller " +
  "conseillere avocat avocate huissier commissaire notaire expert demandeur demanderesse defendeur defenderesse appelant appelante intime intimee " +
  "partie parties client cliente bailleur preneur vendeur acquereur cedant cessionnaire employeur salarie salariee janvier fevrier mars " +
  "avril mai juin juillet aout septembre octobre novembre decembre lundi mardi mercredi jeudi vendredi samedi dimanche france paris " +
  "republique etat cedex rcs tva siret siren ttc ht eur euros rgpd cnil urssaf annexe page total messieurs cher chere bonjour cordialement " +
  "pj nb ps tel fax mail email courriel adresse siege social capital premier premiere titre chapitre section preambule definitions conditions " +
  "generales particulieres responsable service chef assistant assistante comptable juriste associe associee rh dg pdg daf drh dsi ceo cfo cto " +
  "equipe pole departement region ville commune note memo courrier lettre mise demeure requete assignation conclusions sommation facture devis").split(/\s+/));

const MOTS_INSTITUTIONS = new Set(["tribunal", "cour", "conseil", "chambre", "parquet", "ministere", "republique", "barreau", "ordre", "greffe",
  "prefecture", "mairie", "urssaf", "cpam", "caf", "dgfip", "impots", "tresor", "code", "loi", "decret", "cnil", "inpi", "insee", "assemblee",
  "senat", "gouvernement", "etat", "union", "europeenne", "cjue", "cedh", "juridiction", "cassation", "commission", "autorite", "agence",
  "direction", "bulletin", "journal", "officiel", "rcs", "registre", "bodacc", "legifrance", "prud'hommes", "prudhommes", "prud'homal",
  "commerce", "judiciaire", "administratif", "administrative", "constitutionnel", "police", "gendarmerie", "douane", "douanes",
  "banque de france", "caisse", "sécurité", "securite", "sociale", "pole", "emploi", "travail", "article", "articles", "tva", "ue", "onu", "ocde"]);

const TITRES = new Set(["le", "la", "president", "presidente", "juge", "procureur", "batonnier", "greffier", "directeur", "directrice",
  "conseiller", "conseillere", "ministre", "maire", "prefet", "rapporteur", "commissaire", "avocat", "general", "generale", "premier",
  "premiere", "substitut", "doyen", "professeur", "docteur", "gerant", "gerante"]);

function cleMot(s) {
  let v = fold(s).replace(/’/g, "'");
  v = v.replace(/[-‐‑]+/g, " ");
  return strip(v.replace(/\s+/g, " "), " .,;:«»\"'()[]");
}

function lireListe(chemin, parLigne = false) {
  const out = new Set();
  let contenu;
  try { contenu = fs.readFileSync(chemin, "utf8"); } catch { return out; }
  for (let ligne of contenu.split(/\r?\n/)) {
    ligne = ligne.split("#")[0].trim();
    if (!ligne) continue;
    for (const el of parLigne ? [ligne] : ligne.split(/\s+/)) {
      const c = cleMot(el);
      if (c) out.add(c);
    }
  }
  return out;
}

const DOSSIER_DONNEES = path.join(__dirname, "data");
const MOTS_COURANTS = lireListe(path.join(DOSSIER_DONNEES, "mots_courants.txt"));
const SIGLES = lireListe(path.join(DOSSIER_DONNEES, "sigles.txt"));
const VILLES = lireListe(path.join(DOSSIER_DONNEES, "villes.txt"), true);
const INSTITUTIONS = lireListe(path.join(DOSSIER_DONNEES, "institutions.txt"), true);
const RE_CHIFFRE_ROMAIN = /^[IVXLCDM]{1,7}$/;

const DETERMINANTS = new Set(("le la les l un une des du de d au aux ce cet cette ces son sa ses leur leurs notre votre nos vos mon ma mes " +
  "ton ta tes quel quelle quels quelles chaque tout toute tous toutes aucun aucune selon voir cf par pour sur sous avec sans chez dans en a et ou").split(" "));

const DENOMINATIONS = "Agence|Cabinet|R[ée]gie|Groupe|[ÉE]tablissements|Ets|Garage|Pharmacie|Boulangerie|P[âa]tisserie|" +
  "Boucherie|Restaurant|Brasserie|H[ôo]tel|Clinique|Laboratoires?|[ÉE]tude|Office|Ateliers?|Maison|" +
  "Entreprise|Transports|Imprimerie|Librairie|Institut|Studio|Domaine|Ch[âa]teau|Banque|Assurances|" +
  "Mutuelle|Auto-[ÉEé]cole|Carrosserie|Menuiserie|Plomberie|Holding|Fondation|Comptoir|Galerie|" +
  "R[ée]sidence|Camping|Optique|Compagnie|Cie|St[ée]|Immobili[èe]re|Fonci[èe]re|Syndic";

function estMotBanal(mot, courants = null) {
  const cle = cleMot(mot.replace(/^[dlDL]['’]/, ""));
  const connu = c => MOTS_VIDES.has(c) || MOTS_COURANTS.has(c) || SIGLES.has(c) || DETERMINANTS.has(c) || MOTS_INSTITUTIONS.has(c) ||
    (courants !== null && courants.has(c));
  if (!cle || connu(cle)) return true;
  return cle.length > 3 && "sx".includes(cle[cle.length - 1]) && connu(cle.slice(0, -1));
}
function estVille(valeur, villes = null) {
  const cle = cleMot(valeur);
  return VILLES.has(cle) || (villes !== null && villes.has(cle));
}

const PARTICULES = String.raw`(?:de|du|des|d'|d’|le|la|van|von|der|den|di|da|del|dos|ben|bin|el|al)`;
const RE_PARTICULE = new RegExp(`^${PARTICULES}$`, "i");
const MOIS = String.raw`(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|janv\.?|f[ée]vr?\.?|avr\.?|juil\.?|sept\.?|oct\.?|nov\.?|d[ée]c\.?)`;

// ---------------------------------------------------------------------------- expressions régulières
const SEP = String.raw`[ \u00a0\u202f.\-]?`;
const RE_EMAIL = rx(String.raw`\b[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)*\.[a-zA-Z]{2,}\b`, "g");
const RE_TEL = rx(String.raw`(?<![\d\w])(?:(?:\+|00)33[ \u00a0.\-]?(?:\(0\)[ \u00a0]?)?|0)[1-9](?:[ \u00a0.\-]?\d{2}){4}(?!\d)`, "g");
const RE_IBAN = rx(String.raw`\b[A-Z]{2}\d{2}(?:[ \u00a0]?[A-Z0-9]{4}){2,7}(?:[ \u00a0]?[A-Z0-9]{1,4})?\b`, "g");
const RE_NIR = rx(String.raw`(?<!\d)[12][ \u00a0]?\d{2}[ \u00a0]?(?:0[1-9]|1[0-2]|[2-9]\d)[ \u00a0]?(?:\d{2}|2[ABab])[ \u00a0]?\d{3}[ \u00a0]?\d{3}(?:[ \u00a0]?\d{2})?(?!\d)`, "g");
const RE_TVA = rx(String.raw`\bFR[ \u00a0]?[0-9A-Z]{2}[ \u00a0]?\d{3}[ \u00a0]?\d{3}[ \u00a0]?\d{3}\b`, "g");
const RE_SIRET = rx(String.raw`(?<![\d])\d{3}${SEP}\d{3}${SEP}\d{3}${SEP}\d{5}(?![\d])`, "g");
const RE_SIREN = rx(String.raw`(?<![\d])\d{3}${SEP}\d{3}${SEP}\d{3}(?![\d])`, "g");
const SEPL = String.raw`(?:[ \u00a0\u202f.\-]?(?:\r?\n[ \t\u00a0]*)?)`;
// Toute l'expression peut être insensible à la casse : le reste du motif ne contient que des chiffres et des classes négatives
const RE_RCS = rx(String.raw`(?:\bR\.?[ \u00a0]?C\.?[ \u00a0]?S\.?(?![\w])|\bregistre du commerce(?: et des soci[ée]t[ée]s)?\b|\bsiren\b|\bsiret\b)` +
  String.raw`(?<entre>[^\d\n]{0,70}(?:\r?\n[^\d\n]{0,40})?)` +
  String.raw`(?<num>\d{3}${SEPL}\d{3}${SEPL}\d{3}(?:${SEPL}\d{5})?)(?!\d)`, "gi");

const DATE_PAT = String.raw`(?:\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})|(?:1er|\d{1,2})[ \u00a0]+${MOIS}[ \u00a0]+\d{4}|\d{4}-\d{2}-\d{2})`;
const RE_DATE = rx(String.raw`(?<![\d/])(?:${DATE_PAT})(?![\d/])`, "gi");
const RE_DATE_NAISSANCE = rx(String.raw`(?:\bn[ée]e?s?\b(?:\s?\(e\))?|\bnaissance\b|\bdate de naiss\.?|\bd\.?o\.?b\.?\b|\bborn\b)[^\n\d]{0,35}?(?<d>${DATE_PAT})`, "gi");
const VILLE_PAT = String.raw`[${UP}][\w\-'’]+(?:[ \-](?:sur|sous|en|l[eè]s|les|le|la|de|du|des|aux|[${UP}][\w\-'’]+)(?=[ \-][${UP}]|\b)){0,3}(?:[ \-][${UP}][\w\-'’]+)?`;
const RE_LIEU_NAISSANCE = rx(ci(String.raw`\bn[ée]e?s?\b(?:\s?\(e\))?`) + String.raw`[^\n]{0,45}?\b(?:[àa])[ \u00a0]+(?<lieu>${VILLE_PAT})` +
  String.raw`(?:[ \u00a0]*\((?<dep>\d{2,3}|2[AB])\))?`, "g");

const TYPES_VOIE = String.raw`(?:rue|avenue|av\.|bd|boulevard|place|pl\.|chemin|ch\.|all[ée]e|impasse|imp\.|quai|cours|route|rte|square|sq\.|passage|voie|rond-point|lieu-dit|lieudit|hameau|mont[ée]e|faubourg|fg|cit[ée]|r[ée]sidence|parvis|esplanade|promenade|sentier|chauss[ée]e|traverse|villa|domaine|lotissement|zone|za|zi|zac|parc|port|mail)`;
const MOT_VOIE = String.raw`(?:(?:[lLdD]['’])?[${UP}0-9][${UP}${LOW}0-9'’\-\.]*|de|du|des|la|le|les|aux|au|sur|sous|en)(?![\w'’])`;
const NUM_VOIE = String.raw`\d{1,4}(?:[ \u00a0]?(?:bis|ter|quater|[a-d])\b)?(?:[ \u00a0]?(?:/|-|\u2013|et|\u00e0|au)[ \u00a0]?\d{1,4}(?:[ \u00a0]?(?:bis|ter|quater|[a-d])\b)?)?`;
const QUALIF_VOIE = String.raw`(?:(?:grande?|grand['\u2019]|petite?|vieille|vieux|vieil|nouvelle|nouveau|haute?|basse?|ancienne?)[ \u00a0\-]?)?`;
const RE_ADRESSE = rx(String.raw`(?:(?<![\w/])(?<num>${ci(NUM_VOIE)})[,]?[ \u00a0]+${ci(QUALIF_VOIE)}${ci(TYPES_VOIE)}\.?)` +
  String.raw`(?:[ \u00a0]+${MOT_VOIE}){1,7}` +
  String.raw`(?:[ \u00a0]*,?[ \u00a0]*(?:(?:BP|CS|TSA)[ \u00a0]*\d{2,6}[ \u00a0]*,?[ \u00a0]*)?\d{5}[ \u00a0]+${VILLE_PAT}` +
  String.raw`(?:[ \u00a0]+${ci("cedex")}(?:[ \u00a0]*\d{1,2})?)?)?`, "g");
const RE_CP_VILLE = rx(String.raw`(?<![\d\-/.])\d{5}[ \u00a0]+(?<ville>[${UP}][${UP}${LOW}\-'’]+(?:[ \-][${UP}][${UP}${LOW}\-'’]+){0,3})` +
  String.raw`(?:[ \u00a0]+${ci("cedex")}(?:[ \u00a0]*\d{1,2})?)?`, "g");
const RE_BOITE = rx(String.raw`\b(?:BP|B\.P\.|CS|TSA)[ \u00a0]*\d{2,6}\b`, "g");

const NOM_MOT = String.raw`[${UP}][${UP}${LOW}'’\-]*[${UP}${LOW}]`;
const RE_CIVILITE = rx(String.raw`(?<![\w])${CIVILITES}[ \u00a0]+(?<nom>(?:${NOM_MOT}|[${UP}]\.)(?:[ \u00a0]+(?:${PARTICULES}[ \u00a0]*)?(?:${NOM_MOT})){0,3})`, "g");
const PRENOM = String.raw`[${UP}][${LOW}]+(?:-[${UP}][${LOW}]+)?`;
const NOM_CAPS = String.raw`[${UP}]{2,}(?:[\-'’ ][${UP}]{2,})*`;
const RE_PRENOM_NOM = rx(String.raw`(?<![\w])(?<nom>${PRENOM}(?:[ \u00a0]+${PRENOM})?[ \u00a0]+(?:${PARTICULES}[ \u00a0]+)?${NOM_CAPS})(?![\w])`, "g");
const RE_NOM_PRENOM = rx(String.raw`(?<![\w])(?<nom>${NOM_CAPS}[ \u00a0]+${PRENOM}(?:[ \u00a0]+${PRENOM})?)(?![\w])`, "g");

const MOT_SOC = String.raw`[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ0-9&][\w&'’\.\-]*`;
const LIAISON_SOC = String.raw`(?:&|et|de|du|des|d'|d’|la|le|les|and|of|the)`;
const NOM_SOC = String.raw`${MOT_SOC}(?:[ \u00a0]+(?:${MOT_SOC}|${LIAISON_SOC})){0,5}`;
const RE_SOC_FORME_AVANT = rx(String.raw`(?<![\w])(?:${FORMES})\b\.?[ \u00a0]+(?<nom>${NOM_SOC})`, "g");
const RE_SOC_FORME_APRES = rx(String.raw`(?<![\w])(?<nom>${MOT_SOC}(?:[ \u00a0]+(?:${MOT_SOC}|&)){0,4})[ \u00a0]*,?[ \u00a0]*\(?(?:${FORMES})\)?(?![\w])`, "g");
const RE_SOC_SOCIETE = rx(String.raw`\b[Ss]oci[ée]t[ée][ \u00a0]+(?:(?:d[ée]nomm[ée]e|anonyme|civile(?:[ \u00a0]+immobili[èe]re)?|` +
  String.raw`par actions simplifi[ée]e(?:[ \u00a0]+unipersonnelle)?|[àa] responsabilit[ée] limit[ée]e|` +
  String.raw`en nom collectif|d'exercice lib[ée]ral[\w ]*?)[ \u00a0]+)?(?<nom>${NOM_SOC})`, "g");
const RE_SOC_GUILLEMETS = rx(ci(String.raw`(?:soci[ée]t[ée]|d[ée]nomm[ée]e?|d[ée]nomination(?: sociale)?|enseigne|nom commercial|marque|groupe)`) +
  String.raw`[^«"“\n]{0,30}?[«"“][ \u00a0]*(?<nom>[^»"”\n]{2,60}?)[ \u00a0]*[»"”]`, "g");
const RE_MARQUEUR = /\[[A-Z_]+_\d+\]/g;
const RE_MARQUEUR_SEUL = /^\[[A-Z_]+_\d+\]$/;

const RE_SOC_DENOMINATION = rx(String.raw`(?<![\w])(?<nom>(?:${DENOMINATIONS})(?:[ \u00a0]+(?:(?:&|et|de|du|des|d'|d’|la|le|les)[ \u00a0]*)?[${UP}][\w&'’\.\-]*){1,4})`, "g");
const RE_LIGNE_TABLEAU = rx(String.raw`(?:^|[\t|;])[ \u00a0]*(?<code>[A-Z]{1,3}[ \u00a0]?\d{1,4}[A-Z]?|${ci(String.raw`(?:lot|lots|appt?\.?|appartement|porte|local|n°|no)`)}[ \u00a0]*\d{1,4}[A-Z]?)` +
  String.raw`[ \u00a0\t]+(?:[|;][ \u00a0]*)?(?<nom>(?:${PARTICULES}[ \u00a0]+)?${NOM_MOT}(?:[ \u00a0\-]+(?:${PARTICULES}[ \u00a0]+)?${NOM_MOT}){0,2})` +
  String.raw`[ \u00a0]*(?=$|[\r\t|;]|[ \u00a0]{2,}|\d)`, "gm");

const NOMBRE = String.raw`(?:\d{1,3}(?:[ \u00a0\u202f.]\d{3})+|\d+)`;
const RE_MONTANT = rx(String.raw`(?<![\w,.])${NOMBRE}(?:[,.]\d{1,2})?[ \u00a0\u202f]?(?:€|euros?\b|EUR\b|[kKM]€|francs?\b)(?:[ \u00a0](?:HT|TTC)\b)?` +
  String.raw`|(?<![\w,.])${NOMBRE},\d{2}(?![\d\w])` +
  String.raw`|(?:€|EUR)[ \u00a0]?\d[\d \u00a0\u202f.]*(?:,\d{1,2})?`, "gi");
const RE_REF_JURIDIQUE = rx(
  ci(String.raw`\b(?:articles?|art\.)`) + String.raw`[ \u00a0]+(?:[LRDA]\.?[ \u00a0]?)?\*?\d+(?:[-–.]\d+)*` +
  String.raw`(?:(?:[ \u00a0]+(?:et|à)[ \u00a0]+|,[ \u00a0]*)(?:[LRDA]\.?[ \u00a0]?)?\d+(?:[-–.]\d+)*)*` +
  String.raw`|\b[LRDA]\.[ \u00a0]?\d{1,4}(?:[-–]\d+){0,4}\b` +
  String.raw`|\b[LRD]\d{3,4}(?:-\d+){1,4}\b` +
  String.raw`|` + ci(String.raw`\bn[°o]`) + String.raw`[ \u00a0]?\d{2}-\d{2}[.\u00a0 ]?\d{3}\b` +
  String.raw`|\b\d{2}-\d{2}\.\d{3}\b` +
  String.raw`|\bECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9.]+` +
  String.raw`|\b[1-9E]\d{4}[A-Z]{1,2}\d{4}\b` +
  String.raw`|` + ci(String.raw`\b(?:RG|R\.G\.)`) + String.raw`[ \u00a0]?(?:n[°o][ \u00a0]?)?\d{2}/\d{4,5}\b` +
  String.raw`|` + ci(String.raw`\b(?:loi|d[ée]cret|ordonnance|directive|r[èe]glement|arr[êe]t[ée]|circulaire)`) + String.raw`[ \u00a0]+` +
  String.raw`(?:\((?:UE|CE|CEE)\)[ \u00a0]+)?n[°o][ \u00a0]?\d{2,4}[-/]\d{1,5}\b` +
  String.raw`|\((?:UE|CE|CEE)\)[ \u00a0]+(?:n[°o][ \u00a0]?)?\d{2,4}/\d{1,5}\b`, "g");

const TYPES_IDENTIFIANTS = new Set(["SIRET", "SIREN", "TVA", "EMAIL", "TELEPHONE", "IBAN", "NIR", "DATE", "DATE_NAISSANCE"]);
const BORDURE = " \u00a0\u202f\t–—-:;,|()";

function* chercher(re, texte) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(texte))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    yield m;
  }
}
// Positions d'un groupe nommé (JavaScript ne les donne qu'avec le drapeau « d » : on les recalcule)
function groupe(m, nom) {
  const v = m.groups && m.groups[nom];
  if (v === undefined || v === null) return null;
  return m.indices ? { start: m.indices.groups[nom][0], end: m.indices.groups[nom][1], value: v } : null;
}

function avecIndices(re) {
  return new RegExp(re.source, re.flags.includes("d") ? re.flags : re.flags + "d");
}
// Toutes les expressions à groupes nommés sont recompilées avec les indices de groupes
const RX = {};
for (const [nom, re] of Object.entries({ RE_RCS, RE_DATE_NAISSANCE, RE_LIEU_NAISSANCE, RE_CP_VILLE, RE_CIVILITE, RE_PRENOM_NOM, RE_NOM_PRENOM,
  RE_SOC_FORME_AVANT, RE_SOC_FORME_APRES, RE_SOC_SOCIETE, RE_SOC_GUILLEMETS, RE_SOC_DENOMINATION, RE_LIGNE_TABLEAU, RE_ADRESSE })) {
  RX[nom] = avecIndices(re);
}

// ---------------------------------------------------------------------------- zones protégées
function zonesProtegees(texte) {
  const zones = [];
  for (const m of chercher(RE_MONTANT, texte)) zones.push([m.index, m.index + m[0].length]);
  for (const m of chercher(RE_REF_JURIDIQUE, texte)) zones.push([m.index, m.index + m[0].length]);
  zones.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return zones;
}

function appliquerZones(spans, zones, texte) {
  if (!zones.length) return spans;
  const out = [];
  for (let s of spans) {
    if (s.source === "impose" || TYPES_IDENTIFIANTS.has(s.type)) { out.push(s); continue; }
    let debut = s.start, fin = s.end;
    for (const [a, b] of zones) {
      if (b <= debut || a >= fin) continue;
      if (a <= debut && b >= fin) { fin = debut; break; }
      if (a > debut) fin = Math.min(fin, a);
      else debut = Math.max(debut, b);
    }
    if (debut !== s.start || fin !== s.end) {
      while (fin > debut && BORDURE.includes(texte[fin - 1])) fin--;
      while (debut < fin && BORDURE.includes(texte[debut])) debut++;
      if (fin - debut < 2) continue;
      s = Object.assign({}, s, { start: debut, end: fin });
    }
    out.push(s);
  }
  return out;
}

function fusionnerAdjacents(retenus, texte) {
  const out = [];
  for (const s of retenus) {
    if (out.length) {
      const p = out[out.length - 1];
      const entre = texte.slice(p.end, s.start);
      if (p.type === "SOCIETE" && (s.type === "PERSONNE" || s.type === "SOCIETE") && (entre === " " || entre === "\u00a0") &&
          (p.source === "ner" || s.source === "ner") && p.source !== "impose" && s.source !== "impose") {
        out[out.length - 1] = Object.assign({}, p, { end: s.end, value: texte.slice(p.start, s.end), priority: Math.max(p.priority, s.priority), source: "fusion" });
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------- listes personnalisées
function analyserTerme(ligne) {
  const m = /^\s*([A-Z_]+)\s*[:;]\s*(.+)$/.exec(ligne);
  if (m && TYPES.includes(m[1])) return [m[1], m[2].trim()];
  return ["AUTRE", ligne.trim()];
}

function chargerListes(dossierConf) {
  const l = { jamais: new Set(), toujours: [], courants: new Set(), villes: new Set() };
  if (!dossierConf) return l;
  l.courants = lireListe(path.join(dossierConf, "mots_courants.txt"));
  l.villes = lireListe(path.join(dossierConf, "villes.txt"), true);
  for (const [fichier, ajouter] of [["ne_jamais_masquer.txt", v => l.jamais.add(normaliser(v))], ["toujours_masquer.txt", v => l.toujours.push(analyserTerme(v))]]) {
    let contenu = "";
    try { contenu = fs.readFileSync(path.join(dossierConf, fichier), "utf8"); } catch { continue; }
    for (const brut of contenu.split(/\r?\n/)) {
      const ligne = brut.trim();
      if (ligne && !ligne.startsWith("#")) ajouter(ligne);
    }
  }
  return l;
}

// ---------------------------------------------------------------------------- propositions du modèle de langue
function mots(valeur) {
  return fold(valeur).split(/[\s\-'’.,]+/).filter(Boolean);
}

const RE_PRENOM_AVANT = rx(String.raw`(?<![\w'’])(${PRENOM})[  ]$`);
const RE_TETE_NER = rx(String.raw`^(?:${CIVILITES}[ \u00a0]+|[LlDd]['’]|(?<mot>[\w]+)[ \u00a0]+)`);

function filtrerCandidatsNer(texte, candidats, listes = null) {
  const courants = listes ? listes.courants : null, villes = listes ? listes.villes : null;
  const spans = [];
  for (let [debut, fin, etiquette] of candidats) {
    let val = texte.slice(debut, fin);
    for (;;) {
      const m = RE_TETE_NER.exec(val);
      if (!m || m[0].length >= val.length) break;
      if (m.groups && m.groups.mot !== undefined && !DETERMINANTS.has(cleMot(m.groups.mot))) break;
      debut += m[0].length;
      val = texte.slice(debut, fin);
    }
    const valS = strip(val, " .,;:«»\"'()");
    if (valS.length < 2 || !/\p{Lu}/u.test(valS) || /\d/.test(valS)) continue;
    if (valS.includes("\n")) continue;
    const ms = mots(valS);
    if (!ms.length || ms.every(m => estMotBanal(m, courants))) continue;
    if (estVille(valS, villes) || INSTITUTIONS.has(cleMot(valS))) continue;
    if (RE_CHIFFRE_ROMAIN.test(valS)) continue;
    const finSpan = debut + rstrip(val, " .,;:").length;
    if (etiquette === "PER") {
      if (ms.length === 1 && (MOTS_VIDES.has(ms[0]) || TITRES.has(ms[0]))) continue;
      // Le modèle propose parfois le seul nom de famille : un prénom juste devant (« Jean » Dupont) lui est rattaché
      const avant = RE_PRENOM_AVANT.exec(texte.slice(Math.max(0, debut - 30), debut));
      let d = debut;
      if (avant && !estMotBanal(avant[1], courants) && !estVille(avant[1], villes)) d -= avant[0].length;
      spans.push(span(d, finSpan, "PERSONNE", P_NER, "ner"));
    } else {
      if (ms.some(m => MOTS_INSTITUTIONS.has(m)) || FORMES_SET.has(valS.toUpperCase())) continue;
      if (estMajuscules(valS) && valS.length <= 3) continue;
      spans.push(span(debut, finSpan, "SOCIETE", P_NER, "ner"));
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------- règles
const ARTICLES = new Set(["les", "la", "le", "l'", "l’"]);
const LIAISONS_FIN = new Set(["&", "et", "de", "du", "des", "d'", "la", "le", "les", "and", "of", "the"]);

function nettoyerNomSociete(texte, debut, fin, garderArticle = false) {
  const ms = texte.slice(debut, fin).split(/\s+/).filter(Boolean);
  while (ms.length && LIAISONS_FIN.has(strip(fold(ms[ms.length - 1]), ".,"))) ms.pop();
  while (ms.length && MOTS_VIDES.has(strip(fold(ms[0]), ".,"))) {
    if (garderArticle && ARTICLES.has(fold(ms[0])) && ms.length > 1) break;
    ms.shift();
  }
  if (!ms.length) return null;
  if (!/^(?:[A-Za-z]\.)+$/.test(ms[ms.length - 1])) {
    ms[ms.length - 1] = rstrip(ms[ms.length - 1], ".,;:");
    if (!ms[ms.length - 1]) { ms.pop(); if (!ms.length) return null; }
  }
  const nom = ms.join(" ");
  if (FORMES_SET.has(nom.toUpperCase()) || nom.length < 2) return null;
  if (ms.every(m => { const f = fold(m); return MOTS_VIDES.has(f) || MOTS_INSTITUTIONS.has(f); })) return null;
  const d = texte.indexOf(ms[0], debut);
  const f = texte.lastIndexOf(ms[ms.length - 1], fin - ms[ms.length - 1].length) + ms[ms.length - 1].length;
  if (d < 0 || f <= d) return null;
  return [d, f];
}

function detecterRegles(texte, types, toutesDates, listes = null) {
  const spans = [];
  const courants = listes ? listes.courants : null, villes = listes ? listes.villes : null;
  const ajouter = (d, f, t, p, src) => { if (types.has(t) && f > d) spans.push(span(d, f, t, p, src)); };
  const debutM = m => m.index, finM = m => m.index + m[0].length;

  for (const m of chercher(RE_EMAIL, texte)) ajouter(debutM(m), finM(m), "EMAIL", P_IDENTIFIANT, "regle");
  for (const m of chercher(RE_IBAN, texte)) if (ibanOk(m[0])) ajouter(debutM(m), finM(m), "IBAN", P_IDENTIFIANT + 2, "regle");
  for (const m of chercher(RE_TVA, texte)) ajouter(debutM(m), finM(m), "TVA", P_IDENTIFIANT + 1, "regle");
  for (const m of chercher(RE_NIR, texte)) {
    const ctx = contexteAvant(texte, m.index, 60);
    const indice = ["secu", "nir", "insee", "numero ss", "n° ss", "assure social"].some(k => ctx.includes(k));
    const longueur = m[0].replace(/\s/g, "").length;
    if (indice || (longueur === 15 && nirOk(m[0]))) ajouter(debutM(m), finM(m), "NIR", P_IDENTIFIANT + 1, "regle");
  }
  for (const m of chercher(RE_SIRET, texte)) {
    const chiffres = m[0].replace(/\D/g, "");
    if (siretOk(chiffres) || contexteAvant(texte, m.index).includes("siret")) ajouter(debutM(m), finM(m), "SIRET", P_IDENTIFIANT, "regle");
  }
  const RE_DEVISE = /^\s*(?:€|euros?(?![\p{L}\p{N}_])|eur(?![\p{L}\p{N}_])|k€|m€)/iu;
  for (const m of chercher(RX.RE_RCS, texte)) {
    const num = groupe(m, "num");
    if (RE_DEVISE.test(texte.slice(num.end, num.end + 8))) continue;
    const chiffres = num.value.replace(/\D/g, "");
    ajouter(num.start, num.end, chiffres.length === 14 ? "SIRET" : "SIREN", P_IDENTIFIANT + 1, "regle");
  }
  for (const m of chercher(RE_SIREN, texte)) {
    const chiffres = m[0].replace(/\D/g, "");
    const ctx = contexteAvant(texte, m.index).split(/\d/).pop();
    if (RE_DEVISE.test(texte.slice(finM(m), finM(m) + 8))) continue;
    if (["siren", "rcs", "r.c.s", "immatricul", "identification", "registre"].some(k => ctx.includes(k)) ||
        (luhnOk(chiffres) && /(?:n[°o]\s*|numero\s*)$/.test(ctx))) {
      ajouter(debutM(m), finM(m), "SIREN", P_IDENTIFIANT - 1, "regle");
    }
  }
  for (const m of chercher(RE_TEL, texte)) ajouter(debutM(m), finM(m), "TELEPHONE", P_IDENTIFIANT - 2, "regle");

  for (const m of chercher(RX.RE_DATE_NAISSANCE, texte)) { const g = groupe(m, "d"); ajouter(g.start, g.end, "DATE_NAISSANCE", P_DATE_NAISSANCE, "regle"); }
  for (const m of chercher(RX.RE_LIEU_NAISSANCE, texte)) {
    const lieu = groupe(m, "lieu"), dep = groupe(m, "dep");
    ajouter(lieu.start, dep ? dep.end + 1 : lieu.end, "LIEU_NAISSANCE", P_LIEU_NAISSANCE, "regle");
  }
  if (toutesDates) for (const m of chercher(RE_DATE, texte)) ajouter(debutM(m), finM(m), "DATE", P_DATE, "regle");

  for (const m of chercher(RX.RE_ADRESSE, texte)) {
    let fin = finM(m);
    for (;;) {
      while (fin > m.index && " ,.;".includes(texte[fin - 1])) fin--;
      const queue = /[ \u00a0](?:de|du|des|la|le|les|aux|au|sur|sous|en)$/.exec(texte.slice(m.index, fin));
      if (!queue) break;
      fin = m.index + queue.index;
    }
    ajouter(m.index, fin, "ADRESSE", P_ADRESSE, "regle");
  }
  for (const m of chercher(RX.RE_CP_VILLE, texte)) ajouter(debutM(m), finM(m), "ADRESSE", P_ADRESSE - 1, "regle");
  for (const m of chercher(RE_BOITE, texte)) ajouter(debutM(m), finM(m), "ADRESSE", P_ADRESSE - 1, "regle");

  // Personnes précédées d'une civilité
  for (const m of chercher(RX.RE_CIVILITE, texte)) {
    const g = groupe(m, "nom");
    const ms = mots(g.value);
    if (!ms.length || ms.every(x => TITRES.has(x) || MOTS_VIDES.has(x))) continue;
    const d = g.start;
    let f = g.end;
    const brut = g.value.split(/\s+/).filter(Boolean);
    const garde = [];
    for (const w of brut) {
      if (MOTS_VIDES.has(strip(fold(w), ".,")) && garde.length) break;
      garde.push(w);
    }
    if (garde.length) f = d + garde.join(" ").length;
    if (garde.length && MOTS_VIDES.has(fold(garde[0]))) continue;
    if (garde.length && garde.every(w => new RegExp(`^[${UP}]\\.?$`, "u").test(w))) continue;
    ajouter(d, f, "PERSONNE", P_CIVILITE, "regle");
  }

  // Prénom NOM / NOM Prénom
  for (const [re, bonus] of [[RX.RE_PRENOM_NOM, 0], [RX.RE_NOM_PRENOM, -5]]) {
    for (const m of chercher(re, texte)) {
      if (ligneEnMajuscules(texte, m.index)) continue;
      const g = groupe(m, "nom");
      const ms = g.value.split(/\s+/).filter(Boolean);
      const msN = ms.map(fold);
      if (msN.some(x => MOTS_VIDES.has(x) || MOTS_INSTITUTIONS.has(x) || FORMES_SET.has(x.toUpperCase()))) continue;
      if (ms.some(x => DETERMINANTS.has(cleMot(x)) || SIGLES.has(cleMot(x))) || ms.every(x => estMotBanal(x, courants))) continue;
      ajouter(g.start, g.end, "PERSONNE", P_PRENOM_NOM + bonus, "regle");
    }
  }

  // Sociétés
  for (const nomRe of ["RE_SOC_GUILLEMETS", "RE_SOC_FORME_AVANT", "RE_SOC_FORME_APRES", "RE_SOC_SOCIETE"]) {
    for (const m of chercher(RX[nomRe], texte)) {
      const g = groupe(m, "nom");
      if (nomRe !== "RE_SOC_GUILLEMETS" && ligneEnMajuscules(texte, m.index)) {
        const forme = strip(texte.slice(m.index, g.start), " .");
        if (nomRe !== "RE_SOC_FORME_AVANT" || ["SA", "SEL", "SEM"].includes(forme)) continue;
      }
      const garder = nomRe === "RE_SOC_FORME_AVANT" || nomRe === "RE_SOC_SOCIETE";
      const res = nettoyerNomSociete(texte, g.start, g.end, garder);
      if (res) ajouter(res[0], res[1], "SOCIETE", P_SOCIETE + (nomRe === "RE_SOC_GUILLEMETS" ? 3 : 0), "regle");
    }
  }

  // Dénomination commerciale
  for (const m of chercher(RX.RE_SOC_DENOMINATION, texte)) {
    if (ligneEnMajuscules(texte, m.index)) continue;
    const g = groupe(m, "nom");
    const d = g.start;
    let f = g.end;
    while (f > d && ".,;:".includes(texte[f - 1])) f--;
    const suite = texte.slice(d, f).split(/[ \u00a0]+/).slice(1).filter(w => !["&", "et", "de", "du", "des", "d", "la", "le", "les"].includes(cleMot(w)));
    if (!suite.length || suite.every(w => estMotBanal(w, courants) || estVille(w, villes))) continue;
    if (INSTITUTIONS.has(cleMot(texte.slice(d, f)))) continue;
    ajouter(d, f, "SOCIETE", P_SOCIETE + 1, "regle");
  }

  // Nom isolé dans un tableau
  for (const m of chercher(RX.RE_LIGNE_TABLEAU, texte)) {
    const g = groupe(m, "nom");
    const ms = g.value.split(/[ \u00a0\-]+/).filter(w => w && !RE_PARTICULE.test(w));
    if (!ms.length || ms.some(w => estMotBanal(w, courants) || FORMES_SET.has(w.toUpperCase()))) continue;
    if (estVille(g.value, villes) || ms.some(w => estVille(w, villes))) continue;
    ajouter(g.start, g.end, "PERSONNE", P_NER - 2, "tableau");
  }
  return spans;
}

// ---------------------------------------------------------------------------- termes, propagation, arbitrage
function motifSouple(valeur) {
  const parties = valeur.trim().split(/\s+/).filter(Boolean).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parties.join("[ \\u00a0]+").replace(/['’]/g, "['’]");
}

function rechercherTermes(texte, termes, priorite, source, exigerMajuscule = false) {
  const spans = [];
  for (const [type, valeur] of termes) {
    if (!valeur || valeur.trim().length < 2) continue;
    let re;
    if (["SIRET", "SIREN", "TVA", "IBAN", "NIR", "TELEPHONE"].includes(type)) {
      const chiffres = valeur.replace(/[^0-9A-Za-z]/g, "");
      re = new RegExp(`(?<![0-9A-Za-z])${[...chiffres].join("[ \\u00a0.\\-]?")}(?![0-9A-Za-z])`, "giu");
    } else {
      re = rx(`(?<![\\w])${motifSouple(valeur)}(?![\\w])`, "gi");
    }
    for (const m of chercher(re, texte)) {
      if (exigerMajuscule && !estMajuscules(m[0][0])) continue;
      spans.push(span(m.index, m.index + m[0].length, type, priorite, source, valeur));
    }
  }
  return spans;
}

function variantesNom(valeur, type) {
  const out = [];
  const ms = valeur.trim().split(/[ \u00a0]+/).filter(Boolean);
  if (type === "PERSONNE" && ms.length >= 2) {
    const caps = ms.filter(w => w.length >= 3 && estMajuscules(w));
    if (caps.length) out.push(caps.join(" "));
    const dernier = ms[ms.length - 1];
    if (dernier.length >= 3 && !MOTS_VIDES.has(fold(dernier))) out.push(dernier);
    for (let i = 1; i < ms.length; i++) {
      if (RE_PARTICULE.test(ms[i])) { out.push(ms.slice(i).join(" ")); break; }
    }
  }
  if (type === "SOCIETE") {
    const sansForme = ms.filter(w => !FORMES_SET.has(strip(w.toUpperCase(), "().,")));
    if (sansForme.length > 0 && sansForme.length < ms.length) out.push(sansForme.join(" "));
  }
  const uniques = [];
  for (const v of out) if (v !== valeur && !uniques.includes(v) && !MOTS_VIDES.has(fold(v))) uniques.push(v);
  return uniques;
}

function resoudre(spans, texte, jamais) {
  for (const s of spans) s.value = texte.slice(s.start, s.end);
  const candidats = spans.filter(s => s.value.trim() && !jamais.has(normaliser(s.value)) && !RE_MARQUEUR_SEUL.test(s.value.trim()));
  candidats.sort((a, b) => (b.priority - a.priority) || ((b.end - b.start) - (a.end - a.start)) || (a.start - b.start));
  const occupe = new Uint8Array(texte.length + 1);
  const retenus = [];
  for (const s of candidats) {
    let libre = true;
    for (let i = s.start; i < s.end; i++) if (occupe[i]) { libre = false; break; }
    if (!libre) continue;
    retenus.push(s);
    occupe.fill(1, s.start, s.end);
  }
  retenus.sort((a, b) => a.start - b.start);
  return retenus;
}

module.exports = {
  TYPES, TYPES_PAR_DEFAUT, P_IMPOSE, P_CONNU, P_PROPAGATION, P_NER, RE_MARQUEUR,
  normaliser, estMotBanal, estVille, zonesProtegees, appliquerZones, fusionnerAdjacents, chargerListes, analyserTerme,
  filtrerCandidatsNer, detecterRegles, rechercherTermes, variantesNom, resoudre, ibanOk, nirOk, siretOk, luhnOk, rx, ci,
};
