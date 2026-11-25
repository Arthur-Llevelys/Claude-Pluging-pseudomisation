/*
 * AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
 * Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
 */
/*
 * Lecture du texte des documents et production d'un docx, sans serveur ni dépendance (moteur local).
 * Formats lus : txt, md, csv, docx, odt, html, eml, rtf, pdf (extraction simplifiée : texte des pages,
 * sans mise en page ; les PDF scannés, sans texte, ne donnent rien — l'OCR viendra plus tard).
 */
"use strict";
const zlib = require("zlib");

function creerFichiers({ lireZip, contenuEntree, ecrireZip, creerEntree }) {
  const decoderXml = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (t, c) =>
    c === "lt" ? "<" : c === "gt" ? ">" : c === "amp" ? "&" : c === "quot" ? '"' : c === "apos" ? "'"
      : String.fromCodePoint(c[1] === "x" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10)));

  function decoderTexte(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
    const utf8 = buf.toString("utf8");
    return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf8;
  }

  // ------------------------------------------------------------------ Word
  function texteWord(xml) {
    let out = "", profondeurCellule = 0;
    const re = /<(\/?)(w:t|w:tab|w:br|w:cr|w:p|w:tc|w:tr)(?=[\s>/])([^>]*)>([^<]*)/g;
    let m;
    while ((m = re.exec(xml))) {
      const [, ferme, balise, attrs, suite] = m;
      const auto = attrs.endsWith("/");
      if (balise === "w:t" && !ferme) out += decoderXml(suite);
      else if ((balise === "w:tab") && !ferme) out += "\t";
      else if ((balise === "w:br" || balise === "w:cr") && !ferme) out += "\n";
      else if (balise === "w:p" && ferme) out += profondeurCellule ? " " : "\n";
      else if (balise === "w:p" && auto) out += profondeurCellule ? "" : "\n";
      else if (balise === "w:tc" && !ferme && !auto) profondeurCellule++;
      else if (balise === "w:tc" && ferme) { profondeurCellule = Math.max(0, profondeurCellule - 1); out = out.replace(/[ ]+$/, "") + " | "; }
      else if (balise === "w:tr" && ferme) out = out.replace(/ \| $/, "") + "\n";
    }
    return out;
  }

  function docx(buf) {
    const entrees = lireZip(buf);
    const partie = nom => { const e = entrees.find(x => x.nom === nom); return e ? contenuEntree(e).toString("utf8") : ""; };
    const parties = [texteWord(partie("word/document.xml"))];
    for (const e of entrees.filter(x => /^word\/(header|footer)\d*\.xml$/.test(x.nom))) {
      const t = texteWord(contenuEntree(e).toString("utf8")).trim();
      if (t) parties.push(t);
    }
    const notes = texteWord(partie("word/footnotes.xml")).trim();
    if (notes) parties.push("[Notes de bas de page]\n" + notes);
    return parties.join("\n");
  }

  function odt(buf) {
    const e = lireZip(buf).find(x => x.nom === "content.xml");
    if (!e) return "";
    const xml = contenuEntree(e).toString("utf8")
      .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (t, n) => " ".repeat(parseInt(n || "1", 10)))
      .replace(/<text:tab\s*\/>/g, "\t").replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<\/text:(p|h)>/g, "\n").replace(/<\/table:table-cell>/g, " | ").replace(/<\/table:table-row>/g, "\n");
    return decoderXml(xml.replace(/<[^>]+>/g, ""));
  }

  // ------------------------------------------------------------------ HTML, RTF, courriel
  function html(t) {
    return decoderXml(t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n").replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function rtf(t) {
    let out = "", profondeurIgnoree = 0, profondeur = 0;
    const pile = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "{") { pile.push(profondeurIgnoree); profondeur++; if (t.startsWith("{\\*", i) || /^\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer)/.test(t.slice(i, i + 12))) profondeurIgnoree = profondeur; continue; }
      if (c === "}") { profondeur--; profondeurIgnoree = pile.pop() || 0; if (profondeurIgnoree > profondeur) profondeurIgnoree = 0; continue; }
      if (c === "\\") {
        const m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(t.slice(i, i + 40));
        if (!m) continue;
        i += m[0].length - 1;
        if (profondeurIgnoree) continue;
        if (m[3]) out += Buffer.from([parseInt(m[3], 16)]).toString("latin1");
        else if (m[4]) out += "\\{}".includes(m[4]) ? m[4] : m[4] === "~" ? " " : "";
        else if (m[1] === "par" || m[1] === "line") out += "\n";
        else if (m[1] === "tab") out += "\t";
        else if (m[1] === "cell") out += " | ";
        else if (m[1] === "row") out += "\n";
        else if (m[1] === "u" && m[2]) { let n = parseInt(m[2], 10); if (n < 0) n += 65536; out += String.fromCharCode(n); if (t[i + 1] === "?") i++; }
        continue;
      }
      if (profondeurIgnoree || c === "\r" || c === "\n") continue;
      out += c;
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  function decoderMime(corps, encodage, charset) {
    let buf;
    if (/base64/i.test(encodage)) buf = Buffer.from(corps.replace(/\s+/g, ""), "base64");
    else if (/quoted-printable/i.test(encodage)) {
      const s = corps.replace(/=\r?\n/g, "");
      const octets = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) { octets.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
        else octets.push(...Buffer.from(s[i], "latin1"));
      }
      buf = Buffer.from(octets);
    } else buf = Buffer.from(corps, "latin1");
    try { return new TextDecoder(charset || "utf-8").decode(buf); } catch { return buf.toString("utf8"); }
  }

  function decoderEntete(v) {
    return v.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (t, cs, enc, txt) =>
      decoderMime(enc.toUpperCase() === "B" ? txt : txt.replace(/_/g, " "), enc.toUpperCase() === "B" ? "base64" : "quoted-printable", cs));
  }

  function partieMime(brut) {
    const sep = brut.search(/\r?\n\r?\n/);
    const entete = (sep < 0 ? brut : brut.slice(0, sep)).replace(/\r?\n[ \t]+/g, " ");
    const corps = sep < 0 ? "" : brut.slice(sep).replace(/^\r?\n\r?\n/, "");
    const champ = n => { const m = new RegExp(`^${n}:\\s*(.*)$`, "im").exec(entete); return m ? m[1].trim() : ""; };
    return { champ, corps };
  }

  function texteMime(brut) {
    const { champ, corps } = partieMime(brut);
    const type = champ("Content-Type") || "text/plain";
    const frontiere = /boundary="?([^";]+)"?/i.exec(type);
    if (/^multipart\//i.test(type) && frontiere) {
      const parties = corps.split("--" + frontiere[1]).slice(1).filter(p => !p.startsWith("--"));
      const textes = parties.map(p => ({ type: (partieMime(p).champ("Content-Type") || "text/plain").toLowerCase(), brut: p }));
      const choix = /^multipart\/alternative/i.test(type)
        ? [textes.find(x => x.type.startsWith("text/plain")) || textes.find(x => x.type.startsWith("text/html")) || textes.find(x => x.type.startsWith("multipart/"))].filter(Boolean)
        : textes.filter(x => /^(text\/|multipart\/)/.test(x.type) && !/attachment/i.test(partieMime(x.brut).champ("Content-Disposition")));
      return choix.map(x => texteMime(x.brut)).filter(Boolean).join("\n\n");
    }
    if (!/^text\//i.test(type)) return "";
    const charset = (/charset="?([^";\s]+)"?/i.exec(type) || [])[1];
    const t = decoderMime(corps, champ("Content-Transfer-Encoding"), charset);
    return /^text\/html/i.test(type) ? html(t) : t;
  }

  function eml(buf) {
    const brut = buf.toString("latin1");
    const { champ } = partieMime(brut);
    const entetes = ["From", "To", "Cc", "Date", "Subject"].map(n => champ(n) ? `${n}: ${decoderEntete(champ(n))}` : null).filter(Boolean).join("\n");
    return entetes + "\n\n" + texteMime(brut).trim();
  }

  // ------------------------------------------------------------------ PDF (extraction simplifiée)
  function pdf(buf) {
    const brut = buf.toString("latin1");
    if (/\/Encrypt\s/.test(brut)) return { texte: "", avert: ["PDF protégé (chiffré) : texte non lisible sans serveur."] };
    const flux = [], images = [];
    const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g;
    let m;
    while ((m = re.exec(brut))) {
      const debut = m.index + m[0].length;
      const fin = brut.indexOf("endstream", debut);
      if (fin < 0) break;
      let donnees = buf.subarray(debut, fin);
      const dico = m[1];
      // Page scannée : image JPEG intégrée telle quelle (lisible directement par l'OCR)
      if (/\/Subtype\s*\/Image/.test(dico) && /\/DCTDecode/.test(dico) && !/\/FlateDecode/.test(dico)) {
        const lg = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dico);
        images.push(Buffer.from(lg ? buf.subarray(debut, debut + parseInt(lg[1], 10)) : donnees));
        re.lastIndex = fin;
        continue;
      }
      if (/\/FlateDecode/.test(dico)) {
        try { donnees = zlib.inflateSync(donnees); } catch { try { donnees = zlib.inflateSync(donnees, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { continue; } }
      } else if (/\/Filter/.test(dico)) continue; // images et autres filtres : ignorés
      flux.push(donnees.toString("latin1"));
      re.lastIndex = fin;
    }
    // Tables de correspondance des polices (ToUnicode), fusionnées
    const cmap = new Map();
    let deuxOctets = false;
    for (const f of flux) {
      if (!/begincmap/.test(f)) continue;
      if (/<0000>\s*<FFFF>/i.test(f) || /begincodespacerange\s*<[0-9a-f]{4}>/i.test(f)) deuxOctets = true;
      for (const b of f.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const p of b[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) cmap.set(parseInt(p[1], 16), Buffer.from(p[2], "hex").swap16().toString("utf16le"));
      }
      for (const b of f.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const p of b[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
          const a = parseInt(p[1], 16), z = parseInt(p[2], 16), dest = parseInt(p[3], 16);
          for (let c = a; c <= z && c - a < 5000; c++) cmap.set(c, String.fromCharCode(dest + c - a));
        }
      }
    }
    const decoderChaine = (octets, hex) => {
      if (hex && cmap.size && deuxOctets && octets.length % 2 === 0) {
        let s = "";
        for (let i = 0; i < octets.length; i += 2) s += cmap.get((octets[i] << 8) | octets[i + 1]) ?? "";
        return s;
      }
      if (cmap.size) return [...octets].map(o => cmap.get(o) ?? String.fromCharCode(o)).join("");
      return Buffer.from(octets).toString("latin1");
    };
    const litterale = (s, i) => {
      const octets = [];
      let niveau = 1;
      for (i++; i < s.length && niveau > 0; i++) {
        const c = s[i];
        if (c === "\\") {
          const n = s[++i];
          const sp = { n: 10, r: 13, t: 9, b: 8, f: 12 }[n];
          if (sp !== undefined) octets.push(sp);
          else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i]; octets.push(parseInt(o, 8) & 255); }
          else if (n === "\r" || n === "\n") { if (n === "\r" && s[i + 1] === "\n") i++; }
          else octets.push(n.charCodeAt(0));
        } else if (c === "(") { niveau++; octets.push(40); } else if (c === ")") { niveau--; if (niveau) octets.push(41); } else octets.push(c.charCodeAt(0) & 255);
      }
      return { octets, fin: i };
    };
    const lignes = [];
    for (const f of flux) {
      if (!/\bBT\b/.test(f)) continue;
      let ligne = "", i = 0;
      const pousser = () => { if (ligne.trim()) lignes.push(ligne.replace(/\s+$/, "")); ligne = ""; };
      while (i < f.length) {
        const c = f[i];
        if (c === "(") { const r = litterale(f, i); ligne += decoderChaine(r.octets, false); i = r.fin; continue; }
        if (c === "<" && f[i + 1] !== "<") {
          const fin = f.indexOf(">", i);
          const hex = f.slice(i + 1, fin).replace(/\s+/g, "");
          ligne += decoderChaine(Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex"), true);
          i = fin + 1;
          continue;
        }
        if (c === "]" ) { i++; continue; }
        const op = /^(-?\d*\.?\d+)\s+(?=[\[(<\-\d])|^(T\*|Td|TD|Tm|ET|')(?![A-Za-z])/.exec(f.slice(i, i + 20));
        if (op && op[1] !== undefined && f[i - 1] !== undefined) {
          // espacement dans un tableau TJ : un grand retrait vaut une espace
          if (parseFloat(op[1]) < -180 && /\[[^\]]*$/.test(f.slice(Math.max(0, i - 200), i)) && !/\s$/.test(ligne)) ligne += " ";
          i += op[0].length;
          continue;
        }
        if (op && op[2]) { pousser(); i += op[0].length; continue; }
        i++;
      }
      pousser();
    }
    const texte = lignes.join("\n").replace(/\u0000/g, "");
    const avert = ["PDF lu par l'extraction simplifiée du moteur local : vérifiez que le texte est complet."];
    if (!texte.trim()) avert.unshift("Aucun texte trouvé dans ce PDF (document scanné ?) : il faudrait un OCR.");
    return { texte, avert, images };
  }

  // ------------------------------------------------------------------ OCR local (Tesseract, s'il est installé)
  let tesseractTrouve;
  function lancer(cmd, args) {
    const { spawn } = require("child_process");
    return new Promise(resolve => {
      const js = /\.js$/i.test(cmd);
      let p;
      try { p = spawn(js ? process.execPath : cmd, js ? [cmd, ...args] : args, { windowsHide: true }); } catch { return resolve({ code: -1, sortie: "" }); }
      const morceaux = [];
      p.stdout.on("data", d => morceaux.push(d));
      p.stderr.on("data", () => {});
      p.on("error", () => resolve({ code: -1, sortie: "" }));
      p.on("close", code => resolve({ code, sortie: Buffer.concat(morceaux).toString("utf8") }));
    });
  }
  async function tesseract() {
    if (tesseractTrouve !== undefined) return tesseractTrouve;
    const candidats = process.env.ANON_TESSERACT ? [process.env.ANON_TESSERACT] : ["tesseract", "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"];
    tesseractTrouve = null;
    for (const c of candidats) if ((await lancer(c, ["--version"])).code === 0) { tesseractTrouve = c; break; }
    return tesseractTrouve;
  }
  async function ocrImages(images) {
    const os = require("os"), fs = require("fs"), path = require("path");
    const outil = await tesseract();
    if (!outil) return { erreur: "absent" };
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "anon-ocr-"));
    try {
      const pages = [];
      for (const [i, img] of images.entries()) {
        const f = path.join(dossier, `page${i + 1}.jpg`);
        fs.writeFileSync(f, img);
        const r = await lancer(outil, [f, "stdout", "-l", process.env.ANON_OCR_LANGUES || "fra"]);
        if (r.code !== 0) return { erreur: `Tesseract a échoué (code ${r.code}) — le français est-il installé (fra) ?` };
        pages.push(r.sortie.trim());
      }
      return { texte: pages.join("\n\n") };
    } finally {
      fs.rmSync(dossier, { recursive: true, force: true }); // l'image de la pièce ne reste pas sur le disque
    }
  }

  /** Comme extraireTexte, avec l'OCR des PDF scannés quand Tesseract est installé (ANON_OCR=0 pour le désactiver). */
  async function extraireTexteAsync(ext, buf) {
    const r = extraireTexte(ext, buf);
    if (ext !== ".pdf" || r.texte.trim().length >= 20 * Math.max(1, (r.images || []).length) || !(r.images || []).length) return r;
    if (/^(0|non|false)$/i.test(process.env.ANON_OCR || "")) return r;
    const o = await ocrImages(r.images);
    if (o.erreur === "absent") {
      return { texte: r.texte, avert: [`PDF scanné (${r.images.length} page(s) en image) : l'OCR n'est pas installé sur ce poste. Installez Tesseract avec le ` +
        "français (sous Windows : programme d'installation « Tesseract at UB Mannheim », en cochant French), puis relancez la lecture."] };
    }
    if (o.erreur) return { texte: r.texte, avert: [`PDF scanné : ${o.erreur} Contenu non analysé.`] };
    return { texte: [r.texte.trim(), o.texte].filter(Boolean).join("\n\n"), avert: [`PDF scanné : texte obtenu par reconnaissance de caractères (OCR) sur ` +
      `${r.images.length} page(s). Relisez les noms propres : l'OCR peut en déformer certains, qui échappent alors au masquage.`] };
  }

  /** Texte d'un document : { texte, avert }. */
  function extraireTexte(ext, buf) {
    switch (ext) {
      case ".txt": case ".md": case ".csv": return { texte: decoderTexte(buf), avert: [] };
      case ".docx": return { texte: docx(buf), avert: [] };
      case ".odt": return { texte: odt(buf), avert: [] };
      case ".html": case ".htm": return { texte: html(decoderTexte(buf)), avert: [] };
      case ".rtf": return { texte: rtf(buf.toString("latin1")), avert: [] };
      case ".eml": return { texte: eml(buf), avert: [] };
      case ".pdf": return pdf(buf);
      default: throw new Error("Format non pris en charge par le moteur local.");
    }
  }

  // ------------------------------------------------------------------ docx à partir d'un texte (Markdown léger)
  const xmlEch = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function runs(texte, taille) {
    const sz = taille ? `<w:sz w:val="${taille}"/>` : "";
    return texte.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(m => {
      const gras = /^\*\*[^*]+\*\*$/.test(m) || !!taille;
      const t = /^\*\*[^*]+\*\*$/.test(m) ? m.slice(2, -2) : m;
      return `<w:r><w:rPr>${gras ? "<w:b/>" : ""}${sz}</w:rPr><w:t xml:space="preserve">${xmlEch(t)}</w:t></w:r>`;
    }).join("");
  }
  function texteVersDocx(texte) {
    const paras = texte.replace(/\r\n?/g, "\n").split("\n").map(l => {
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>${runs(h[2], [36, 30, 26, 24, 24, 24][h[1].length - 1])}</w:p>`;
      const li = /^\s*[-*+]\s+(.*)$/.exec(l);
      if (li) return `<w:p><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr>${runs("•\t" + li[1])}</w:p>`;
      return `<w:p>${l ? runs(l) : ""}</w:p>`;
    }).join("");
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    return ecrireZip([
      creerEntree("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      creerEntree("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      creerEntree("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    ]);
  }

  return { extraireTexte, extraireTexteAsync, texteVersDocx, texteWord, html, rtf, eml, pdf, partieMime, decoderMime, decoderEntete };
}

module.exports = { creerFichiers };
