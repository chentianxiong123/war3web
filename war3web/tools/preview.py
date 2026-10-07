"""Software rasterizer to visually validate MDX parsing (bind pose, textured)."""
import sys, os, json, math
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from PIL import Image
import mdx

TEXIDX = json.load(open('assets/textures.json'))
def load_tex(path):
    if not path: return None
    key = path.replace('/', '\\').lower()
    for cand in (key, 'war3mapimported\\' + key.split('\\')[-1],
                 'textures\\' + key.split('\\')[-1]):
        if cand in TEXIDX:
            return np.asarray(Image.open('assets/' + TEXIDX[cand]).convert('RGBA')).astype(np.float32)/255.
    base = key.split('\\')[-1]
    for k, v in TEXIDX.items():
        if k.split('\\')[-1] == base:
            return np.asarray(Image.open('assets/' + v).convert('RGBA')).astype(np.float32)/255.
    return None

def render(path, size=320, yaw=math.radians(200), pitch=math.radians(-12)):
    M = mdx.parse(path)
    tris = []
    for gi, g in enumerate(M['geosets']):
        V = np.array(g['vertices'], np.float32).reshape(-1, 3)
        N = np.array(g['normals'], np.float32).reshape(-1, 3)
        UV = np.array(g['uvs'][0], np.float32).reshape(-1, 2) if g['uvs'] else np.zeros((len(V),2), np.float32)
        idx = np.array(g['indices'], np.int32).reshape(-1, 3)
        mat = M['materials'][g['materialId']] if g['materialId'] < len(M['materials']) else None
        tex = None
        if mat:
            for L in mat['layers']:
                if 0 <= L['textureId'] < len(M['textures']):
                    t = load_tex(M['textures'][L['textureId']]['path'])
                    if t is not None: tex = t; break
        tris.append((V, N, UV, idx, tex))
    allv = np.concatenate([t[0] for t in tris])
    c = (allv.min(0) + allv.max(0)) / 2
    rad = np.abs(allv - c).max() * 1.15
    # camera: MDX is Z-up
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    Rz = np.array([[cy,-sy,0],[sy,cy,0],[0,0,1]], np.float32)
    Rx = np.array([[1,0,0],[0,cp,-sp],[0,sp,cp]], np.float32)
    R = Rx @ Rz
    img = np.zeros((size, size, 3), np.float32)
    zbuf = np.full((size, size), 1e9, np.float32)
    light = np.array([0.4, -0.7, 0.6]); light /= np.linalg.norm(light)
    for V, N, UV, idx, tex in tris:
        P = (V - c) @ R.T
        Nr = N @ R.T
        sx = (P[:,0]/rad*0.5+0.5)*size
        sy_ = (0.5-P[:,2]/rad*0.5)*size
        depth = P[:,1]
        for f in idx:
            x0,y0 = sx[f], sy_[f]
            minx,maxx = int(max(0,x0.min())), int(min(size-1,x0.max())+1)
            miny,maxy = int(max(0,y0.min())), int(min(size-1,y0.max())+1)
            if minx>=maxx or miny>=maxy: continue
            ax,ay = x0[0],y0[0]; bx,by = x0[1],y0[1]; cx2,cy2 = x0[2],y0[2]
            den = (by-cy2)*(ax-cx2)+(cx2-bx)*(ay-cy2)
            if abs(den) < 1e-9: continue
            X,Y = np.meshgrid(np.arange(minx,maxx)+0.5, np.arange(miny,maxy)+0.5)
            w0 = ((by-cy2)*(X-cx2)+(cx2-bx)*(Y-cy2))/den
            w1 = ((cy2-ay)*(X-cx2)+(ax-cx2)*(Y-cy2))/den
            w2 = 1-w0-w1
            m = (w0>=0)&(w1>=0)&(w2>=0)
            if not m.any(): continue
            z = w0*depth[f[0]]+w1*depth[f[1]]+w2*depth[f[2]]
            sub = zbuf[miny:maxy, minx:maxx]
            m &= z < sub
            if not m.any(): continue
            nrm = (w0[...,None]*Nr[f[0]]+w1[...,None]*Nr[f[1]]+w2[...,None]*Nr[f[2]])
            nl = np.linalg.norm(nrm,axis=-1,keepdims=True); nl[nl==0]=1
            lam = np.abs((nrm/nl) @ light)*0.75+0.3
            if tex is not None:
                u = w0*UV[f[0],0]+w1*UV[f[1],0]+w2*UV[f[2],0]
                v = w0*UV[f[0],1]+w1*UV[f[1],1]+w2*UV[f[2],1]
                th,tw = tex.shape[:2]
                tu = np.clip((u%1.0*tw).astype(int),0,tw-1)
                tv = np.clip((v%1.0*th).astype(int),0,th-1)
                col = tex[tv,tu,:3]
                alpha = tex[tv,tu,3]
                m &= alpha > 0.35
                if not m.any(): continue
            else:
                col = np.full(lam.shape+(3,), 0.65, np.float32)
            px = col*lam[...,None]
            tgt = img[miny:maxy, minx:maxx]
            tgt[m] = np.clip(px[m],0,1)
            sub[m] = z[m]
    return Image.fromarray((img*255).astype(np.uint8)), M

if __name__ == '__main__':
    names = sys.argv[1:]
    tiles=[]
    for n in names:
        p = 'extracted/war3mapImported/%s.mdx' % n
        im, M = render(p)
        tiles.append((n, im, M))
    S=320
    from PIL import ImageDraw
    sheet = Image.new('RGB',(S*len(tiles), S+16),(12,12,16))
    d=ImageDraw.Draw(sheet)
    for i,(n,im,M) in enumerate(tiles):
        sheet.paste(im,(i*S,16))
        d.text((i*S+4,3), '%s  %dtri %db %dseq' % (n, sum(len(g['indices'])//3 for g in M['geosets']),
               len(M['bones']), len(M['sequences'])), fill=(240,240,120))
    out=os.environ.get('SP','/tmp')+'/models.png'
    sheet.save(out); print(out)
