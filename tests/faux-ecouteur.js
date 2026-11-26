/*
 * Faux écouteur de raccourcis clavier pour les tests : remplace la fenêtre invisible Windows.
 * - annonce « PRET » ;
 * - quand le fichier ANON_FAUX_DECLENCHEUR apparaît, émet les raccourcis qu'il contient (une ligne par raccourci :
 *   COLLER ou REID), puis le supprime ;
 * - note dans ANON_FAUX_JOURNAL chaque commande reçue de l'extension (COLLER, NOTIF…).
 */
"use strict";
const fs = require("fs");
const declencheur = process.env.ANON_FAUX_DECLENCHEUR;
const journal = process.env.ANON_FAUX_JOURNAL;

process.stdout.write("PRET:COLLER,REID\n");
let tampon = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  tampon += d;
  let i;
  while ((i = tampon.indexOf("\n")) >= 0) {
    fs.appendFileSync(journal, tampon.slice(0, i) + "\n", "utf8");
    tampon = tampon.slice(i + 1);
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {
  let contenu = null;
  try { contenu = fs.readFileSync(declencheur, "utf8"); fs.unlinkSync(declencheur); } catch { return; }
  for (const l of contenu.split(/\r?\n/).filter(Boolean)) process.stdout.write(`HOTKEY:${l.trim()}\n`);
}, 100);
