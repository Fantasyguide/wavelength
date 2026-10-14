# Fantasyguide UI assets

Reference: [Nipporita/fantasyguide_statics](https://github.com/Nipporita/fantasyguide_statics/tree/44ec85e7dca92780555453a801018521f0695735), pinned to `44ec85e7dca92780555453a801018521f0695735`.

- `ZaoZiGongFangYanSongTi-1.otf`: the original YanSong font used by the site's `template.css`. Used at its native Regular weight (400), without synthetic bold, for section/modal headings and the brand subtitle.
- `imperial_coin_pattern.svg`, `Yin.svg`, `Yang.svg`: original background and separator artwork from `images/`.
- `panel-border.svg`: the light-theme `--fantasy-guide-div-1-border-image` SVG decoded from `template/normal.css`.
- `JinLing.woff2`: lossless WOFF2 conversion of `fonts/FZJinL-L_GBJF.TTF` at the same pinned source commit. Its internal name is FZJinLing Light. Retained as a reference face; no longer used for game information.
- `SourceHanSerifCN-{Medium,SemiBold}.woff2`: WOFF2 conversions of Adobe's [Source Han Serif 2.003](https://github.com/adobe-fonts/source-han-serif), `SubsetOTF/CN` at commit `7889f11bf31170b5d092a083b357c8c8130f89e0`. Actual Medium (500) for body text and controls; SemiBold (600) retained for reference; historical records use Medium (500), matching the imported scheme. Also provides fallback glyphs for YanSong. These faces retain the full upstream CN glyph coverage. No synthetic bold is used for Song text. License: `SourceHanSerif-OFL.txt` (SIL OFL 1.1).
- `wenkai/*.woff2`: the unmodified Regular subsets from `lxgw-wenkai-webfont@1.1.0`, which Fourth Righter's `template.html` loads for `LXGW WenKai`. Used only for audience nicknames and avatar initials, with CSS bold. Source CSS: https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.1.0/lxgwwenkai-regular.css . The generated `@font-face` declarations are kept in `app.css` for compatibility with the existing static asset allowlist.
- `WavelengthNumeric-{Regular,Bold}.woff2`: numeric subsets of DejaVu Sans, with full-width digits/signs mapped to their corresponding readable glyphs. Their internal family is renamed `Wavelength Numeric`. Copyright and redistribution terms are in `DejaVu-LICENSE.txt`. These faces precede the regular Chinese text fonts through `unicode-range`, including digits embedded in names, topics, instructions and history. Scores use the Source Han Serif subset below; scale/history percentages and timers use DejaVu. Neither uses YanSong, AaGothic or Kangxi glyphs.

`YanSong` is **造字工房言宋**, rather than “燕宋”. It provides the expressive display typography; Source Han carries longer reading text. AaGothic and Kangxi are not used in Wavelength.

WenKai's typeface license is preserved in `WenKai-OFL.txt`; the webfont package's MIT license is in `WenKai-LICENSE.txt`.

`app.css` adapts the stepped panel borders, monochrome palette, typography and ornaments to Wavelength. Layout reference: [Fourth Righter / 四权家异变](https://github.com/Nipporita/danmaku-app/tree/336ebe3d1eaa1da830ffde4c36414ce2a07def6b/danmaku-frontend).

These assets are served locally so the UI does not depend on remote font or image CDNs. Include this directory when copying or deploying the game.

## Imported user scheme (2026-10-14)

Source settings are preserved in `design/font-lab/applied-scheme.json`. Sample text in that export is for design preview only; game teams and questions remain controlled by game state.

- `FZPingXianYaSong-Regular.woff2`: lossless WOFF2 conversion of the user's attached `FZPingXianYaSong-R-GBK.ttf`; PostScript `FZPINGXYSK--GBK1-0`, static Regular 400. Team names request 500 but resolve to this Regular face. The large names add a `.008em` stroke (0.928px at 116px) with `paint-order: stroke fill`; synthetic bold stays disabled. This is a small CSS outline, not an invented intermediate font weight.
- `FZYaShiHei-Medium.woff2`: lossless WOFF2 conversion of the existing local `FZYASHJW_Zhun.TTF` in the Windows user's 方正字库/Font folder. PostScript `FZYASHS_ZHUN--GB1-0`, actual Medium 500, which is the closest supplied face to the scheme's 400 request. Used for concepts at 100px (72px for two candidate cards). Font outlines are unchanged.
- `SourceHanSerifCN-Bold-Numeric.woff2`: ASCII score digits and signs subset of Adobe Source Han Serif CN Bold, same 2.003 commit as above. Actual Bold 700, for 208px scores; preserves tabular numeral features. License: `SourceHanSerif-OFL.txt`.

Team colors are `#079c94` and `#de5458`; background remains pure white. Names, progress fill direction, scores and gain badges mirror across the stage. Multi-row progress tracks reserve enough vertical room before history/ranking panels.

## Refined wide display

`panel-outline.svg` preserves the original stepped border paths but omits the white center polygon. Wide monitor panels use 60% white backgrounds, allowing the continuous coin pattern to show faintly through them. The pattern is an SVG mask over a left-to-right team-color gradient at 28% opacity. Each team card has a single nine-slice masked outline; its original outline changes color when active.

The central card displays only concepts, with a black divider when two choices are visible. The phase label sits above the spectrum; the timer has a dedicated bottom row. Gray direction arrows with straight tails occupy their own background layer below every team-card element and stay inside the team frame. Scores are larger than names and centered vertically in their frames; progress wraps in the separate name column. History values follow wavelength order; gains always follow A/left then B/right.

- `FZCYSJW.woff2`: lossless conversion of the user-provided `FZCYSJW.TTF`; internal family `FZYaSongS-B-GB`, PostScript `FZCYSJW--GB1-0`. Its metadata is static Regular 400 despite the heavy design. Used at its native outlines, without CSS bold, for the 56px wide-monitor phase label. Digits still use Wavelength Numeric.
- `WavelengthSans-{Regular,Bold}.woff2`: Latin subsets of DejaVu Sans, served alongside the numeric subsets so interface Latin text also does not require a locally installed font. Same DejaVu license above.

Current wide-display sizes: names 116px, scores 208px, selected concepts 100px, choices 72px, phase 56px, timer 64px, history text 48px and history details 40px. The history heading stays 40px. Name size adapts to long names and multi-digit scores. All named faces are loaded from server URLs, without `local()` font sources.

## Team direction backdrop

Direction arrows use `#d3d3d3` and the full-card inset layout (28px vertically, 32px horizontally at native scale). Their thin tails end with a straight edge. They stay below names, scores and progress, entirely inside the team frame. There is no large dial-percentage backdrop. Score bands use digits only (`2 / 3 / 4 / 3 / 2`).

`FZFWZhuZiAOldMinchoD.woff2` is retained as an unused font reference from the user's upload; it is no longer requested by the game. Internal family `FZFW ZhuZi A Old Mincho`, style `D`, PostScript `FZFW-ZhuZiAOldMin-D--GB1-0`, static weight 600.
