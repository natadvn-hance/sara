import sys, os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.merge import Merger

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
# Involve (the words) is used as the site ships it: Проекты/hance/site/assets/fonts/Involve-*.ttf.
# Martian Mono (the labels) comes from the site's web fonts, three subsets merged into one static TTF.
fams = {
  'MartianMono': ('martian-mono', {'Regular': 400}),
}
for fam, (prefix, weights) in fams.items():
  for style, w in weights.items():
    parts = []
    for sub in ['latin', 'latin-ext', 'cyrillic']:
      f = TTFont(os.path.join(src, f'{prefix}-{sub}.woff2'))
      f.flavor = None
      axes = {a.axisTag: a for a in f['fvar'].axes}
      loc = {'wght': w}
      if 'wdth' in axes: loc['wdth'] = 100
      inst = instancer.instantiateVariableFont(f, loc)
      p = os.path.join(out, f'_{fam}-{style}-{sub}.ttf')
      inst.save(p)
      parts.append(p)
    merged = Merger().merge(parts)
    name = merged['name']
    display = 'Martian Mono' if fam == 'MartianMono' else fam
    ps = f'{fam}-{style}'
    for rec in list(name.names):
      if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 25):
        name.removeNames(nameID=rec.nameID)
    # Regular and the rest as one family with its own style names (typographic family 16/17).
    legacy_family = display if style == 'Regular' else f'{display} {style}'
    name.setName(legacy_family, 1, 3, 1, 0x409)
    name.setName('Regular', 2, 3, 1, 0x409)
    name.setName(f'{ps};hance', 3, 3, 1, 0x409)
    name.setName(f'{display} {style}' if style != 'Regular' else f'{display} Regular', 4, 3, 1, 0x409)
    name.setName(ps, 6, 3, 1, 0x409)
    name.setName(display, 16, 3, 1, 0x409)
    name.setName(style, 17, 3, 1, 0x409)
    merged['OS/2'].usWeightClass = w
    if 'STAT' in merged: del merged['STAT']
    dst = os.path.join(out, f'{ps}.ttf')
    merged.save(dst)
    cmap = merged.getBestCmap()
    print(dst, len(cmap), 'А' in map(chr, cmap), os.path.getsize(dst))
for p in os.listdir(out):
  if p.startswith('_'): os.remove(os.path.join(out, p))
