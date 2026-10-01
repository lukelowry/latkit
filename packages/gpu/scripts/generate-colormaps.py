"""Regenerate published palette tables. Python stdlib only; never executes upstream Python.
Run from any directory: python packages/gpu/scripts/generate-colormaps.py
Sources are pinned and cached under output/color-sources; builds do not require Python/network.
"""
import ast
import hashlib
import json
import math
import re
import struct
import urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / 'output/color-sources'
OUT = ROOT / 'packages/gpu/src/colors/presets'
CACHE.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
SOURCES = {'matplotlib': ('matplotlib/matplotlib', '4aeb773422464799998d900198b35cb80e94b3e1'), 'seaborn': ('mwaskom/seaborn', '9521ea1f29b5ce1df1aa2ed6f65f3bd1c63884bb'), 'cmcrameri': ('callumrollo/cmcrameri', '78f02a088fa3c4fb4cb8aa92bd8e52389ab9d09a'), 'cmocean': ('matplotlib/cmocean', '59c35002c3aa5296b65d9646e52604c627441eb6'), 'd3': ('d3/d3-scale-chromatic', '2c52792197299346b7bdb94322bb4dff8f554fea')}
files = {}
entries = {}

def fetch(source, path):
    repo, revision = SOURCES[source]
    url = f'https://raw.githubusercontent.com/{repo}/{revision}/{path}'
    cached = CACHE / (hashlib.sha256(url.encode()).hexdigest() + '.txt')
    if not cached.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'latkit-colormaps'})
        with urllib.request.urlopen(request, timeout=30) as response:
            cached.write_bytes(response.read())
    data = cached.read_bytes()
    files[url] = hashlib.sha256(data).hexdigest()
    return (data.decode('utf-8'), url)

def literals(text):
    values = {}
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign):
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, TypeError, SyntaxError):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    values[target.id] = value
    return values

def add(name, label, kind, colors, url):
    assert 1 <= len(colors) <= 16384
    assert all((len(c) == 3 and all((math.isfinite(v) and 0 <= v <= 1 for v in c)) for c in colors)), name
    packed = b''.join((struct.pack('<ddd', *c) for c in colors))
    entries[name] = {'label': label, 'kind': kind, 'count': len(colors), 'rgb': json.dumps([v for color in colors for v in color], separators=(',', ':')), 'source': url, 'sha256': hashlib.sha256(packed).hexdigest()}

def rows(text):
    return [[float(v) for v in line.split()] for line in text.splitlines() if line.strip()]
text, url = fetch('matplotlib', 'lib/matplotlib/_cm_listed.py')
listed = literals(text)
for name in ['viridis', 'cividis', 'inferno', 'magma', 'plasma', 'berlin', 'managua', 'vanimo', 'twilight', 'turbo']:
    kind = 'diverging' if name in ['berlin', 'managua', 'vanimo'] else 'cyclic' if name == 'twilight' else 'multihue' if name == 'turbo' else 'sequential'
    add(name, name.capitalize(), kind, listed['_' + name + '_data'], url)
text, url = fetch('matplotlib', 'lib/matplotlib/_cm.py')
maps = literals(text)
for name in ['tab10', 'tab20']:
    add(name, name.capitalize(), 'categorical', maps['_' + name + '_data'], url)
for name, label in [('RdBu', 'Red / Blue'), ('BrBG', 'Brown / Green'), ('PuOr', 'Purple / Orange'), ('PiYG', 'Pink / Green'), ('Spectral', 'Spectral'), ('coolwarm', 'Cool / Warm')]:
    data = maps['_' + name + '_data']
    if isinstance(data, dict):

        def sample(t):
            color = []
            for channel in ['red', 'green', 'blue']:
                stops = data[channel]
                j = next((j for j in range(1, len(stops)) if stops[j][0] >= t), len(stops) - 1)
                a, b = (stops[j - 1], stops[j])
                weight = (t - a[0]) / (b[0] - a[0])
                color.append(a[2] * (1 - weight) + b[1] * weight)
            return color
        colors = [sample(i / 255) for i in range(256)]
    else:
        colors = []
        for i in range(256):
            x = i / 255 * (len(data) - 1)
            j = min(int(x), len(data) - 2)
            f = x - j
            colors.append([data[j][c] * (1 - f) + data[j + 1][c] * f for c in range(3)])
    add(name.lower(), label, 'diverging', colors, url)
