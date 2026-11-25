"""
Tests de la version 1.2.0 (lot 4) : corrections d'un dossier (fusionner, exclure, réintégrer, ajouter)
et fermeture de l'export en masse des valeurs réelles. Données entièrement fictives.

    python -m tests.test_lot4      (aussi lancé par « python -m tests.test_moteur »)
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography.fernet import Fernet  # noqa: E402

from app import detect as D  # noqa: E402
from app.engine import Moteur  # noqa: E402
from app.store import Store  # noqa: E402

TMP = tempfile.mkdtemp(prefix="anon-lot4-")
CONF = tempfile.mkdtemp(prefix="conf-", dir=TMP)
ECHECS: list[str] = []
_N = [0]


def verifier(cond, message):
    print(("  ok   " if cond else "  ÉCHEC ") + message)
    if not cond:
        ECHECS.append(message)


def moteur():
    _N[0] += 1
    return Moteur(Store(os.path.join(TMP, f"b{_N[0]}.db"), Fernet.generate_key().decode()), D.Listes.charger(CONF))


def erreur(fonction):
    try:
        fonction()
    except ValueError as e:
        return str(e)
    return ""


def test_fusionner():
    print("\nL4-1. Fusionner deux marqueurs (même personne écrite de deux façons)")
    M = moteur()
    r = M.anonymiser("Courrier de Jean-Pierre DUPONT. Signé : J.-P. Dupont-Martin.", "f", {"ner": False, "termes": ["PERSONNE: J.-P. Dupont-Martin"]})
    verifier("[PERSONNE_1]" in r["texte"] and "[PERSONNE_2]" in r["texte"], f"deux marqueurs au départ ({r['texte']})")
    c = M.corriger("f", "fusionner", ["[PERSONNE_1]", "PERSONNE_2"])
    verifier(c["marqueur"] == "[PERSONNE_1]" and c["absorbes"] == ["[PERSONNE_2]"], "fusion : marqueur gardé et marqueur absorbé")
    verifier(not any(isinstance(v, str) and "DUPONT" in v for v in c.values()), "la réponse ne contient aucune valeur réelle")
    r2 = M.anonymiser("Relance à Jean-Pierre DUPONT et à J.-P. Dupont-Martin.", "f", {"ner": False})
    verifier(r2["texte"] == "Relance à [PERSONNE_1] et à [PERSONNE_1].", f"document suivant : un seul marqueur ({r2['texte']})")
    back = M.reidentifier("[PERSONNE_1] / [PERSONNE_2]", "f")
    verifier(back["texte"] == "Jean-Pierre DUPONT / J.-P. Dupont-Martin" and not back["marqueurs_inconnus"],
             "un ancien document contenant le marqueur absorbé se ré-identifie toujours")
    verifier("PERSONNE_2" not in str([e["marqueur"] for e in M.store.entites("f", False)]), "le marqueur absorbé disparaît de la liste")
    verifier("inconnu" in erreur(lambda: M.corriger("f", "fusionner", ["[PERSONNE_1]", "[PERSONNE_9]"])), "marqueur inconnu refusé")
    verifier("deux marqueurs" in erreur(lambda: M.corriger("f", "fusionner", ["[PERSONNE_1]"])), "un seul marqueur refusé")


def test_exclure_reinclure():
    print("\nL4-2. Exclure un marqueur masqué à tort, puis le réintégrer")
    M = moteur()
    r = M.anonymiser("M. Bureau a signé. Le Montant est dû par Jean DUPONT.", "e", {"ner": False, "termes": ["AUTRE: Montant"]})
    verifier("[AUTRE_1]" in r["texte"], "« Montant » imposé par erreur : masqué")
    imposer = {"ner": False}
    c = M.corriger("e", "exclure", ["[PERSONNE_1]"])
    verifier(c["valeurs"] == 1, "exclusion enregistrée")
    r2 = M.anonymiser("M. Bureau a signé. Jean DUPONT paiera.", "e", imposer)
    verifier(r2["texte"] == "M. Bureau a signé. [PERSONNE_2] paiera.", f"valeur exclue laissée en clair, autres noms masqués ({r2['texte']})")
    ent = {e["marqueur"]: e for e in M.store.entites("e", False)}
    verifier(ent["[PERSONNE_1]"].get("exclu") is True and not ent["[PERSONNE_2]"].get("exclu"), "liste des marqueurs : exclusion signalée")
    verifier(M.reidentifier("[PERSONNE_1]", "e")["texte"] == "Bureau", "un marqueur exclu reste ré-identifiable dans les anciens documents")
    r3 = M.anonymiser("Le Montant reste dû.", "e", {"ner": False, "termes": ["AUTRE: Montant"]})
    M.corriger("e", "exclure", ["[AUTRE_1]"])
    r4 = M.anonymiser("Le Montant reste dû.", "e", {"ner": False, "termes": ["AUTRE: Montant"]})
    verifier("[AUTRE_1]" in r3["texte"] and "[AUTRE_1]" in r4["texte"], "un terme imposé dans la demande l'emporte sur l'exclusion")
    M.corriger("e", "reinclure", ["[PERSONNE_1]"])
    r5 = M.anonymiser("M. Bureau a signé.", "e", {"ner": False})
    verifier(r5["texte"] == "M. [PERSONNE_1] a signé.", f"réintégré : de nouveau masqué ({r5['texte']})")


def test_ajouter():
    print("\nL4-3. Ajouter une entité oubliée par la détection")
    M = moteur()
    r = M.anonymiser("Rendez-vous avec zorglub, puis réunion chez Brivane.", "a", {"ner": False})
    verifier("Brivane" in r["texte"], "nom non détecté au départ (règles seules)")
    c = M.corriger("a", "ajouter", type_="SOCIETE", valeur="Brivane")
    verifier(c["marqueur"] == "[SOCIETE_1]" and c["deja_connu"] is False, "entité ajoutée sous un nouveau marqueur")
    r2 = M.anonymiser("Brivane a répondu. BRIVANE confirme.", "a", {"ner": False})
    verifier(r2["texte"] == "[SOCIETE_1] a répondu. [SOCIETE_1] confirme.", f"masquée dans les documents suivants ({r2['texte']})")
    c2 = M.corriger("a", "ajouter", type_="SOCIETE", valeur="Brivane")
    verifier(c2["marqueur"] == "[SOCIETE_1]" and c2["deja_connu"] is True, "valeur déjà connue : même marqueur")
    M.corriger("a", "exclure", ["[SOCIETE_1]"])
    M.corriger("a", "ajouter", type_="SOCIETE", valeur="Brivane")
    verifier("[SOCIETE_1]" in M.anonymiser("Brivane écrit.", "a", {"ner": False})["texte"], "ajouter une valeur exclue la réintègre")
    verifier("Type inconnu" in erreur(lambda: M.corriger("a", "ajouter", type_="CHAT", valeur="Minou")), "type inconnu refusé")
    verifier("Valeur invalide" in erreur(lambda: M.corriger("a", "ajouter", type_="PERSONNE", valeur="[PERSONNE_1]")), "valeur contenant un marqueur refusée")
    verifier("Action inconnue" in erreur(lambda: M.corriger("a", "supprimer")), "action inconnue refusée")


def test_serveur():
    print("\nL4-4. Serveur : route de correction, export des valeurs fermé par défaut")
    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from starlette.testclient import TestClient
    except Exception as exc:
        print(f"  --   non lancé (module httpx absent : {type(exc).__name__})")
        return
    import importlib
    os.environ.update(ANON_SECRET_KEY=Fernet.generate_key().decode(), ANON_API_KEY="cle-test", ANON_DB=os.path.join(TMP, "srv.db"),
                      ANON_CONFIG_DIR=CONF, ANON_LOG_LEVEL="WARNING", ANON_EXPORT_VALEURS="0")
    from app import main
    main = importlib.reload(main)
    h = {"X-API-Key": "cle-test"}
    with TestClient(main.app) as client:
        verifier(client.get("/api/sante").json()["version"] == main.VERSION, f"version annoncée : {main.VERSION}")
        client.post("/api/anonymiser", headers=h, json={"texte": "Courrier de Jean DUPONT.", "dossier": "web", "options": {"ner": False}})
        r = client.post("/api/dossiers/web/corriger", headers=h, json={"action": "ajouter", "type": "SOCIETE", "valeur": "Brivane"})
        verifier(r.status_code == 200 and r.json()["marqueur"] == "[SOCIETE_1]" and "Brivane" not in r.text, "route corriger : marqueur seul dans la réponse")
        r = client.post("/api/dossiers/web/corriger", headers=h, json={"action": "exclure", "marqueurs": ["[PERSONNE_7]"]})
        verifier(r.status_code == 400 and "inconnu" in r.json()["erreur"], "route corriger : erreur explicite")
        r = client.get("/api/dossiers/web/entites?valeurs=1", headers=h)
        verifier(r.status_code == 403, "export des valeurs réelles refusé par défaut")
        r = client.get("/api/dossiers/web/entites", headers=h)
        verifier(r.status_code == 200 and "DUPONT" not in r.text, "liste des marqueurs sans valeurs toujours disponible")
        main.EXPORT_VALEURS = True
        verifier(client.get("/api/dossiers/web/entites?valeurs=1", headers=h).status_code == 200, "export possible si le réglage l'autorise")


def lancer() -> list[str]:
    ECHECS.clear()
    for t in (test_fusionner, test_exclure_reinclure, test_ajouter, test_serveur):
        t()
    return list(ECHECS)


def test_tout():
    assert not lancer(), ECHECS


if __name__ == "__main__":
    echecs = lancer()
    print("\nRésultat :", "TOUT EST OK" if not echecs else f"{len(echecs)} échec(s)")
    sys.exit(1 if echecs else 0)
