import sys, json, re
# Builds out/portal-mockup.local.html (member + admin site map mockup). It embeds member names, so it is a
# gitignored *.local.* file; the frozen layout is layout-frozen-2026-10-29.json next to the README.
out_dir, layout = sys.argv[1], sys.argv[2]
src = open(f'{out_dir}/site-map-mockup.html').read()
data = json.loads(re.search(r'const DATA = (\{.*?\});\nconst TYPES', src, re.S).group(1))
data = {'clusters': data['clusters']}  # the mockup does not need the old auto-fit houses
dump = lambda o: json.dumps(o, separators=(',', ':'))
tpl = open(f'{out_dir}/tpl-portal-mockup.html').read()
html = tpl.replace('/*DATA*/null', dump(data)).replace('/*LAYOUT*/null', dump(json.load(open(layout)))).replace('/*MEMBERS*/null', dump(json.load(open(f'{out_dir}/member-info.local.json'))))
open(f'{out_dir}/portal-mockup.local.html', 'w').write(html)
print('wrote portal-mockup.local.html', len(html) // 1024, 'KB')
