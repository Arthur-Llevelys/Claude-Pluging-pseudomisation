# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
# Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
"""
Table de correspondance marqueur <-> valeur réelle, par dossier.

- Les valeurs réelles sont chiffrées (Fernet / AES-128-CBC + HMAC-SHA256).
- La recherche d'une valeur déjà vue se fait par empreinte HMAC-SHA256
  (la valeur en clair n'est jamais stockée).
- Les dossiers inactifs sont purgés après ANON_RETENTION_DAYS jours.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import sqlite3
import threading
import time

from cryptography.fernet import Fernet

RE_DOSSIER = re.compile(r"^[\w\-. ]{1,64}$")

# Génération des règles de détection ayant créé une entrée. Les entrées créées avant la
# version 1.1.0 portent 0 : le moteur peut ainsi cesser de rechercher celles qui étaient des
# erreurs (« Montant », « Lyon », « Son IBAN ») sans toucher aux entrées créées depuis.
GENERATION = 2


class Store:
    def __init__(self, chemin: str, cle: str, retention_jours: int = 30):
        os.makedirs(os.path.dirname(os.path.abspath(chemin)), exist_ok=True)
        self.fernet = Fernet(cle.encode() if isinstance(cle, str) else cle)
        self.cle_hmac = hashlib.sha256(b"anonymiseur-hmac:" + (cle.encode() if isinstance(cle, str) else cle)).digest()
        self.retention = retention_jours * 86400
        self.lock = threading.Lock()
        self.db = sqlite3.connect(chemin, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS dossiers(
                id TEXT PRIMARY KEY, cree REAL NOT NULL, utilise REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS entrees(
                dossier TEXT NOT NULL, marqueur TEXT NOT NULL, type TEXT NOT NULL,
                empreinte TEXT NOT NULL, valeur BLOB NOT NULL, canonique INTEGER NOT NULL,
                occurrences INTEGER NOT NULL DEFAULT 0, cree REAL NOT NULL,
                PRIMARY KEY(dossier, empreinte));
            CREATE INDEX IF NOT EXISTS idx_marqueur ON entrees(dossier, marqueur);
            CREATE TABLE IF NOT EXISTS compteurs(
                dossier TEXT NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL,
                PRIMARY KEY(dossier, type));
            """
        )
        # Mise à niveau d'une base créée par une version antérieure (les entrées existantes restent à 0)
        colonnes = {r[1] for r in self.db.execute("PRAGMA table_info(entrees)")}
        if "generation" not in colonnes:
            self.db.execute("ALTER TABLE entrees ADD COLUMN generation INTEGER NOT NULL DEFAULT 0")
        # Version 1.2.0 : fusion de marqueurs (l'ancien marqueur reste ré-identifiable) et exclusions par dossier
        if "ancien" not in colonnes:
            self.db.execute("ALTER TABLE entrees ADD COLUMN ancien TEXT")
            self.db.execute("ALTER TABLE entrees ADD COLUMN ancien_canonique INTEGER NOT NULL DEFAULT 0")
        self.db.execute("CREATE TABLE IF NOT EXISTS exclusions(dossier TEXT NOT NULL, empreinte TEXT NOT NULL, "
                        "PRIMARY KEY(dossier, empreinte))")
        self.db.commit()
        try:
            os.chmod(chemin, 0o600)
        except OSError:
            pass

    # ------------------------------------------------------------------
    @staticmethod
    def valider_dossier(dossier: str) -> str:
        dossier = (dossier or "general").strip()
        if not RE_DOSSIER.match(dossier):
            raise ValueError("Nom de dossier invalide (lettres, chiffres, espace, - _ . ; 64 caractères max)")
        return dossier

    def empreinte(self, dossier: str, valeur_norm: str) -> str:
        return hmac.new(self.cle_hmac, f"{dossier}\x00{valeur_norm}".encode(), hashlib.sha256).hexdigest()

    def _chiffrer(self, v: str) -> bytes:
        return self.fernet.encrypt(v.encode())

    def _dechiffrer(self, b: bytes) -> str:
        return self.fernet.decrypt(b).decode()

    # ------------------------------------------------------------------
    def purger(self) -> int:
        limite = time.time() - self.retention
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM dossiers WHERE utilise < ?", (limite,))]
            for i in ids:
                self._supprimer(i)
            self.db.commit()
        return len(ids)

    def toucher(self, dossier: str):
        now = time.time()
        with self.lock:
            self.db.execute(
                "INSERT INTO dossiers(id, cree, utilise) VALUES(?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET utilise=excluded.utilise", (dossier, now, now))
            self.db.commit()

    def marqueur_pour(self, dossier: str, type_: str, valeur: str, valeur_norm: str,
                      canonique_de: str | None = None) -> str:
        """Retourne le marqueur existant ou en crée un nouveau.

        `canonique_de` : si fourni, la valeur est une variante (ex. nom de
        famille seul) rattachée au marqueur de cette valeur de référence.
        """
        emp = self.empreinte(dossier, valeur_norm)
        with self.lock:
            row = self.db.execute(
                "SELECT marqueur FROM entrees WHERE dossier=? AND empreinte=?", (dossier, emp)).fetchone()
            if row:
                # Retrouvée par les règles actuelles : l'entrée est confirmée (génération mise à jour)
                self.db.execute("UPDATE entrees SET occurrences=occurrences+1, generation=? "
                                "WHERE dossier=? AND empreinte=?", (GENERATION, dossier, emp))
                return row[0]
            marqueur = None
            if canonique_de is not None:
                r2 = self.db.execute("SELECT marqueur, type FROM entrees WHERE dossier=? AND empreinte=?",
                                     (dossier, self.empreinte(dossier, canonique_de))).fetchone()
                if r2:
                    marqueur, type_ = r2
            canonique = 0
            if marqueur is None:
                row = self.db.execute("SELECT n FROM compteurs WHERE dossier=? AND type=?",
                                      (dossier, type_)).fetchone()
                n = (row[0] if row else 0) + 1
                self.db.execute("INSERT INTO compteurs(dossier,type,n) VALUES(?,?,?) "
                                "ON CONFLICT(dossier,type) DO UPDATE SET n=excluded.n", (dossier, type_, n))
                marqueur = f"[{type_}_{n}]"
                canonique = 1
            self.db.execute(
                "INSERT INTO entrees(dossier, marqueur, type, empreinte, valeur, canonique, occurrences, cree, "
                "generation) VALUES(?,?,?,?,?,?,1,?,?)",
                (dossier, marqueur, type_, emp, self._chiffrer(valeur), canonique, time.time(), GENERATION))
            return marqueur

    def valider(self):
        with self.lock:
            self.db.commit()

    def valeurs_connues(self, dossier: str) -> list[tuple[str, str, str, bool, int]]:
        """[(marqueur, type, valeur, canonique, génération)] — pour re-masquer dans un nouveau texte."""
        with self.lock:
            rows = self.db.execute(
                "SELECT marqueur, type, valeur, canonique, generation FROM entrees WHERE dossier=? "
                "AND empreinte NOT IN (SELECT empreinte FROM exclusions WHERE dossier=?)",
                (dossier, dossier)).fetchall()
        return [(m, t, self._dechiffrer(v), bool(c), g) for m, t, v, c, g in rows]

    def table_inverse(self, dossier: str) -> dict[str, str]:
        """marqueur -> valeur de référence (y compris les marqueurs absorbés par une fusion)."""
        with self.lock:
            rows = self.db.execute(
                "SELECT marqueur, valeur FROM entrees WHERE dossier=? AND canonique=1", (dossier,)).fetchall()
            anciens = self.db.execute(
                "SELECT ancien, valeur FROM entrees WHERE dossier=? AND ancien IS NOT NULL AND ancien_canonique=1",
                (dossier,)).fetchall()
        table = {m: self._dechiffrer(v) for m, v in rows}
        for m, v in anciens:
            table.setdefault(m, self._dechiffrer(v))
        return table

    # ------------------------------------------------------------------
    # Corrections (outil corriger_entite) — aucune valeur réelle ne sort de ces méthodes
    def types_marqueurs(self, dossier: str) -> dict[str, str]:
        with self.lock:
            rows = self.db.execute("SELECT DISTINCT marqueur, type FROM entrees WHERE dossier=?", (dossier,)).fetchall()
        return {m: t for m, t in rows}

    def fusionner(self, dossier: str, garder: str, absorbes: list[str]) -> int:
        """Rattache les valeurs des marqueurs absorbés au marqueur gardé ; les anciens marqueurs restent ré-identifiables."""
        types = self.types_marqueurs(dossier)
        n = 0
        with self.lock:
            for m in absorbes:
                n += self.db.execute(
                    "UPDATE entrees SET ancien_canonique = CASE WHEN ancien IS NULL THEN canonique ELSE ancien_canonique END, "
                    "ancien = COALESCE(ancien, marqueur), marqueur=?, type=?, canonique=0 WHERE dossier=? AND marqueur=?",
                    (garder, types[garder], dossier, m)).rowcount
            self.db.commit()
        return n

    def exclure(self, dossier: str, marqueur: str) -> int:
        with self.lock:
            emps = [r[0] for r in self.db.execute(
                "SELECT empreinte FROM entrees WHERE dossier=? AND marqueur=?", (dossier, marqueur))]
            self.db.executemany("INSERT OR IGNORE INTO exclusions(dossier, empreinte) VALUES(?,?)", [(dossier, e) for e in emps])
            self.db.commit()
        return len(emps)

    def reinclure(self, dossier: str, marqueur: str | None = None, empreinte: str | None = None) -> int:
        with self.lock:
            if empreinte is not None:
                n = self.db.execute("DELETE FROM exclusions WHERE dossier=? AND empreinte=?", (dossier, empreinte)).rowcount
            else:
                n = self.db.execute(
                    "DELETE FROM exclusions WHERE dossier=? AND empreinte IN "
                    "(SELECT empreinte FROM entrees WHERE dossier=? AND marqueur=?)", (dossier, dossier, marqueur)).rowcount
            self.db.commit()
        return n

    def exclusions(self, dossier: str) -> set[str]:
        with self.lock:
            return {r[0] for r in self.db.execute("SELECT empreinte FROM exclusions WHERE dossier=?", (dossier,))}

    def marqueurs_exclus(self, dossier: str) -> set[str]:
        with self.lock:
            return {r[0] for r in self.db.execute(
                "SELECT DISTINCT e.marqueur FROM entrees e JOIN exclusions x ON x.dossier=e.dossier AND x.empreinte=e.empreinte "
                "WHERE e.dossier=?", (dossier,))}

    def lister_dossiers(self) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT d.id, d.cree, d.utilise, COUNT(DISTINCT e.marqueur) FROM dossiers d "
                "LEFT JOIN entrees e ON e.dossier = d.id GROUP BY d.id ORDER BY d.utilise DESC").fetchall()
        return [{"id": r[0], "cree": r[1], "utilise": r[2], "nb_entites": r[3]} for r in rows]

    def entites(self, dossier: str, avec_valeurs: bool) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT marqueur, type, valeur, canonique, occurrences FROM entrees WHERE dossier=? "
                "ORDER BY type, CAST(substr(marqueur, instr(marqueur, '_') + 1) AS INTEGER)", (dossier,)).fetchall()
        res: dict[str, dict] = {}
        for m, t, v, c, occ in rows:
            e = res.setdefault(m, {"marqueur": m, "type": t, "occurrences": 0, "variantes": []})
            e["occurrences"] += occ
            if avec_valeurs:
                val = self._dechiffrer(v)
                if c:
                    e["valeur"] = val
                else:
                    e["variantes"].append(val)
        out = list(res.values())
        exclus = self.marqueurs_exclus(dossier)
        for e in out:
            if e["marqueur"] in exclus:
                e["exclu"] = True
        if not avec_valeurs:
            for e in out:
                e.pop("variantes", None)
        # tri naturel par type puis numéro
        out.sort(key=lambda e: (e["type"], int(re.sub(r"\D", "", e["marqueur"]) or 0)))
        return out

    def _supprimer(self, dossier: str):
        self.db.execute("DELETE FROM entrees WHERE dossier=?", (dossier,))
        self.db.execute("DELETE FROM compteurs WHERE dossier=?", (dossier,))
        self.db.execute("DELETE FROM exclusions WHERE dossier=?", (dossier,))
        self.db.execute("DELETE FROM dossiers WHERE id=?", (dossier,))

    def supprimer(self, dossier: str):
        with self.lock:
            self._supprimer(dossier)
            self.db.commit()
