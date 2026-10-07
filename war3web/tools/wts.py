"""Warcraft III's trigger strings.

Anything an author types into the World Editor -- a unit's name, an item's
tooltip, the map's own description -- is not stored in the object data. The
editor puts the text in `war3map.wts` and leaves a reference behind:

    STRING 1013
    {
    Dummy Caster
    }

and the unit table then says `TRIGSTR_1013`. Read the object data without the
string table and the reference is what you display, which is why `TRIGSTR_9662`
turns up in the UI where a name should be.
"""
import os
import re

_WTS = None


def table(path='extracted/war3map.wts'):
    """The map's string table, parsed once."""
    global _WTS
    if _WTS is None:
        _WTS = {}
        if os.path.exists(path):
            txt = open(path, encoding='utf-8-sig').read().replace('\r', '')
            for m in re.finditer(r'STRING (\d+)\s*\{\n(.*?)\n\}', txt, re.S):
                _WTS[int(m.group(1))] = m.group(2)
    return _WTS


def S(v):
    """Resolve one `TRIGSTR_n` reference; anything else passes through."""
    if isinstance(v, str):
        m = re.fullmatch(r'TRIGSTR_(\d+)', v.strip())
        if m:
            return table().get(int(m.group(1)), v)
    return v


def clean(v):
    """Resolve, then drop Warcraft III's colour markup and turn |n into a break."""
    v = S(v)
    if not isinstance(v, str):
        return v
    return re.sub(r'\|c[0-9a-fA-F]{8}|\|r|\|n',
                  lambda m: '\n' if m.group(0) == '|n' else '', v)


def resolve_deep(obj):
    """Resolve every trigger string anywhere inside a nested structure.

    The tables carry text in a dozen fields -- name, proper name, tooltip,
    description, the shop's own label -- and chasing them one at a time is how
    some get missed. Sweeping the whole structure once is both shorter and
    complete.
    """
    if isinstance(obj, str):
        return S(obj)
    if isinstance(obj, list):
        return [resolve_deep(x) for x in obj]
    if isinstance(obj, dict):
        return {k: resolve_deep(v) for k, v in obj.items()}
    return obj
