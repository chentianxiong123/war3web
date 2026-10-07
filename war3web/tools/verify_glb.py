"""Read a .glb back, apply skinning + animation, rasterize. End-to-end validation."""
import sys, os, json, struct, math
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from PIL import Image, ImageDraw

CTSZ = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}
CTNP = {5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def load_glb(p):
    b = open(p,'rb').read()
    assert struct.unpack_from('<I',b,0)[0]==0x46546C67
    o=12; js=None; bin_=None
    while o < len(b):
        ln,ty = struct.unpack_from('<II',b,o); o+=8
        if ty==0x4E4F534A: js=json.loads(b[o:o+ln])
        elif ty==0x004E4942: bin_=b[o:o+ln]
        o+=ln
    return js, bin_

def acc(js,bin_,i):
    a=js['accessors'][i]; v=js['bufferViews'][a['bufferView']]
    off=v.get('byteOffset',0)+a.get('byteOffset',0)
    n=a['count']*NC[a['type']]
    arr=np.frombuffer(bin_,CTNP[a['componentType']],count=n,offset=off)
    return arr.reshape(a['count'],NC[a['type']]) if NC[a['type']]>1 else arr

def trs(t,r,s):
    x,y,z,w=r
    R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    M=np.eye(4); M[:3,:3]=R*np.array(s); M[:3,3]=t
    return M

def sample(js,bin_,anim,node,path,t):
    for ch in anim['channels']:
        if ch['target']['node']==node and ch['target']['path']==path:
            sm=anim['samplers'][ch['sampler']]
            ti=acc(js,bin_,sm['input']).astype(np.float64).ravel()
            vo=acc(js,bin_,sm['output']).astype(np.float64)
            if t<=ti[0]: return vo[0]
            if t>=ti[-1]: return vo[-1]
            k=int(np.searchsorted(ti,t)-1); k=max(0,min(k,len(ti)-2))
            f=(t-ti[k])/max(1e-9,(ti[k+1]-ti[k]))
            if path=='rotation':
                a,b2=vo[k],vo[k+1]
                if np.dot(a,b2)<0: b2=-b2
                q=a+(b2-a)*f; return q/np.linalg.norm(q)
            return vo[k]+(vo[k+1]-vo[k])*f
    return None

def world_matrices(js,bin_,anim,t):
    nodes=js['nodes']
    parent={}
    for i,n in enumerate(nodes):
        for c in n.get('children',[]): parent[c]=i
    W={}
    def calc(i):
        if i in W: return W[i]
        n=nodes[i]
        tr=list(n.get('translation',[0,0,0])); ro=list(n.get('rotation',[0,0,0,1])); sc=list(n.get('scale',[1,1,1]))
        if anim:
            v=sample(js,bin_,anim,i,'translation',t);  tr=list(v) if v is not None else tr
            v=sample(js,bin_,anim,i,'rotation',t);     ro=list(v) if v is not None else ro
            v=sample(js,bin_,anim,i,'scale',t);        sc=list(v) if v is not None else sc
        L=trs(tr,ro,sc)
        W[i]= (calc(parent[i]) @ L) if i in parent else L
        return W[i]
    for i in range(len(nodes)): calc(i)
    return W

def render(glbpath, seqname=None, t=0.0, size=300, texdir='assets'):
    js,bin_ = load_glb(glbpath)
    anim=None
    if seqname:
        for a in js.get('animations',[]):
            if a['name'].lower()==seqname.lower(): anim=a; break
    W=world_matrices(js,bin_,anim,t)
    skin=js['skins'][0]
    ibm=acc(js,bin_,skin['inverseBindMatrices']).reshape(-1,4,4)
    ibm=np.transpose(ibm,(0,2,1))
    joints=skin['joints']
    JM=np.stack([W[joints[k]] @ ibm[k] for k in range(len(joints))])
    mesh=js['meshes'][0]
    tris=[]
    for prim in mesh['primitives']:
        P=acc(js,bin_,prim['attributes']['POSITION']).astype(np.float64)
        N=acc(js,bin_,prim['attributes']['NORMAL']).astype(np.float64)
        UV=acc(js,bin_,prim['attributes']['TEXCOORD_0']).astype(np.float64)
        J=acc(js,bin_,prim['attributes']['JOINTS_0']).astype(int)
        WT=acc(js,bin_,prim['attributes']['WEIGHTS_0']).astype(np.float64)
        IDX=acc(js,bin_,prim['indices']).astype(int).ravel()
        Ph=np.concatenate([P,np.ones((len(P),1))],1)
        out=np.zeros((len(P),3)); non=np.zeros((len(P),3))
        for k in range(4):
            w=WT[:,k]
            if not w.any(): continue
            m=JM[J[:,k]]
            out += w[:,None]*np.einsum('nij,nj->ni',m[:,:3,:],Ph)
            non += w[:,None]*np.einsum('nij,nj->ni',m[:,:3,:3],N)
        tex=None
        if 'material' in prim:
            mat=js['materials'][prim['material']]
            bt=mat.get('pbrMetallicRoughness',{}).get('baseColorTexture')
            if bt:
                uri=js['images'][js['textures'][bt['index']]['source']]['uri']
                fp=os.path.join(texdir,uri)
                if os.path.exists(fp):
                    tex=np.asarray(Image.open(fp).convert('RGBA')).astype(np.float32)/255.
        tris.append((out,non,UV,IDX.reshape(-1,3),tex))
    allv=np.concatenate([t_[0] for t_ in tris])
    c=(allv.min(0)+allv.max(0))/2; rad=np.abs(allv-c).max()*1.15
    yaw=math.radians(200); pitch=math.radians(12)
    cy,sy=math.cos(yaw),math.sin(yaw); cp,sp=math.cos(pitch),math.sin(pitch)
    Ry=np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]]); Rx=np.array([[1,0,0],[0,cp,-sp],[0,sp,cp]])
    R=Rx@Ry
    img=np.zeros((size,size,3),np.float32); zb=np.full((size,size),1e9,np.float32)
    light=np.array([0.4,0.7,0.6]); light/=np.linalg.norm(light)
    for V,N,UV,IDX,tex in tris:
        Pv=(V-c)@R.T; Nv=N@R.T
        sx=(Pv[:,0]/rad*0.5+0.5)*size; sy_=(0.5-Pv[:,1]/rad*0.5)*size; dep=Pv[:,2]
        for f in IDX:
            x0,y0=sx[f],sy_[f]
            mnx,mxx=int(max(0,x0.min())),int(min(size-1,x0.max())+1)
            mny,mxy=int(max(0,y0.min())),int(min(size-1,y0.max())+1)
            if mnx>=mxx or mny>=mxy: continue
            ax,ay=x0[0],y0[0]; bx,by=x0[1],y0[1]; cx2,cy2=x0[2],y0[2]
            den=(by-cy2)*(ax-cx2)+(cx2-bx)*(ay-cy2)
            if abs(den)<1e-9: continue
            X,Y=np.meshgrid(np.arange(mnx,mxx)+0.5,np.arange(mny,mxy)+0.5)
            w0=((by-cy2)*(X-cx2)+(cx2-bx)*(Y-cy2))/den
            w1=((cy2-ay)*(X-cx2)+(ax-cx2)*(Y-cy2))/den
            w2=1-w0-w1; m=(w0>=0)&(w1>=0)&(w2>=0)
            if not m.any(): continue
            z=w0*dep[f[0]]+w1*dep[f[1]]+w2*dep[f[2]]
            sub=zb[mny:mxy,mnx:mxx]; m&=z<sub
            if not m.any(): continue
            nrm=w0[...,None]*Nv[f[0]]+w1[...,None]*Nv[f[1]]+w2[...,None]*Nv[f[2]]
            nl=np.linalg.norm(nrm,axis=-1,keepdims=True); nl[nl==0]=1
            lam=np.abs((nrm/nl)@light)*0.75+0.3
            if tex is not None:
                u=w0*UV[f[0],0]+w1*UV[f[1],0]+w2*UV[f[2],0]
                v=w0*UV[f[0],1]+w1*UV[f[1],1]+w2*UV[f[2],1]
                th,tw=tex.shape[:2]
                col=tex[np.clip((v%1*th).astype(int),0,th-1),np.clip((u%1*tw).astype(int),0,tw-1)]
                m&=col[...,3]>0.35
                if not m.any(): continue
                px=col[...,:3]*lam[...,None]
            else:
                px=np.full(lam.shape+(3,),0.6,np.float32)*lam[...,None]
            img[mny:mxy,mnx:mxx][m]=np.clip(px[m],0,1); sub[m]=z[m]
    return Image.fromarray((img*255).astype(np.uint8)), js

if __name__=='__main__':
    model=sys.argv[1]; seq=sys.argv[2] if len(sys.argv)>2 else None
    glb='assets/models/%s.glb' % model
    meta=json.load(open('assets/models/%s.json'%model))
    seqs=[s for s in meta['sequences'] if s['hasAnim']]
    print(model, 'sequences:', [s['name'] for s in seqs][:12])
    pick = seq or (seqs[0]['name'] if seqs else None)
    dur = next((s['duration'] for s in meta['sequences'] if s['name']==pick), 1.0)
    S=300; frames=5
    sheet=Image.new('RGB',(S*frames,S+16),(12,12,16)); d=ImageDraw.Draw(sheet)
    for i in range(frames):
        t=dur*i/max(1,frames-1)
        im,_=render(glb,pick,t,S)
        sheet.paste(im,(i*S,16)); d.text((i*S+4,3),'%s t=%.2fs'%(pick,t),fill=(240,240,120))
    out=os.environ.get('SP','/tmp')+'/anim_%s.png'%model.strip('-')
    sheet.save(out); print(out)
