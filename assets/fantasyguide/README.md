# Fantasyguide UI assets

Reference: [Nipporita/fantasyguide_statics](https://github.com/Nipporita/fantasyguide_statics/tree/44ec85e7dca92780555453a801018521f0695735), pinned to `44ec85e7dca92780555453a801018521f0695735`.

- `ZaoZiGongFangYanSongTi-1.otf`: the original YanSong font used by the site's `template.css`.
- `imperial_coin_pattern.svg`, `Yin.svg`, `Yang.svg`: original background and separator artwork from `images/`.
- `panel-border.svg`: the light-theme `--fantasy-guide-div-1-border-image` SVG decoded from `template/normal.css`.

`app.css` adapts the stepped panel borders, monochrome palette, typography and ornaments to Wavelength. Layout reference: [Fourth Righter / 四权家异变](https://github.com/Nipporita/danmaku-app/tree/336ebe3d1eaa1da830ffde4c36414ce2a07def6b/danmaku-frontend).

These assets are served locally so the UI does not depend on remote font or image CDNs. Include this directory when copying or deploying the game.
