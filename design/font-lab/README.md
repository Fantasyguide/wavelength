# Offline font lab

The standalone HTML uses the real monitor markup and CSS at a fixed 3904 × 672 iframe viewport. It does not contain the game client, contact a game server, or load remote resources.

Build with Python 3, `fonttools` and `brotli` installed:

```sh
python3 scripts/build-font-lab.py /tmp/Wavelength-Font-Lab.html
```

Open the output file directly. Fonts can be selected by installed family name, loaded from a local font file, or enumerated with the browser's optional Local Font Access API. Enumeration requires a supported browser and user permission; file import and family-name entry remain available when enumeration is blocked.

The default scheme matches the current game: PingXian team names (116px), YaShi concepts (100px / 72px), FZCYSJW phase labels (56px), Source Han Bold scores (208px), and 64px timers. The straight gray direction arrow remains inside its team frame. Current team colors, translucent panels, the coin pattern, and five fixed avatars are embedded.

The artifact embeds the original YanSong face, the existing numeric/Latin faces, and small specimen subsets of PingXian, YaShi, FZCYSJW, Old Mincho, Source Han and WenKai. Their license texts remain in the artifact payload. The subset faces have distinct internal names; missing specimen characters use installed fallback fonts. Loading a local font file uses the complete provided font.

Settings can be exported/imported as versioned JSON or exported as CSS. “Save current HTML” embeds the current settings and imported fonts in another standalone file. JSON stores parameters and filenames, not font binaries. Browser storage is best effort and never required.

Source files are `index.html`, `lab.css` and `lab.js`. The generated HTML is a downloadable artifact, not an additional game route.

The editor supports per-region font, size, weight, spacing, line height, color, italic/synthetic bold and a small text stroke. Team, spectrum, cursor and direction-arrow colors can be changed globally. A/B comparison, editable sample text and 100% display remain available. The new baseline uses a separate local-storage key so an old lab does not silently replace the latest default scheme. Earlier version-1 JSON files remain importable; new groups and fields use current defaults if omitted.
