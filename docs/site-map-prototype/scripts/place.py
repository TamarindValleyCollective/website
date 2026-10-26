import re, sys, json, math
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union, split
from shapely import affinity
pdf_dir,out_dir=sys.argv[1],sys.argv[2]
H=json.load(open(out_dir+'/houses_base.json'))
pat = re.compile(r'<path fill="none" stroke-width="([\d.]+)"[^>]*stroke="rgb\(([^)]*)\)"[^>]*d="([^"]*)"\s*transform="matrix\(([^)]*)\)"')
PAGE={'H1A':1,'H1B':2,'H2':3}
R=lambda x,y,w,h: box(x,y,x+w,y+h)
BASE=[R(-17,-18,17,15),R(0,-18,17,15),R(0,-3,17,22)]
FOOT={'S':(-.5,BASE),'DF':(-.5,BASE),'DG':(10.5,BASE+[R(-17,-40,17,22)]),
      'DO':(22.5,BASE+[R(-17,-64,17,24),R(-5,-40,5,22)]),'TO':(22.5,BASE+[R(-17,-64,17,24),R(-5,-40,5,22)])}
def footprint(t,x,y,theta,flip,s,sx=1.0):
    dy,rects=FOOT[t]; g=unary_union([affinity.translate(r,0,dy) for r in rects])
    sxs=(-s if flip else s)*sx; c,sn=math.cos(theta),math.sin(theta)
    return affinity.affine_transform(g,[c*sxs,-sn*s,sn*sxs,c*s,x,y])
def axis_of(cl,h):
    n=int(h[2:])
    if cl!='H1A': return 0
    if 16<=n<=22: return 24
    if 27<=n<=32: return 39
    return 24
