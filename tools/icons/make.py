import math, sys
from PIL import Image, ImageDraw
N=1024
def grad(top,bot):
    im=Image.new('RGB',(N,N))
    px=im.load()
    for y in range(N):
        t=y/(N-1); c=tuple(int(top[i]+(bot[i]-top[i])*t) for i in range(3))
        for x in range(N): px[x,y]=c
    return im
def thermo(d,cx,cy,top,bot):
    W=(255,255,255,255); col=(bot[0],bot[1],bot[2],255)
    sw=96; ytop=cy-190; ybot=cy+110; br=96
    d.rounded_rectangle([cx-sw/2,ytop,cx+sw/2,ybot],radius=sw/2,fill=W)
    d.ellipse([cx-br,ybot-br+60,cx+br,ybot+br+60],fill=W)
    # kwik
    d.rounded_rectangle([cx-20,cy-60,cx+20,ybot+30],radius=20,fill=col)
    d.ellipse([cx-58,ybot-58+60,cx+58,ybot+58+60],fill=col)
    for i in range(3):
        y=ytop+50+i*50; d.rounded_rectangle([cx+70,y-8,cx+120,y+8],radius=8,fill=W)
def badge(d,glyph,top,bot):
    bx,by,r=790,790,128
    d.ellipse([bx-r-14,by-r-14,bx+r+14,by+r+14],fill=(bot[0],bot[1],bot[2],255))
    d.ellipse([bx-r,by-r,bx+r,by+r],fill=(255,255,255,255))
    glyph(d,bx,by,bot)
def base(top,bot,glyph,rounded=True):
    bg=grad(top,bot).convert('RGBA')
    fg=Image.new('RGBA',(N,N),(0,0,0,0)); d=ImageDraw.Draw(fg)
    cx=cy=N//2; R=330; w=84
    # dial arc 270deg, gap at the bottom (from 135 to 405 deg in PIL: angles clockwise from 3 o'clock)
    r=R-w/2
    for i in range(0,2701):
        ang=math.radians(135+i/10)
        ax=cx+r*math.cos(ang); ay=cy+10+r*math.sin(ang)
        d.ellipse([ax-w/2,ay-w/2,ax+w/2,ay+w/2],fill=(255,255,255,255))
    # setpoint marker: small dot on the ring (upper right), contrasting
    a=-50; r=R-w/2; mx=cx+r*math.cos(math.radians(a)); my=cy+10+r*math.sin(math.radians(a))
    d.ellipse([mx-w*0.36,my-w*0.36,mx+w*0.36,my+w*0.36],fill=(top[0],top[1],top[2],255))
    thermo(d,cx-20,cy+0,top,bot)
    badge(d,glyph,top,bot)
    out=Image.alpha_composite(bg,fg)
    if rounded:
        m=Image.new('L',(N,N),0); ImageDraw.Draw(m).rounded_rectangle([0,0,N-1,N-1],radius=230,fill=255)
        out.putalpha(m)
    return out
def bolt(d,cx,cy,col):
    pts=[(0.10,-0.30),(-0.12,0.04),(0.02,0.04),(-0.10,0.30),(0.14,-0.06),(0.00,-0.06)]
    s=300
    d.polygon([(cx+x*s,cy+y*s) for x,y in pts],fill=(col[0],col[1],col[2],255))
def house_full(d,cx,cy,col):
    s=215; c=(col[0],col[1],col[2],255)
    d.polygon([(cx,cy-0.30*s-30),(cx-0.50*s,cy-0.02*s-10),(cx+0.50*s,cy-0.02*s-10)],fill=c)
    d.rectangle([cx-0.34*s,cy-0.04*s-10,cx+0.34*s,cy+0.34*s],fill=c)
    d.rectangle([cx-0.08*s,cy+0.12*s,cx+0.08*s,cy+0.34*s],fill=(255,255,255,255))
P1=((255,122,61),(214,64,6)); HA=((38,176,232),(12,92,150))
variants={'p1':base(P1[0],P1[1],house_full),'ha':base(HA[0],HA[1],house_full)}
flat={'p1':base(P1[0],P1[1],house_full,False),'ha':base(HA[0],HA[1],house_full,False)}
import os
def save(img,path,size): 
    os.makedirs(os.path.dirname(path),exist_ok=True); img.resize((size,size),Image.LANCZOS).save(path)
if __name__=='__main__':
    W=Image.new('RGBA',(1100,560),(210,210,210,255))
    W.paste(variants['p1'].resize((512,512),Image.LANCZOS),(20,24),variants['p1'].resize((512,512),Image.LANCZOS)); W.paste(variants['ha'].resize((512,512),Image.LANCZOS),(560,24),variants['ha'].resize((512,512),Image.LANCZOS))
    W.save('icons/preview.png')
