#!/usr/bin/env python3
"""Build the offline, single-file font lab. Requires fonttools[woff]."""
import argparse
import base64
import io
import json
from pathlib import Path
import re

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'design/font-lab'
ASSETS = ROOT / 'assets/fantasyguide'


def uri(data, mime):
    return 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')


def font_subset(path, characters, family):
    font = TTFont(path)
    covered = sorted(set(font.getBestCmap()).intersection(map(ord, characters)))
    if not covered:
        return None
    options = subset.Options()
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=covered)
    sub.subset(font)
    # These reduced specimen faces retain the original copyright/license names.
    # Distinct family names avoid presenting a reduced face as a complete font.
    for record in font['name'].names:
        if record.nameID in (1, 3, 4, 6, 16):
            record.string = family.replace(' ', '') if record.nameID == 6 else family
    font.flavor = 'woff2'
    output = io.BytesIO()
    font.save(output)
    return output.getvalue(), covered


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    template = (SOURCE / 'index.html').read_text()
    javascript = (SOURCE / 'lab.js').read_text()
    game_html = (ROOT / 'index.html').read_text()
    start = game_html.index('<div class="wrap">')
    end = game_html.index('\n<div class="modal-mask', start)
    markup = game_html[start:end].strip()
    css = re.sub(r'@font-face\s*\{[^}]*\}', '', (ROOT / 'app.css').read_text())

    def embed_asset(match):
        path = ROOT / match.group(1)
        if path.suffix != '.svg':
            raise ValueError('Unexpected non-SVG CSS asset: ' + str(path))
        return 'url("' + uri(path.read_bytes(), 'image/svg+xml') + '")'

    css = re.sub(r'url\([\'\"]?(assets/[^)\'\"]+)[\'\"]?\)', embed_asset, css)
    characters = template + javascript + markup + ''.join(chr(n) for n in range(32, 127))
    fonts = [{
        'family': 'Wavelength Song', 'weight': 400,
        'uri': uri((ASSETS / 'ZaoZiGongFangYanSongTi-1.otf').read_bytes(), 'font/otf')
    }]
    for filename, family, weight in [
        ('FZPingXianYaSong-Regular.woff2', 'Wavelength PingXian', 400),
        ('FZYaShiHei-Medium.woff2', 'Wavelength YaShi', 500),
        ('FZCYSJW.woff2', 'FZYaSongS-B-GB', 400),
        ('FZFWZhuZiAOldMinchoD.woff2', 'Wavelength Old Mincho', 600),
    ]:
        data, _ = font_subset(ASSETS / filename, characters, 'WL Lab ' + family + ' Specimen')
        fonts.append({'family': family, 'weight': weight, 'uri': uri(data, 'font/woff2')})
    fonts.append({'family': 'Wavelength Score', 'weight': 700,
                  'uri': uri((ASSETS / 'SourceHanSerifCN-Bold-Numeric.woff2').read_bytes(), 'font/woff2')})
    for cut, weight in [('Medium', 500), ('SemiBold', 600)]:
        data, _ = font_subset(ASSETS / f'SourceHanSerifCN-{cut}.woff2', characters, 'WL Lab Source Han ' + cut)
        fonts.append({'family': 'Wavelength Source Han Serif', 'weight': weight, 'uri': uri(data, 'font/woff2')})
    numeric_range = 'U+0025,U+002B-003A,U+003D,U+00B1-00B3,U+00B9,U+00BC-00BE,U+2070-209F,U+2150-218F,U+2212,U+FF05,U+FF0B-FF1A,U+FF1D'
    for cut, weight in [('Regular', 400), ('Bold', 700)]:
        fonts.append({'family': 'Wavelength Numeric', 'weight': weight, 'unicodeRange': numeric_range,
                      'uri': uri((ASSETS / f'WavelengthNumeric-{cut}.woff2').read_bytes(), 'font/woff2')})
        fonts.append({'family': 'Wavelength Sans', 'weight': weight,
                      'uri': uri((ASSETS / f'WavelengthSans-{cut}.woff2').read_bytes(), 'font/woff2')})
    for path in sorted((ASSETS / 'wenkai').glob('*.woff2')):
        result = font_subset(path, characters, 'WL Lab WenKai Specimen')
        if result:
            data, covered = result
            fonts.append({'family': 'Wavelength WenKai', 'weight': 400, 'uri': uri(data, 'font/woff2'),
                          'unicodeRange': ','.join(f'U+{value:04X}' for value in covered)})
    licenses = {name: (ASSETS / name).read_text() for name in ['SourceHanSerif-OFL.txt', 'WenKai-OFL.txt', 'WenKai-LICENSE.txt', 'DejaVu-LICENSE.txt']}
    avatars = [uri((ROOT / 'assets/demo' / (name + '.svg')).read_bytes(), 'image/svg+xml')
               for name in ['reimu', 'marisa', 'sakuya', 'sanae', 'youmu']]
    payload = {'css': css, 'markup': markup, 'fonts': fonts, 'licenses': licenses, 'avatars': avatars,
               'fontNote': 'Chinese sample faces embed the specimen glyphs from the current game fonts. Characters outside the specimen use an installed fallback; importing a local font file embeds its full coverage. Numeric faces, avatars and ornaments are embedded offline.'}
    html = template.replace('/* LAB_CSS */', (SOURCE / 'lab.css').read_text())
    html = html.replace('/* LAB_PAYLOAD */', json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'))
    html = html.replace('/* LAB_JS */', javascript)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html)
    print(f'Built {args.output} ({args.output.stat().st_size:,} bytes, fully offline)')


if __name__ == '__main__':
    main()
