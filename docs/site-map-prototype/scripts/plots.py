import re, sys, json
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union
from shapely import affinity
pdf_dir,out_dir=sys.argv[1],sys.argv[2]
TOL=float(sys.argv[3]) if len(sys.argv)>3 else 2.5
pat = re.compile(r'<path fill="none" stroke-width="([\d.]+)"[^>]*stroke="rgb\(([^)]*)\)"[^>]*d="([^"]*)"\s*transform="matrix\(([^)]*)\)"')
def plotcol(c):
    r,g,b=[float(x.strip('% '))/100 for x in c.split(',')]
    if g>0.8 and b>0.8: return False
    return max(r,g,b)-min(r,g,b)>0.45 and not (r>0.6 and g>0.4 and b<0.2 and r<0.9)
H=json.load(open(out_dir+'/houses_base.json'))
SEED={'H-02':(225,525),'H-32':(400,150)}
res={}
for page,cl in ((1,'H1A'),(2,'H1B'),(3,'H2')):
    svg=open(f'{pdf_dir}/p{page}.svg').read(); lines=[]
    for m in pat.finditer(svg):
        w,c,d,tr=m.groups()
        if float(w)<8 or not plotcol(c): continue
        a,_,_,e,tx,ty=[float(v) for v in tr.split(',')]
        n=re.findall(r'-?[\d.]+',d)
        pts=[(float(n[i])*a+tx,float(n[i+1])*e+ty) for i in range(0,len(n)-1,2)]
        if len(pts)>1: lines.append(LineString(pts))
    xs=[p for l in lines for p in l.bounds]; 
    ub=unary_union(lines).buffer(TOL,join_style=2)
    full=box(50,30,1700,1150)
    free=full.difference(ub)
    faces=[g for g in (free.geoms if hasattr(free,'geoms') else [free]) if 300<g.area<45000]
    faces=[g.buffer(TOL,join_style=2).simplify(0.8) for g in faces]
    print(cl,len(faces),'faces')
    for k,v in H.items():
        if v['cl']!=cl: continue
        sx,sy=SEED.get(k,(v['x'],v['y']))
        hit=[i for i,f in enumerate(faces) if f.contains(Point(sx,sy))]
        print(k,hit,end=' | ')
        if len(hit)==1: res[k]=hit[0]
    print()
    json.dump({'faces':[list(f.exterior.coords) for f in faces],'map':{k:i for k,i in res.items() if H[k]['cl']==cl}},open(f'{out_dir}/faces_{cl}.json','w'))
