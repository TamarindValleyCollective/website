import sys, json, re, os
# Builds the editor from out/tpl-editor.html, reusing the DATA already embedded in out/site-map-mockup.html
# (so the PDF pipeline does not need to be re-run).
#   out/site-map-editor.html        no personal data; safe to commit
#   out/site-map-editor.local.html  also embeds member names and house plot sizes from out/member-info.local.json
#                                   (gitignored; query is in the README)
out_dir = sys.argv[1]
src = open(f'{out_dir}/site-map-mockup.html').read()
m = re.search(r'const DATA = (\{.*?\});\nconst TYPES', src, re.S)
data = json.dumps(json.loads(m.group(1)), separators=(',', ':'))
tpl = open(f'{out_dir}/tpl-editor.html').read().replace('/*DATA*/null', data)
open(f'{out_dir}/site-map-editor.html', 'w').write(tpl.replace('/*MEMBERS*/null', 'null'))
mp = f'{out_dir}/member-info.local.json'
if os.path.exists(mp):
    members = json.dumps(json.load(open(mp)), separators=(',', ':'))
    open(f'{out_dir}/site-map-editor.local.html', 'w').write(tpl.replace('/*MEMBERS*/null', members))
    print('wrote site-map-editor.local.html with member info')
print('homes', len(json.loads(data)['houses']))
