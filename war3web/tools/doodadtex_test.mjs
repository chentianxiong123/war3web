// Does every geoset a placed doodad draws have a texture?
//
// Warcraft III's replaceable texture id 11 means "this tileset's cliff texture".
// The cliff meshes use it and tools/cliffs.py resolves it; mdx2gltf.py handled
// ids 1 and 2 (team colour and glow) and nothing else, and slot 11 arrives with
// an empty path -- so a material asking for it got no texture at all and drew
// flat white.
//
// It is not only cliffs that ask. The two city entrance gates, at the top left
// and top right of this map, put their pillars on slot 11: bars and beams
// textured, pillars white.
//
// This reads the converted models rather than a browser, because the defect is
// in what the pipeline wrote. The assertion that matters is that the slot
// resolves to the *same* texture the cliff mesh draws -- a map that declares two
// cliff types can resolve it to the wrong one and still not be white.
//
//   node tools/doodadtex_test.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const doodads = read('public/data/doodads.json');
const meta = read('public/data/doodadmeta.json');
const cliffs = read('data/cliffs.json');
const cliffTex = cliffs.groups?.[0]?.texture || null;

// every doodad type actually placed on the map, and the model it draws
const placed = new Map();
for (const d of doodads) placed.set(d.id, (placed.get(d.id) || 0) + 1);

const models = [];
for (const [id, n] of placed) {
  const m = meta[id]?.m;
  if (!m) continue;
  const p = `assets/models/${m.replace(/\\/g, '~')}.json`;
  if (!fs.existsSync(path.join(ROOT, p))) continue;
  models.push({ id, n, m, mat: read(p).materials || [], tex: meta[id]?.tex || null });
}
check('placed doodad models were found', models.length > 0, `${models.length} types`);

// Nothing a placed doodad draws may end up untextured -- but the texture can
// come from either side. A model carries its own where the MDX names a path;
// where the MDX uses a replaceable slot it carries none, and the *type* supplies
// it from DestructableData's texFile. One model is shared by many types with
// different textures, which is why it cannot all live in the model.
const untextured = models.filter((x) => x.mat.some((mm) => !mm.texture) && !x.tex);
check('every placed doodad ends up textured', untextured.length === 0,
      untextured.map((x) => `${x.id} ${x.m}`).join(' ') || 'all textured');

// and where the type supplies it, it has to be a real staged file
const byType = models.filter((x) => x.tex);
check('types using a replaceable slot name a staged texture',
      byType.length > 0 && byType.every(
        (x) => fs.existsSync(path.join(ROOT, 'public/assets', x.tex))),
      byType.map((x) => `${x.id}:${x.tex.split('/').pop()}`).join(' ') || 'none');

// the trees specifically: 17 Lordaeron and 10 Barrens drew nothing at all
const trees = models.filter((x) => /lordaerontree|barrenstree/i.test(x.m));
check('the trees get a texture from their type', trees.length > 0 && trees.every((x) => !!x.tex),
      trees.map((x) => `${x.id} x${x.n} -> ${x.tex ? x.tex.split('/').pop() : 'NONE'}`).join(' '));

// the gates specifically: they are what slot 11 broke
const gate = models.find((x) => /cityenterancegate/i.test(x.m));
check('the city entrance gate is placed and converted', !!gate,
      gate ? `${gate.id} x${gate.n}` : 'not found');
if (gate) {
  check('the gate has no untextured material', gate.mat.every((mm) => !!mm.texture),
        gate.mat.map((mm) => mm.texture || 'NONE').join(' '));
  check('its cliff-slot material is the map\'s own cliff texture',
        !!cliffTex && gate.mat.some((mm) => mm.texture === cliffTex),
        `wants ${cliffTex}, has ${gate.mat.map((mm) => mm.texture).join(' ')}`);
}

// and every texture named actually exists on disk, staged for the client
const missing = new Set();
for (const x of models) {
  for (const mm of x.mat) {
    if (!mm.texture) continue;
    if (!fs.existsSync(path.join(ROOT, 'public/assets', mm.texture))) missing.add(mm.texture);
  }
}
check('every texture they name is staged', missing.size === 0,
      [...missing].slice(0, 3).join(' ') || 'all present');

// ---- the wreckage a destructable carries must not be drawn while it stands
//
// A destructable model keeps its debris as extra geosets and hides them with a
// geoset-alpha track: the elven gate stands as [1,0,1,0] and dies as [1,1,0,0].
// Doodads never animate, so nothing sampled those tracks and every geoset drew
// at full alpha -- the gates showed their closed doors and their own rubble at
// once. Read from the compiled models, which is where the answer lives.
const gates = models.filter((x) => /gate/i.test(x.m));
check('the gate models were found', gates.length >= 4, `${gates.length}`);
const withAnim = [];
for (const x of gates) {
  const p = `assets/models/${x.m.replace(/\\/g, '~')}.json`;
  const seqs = read(p).sequences || [];
  const stand = seqs.find((q) => /^stand$/i.test(q.name));
  if (stand?.geosetAlpha?.some((a) => a <= 0.01)) withAnim.push({ id: x.id, a: stand.geosetAlpha });
}
check('some gates hide geosets while standing', withAnim.length > 0,
      withAnim.map((w) => `${w.id}[${w.a.join(',')}]`).join(' ') || 'none -- nothing to hide');
check('and each still keeps something visible',
      withAnim.every((w) => w.a.some((a) => a > 0.01)),
      withAnim.map((w) => `${w.id}:${w.a.filter((a) => a > 0.01).length} shown`).join(' '));

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
