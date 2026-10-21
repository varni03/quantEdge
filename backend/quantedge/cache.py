"""Response caches: in-process TTL cache, or Redis when a client is supplied."""
from __future__ import annotations

import json
import time
from typing import Any


class MemoryCache:
    def __init__(self, ttl: float = 300.0):
        self.ttl = ttl
        self._d: dict[str, tuple[float, str]] = {}

    def get(self, key: str) -> Any | None:
        hit = self._d.get(key)
        if hit is None:
            return None
        if time.monotonic() - hit[0] > self.ttl:
            del self._d[key]
            return None
        return json.loads(hit[1])

    def set(self, key: str, value: Any) -> None:
        self._d[key] = (time.monotonic(), json.dumps(value))


class RedisCache:
    def __init__(self, client, ttl: int = 300, prefix: str = "quantedge:"):
        self.client, self.ttl, self.prefix = client, int(ttl), prefix

    def get(self, key: str) -> Any | None:
        raw = self.client.get(self.prefix + key)
        return None if raw is None else json.loads(raw)

    def set(self, key: str, value: Any) -> None:
        self.client.set(self.prefix + key, json.dumps(value), ex=self.ttl)
