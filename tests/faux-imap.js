/*
 * Faux serveur de messagerie IMAP pour les tests (sans chiffrement), avec deux messages fictifs.
 * Il note les commandes reçues : les tests vérifient que la boîte est ouverte en lecture seule.
 */
"use strict";
const net = require("net");

const PDF = Buffer.from("%PDF-1.4 faux contenu de pièce jointe");
const MESSAGES = [
  {
    uid: 41, id: "<ancien@exemple.fr>",
    brut: "From: Marie Martin <marie@exemple.fr>\r\nSubject: Ancien message\r\nDate: Mon, 3 Nov 2025 09:00:00 +0100\r\nMessage-ID: <ancien@exemple.fr>\r\n\r\nBonjour.\r\n",
  },
  {
    uid: 42, id: "<affaire@exemple.fr>",
    brut: "From: Jean Dupont <jean.dupont@exemple.fr>\r\nTo: cabinet@exemple.fr\r\nSubject: =?UTF-8?Q?Cr=C3=A9ance_ZORVAL?=\r\n" +
      "Date: Tue, 25 Nov 2025 14:03:00 +0100\r\nMessage-ID: <affaire@exemple.fr>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n" +
      "--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nMa=C3=AEtre,\r\nZORVAL ne m'a pas pay=C3=A9. Jean Dupont\r\n" +
      "--b1\r\nContent-Type: application/pdf; name=\"facture.pdf\"\r\nContent-Disposition: attachment; filename=\"Facture ZORVAL.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
      PDF.toString("base64") + "\r\n" +
      "--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename*=UTF-8''Lettre%20de%20Jean%20Dupont%20%C3%A9t%C3%A9.txt\r\n\r\n" +
      "Lettre de Jean Dupont à ZORVAL.\r\n--b1--\r\n",
  },
];

function creer({ utilisateur = "avocat", motDePasse = "secret" } = {}) {
  const commandes = [];
  const srv = net.createServer(sock => {
    sock.write("* OK IMAP4rev1 faux serveur prêt\r\n");
    let tampon = "";
    sock.on("data", d => {
      tampon += d.toString("utf8");
      let i;
      while ((i = tampon.indexOf("\r\n")) >= 0) {
        const ligne = tampon.slice(0, i);
        tampon = tampon.slice(i + 2);
        const [tag, ...reste] = ligne.split(" ");
        const cmd = reste.join(" ");
        commandes.push(cmd.replace(/^LOGIN .*/i, "LOGIN ***"));
        const ok = t => sock.write(`${tag} OK ${t || "fait"}\r\n`);
        if (/^LOGIN /i.test(cmd)) {
          const m = /^LOGIN "([^"]*)" "([^"]*)"$/i.exec(cmd);
          if (m && m[1] === utilisateur && m[2] === motDePasse) ok(); else sock.write(`${tag} NO identifiants refusés\r\n`);
        } else if (/^(EXAMINE|SELECT) /i.test(cmd)) {
          sock.write(`* ${MESSAGES.length} EXISTS\r\n* OK [UIDVALIDITY 777] valide\r\n`);
          ok("[READ-ONLY] ouvert");
        } else if (/^UID SEARCH ALL/i.test(cmd)) {
          sock.write(`* SEARCH ${MESSAGES.map(m => m.uid).join(" ")}\r\n`); ok();
        } else if (/^UID SEARCH HEADER Message-ID "(.*)"/i.test(cmd)) {
          const id = /"(.*)"/.exec(cmd)[1];
          sock.write(`* SEARCH ${MESSAGES.filter(m => m.id === id).map(m => m.uid).join(" ")}\r\n`); ok();
        } else if (/^UID FETCH /i.test(cmd)) {
          const uids = /^UID FETCH ([\d,]+)/i.exec(cmd)[1].split(",").map(Number);
          for (const [n, msg] of MESSAGES.entries()) {
            if (!uids.includes(msg.uid)) continue;
            const corps = /HEADER\.FIELDS/i.test(cmd) ? Buffer.from(msg.brut.split("\r\n\r\n")[0] + "\r\n\r\n", "utf8") : Buffer.from(msg.brut, "utf8");
            const section = /HEADER\.FIELDS/i.test(cmd) ? "BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]" : "BODY[]";
            sock.write(`* ${n + 1} FETCH (UID ${msg.uid} ${section} {${corps.length}}\r\n`);
            sock.write(corps);
            sock.write(")\r\n");
          }
          ok();
        } else if (/^LOGOUT/i.test(cmd)) {
          sock.write("* BYE\r\n"); ok(); sock.end();
        } else {
          sock.write(`${tag} BAD commande inconnue\r\n`);
        }
      }
    });
    sock.on("error", () => {});
  });
  return {
    commandes, MESSAGES, PDF,
    demarrer: () => new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port))),
    arreter: () => new Promise(r => srv.close(r)),
  };
}

module.exports = { creer };
