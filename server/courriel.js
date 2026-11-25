/*
 * AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
 * Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
 */
/*
 * Import de courriels sans passer par la conversation : client IMAP minimal (sans dépendance) et
 * extraction des pièces jointes. La boîte est ouverte en lecture seule (EXAMINE, BODY.PEEK) : les messages
 * ne sont ni marqués comme lus, ni déplacés, ni supprimés.
 */
"use strict";
const net = require("net");
const tls = require("tls");

class ClientImap {
  constructor({ hote, port = 993, tls: avecTls = true, delaiMs = 60000 }) {
    Object.assign(this, { hote, port, avecTls, delaiMs });
    this.tampon = Buffer.alloc(0);
    this.restant = 0;
    this.courante = { texte: "", litteraux: [] };
    this.attente = null;
    this.numero = 0;
  }

  connecter() {
    return new Promise((resolve, reject) => {
      const options = { host: this.hote, port: this.port, servername: this.hote };
      this.socket = this.avecTls ? tls.connect(options) : net.connect(options);
      this.socket.setTimeout(this.delaiMs, () => this.socket.destroy(new Error("délai dépassé")));
      this.socket.on("error", e => { if (this.attente) this.attente.reject(e); else reject(e); });
      this.socket.on("data", d => { this.tampon = Buffer.concat([this.tampon, d]); this.traiter(); });
      this.accueil = { resolve, reject };
    });
  }

  traiter() {
    for (;;) {
      if (this.restant > 0) {
        if (this.tampon.length < this.restant) return;
        this.courante.litteraux.push(this.tampon.subarray(0, this.restant));
        this.tampon = this.tampon.subarray(this.restant);
        this.restant = 0;
        continue;
      }
      const i = this.tampon.indexOf("\r\n");
      if (i < 0) return;
      const ligne = this.tampon.subarray(0, i).toString("utf8");
      this.tampon = this.tampon.subarray(i + 2);
      this.courante.texte += ligne;
      const lit = /\{(\d+)\}$/.exec(ligne);
      if (lit) {
        this.restant = parseInt(lit[1], 10);
        if (!this.restant) this.courante.litteraux.push(Buffer.alloc(0));
        continue;
      }
      const rep = this.courante;
      this.courante = { texte: "", litteraux: [] };
      if (this.accueil) {
        const a = this.accueil;
        this.accueil = null;
        if (/^\* (OK|PREAUTH)/i.test(rep.texte)) a.resolve(); else a.reject(new Error("accueil inattendu du serveur de messagerie"));
      } else if (this.attente && rep.texte.startsWith(this.attente.tag + " ")) {
        const a = this.attente;
        this.attente = null;
        const statut = rep.texte.slice(a.tag.length + 1);
        if (/^OK/i.test(statut)) a.resolve(a.reponses);
        else a.reject(new Error(`refus du serveur de messagerie (${statut.replace(/^(NO|BAD)\s*/i, "").slice(0, 120)})`));
      } else if (this.attente) {
        this.attente.reponses.push(rep);
      }
    }
  }

  commande(texte) {
    const tag = "A" + String(++this.numero).padStart(3, "0");
    return new Promise((resolve, reject) => {
      this.attente = { tag, resolve, reject, reponses: [] };
      this.socket.write(`${tag} ${texte}\r\n`);
    });
  }