out={}; report=[]
for cl,page in PAGE.items():
    F=json.load(open(f'{out_dir}/faces_{cl}.json')); faces=[Polygon(f) for f in F['faces']]
    poly={h:faces[i] for h,i in F['map'].items()}
    if cl=='H1A' and 'H-32' not in poly:
        a,b=H['H-31'],H['H-32']
        sx_,sy_=(a['x']+b['x'])/2,(a['y']+b['y'])/2; vx,vy=a['x']-b['x'],a['y']-b['y']; n=math.hypot(vx,vy); vx,vy=vx/n,vy/n
        cut=LineString([(sx_-vy*300,sy_+vx*300),(sx_+vy*300,sy_-vx*300)])
        parts=list(split(poly['H-31'],cut).geoms)
        parts.sort(key=lambda p:(p.centroid.x-b['x'])**2+(p.centroid.y-b['y'])**2)
        poly['H-32'],poly['H-31']=parts[0],max(parts[1:],key=lambda p:p.area)
    svg=open(f'{pdf_dir}/p{page}.svg').read(); walls=[]
    for m in pat.finditer(svg):
        w,c,d,tr=m.groups()
        if c!='0%, 0%, 0%' or float(w)<5: continue
        a_,_,_,e,tx,ty=[float(v) for v in tr.split(',')]
        nn=re.findall(r'-?[\d.]+',d)
        pts=[(float(nn[i])*a_+tx,float(nn[i+1])*e+ty) for i in range(0,len(nn)-1,2)]
        if len(pts)>1: walls.append(LineString(pts))
    W=unary_union(walls)
    dil=W.buffer(5); gs=dil.geoms if hasattr(dil,'geoms') else [dil]
    filled=unary_union([Polygon(g.exterior) for g in gs]).buffer(-5)
    ids=[h for h in H if H[h]['cl']==cl]; st={}
    for h in ids:
        d=H[h]; P=poly[h]; mk=filled.intersection(P.buffer(1.5)); s0=1.78
        best=None; Pb=P.buffer(1.5)
        if mk.area>250:
            c0=mk.centroid; base=axis_of(cl,h)
            for k in range(4):
              for off in (0,):
                th=math.radians(base+k*90)
                for fl in (False,True):
                  for mult in (1.0,):
                    for dx in range(-14,15,7):
                      for dyy in range(-14,15,7):
                        g=footprint(d['t'],c0.x+dx,c0.y+dyy,th,fl,s0*mult)
                        i=g.intersection(mk).area
                        if i<=0: continue
                        iou=i/(g.area+mk.area-i)
                        outside=(g.area-g.intersection(Pb).area)/g.area
                        sc=iou-1.5*outside
                        if best is None or sc>best[0]: best=(sc,th,fl,mult,c0.x+dx,c0.y+dyy,iou,outside)
        if best is None:
            r=math.radians(d['rot']); best=(0,r,d['flip'],1.0,d['x'],d['y'],0,0)
        sc,th,fl,mult,x,y,iou,outs=best; report.append(f'{h} {d["t"]} iou {iou:.2f} out {outs:.2f} rot {math.degrees(th)%360:.0f} flip {fl}')
        u=(math.cos(th),math.sin(th)); u=(-u[0],-u[1]) if fl else u
        st[h]=dict(th=th,fl=fl,s=s0*mult,o=[x,y],u=u)

    contacts={h:[] for h in ids}
    for i,a in enumerate(ids):
        for b in ids[i+1:]:
            S=poly[a].buffer(0.6).intersection(poly[b].buffer(0.6))
            if S.is_empty or S.area<1: continue
            Rr=S.minimum_rotated_rectangle; xs=list(Rr.exterior.coords)[:4]
            e1=(xs[1][0]-xs[0][0],xs[1][1]-xs[0][1]); e2=(xs[2][0]-xs[1][0],xs[2][1]-xs[1][1])
            L=max(math.hypot(*e1),math.hypot(*e2)); t=e1 if math.hypot(*e1)>=math.hypot(*e2) else e2
            if L<18: continue
            tl=math.hypot(*t); t=(t[0]/tl,t[1]/tl); nrm=(-t[1],t[0])
            if W.intersection(S.buffer(3)).length<22: continue
            M=S.centroid
            for me,other in ((a,b),(b,a)):
                oc=poly[other].centroid; mc=poly[me].centroid
                nn_=nrm if (nrm[0]*(oc.x-mc.x)+nrm[1]*(oc.y-mc.y))>0 else (-nrm[0],-nrm[1])
                contacts[me].append(dict(M=(M.x,M.y),n=nn_,other=other))

    # square-up: align the K/H row of wall-sharing, axis-parallel neighbours to a common depth line
    def khrow(h):
        s=st[h]; dy=FOOT[H[h]['t']][0]; v=(-math.sin(s['th']),math.cos(s['th']))
        return v,(s['o'][0]+s['s']*(-10.5+dy)*v[0],s['o'][1]+s['s']*(-10.5+dy)*v[1])
    seen=set()
    for h0 in ids:
        if h0 in seen or not contacts[h0]: continue
        comp=[]; q=[h0]; seen.add(h0)
        while q:
            h=q.pop(0); comp.append(h)
            for o in [c['other'] for c in contacts[h]]:
                if o in seen: continue
                vh,_=khrow(h); vo,_=khrow(o)
                if abs(vh[0]*vo[0]+vh[1]*vo[1])>0.95: seen.add(o); q.append(o)
        if len(comp)<2: continue
        w=khrow(comp[0])[0]
        cs=sorted((khrow(h)[1][0]*w[0]+khrow(h)[1][1]*w[1],h) for h in comp)
        groups=[[cs[0]]]
        for c,h in cs[1:]:
            (groups[-1].append((c,h)) if c-groups[-1][-1][0]<=12 else groups.append([(c,h)]))
        for g in groups:
            tgt=sum(c for c,_ in g)/len(g)
            for c,h in g: st[h]['o'][0]+=(tgt-c)*w[0]; st[h]['o'][1]+=(tgt-c)*w[1]

    for h in ids:
        s=st[h]; u=s['u']; sx=1.0
        if False:
            c1,c2=contacts[h][:2]
            wd=abs((c1['M'][0]-c2['M'][0])*u[0]+(c1['M'][1]-c2['M'][1])*u[1])
            sx=max(0.85,min(1.15,wd/(34*s['s'])))
        sh=[]
        for c in contacts[h]:
            side=1 if (u[0]*c['n'][0]+u[1]*c['n'][1])>0 else -1
            wp=(s['o'][0]+u[0]*17*s['s']*sx*side,s['o'][1]+u[1]*17*s['s']*sx*side)
            dist=(c['M'][0]-wp[0])*c['n'][0]+(c['M'][1]-wp[1])*c['n'][1]
            sh.append((c['n'][0]*dist,c['n'][1]*dist))
        x,y=s['o']
        if sh: x+=sum(a for a,_ in sh)/len(sh); y+=sum(b for _,b in sh)/len(sh)
        ring=list(poly[h].simplify(0.6).exterior.coords)
        out[h]=dict(x=round(x,1),y=round(y,1),rot=round(math.degrees(s['th'])%360,1),flip=bool(s['fl']),k=round(s['s'],3),sx=round(sx,3),
                    poly='M'+' L'.join(f'{px:.1f} {py:.1f}' for px,py in ring)+' Z')
json.dump(out,open(out_dir+'/placed.json','w'))
print('\n'.join(report))
