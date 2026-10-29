# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Configuration du proxy, lue depuis les variables d'environnement (préfixe PSEUDO_PROXY_).

Toutes les valeurs ont un défaut sûr : écoute sur 127.0.0.1 uniquement, table de
correspondance en mémoire seule, restitution activée, audit sans valeurs réelles.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:  # python-dotenv est optionnel : sans lui, seules les variables d'environnement comptent
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - dépendance optionnelle
    load_dotenv = None  # type: ignore[assignment]

#: Catégories de données prises en charge (ordre d'affichage).
ALL_CATEGORIES: tuple[str, ...] = (
    "PERSONNE",
    "SOCIETE",
    "EMAIL",
    "TEL",
    "ADRESSE",
    "NIR",
    "IBAN",
    "CB",
    "SIREN",
    "SIRET",
    "DATE_NAISSANCE",
    "ID_CLIENT",
    "URL",
    "UTILISATEUR",
    "IP",
    "RG",
    "PORTALIS",
    "RPPS",
    "SINISTRE",
    "IMMATRICULATION",
)

_TRUE = {"1", "true", "yes", "on", "oui", "vrai"}
_FALSE = {"0", "false", "no", "off", "non", "faux", ""}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    val = raw.strip().lower()
    if val in _TRUE:
        return True
    if val in _FALSE:
        return False
    raise ValueError(f"{name} doit valoir true/false, reçu : {raw!r}")


def _env_int(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} doit être un entier, reçu : {raw!r}") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} doit être >= {minimum}")
    return value


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} doit être un nombre, reçu : {raw!r}") from exc


def _env_set(name: str) -> set[str]:
    raw = os.environ.get(name, "")
    items = {item.strip().upper() for item in raw.replace(";", ",").split(",")}
    items.discard("")
    unknown = items - set(ALL_CATEGORIES)
    if unknown:
        raise ValueError(
            f"{name} contient des catégories inconnues : {', '.join(sorted(unknown))}. "
            f"Catégories possibles : {', '.join(ALL_CATEGORIES)}"
        )
    return items


@dataclass
class Settings:
    """Paramètres du proxy. Voir .env.example pour la description de chaque variable."""

    bind_host: str = "127.0.0.1"
    port: int = 8080
    upstream_base_url: str = "https://api.anthropic.com"
    upstream_timeout: float = 600.0  # lecture (streaming long)
    connect_timeout: float = 10.0
    max_body_bytes: int = 64 * 1024 * 1024
    mapping_ttl_seconds: int = 30 * 60
    restore_enabled: bool = True
    audit_enabled: bool = True
    log_level: str = "INFO"
    log_file: str | None = None
    categories_allow: set[str] = field(default_factory=set)  # vide = toutes
    categories_deny: set[str] = field(default_factory=set)
    pseudonymize_tool_inputs: bool = True
    pdf_guard_mode: str = "replace"  # replace | block | off
    pdf_guard_max_bytes: int = 25 * 1024 * 1024
    api_token: str = ""
    api_cors_origin_regex: str = r"^(chrome-extension://[a-z]+|moz-extension://[0-9a-f-]+|https://claude\.ai)$"
    strict_person_detection: bool = False  # True : seules les formes avec civilité ou NOM en capitales

    @classmethod
    def from_env(cls, dotenv_path: str | os.PathLike[str] | None = None) -> "Settings":
        """Construit la configuration depuis l'environnement (et un éventuel fichier .env)."""
        if load_dotenv is not None:
            if dotenv_path is not None:
                load_dotenv(dotenv_path, override=False)
            else:
                candidate = Path.cwd() / ".env"
                if candidate.is_file():
                    load_dotenv(candidate, override=False)

        settings = cls(
            bind_host=os.environ.get("PSEUDO_PROXY_BIND_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=_env_int("PSEUDO_PROXY_PORT", 8080, minimum=1),
            upstream_base_url=os.environ.get("PSEUDO_PROXY_UPSTREAM_URL", "https://api.anthropic.com").rstrip("/"),
            upstream_timeout=_env_float("PSEUDO_PROXY_UPSTREAM_TIMEOUT", 600.0),
            connect_timeout=_env_float("PSEUDO_PROXY_CONNECT_TIMEOUT", 10.0),
            max_body_bytes=_env_int("PSEUDO_PROXY_MAX_BODY_MB", 64, minimum=1) * 1024 * 1024,
            mapping_ttl_seconds=_env_int("PSEUDO_PROXY_MAPPING_TTL_SECONDS", 1800, minimum=10),
            restore_enabled=_env_bool("PSEUDO_PROXY_RESTORE", True),
            audit_enabled=_env_bool("PSEUDO_PROXY_AUDIT", True),
            log_level=os.environ.get("PSEUDO_PROXY_LOG_LEVEL", "INFO").upper(),
            log_file=os.environ.get("PSEUDO_PROXY_LOG_FILE") or None,
            categories_allow=_env_set("PSEUDO_PROXY_CATEGORIES_ALLOW"),
            categories_deny=_env_set("PSEUDO_PROXY_CATEGORIES_DENY"),
            pseudonymize_tool_inputs=_env_bool("PSEUDO_PROXY_TOOL_INPUTS", True),
            pdf_guard_mode=os.environ.get("PSEUDO_PROXY_PDF_GUARD", "replace").strip().lower() or "replace",
            pdf_guard_max_bytes=_env_int("PSEUDO_PROXY_PDF_GUARD_MAX_MB", 25, minimum=1) * 1024 * 1024,
            api_token=os.environ.get("PSEUDO_PROXY_API_TOKEN", "").strip(),
            strict_person_detection=_env_bool("PSEUDO_PROXY_STRICT_PERSONS", False),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.pdf_guard_mode not in {"replace", "block", "off"}:
            raise ValueError("PSEUDO_PROXY_PDF_GUARD doit valoir replace, block ou off")
        if not self.upstream_base_url.startswith(("http://", "https://")):
            raise ValueError("PSEUDO_PROXY_UPSTREAM_URL doit commencer par http:// ou https://")
        if self.bind_host not in {"127.0.0.1", "localhost", "::1"}:
            # Autorisé mais signalé : le proxy manipule des données en clair.
            import logging

            logging.getLogger("pseudo_proxy").warning(
                "PSEUDO_PROXY_BIND_HOST=%s : le proxy sera joignable depuis d'autres machines. "
                "Protégez l'accès (pare-feu, réseau privé) : les données transitent en clair.",
                self.bind_host,
            )

    def category_enabled(self, category: str) -> bool:
        category = category.upper()
        if self.categories_allow and category not in self.categories_allow:
            return False
        return category not in self.categories_deny

    def enabled_categories(self) -> list[str]:
        return [c for c in ALL_CATEGORIES if self.category_enabled(c)]

    def public_dict(self) -> dict:
        """Représentation sans secret, pour /health et l'audit."""
        return {
            "bind_host": self.bind_host,
            "port": self.port,
            "upstream_base_url": self.upstream_base_url,
            "mapping_ttl_seconds": self.mapping_ttl_seconds,
            "restore_enabled": self.restore_enabled,
            "audit_enabled": self.audit_enabled,
            "pseudonymize_tool_inputs": self.pseudonymize_tool_inputs,
            "pdf_guard_mode": self.pdf_guard_mode,
            "max_body_bytes": self.max_body_bytes,
            "categories": self.enabled_categories(),
            "api_token_required": bool(self.api_token),
        }