  static chaine(s) {
    return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  async connexion(utilisateur, motDePasse, dossier) {
    await this.connecter();
    await this.commande(`LOGIN ${ClientImap.chaine(utilisateur)} ${ClientImap.chaine(motDePasse)}`);
    const rep = await this.commande(`EXAMINE ${ClientImap.chaine(dossier || "INBOX")}`); // lecture seule
    const v = rep.map(r => /UIDVALIDITY (\d+)/i.exec(r.texte)).find(Boolean);
    this.uidValidity = v ? v[1] : "0";
  }

  async uids(critere = "ALL") {
    const rep = await this.commande(`UID SEARCH ${critere}`);
    const ligne = rep.find(r => /^\* SEARCH/i.test(r.texte));
    return ligne ? ligne.texte.replace(/^\* SEARCH\s*/i, "").split(/\s+/).filter(Boolean).map(Number) : [];
  }

  async entetes(uids) {
    if (!uids.length) return [];
    const rep = await this.commande(`UID FETCH ${uids.join(",")} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`);
    return rep.filter(r => /FETCH/i.test(r.texte) && r.litteraux.length).map(r => ({
      uid: Number((/UID (\d+)/i.exec(r.texte) || [])[1]), entete: r.litteraux[0].toString("latin1"),
    }));
  }

  async message(uid) {
    const rep = await this.commande(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    const r = rep.find(x => /FETCH/i.test(x.texte) && x.litteraux.length);
    return r ? r.litteraux[r.litteraux.length - 1] : null;
  }

  async fermer() {
    try { await this.commande("LOGOUT"); } catch { /* déjà fermé */ }
    try { this.socket.end(); } catch { /* déjà fermé */ }
  }
}

// ---------------------------------------------------------------------------- pièces jointes
function octetsQP(corps) {
  const s = corps.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 255);
  }
  return Buffer.from(out);
}

/** Nom de fichier d'une pièce jointe : filename*=UTF-8''…, filename*0*=…, filename="=?UTF-8?…?=", name=… */
function nomFichier(entete, F) {
  if (!entete) return "";
  const morceaux = [...entete.matchAll(/(?:file)?name\*(\d+)?\*?=(?:"([^"]*)"|([^;\s]+))/gi)];
  if (morceaux.length) {
    const brut = morceaux.sort((a, b) => (+a[1] || 0) - (+b[1] || 0)).map(m => m[2] ?? m[3]).join("");
    const m = /^([^']*)'[^']*'(.*)$/.exec(brut);
    if (!m) return brut;
    const octets = Buffer.from(m[2].replace(/%([0-9A-F]{2})/gi, (t, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    try { return new TextDecoder(m[1] || "utf-8").decode(octets); } catch { return octets.toString("utf8"); }
  }
  const simple = /(?:^|;)\s*(?:file)?name=(?:"([^"]*)"|([^;]+))/i.exec(entete);
  return simple ? F.decoderEntete((simple[1] ?? simple[2]).trim()) : "";
}

/** Pièces jointes d'un message brut : [{ nom, octets }]. */
function piecesJointes(brut, F) {
  const out = [];
  const visiter = (partie, profondeur) => {
    if (profondeur > 8) return;
    const { champ, corps } = F.partieMime(partie);
    const type = champ("Content-Type") || "text/plain";
    const fr = /boundary="?([^";]+)"?/i.exec(type);
    if (/^multipart\//i.test(type) && fr) {
      for (const p of corps.split("--" + fr[1]).slice(1)) if (!p.startsWith("--")) visiter(p, profondeur + 1);
      return;
    }
    const disposition = champ("Content-Disposition");
    const nom = nomFichier(disposition, F) || nomFichier(type, F);
    if (profondeur === 0 || (!nom && !/^attachment/i.test(disposition) && !/^message\/rfc822/i.test(type))) return;
    if (!nom && /^text\//i.test(type) && !/^attachment/i.test(disposition)) return;
    const enc = champ("Content-Transfer-Encoding");
    const octets = /base64/i.test(enc) ? Buffer.from(corps.replace(/\s+/g, ""), "base64")
      : /quoted-printable/i.test(enc) ? octetsQP(corps) : Buffer.from(corps.replace(/\r?\n$/, ""), "latin1");
    out.push({ nom: nom || (/^message\/rfc822/i.test(type) ? "courriel joint.eml" : "piece-jointe"), octets });
  };
  visiter(brut, 0);
  return out;
}

module.exports = { ClientImap, piecesJointes, nomFichier };
