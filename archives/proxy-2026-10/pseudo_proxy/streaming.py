# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Restitution des marqueurs dans un flux Server-Sent Events de l'API Messages.

Les événements `content_block_delta` de type `text_delta` (texte) et `input_json_delta`
(arguments d'outils, fragments de JSON) sont traités. Un marqueur peut être coupé entre deux
fragments (« [PERSON » puis « NE_1] ») : le début possible d'un marqueur est retenu jusqu'au
fragment suivant, et libéré au plus tard à la fin du bloc (`content_block_stop`), sous la
forme d'un événement `content_block_delta` supplémentaire si nécessaire.
"""
from __future__ import annotations

import json

from .engine import Restorer, StreamRestorer


class SSERestoreProcessor:
    """Traite un flux SSE octet par octet et restitue les marqueurs à la volée."""

    def __init__(self, restorer: Restorer):
        self.restorer = restorer
        self.buffer = b""
        self.text_restorers: dict[int, StreamRestorer] = {}
        self.json_restorers: dict[int, StreamRestorer] = {}
        self.restored = 0

    # ------------------------------------------------------------------ API
    def feed(self, data: bytes) -> bytes:
        self.buffer += data
        out: list[bytes] = []
        while True:
            boundary = self._find_boundary()
            if boundary is None:
                break
            end, sep_len = boundary
            raw = self.buffer[: end + sep_len]
            self.buffer = self.buffer[end + sep_len :]
            out.append(self.process_event(raw))
        return b"".join(out)

    def finish(self) -> bytes:
        out: list[bytes] = []
        if self.buffer.strip():
            out.append(self.process_event(self.buffer))
        self.buffer = b""
        for idx, r in list(self.text_restorers.items()):
            tail = r.flush()
            self.restored += r.restored
            if tail:
                out.append(self._delta_event(idx, tail, json_mode=False))
        for idx, r in list(self.json_restorers.items()):
            tail = r.flush()
            self.restored += r.restored
            if tail:
                out.append(self._delta_event(idx, tail, json_mode=True))
        self.text_restorers.clear()
        self.json_restorers.clear()
        return b"".join(out)

    # ------------------------------------------------------------------ interne
    def _find_boundary(self) -> tuple[int, int] | None:
        i_lf = self.buffer.find(b"\n\n")
        i_crlf = self.buffer.find(b"\r\n\r\n")
        candidates = [(i, n) for i, n in ((i_lf, 2), (i_crlf, 4)) if i >= 0]
        if not candidates:
            return None
        return min(candidates)

    @staticmethod
    def _delta_event(index: int, text: str, json_mode: bool) -> bytes:
        if json_mode:
            delta = {"type": "input_json_delta", "partial_json": text}
        else:
            delta = {"type": "text_delta", "text": text}
        payload = json.dumps({"type": "content_block_delta", "index": index, "delta": delta}, ensure_ascii=False)
        return f"event: content_block_delta\ndata: {payload}\n\n".encode("utf-8")

    def process_event(self, raw: bytes) -> bytes:
        text = raw.decode("utf-8", errors="replace")
        lines = text.replace("\r\n", "\n").split("\n")
        data_lines: list[str] = []
        other_lines: list[str] = []
        for line in lines:
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
            elif line.strip():
                other_lines.append(line)
        if not data_lines:
            return raw
        try:
            obj = json.loads("\n".join(data_lines))
        except ValueError:
            return raw
        if not isinstance(obj, dict):
            return raw

        etype = obj.get("type")
        if etype == "content_block_delta":
            index = obj.get("index", 0)
            delta = obj.get("delta")
            if not isinstance(delta, dict):
                return raw
            if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
                r = self.text_restorers.get(index)
                if r is None:
                    r = self.text_restorers[index] = StreamRestorer(self.restorer)
                delta["text"] = r.feed(delta["text"])
            elif delta.get("type") == "input_json_delta" and isinstance(delta.get("partial_json"), str):
                r = self.json_restorers.get(index)
                if r is None:
                    r = self.json_restorers[index] = StreamRestorer(self.restorer, json_string=True)
                delta["partial_json"] = r.feed(delta["partial_json"])
            else:
                return raw
            return self._encode(other_lines, obj)

        if etype == "content_block_stop":
            index = obj.get("index", 0)
            prefix = b""
            r = self.text_restorers.pop(index, None)
            if r is not None:
                tail = r.flush()
                self.restored += r.restored
                if tail:
                    prefix += self._delta_event(index, tail, json_mode=False)
            r = self.json_restorers.pop(index, None)
            if r is not None:
                tail = r.flush()
                self.restored += r.restored
                if tail:
                    prefix += self._delta_event(index, tail, json_mode=True)
            return prefix + raw

        return raw

    @staticmethod
    def _encode(other_lines: list[str], obj: dict) -> bytes:
        payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        head = "\n".join(other_lines)
        if head:
            head += "\n"
        return f"{head}data: {payload}\n\n".encode("utf-8")
