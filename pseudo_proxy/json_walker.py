# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Parcours des requêtes et réponses de l'API Anthropic Messages.

On collecte des références vers chaque champ texte à traiter, pour pouvoir le relire puis
le réécrire en place :
- requête : `system` (chaîne ou blocs), `messages[].content` (chaîne ou blocs `text`,
  `tool_result.content`, `tool_use.input` en option) ;
- réponse : `content[]` (blocs `text`, `tool_use.input`).

Les blocs `thinking` / `redacted_thinking` ne sont jamais modifiés : leur signature doit
rester vérifiable par l'API. Les images, documents (traités par le garde PDF), définitions
d'outils et métadonnées ne sont pas touchés.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class TextRef:
    container: Any  # dict ou list
    key: Any  # clé ou indice

    def get(self) -> str:
        return self.container[self.key]

    def set(self, value: str) -> None:
        self.container[self.key] = value


def _walk_json_strings(obj: Any, refs: list[TextRef]) -> None:
    """Toutes les chaînes d'un objet JSON (valeurs uniquement, pas les clés)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                refs.append(TextRef(obj, k))
            elif isinstance(v, (dict, list)):
                _walk_json_strings(v, refs)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                refs.append(TextRef(obj, i))
            elif isinstance(v, (dict, list)):
                _walk_json_strings(v, refs)


def _collect_blocks(container: Any, key: Any, refs: list[TextRef], tool_inputs: bool) -> None:
    content = container.get(key) if isinstance(container, dict) else None
    if isinstance(content, str):
        refs.append(TextRef(container, key))
        return
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text" and isinstance(block.get("text"), str):
            refs.append(TextRef(block, "text"))
        elif btype == "tool_result":
            _collect_blocks(block, "content", refs, tool_inputs)
        elif btype == "tool_use" and tool_inputs:
            inp = block.get("input")
            if isinstance(inp, (dict, list)):
                _walk_json_strings(inp, refs)
        # thinking, redacted_thinking, image, document, server_tool_use... : ignorés


def collect_request_texts(body: dict, tool_inputs: bool = True) -> list[TextRef]:
    refs: list[TextRef] = []
    if isinstance(body.get("system"), str):
        refs.append(TextRef(body, "system"))
    elif isinstance(body.get("system"), list):
        for block in body["system"]:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                refs.append(TextRef(block, "text"))
    messages = body.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                _collect_blocks(msg, "content", refs, tool_inputs)
    return refs


def collect_response_texts(body: dict) -> list[TextRef]:
    refs: list[TextRef] = []
    content = body.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text" and isinstance(block.get("text"), str):
                refs.append(TextRef(block, "text"))
            elif btype == "tool_use":
                inp = block.get("input")
                if isinstance(inp, (dict, list)):
                    _walk_json_strings(inp, refs)
    return refs


def iter_pdf_documents(body: dict):
    """Génère (liste_parent, indice, bloc) pour chaque bloc document PDF en base64 de la requête."""
    messages = body.get("messages")
    if not isinstance(messages, list):
        return
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for i, block in enumerate(content):
            if _is_pdf_block(block):
                yield content, i, block
            elif isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("content"), list):
                sub = block["content"]
                for j, sb in enumerate(sub):
                    if _is_pdf_block(sb):
                        yield sub, j, sb


def _is_pdf_block(block: Any) -> bool:
    if not isinstance(block, dict) or block.get("type") != "document":
        return False
    source = block.get("source")
    return (
        isinstance(source, dict)
        and source.get("type") == "base64"
        and source.get("media_type") == "application/pdf"
        and isinstance(source.get("data"), str)
    )
