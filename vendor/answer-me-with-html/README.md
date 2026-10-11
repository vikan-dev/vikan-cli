# Vendored answer-me-with-html renderer

`am.mjs` is an unchanged copy of
[`skills/answer-me-with-html/scripts/am.mjs`](https://github.com/QingYunA/answer-me-with-html/blob/533c39fd47d814a6bee3d9c1df388345f4e4c858/skills/answer-me-with-html/scripts/am.mjs)
from **answer-me-with-html 0.5.0**, commit
`533c39fd47d814a6bee3d9c1df388345f4e4c858`.

Its SHA-256 is
`8a52581ca87beeffa19fd5bdb1d8da3cee75ae9ef41e7d7277471c305fd4fa92`
(575,084 bytes). `provenance.json` records the bundle, license hashes and the
runtime dependencies pinned in the upstream `package-lock.json`.

`LICENSE.txt` contains the upstream MIT license. `THIRD_PARTY_NOTICES.txt`
retains the complete notices from the locked npm archives for Marked 18.0.14,
Dagre 3.1.1 and Graphlib 4.0.5. The notices include Marked's original Markdown
notice and `dagre.esm.js.LEGAL.txt`, which the upstream bundle references but
does not contain. These files were compared with archives verified against
the SHA-512 integrity values recorded in the upstream lockfile. Esbuild and
YAML are upstream development tools and are not bundled runtime modules.

`src/plan-renderer/resources.ts` imports the bundle and notices with Bun's text
loader so source execution and the movable `dist/index.js` carry the same
bytes. `render-plan --licenses` exposes the licenses; the wrapper also retains
them in every generated HTML attachment. Runtime code must not load assets
from this directory, an upstream checkout or a globally installed skill.

For an upgrade, choose a new full upstream commit, copy its bundle without
modification, inspect the actual bundled modules and lockfile, refresh all
applicable notices and provenance hashes, and rerun the local rendering and
standalone-bundle checks. Do not follow a floating branch or rebuild this
bundle from different dependency versions.
