import re, sys, json, subprocess
pdf_dir, out_dir = sys.argv[1], sys.argv[2]
cols = {'100%, 0%, 0%':'red','0%, 0%, 100%':'blue','0%, 100%, 0%':'green'}
pat = re.compile(r'<path fill="none" stroke-width="([\d.]+)"[^>]*stroke="rgb\(([^)]*)\)"[^>]*?(?:stroke-dasharray="([^"]*)")?[^>]*d="([^"]*)"\s*transform="matrix\(([^)]*)\)"')
for p in (1,2,3):
    svg = open(f'{pdf_dir}/p{p}.svg').read()
    paths=[]
    for m in pat.finditer(svg):
        w,c,dash,d,tr = m.groups()
        if c not in cols or float(w) < 8: continue
        a,_,_,e,tx,ty = [float(x) for x in tr.split(',')]
        nums = re.findall(r'-?[\d.]+', d)
        pts=[(float(nums[i])*a+tx, float(nums[i+1])*e+ty) for i in range(0,len(nums)-1,2)]
        paths.append((cols[c], dash, pts))
    xs=[x for _,_,pp in paths for x,_ in pp]; ys=[y for _,_,pp in paths for _,y in pp]
    print(p, len(paths), min(xs),max(xs),min(ys),max(ys))
    json.dump(paths, open(f'{out_dir}/paths{p}.json','w'))
    # labels
    t = subprocess.run(['pdftotext','-bbox','-f',str(p),'-l',str(p),f'{pdf_dir}/plan.pdf','-'],capture_output=True,text=True).stdout
    lab=[]
    for m in re.finditer(r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)<',t):
        x0,y0,x1,y1,w = m.groups()
        if re.fullmatch(r'\d{1,2}',w) and float(y1)-float(y0)>8 and float(y1)-float(y0)<14:
            lab.append((int(w),(float(x0)+float(x1))/2,(float(y0)+float(y1))/2))
    print(sorted(lab))
    json.dump(lab, open(f'{out_dir}/labels{p}.json','w'))
