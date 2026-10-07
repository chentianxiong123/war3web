"""Warcraft III's .fdf interface layout files.

The console, the command card and the info panel are not drawn at coordinates
somebody measured off a screenshot: the game ships the layout as text.

    Frame "SIMPLEFRAME" "ConsoleUI" {
        DecorateFileNames,
        Texture {
            File "ConsoleTexture01",
            Width 0.256, Height 0.032,
            TexCoord 0, 1, 0, 0.125,
            Anchor TOPLEFT, 0, 0,
        }
    }

Coordinates are in Warcraft III's screen space, which is not the viewport: the
origin is bottom-left and the axes are normalised against a 4:3 screen, so x
runs 0..0.8 and y runs 0..0.6. `TexCoord` is a sub-rectangle of the texture --
left, right, top, bottom -- which is how four tile files cover a whole console.
`File` names a skin alias rather than a path, and UI\\war3skins.txt resolves it
per race: "ConsoleTexture01" is UI\\Console\\Human\\HumanUITile01 for Human and
something else for the other three.

Parsing rests on one measured fact rather than a guess about the grammar. A
comma is ambiguous -- it separates the values of `TexCoord 0, 1, 0, 0.125,` and
also terminates the statement -- but across all 85 of the game's .fdf files,
13087 statement lines, every line ends in a comma, a brace, or is inside a
block comment. So the line is the statement and the comma is only ever a
separator.

    python3 tools/fdf.py war3_extracted/UI/FrameDef/UI/ConsoleUI.fdf
"""
import json, re, sys

TOKEN = re.compile(r'"([^"]*)"|([{}])|,|([^\s,{}"]+)')
LINE_COMMENT = re.compile(r'//[^\n]*')
BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.S)

# Warcraft III's screen box, for callers turning these into pixels
SCREEN_W, SCREEN_H = 0.8, 0.6


def _tokens(line):
    for m in TOKEN.finditer(line):
        s, brace, word = m.groups()
        if s is not None:
            yield ('str', s)
        elif brace:
            yield ('brace', brace)
        elif word is not None:
            yield ('word', word)


def _value(kind, raw):
    if kind == 'str':
        return raw
    if re.fullmatch(r'-?\d+', raw):
        return int(raw)
    try:
        return float(raw)
    except ValueError:
        return raw


def _open(stack, head):
    words = [r for k, r in head if k == 'word']
    strs = [r for k, r in head if k == 'str']
    inherits = None
    if 'INHERITS' in words:
        # `Texture INHERITS "Template"` and `String "Name" INHERITS "Template"`
        inherits = strs[-1] if strs else None
        strs = strs[:-1]
    blk = {'type': words[0] if words else '?',
           # `Frame "SIMPLEFRAME" "ConsoleUI"`: the first string is the widget
           # kind, the last is always the name
           'kind': strs[0] if len(strs) > 1 else None,
           'name': strs[-1] if strs else None,
           'inherits': inherits, 'props': {}, 'children': []}
    stack[-1]['children'].append(blk)
    stack.append(blk)


def parse(text):
    """-> a list of top-level blocks, each {type, kind, name, inherits, props, children}."""
    text = LINE_COMMENT.sub('', BLOCK_COMMENT.sub('', text))
    # root carries props too: a file may open with `IncludeFile "...",` before
    # any block
    root = {'props': {}, 'children': []}
    stack = [root]
    for line in text.splitlines():
        head = []
        for kind, raw in _tokens(line):
            if kind == 'brace' and raw == '{':
                _open(stack, head)
                head = []
            elif kind == 'brace':
                if len(stack) > 1:
                    stack.pop()
                head = []
            else:
                head.append((kind, raw))
        if not head:
            continue
        key = head[0][1]
        vals = [_value(k, r) for k, r in head[1:]]
        # a bare `DecorateFileNames,` is a flag, not a value
        stack[-1]['props'][key] = True if not vals else (vals[0] if len(vals) == 1 else vals)
    return root['children']


def walk(blocks):
    """Every block, depth first, so a caller can find one by type or name."""
    for b in blocks:
        yield b
        yield from walk(b['children'])


if __name__ == '__main__':
    for path in sys.argv[1:]:
        print(json.dumps(parse(open(path, encoding='latin-1').read()), indent=1))
