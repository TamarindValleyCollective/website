import sys, json, re
# Builds out/site-map-editor.html from out/tpl-editor.html, reusing the DATA already embedded in
# out/site-map-mockup.html (so the PDF pipeline does not need to be re-run).
out_dir = sys.argv[1]
src = open(f'{out_dir}/site-map-mockup.html').read()
m = re.search(r'const DATA = (\{.*?\});\nconst TYPES', src, re.S)
data = json.loads(m.group(1))
tpl = open(f'{out_dir}/tpl-editor.html').read()
open(f'{out_dir}/site-map-editor.html', 'w').write(tpl.replace('/*DATA*/null', json.dumps(data, separators=(',', ':'))))
print('homes', len(data['houses']), 'clusters', list(data['clusters']))
