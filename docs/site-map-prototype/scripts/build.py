import re, sys, json
pdf_dir, out_dir = sys.argv[1], sys.argv[2]
cols = {'100%, 0%, 0%':'plot','0%, 0%, 100%':'plot','0%, 100%, 0%':'plot','0%, 0%, 0%':'wall'}
pat = re.compile(r'<path fill="none" stroke-width="([\d.]+)"[^>]*stroke="rgb\(([^)]*)\)"[^>]*d="([^"]*)"\s*transform="matrix\(([^)]*)\)"')
VB = {'H1A':(330,90,560,930,1),'H1B':(190,130,920,500,2),'H2':(110,330,1010,310,3)}
def inview(pts,vb):
    x,y,w,h=vb[:4]; return any(x-5<=px<=x+w+5 and y-5<=py<=y+h+5 for px,py in pts)
clusters={}
for k,vb in VB.items():
    svg=open(f'{pdf_dir}/p{vb[4]}.svg').read(); plot=[]; wall=[]
    for m in pat.finditer(svg):
        w,c,d,tr=m.groups(); kind=cols.get(c)
        if not kind: continue
        w=float(w)
        if kind=='plot' and w<8: continue
        if kind=='wall' and w<5: continue
        a,_,_,e,tx,ty=[float(v) for v in tr.split(',')]
        n=re.findall(r'-?[\d.]+',d)
        pts=[(float(n[i])*a+tx,float(n[i+1])*e+ty) for i in range(0,len(n)-1,2)]
        if not inview(pts,vb): continue
        s='M'+' L'.join(f'{px:.1f} {py:.1f}' for px,py in pts)
        (plot if kind=='plot' else wall).append(s)
    clusters[k]={'vb':list(vb[:4]),'plot':' '.join(plot),'wall':' '.join(wall)}
labels={}
for p in (1,2,3):
    for n,x,y in json.load(open(f'{out_dir}/labels{p}.json')):
        if y<1000 and 1<=n<=52: labels.setdefault(n,(x,y,p))
types="1 S,2 S,3 S,4 DG,5 DG,6 S,7 DO,8 TO,9 TO,10 DF,11 DG,12 DO,13 DO,14 DO,15 S,16 S,17 DG,18 S,19 DF,20 DO,21 DF,22 DF,23 DF,24 TO,25 DG,26 DF,27 DF,28 DO,29 TO,30 DO,31 S,32 DF,33 S,34 DO,35 TO,36 DO,37 DG,38 S,39 S,40 S,41 S,42 S,43 S,44 S,45 S,46 S,47 S,48 S,49 S,50 S,51 S,52 S"
types={int(a):b for a,b in (t.split() for t in types.split(','))}
H={}
def put(n,cl,x,y,rot,sc=1.0,flip=False): H[n]=dict(cl=cl,x=round(x),y=round(y),rot=rot,s=sc,flip=flip)
# H2: road to the south, plots run north
for n,(x,y) in {1:(172,538),2:(258,525),3:(285,505),4:(346,490),5:(412,450),6:(480,450),7:(547,420),8:(608,420),9:(670,420),10:(735,440),11:(805,450),12:(870,450),13:(931,450),14:(993,450),15:(1062,450)}.items(): put(n,'H2',x,y,0,0.95,n%2==0)
# H1B upper row: road to the south, slight tilt
for n,(x,y) in {44:(245,300),45:(306,305),46:(378,312),47:(451,315),48:(526,325),49:(606,332)}.items(): put(n,'H1B',x,y,6,0.9,n%2==0)
put(50,'H1B',915,355,6,0.9); put(52,'H1B',780,205,-90,0.9); put(51,'H1B',775,325,-90,0.9,True)
# H1B lower row: road to the north
for n,x in {43:400,42:466,41:528,40:592,39:655,38:718,37:785,36:850,35:912,34:972,33:1040}.items():
    top=452+(x-400)*0.09; put(n,'H1B',x,top+(38 if n==43 else 58),186,0.9,n%2==0)
# H1A bottom group: 7M road to the west
for n in range(16,23):
    lx,ly,_=labels[n]; put(n,'H1A',lx+53,ly+31,106,0.8,n%2==0)
# H1A top-left group: 9M road to the south-west
for n in range(27,33):
    lx,ly,_=labels[n]; put(n,'H1A',lx+41,ly-34,30,0.8,n%2==0)
# H1A right group: public road to the east
for n,(x,y) in {26:(788,307),25:(772,359),24:(780,430),23:(765,470)}.items(): put(n,'H1A',x,y,-90,0.8,n%2==0)
assert len(H)==52, len(H)
for n in H:
    lx,ly,_=labels[n]; H[n].update(t=types[n],lx=round(lx),ly=round(ly))
json.dump({f'H-{n:02d}':v for n,v in sorted(H.items())},open(f'{out_dir}/houses_base.json','w'))
import os
if os.path.exists(f'{out_dir}/placed.json'):
    pl=json.load(open(f'{out_dir}/placed.json'))
    for n in H:
        q=pl[f'H-{n:02d}']; H[n].update(x=q['x'],y=q['y'],flip=q['flip'],sx=q['sx'],rot=q['rot'],k=q['k'],poly=q['poly'])
tpl=open(f'{out_dir}/tpl.html').read()
data=json.dumps({'clusters':clusters,'houses':{f'H-{n:02d}':v for n,v in sorted(H.items())}},separators=(',',':'))
open(f'{out_dir}/site-map-mockup.html','w').write(tpl.replace('/*DATA*/null',data))
print(len(data)//1024,'KB', {k:(len(v['plot'])//1024,len(v['wall'])//1024) for k,v in clusters.items()})