for name in ['batlow', 'devon', 'oslo', 'lajolla', 'turku', 'vik', 'broc', 'cork', 'romaO']:
    text, url = fetch('cmcrameri', 'cmcrameri/cmaps/' + name + '.txt')
    kind = 'cyclic' if name == 'romaO' else 'diverging' if name in ['vik', 'broc', 'cork'] else 'sequential'
    add(name.lower(), 'RomaO' if name == 'romaO' else name.capitalize(), kind, rows(text), url)
for name in ['thermal', 'haline', 'deep', 'amp', 'balance', 'phase']:
    text, url = fetch('cmocean', 'cmocean/rgb/' + name + '-rgb.txt')
    add(name, name.capitalize(), 'cyclic' if name == 'phase' else 'diverging' if name == 'balance' else 'sequential', rows(text), url)
text, url = fetch('seaborn', 'seaborn/cm.py')
maps = literals(text)
for name in ['icefire', 'vlag', 'rocket', 'mako', 'flare', 'crest']:
    add(name, name.capitalize(), 'diverging' if name in ['icefire', 'vlag'] else 'sequential', maps['_' + name + '_lut'], url)
for name in ['Tableau10', 'Dark2', 'Set2', 'Paired']:
    text, url = fetch('d3', 'src/categorical/' + name + '.js')
    packed = re.search('colors\\("([0-9a-f]+)"\\)', text).group(1)
    colors = [[int(packed[i + c:i + c + 2], 16) / 255 for c in (0, 2, 4)] for i in range(0, len(packed), 6)]
    add(name.lower(), name, 'categorical', colors, url)
# Published Okabe-Ito palette, ordered for categorical use.
hexes = ['E69F00', '56B4E9', '009E73', 'F0E442', '0072B2', 'D55E00', 'CC79A7', '000000']
add('okabeito', 'Okabe-Ito', 'categorical', [[int(h[c:c + 2], 16) / 255 for c in (0, 2, 4)] for h in hexes], 'https://jfly.uni-koeln.de/color/#pallet')
add('grays', 'Grays', 'sequential', [[0, 0, 0], [1, 1, 1]], 'Latkit: sRGB black to white')
add('amber', 'Amber', 'sequential', [[0.15, 0.08, 0], [1, 0.78, 0.2]], 'Latkit: sRGB amber ramp')
order = {'sequential': 0, 'diverging': 1, 'cyclic': 2, 'categorical': 3, 'multihue': 4}
entries = dict(sorted(entries.items(), key=lambda item: (order[item[1]['kind']], item[0])))
# Keep lossless numeric JSON lazy; it compresses better than encoded binary doubles.
header = '// Generated by scripts/generate-colormaps.py. See provenance.json and THIRD_PARTY_NOTICES.md.\n'
header += "import type { ColormapKind } from '../colormap.js';\n"
header += 'export type ColormapName = ' + ' | '.join((repr(k) for k in entries)) + ';\n'
header += 'interface Preset { readonly label: string; readonly kind: ColormapKind; readonly rgb: string }\n'
body = header + 'export const presets: Readonly<Record<ColormapName, Preset>> = ' + json.dumps({k: {'label': v['label'], 'kind': v['kind'], 'rgb': v['rgb']} for k, v in entries.items()}, ensure_ascii=False, indent=2) + ';\n'
(OUT / 'data.ts').write_text(body, encoding='utf-8')
(OUT / 'provenance.json').write_text(json.dumps({'files': files, 'palettes': {k: {key: value for key, value in v.items() if key != 'rgb'} for k, v in entries.items()}}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
notices = ['# Palette source notices\n\nGenerated data retain the following upstream licenses and attribution.\n']
for source, path in [('matplotlib', 'LICENSE/LICENSE'), ('matplotlib', 'LICENSE/LICENSE_COLORBREWER'), ('seaborn', 'LICENSE.md'), ('cmcrameri', 'LICENSE.txt'), ('cmocean', 'LICENSE.txt'), ('d3', 'LICENSE')]:
    text, url = fetch(source, path)
    notices.append(f'\n## {source}: {path}\n\nSource: {url}\n\n```text\n{text.rstrip()}\n```\n')
notices.append('\n## Okabe-Ito\n\nMasataka Okabe and Kei Ito, Color Universal Design.\nSource: https://jfly.uni-koeln.de/color/#pallet\n')
(ROOT / 'packages/gpu/THIRD_PARTY_NOTICES.md').write_text(''.join(notices), encoding='utf-8')
print(f"Generated {len(entries)} palettes / {sum((v['count'] for v in entries.values()))} published samples")
