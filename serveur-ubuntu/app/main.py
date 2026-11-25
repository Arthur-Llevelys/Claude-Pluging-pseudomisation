# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
# Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
"""
Serveur d'anonymisation — API REST + interface web.

Lancement : uvicorn app.main:app --host 0.0.0.0 --port 8765
Configuration par variables d'environnement (voir anonymiseur.env.exemple).
"""
from __future__ import annotations

import contextlib
import hmac
import json
import logging
import os
import re
import time
from pathlib import Path
from urllib.parse import quote

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

from . import detect as D
from .engine import Moteur
from .fichiers import EXTENSIONS, extraire_texte, ocr_disponible, texte_vers_docx
from .store import Store

VERSION = "1.3.0"
logging.basicConfig(level=os.environ.get("ANON_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("anonymiseur")

API_KEY = os.environ.get("ANON_API_KEY", "")
SECRET = os.environ.get("ANON_SECRET_KEY", "")
DB = os.environ.get("ANON_DB", "/var/lib/anonymiseur/correspondances.db")
CONF = os.environ.get("ANON_CONFIG_DIR", "/etc/anonymiseur")
RETENTION = int(os.environ.get("ANON_RETENTION_DAYS", "30"))
MAX_MO = int(os.environ.get("ANON_MAX_UPLOAD_MB", "25"))
# Export en masse des valeurs réelles d'un dossier (écran « Dossiers » de l'interface web) : fermé par défaut
EXPORT_VALEURS = os.environ.get("ANON_EXPORT_VALEURS", "0").lower() in {"1", "true", "oui"}
STATIC = Path(__file__).parent / "static"

if not SECRET:
    raise SystemExit("ANON_SECRET_KEY manquante : lancez install.sh ou générez une clé Fernet.")
if not API_KEY:
    log.warning("ANON_API_KEY vide : l'API est accessible sans clé depuis le réseau local !")

store = Store(DB, SECRET, RETENTION)
listes = D.Listes.charger(CONF)
moteur = Moteur(store, listes)
_derniere_purge = [0.0]

# Journal : on ne journalise JAMAIS le contenu des textes, seulement des volumes.


SAUVEGARDE = DB + ".avant-mise-a-jour"


def _nettoyer_sauvegarde():
    """La copie de sécurité faite par install.sh avant une mise à jour ne survit pas à la durée
    de conservation : elle contient les mêmes correspondances (chiffrées) que la base."""
    with contextlib.suppress(OSError):
        if time.time() - os.path.getmtime(SAUVEGARDE) > RETENTION * 86400:
            os.remove(SAUVEGARDE)
            log.info("Copie de sécurité d'avant mise à jour supprimée (durée de conservation dépassée)")


def _purge_eventuelle():
    if time.time() - _derniere_purge[0] > 3600:
        _derniere_purge[0] = time.time()
        n = store.purger()
        if n:
            log.info("Purge : %d dossier(s) inactif(s) supprimé(s)", n)
        _nettoyer_sauvegarde()


class Authentification(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/api/") and request.url.path != "/api/sante" and API_KEY:
            fournie = request.headers.get("x-api-key", "")
            if not hmac.compare_digest(fournie.encode(), API_KEY.encode()):
                return JSONResponse({"erreur": "Clé d'API invalide ou absente (en-tête X-API-Key)."}, status_code=401)
        reponse = await call_next(request)
        reponse.headers["Cache-Control"] = "no-store"
        reponse.headers["X-Content-Type-Options"] = "nosniff"
        reponse.headers["Referrer-Policy"] = "no-referrer"
        return reponse


def erreur(message: str, code: int = 400) -> JSONResponse:
    return JSONResponse({"erreur": message}, status_code=code)


async def _json(request: Request) -> dict:
    try:
        return await request.json()
    except Exception:
        raise ValueError("Corps JSON invalide.")


def _options(brut) -> dict:
    if isinstance(brut, str):
        brut = json.loads(brut) if brut.strip() else {}
    brut = brut or {}
    types = brut.get("types")
    if types is not None:
        types = [t for t in types if t in D.TYPES]
    def lignes(valeur) -> list[str]:
        if isinstance(valeur, str):
            valeur = valeur.splitlines()
        return [t for t in (valeur or []) if isinstance(t, str) and t.strip()]

    return {"types": types, "toutes_dates": bool(brut.get("toutes_dates")),
            "termes": lignes(brut.get("termes")),      # à masquer en plus, pour cette demande
            "jamais": lignes(brut.get("jamais")),      # à ne pas masquer, pour cette demande
            "consigne": bool(brut.get("consigne")), "ner": brut.get("ner", True)}


# --------------------------------------------------------------------------
async def accueil(request: Request):
    return FileResponse(STATIC / "index.html")


async def sante(request: Request):
    return JSONResponse({"ok": True, "version": VERSION, "spacy": D.etat_spacy(),
                         "types": D.TYPES, "types_par_defaut": D.TYPES_PAR_DEFAUT,
                         "extensions": sorted(EXTENSIONS), "cle_requise": bool(API_KEY), "ocr": bool(ocr_disponible())})


async def anonymiser(request: Request):
    _purge_eventuelle()
    try:
        corps = await _json(request)
        texte = corps.get("texte") or ""
        if not isinstance(texte, str) or not texte.strip():
            return erreur("Le champ « texte » est vide.")
        r = moteur.anonymiser(texte, corps.get("dossier") or "general", _options(corps.get("options")),
                              inclure_valeurs=bool(corps.get("inclure_valeurs")))
        log.info("anonymiser dossier=%s car=%d remplacements=%d", r["dossier"], len(texte), r["nb_remplacements"])
        return JSONResponse(r)
    except ValueError as e:
        return erreur(str(e))


async def anonymiser_fichier(request: Request):
    _purge_eventuelle()
    taille = int(request.headers.get("content-length") or 0)
    if taille > MAX_MO * 1024 * 1024:
        return erreur(f"Fichier trop volumineux (max {MAX_MO} Mo).", 413)
    try:
        form = await request.form(max_files=1, max_part_size=MAX_MO * 1024 * 1024)
        fichier = form.get("fichier")
        if fichier is None or not hasattr(fichier, "read"):
            return erreur("Champ « fichier » manquant.")
        data = await fichier.read()
        nom = fichier.filename or "document.txt"
        texte, avert = extraire_texte(nom, data)
        if not texte.strip():
            return erreur("Aucun texte exploitable dans ce fichier. " + " ".join(avert))
        r = moteur.anonymiser(texte, form.get("dossier") or "general", _options(form.get("options") or "{}"),
                              inclure_valeurs=str(form.get("inclure_valeurs", "")).lower() in {"1", "true", "oui"})
        r["avertissements"] = avert + r["avertissements"]
        r["nb_caracteres"] = len(texte)
        log.info("anonymiser-fichier dossier=%s ext=%s car=%d remplacements=%d",
                 r["dossier"], nom.rsplit(".", 1)[-1], len(texte), r["nb_remplacements"])
        return JSONResponse(r)
    except ValueError as e:
        return erreur(str(e))


async def reidentifier(request: Request):
    try:
        corps = await _json(request)
        r = moteur.reidentifier(corps.get("texte") or "", corps.get("dossier") or "general")
        log.info("reidentifier dossier=%s remplacements=%d", r["dossier"], r["nb_remplacements"])
        return JSONResponse(r)
    except ValueError as e:
        return erreur(str(e))


async def reidentifier_fichier(request: Request):
    """Ré-identifie et renvoie un fichier (docx, md ou txt) — le texte en clair
    ne transite que dans le corps binaire de la réponse."""
    try:
        corps = await _json(request)
        fmt = (corps.get("format") or "docx").lower()
        if fmt not in {"docx", "md", "txt"}:
            return erreur("Format attendu : docx, md ou txt.")
        r = moteur.reidentifier(corps.get("texte") or "", corps.get("dossier") or "general")
        nom = re.sub(r"[^\w\-. ]", "_", corps.get("nom") or "document")[:80] or "document"
        if fmt == "docx":
            data = texte_vers_docx(r["texte"], titre=nom)
            mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            data = r["texte"].encode("utf-8")
            mime = "text/markdown; charset=utf-8" if fmt == "md" else "text/plain; charset=utf-8"
        return Response(data, media_type=mime, headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(nom)}.{fmt}",
            "X-Remplacements": str(r["nb_remplacements"]),
            "X-Marqueurs-Inconnus": ",".join(r["marqueurs_inconnus"]),
        })
    except ValueError as e:
        return erreur(str(e))


async def dossiers(request: Request):
    return JSONResponse({"dossiers": store.lister_dossiers(), "retention_jours": RETENTION})


async def dossier_entites(request: Request):
    try:
        d = store.valider_dossier(request.path_params["dossier"])
    except ValueError as e:
        return erreur(str(e))
    avec = request.query_params.get("valeurs") in {"1", "true", "oui"}
    if avec and not EXPORT_VALEURS:
        return erreur("Export des valeurs réelles désactivé sur ce serveur (réglage ANON_EXPORT_VALEURS).", 403)
    return JSONResponse({"dossier": d, "entites": store.entites(d, avec)})


async def dossier_corriger(request: Request):
    """Corrections d'un dossier (fusionner, exclure, reinclure, ajouter) : la réponse ne contient que des marqueurs."""
    try:
        d = store.valider_dossier(request.path_params["dossier"])
        corps = await _json(request)
        r = moteur.corriger(d, str(corps.get("action") or ""), corps.get("marqueurs"), corps.get("type"), corps.get("valeur"))
        log.info("corriger dossier=%s action=%s", d, r["action"])
        return JSONResponse(dict(r, ok=True, dossier=d))
    except ValueError as e:
        return erreur(str(e))


async def dossier_supprimer(request: Request):
    try:
        d = store.valider_dossier(request.path_params["dossier"])
    except ValueError as e:
        return erreur(str(e))
    store.supprimer(d)
    log.info("dossier supprimé : %s", d)
    return JSONResponse({"ok": True, "dossier": d})


@contextlib.asynccontextmanager
async def _cycle_de_vie(app):
    D.charger_spacy()  # chargement du modèle au démarrage (quelques secondes)
    store.purger()
    _nettoyer_sauvegarde()
    log.info("Anonymiseur %s prêt — spaCy : %s", VERSION, D.etat_spacy())
    yield


app = Starlette(
    routes=[
        Route("/", accueil),
        Route("/api/sante", sante),
        Route("/api/anonymiser", anonymiser, methods=["POST"]),
        Route("/api/anonymiser-fichier", anonymiser_fichier, methods=["POST"]),
        Route("/api/reidentifier", reidentifier, methods=["POST"]),
        Route("/api/reidentifier-fichier", reidentifier_fichier, methods=["POST"]),
        Route("/api/dossiers", dossiers),
        Route("/api/dossiers/{dossier}/entites", dossier_entites),
        Route("/api/dossiers/{dossier}/corriger", dossier_corriger, methods=["POST"]),
        Route("/api/dossiers/{dossier}", dossier_supprimer, methods=["DELETE"]),
    ],
    middleware=[Middleware(Authentification)],
    lifespan=_cycle_de_vie,
)
