# Stroke data provenance

The JSON bundles in this directory are trimmed and reformatted derivatives of
[Make Me a Hanzi](https://github.com/skishore/makemeahanzi) `graphics.txt`. Only characters
used by the six generated HSK decks and the bundled demo deck are retained.

- Source commit: `618dbab8a8ddefb958763c8b4afbaa741a4460de`
- Source `graphics.txt` SHA-256: `a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee`
- Extraction date: 2026-09-01
- Extractor: `tools/import-strokes/`
- Applied corrections: 滚 (https://github.com/skishore/makemeahanzi/issues/72), 肠 (https://github.com/skishore/makemeahanzi/issues/95)

The source graphics are derived from Arphic PL KaitiM GB and Arphic PL UKai.
They are redistributed under the Arphic Public License in `ARPHICPL.txt`. See
`COPYING` for the upstream notice. The runtime renderer is Hanzi Writer,
licensed under the MIT license in `HANZI_WRITER_LICENSE.txt`.

Citation: Kishore, Shaunak (2018), Make Me a Hanzi (commit 618dbab).
