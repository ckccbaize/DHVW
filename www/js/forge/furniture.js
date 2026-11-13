// 家具层 painter（W31 第二批）：paint_home.py 的 JS 移植（home 用到的家具/墙面/小物）。
// 与 Python 逐像素对比；椭圆/圆弧按 PIL 的像素覆盖规则实现。

import { applyTone, createCanvas, put, rect, T } from "./painter.js";

const WOOD = [[58,40,32],[92,62,44],[128,88,58],[164,120,78],[196,154,104]];
const WALL = [[70,60,70],[102,86,92],[138,118,114],[174,152,136],[206,186,162]];
const FLOOR = [[86,56,42],[118,82,56],[150,110,72],[180,140,96]];
const TILE = [[82,88,100],[114,120,132],[146,152,162],[178,184,192]];
const STONE = [[86,84,92],[118,116,124],[150,148,154],[180,178,182]];
const FAB = [[48,56,74],[74,86,106],[102,118,140],[136,152,172]];
const BED = [[140,142,152],[180,184,194],[212,216,224]];
const RUG = [[94,42,48],[132,62,64],[168,96,86],[200,138,116]];
const LEAF = [[40,64,48],[64,92,60],[92,124,78],[126,158,102]];
const CARD = [[98,68,42],[138,98,58],[176,134,86],[206,168,116]];
const CREAM = [228,210,178];
const INK = [46,34,36];

function hline(cv,x0,x1,y,c){for(let x=x0;x<=x1;x++)put(cv,x,y,c);}
function vline(cv,x,y0,y1,c){for(let y=y0;y<=y1;y++)put(cv,x,y,c);}
function outline(cv,x,y,w,h,c){hline(cv,x,x+w-1,y,c);hline(cv,x,x+w-1,y+h-1,c);vline(cv,x,y,y+h-1,c);vline(cv,x+w-1,y,y+h-1,c);}

function ellipse(cv,x0,y0,x1,y1,c){
  const cx=(x0+x1)/2, cy=(y0+y1)/2;
  const rx=(x1-x0+1)/2, ry=(y1-y0+1)/2;
  for(let y=y0;y<=y1;y++){
    const dy=(y-cy)/ry;
    if(Math.abs(dy)>1) continue;
    const dx=rx*Math.sqrt(Math.max(0,1-dy*dy));
    const xs=Math.ceil(cx-dx), xe=Math.floor(cx+dx);
    for(let x=xs;x<=xe;x++) put(cv,x,y,c);
  }
}

function ellipseOutline(cv,x0,y0,x1,y1,c){
  const cx=(x0+x1)/2, cy=(y0+y1)/2;
  const rx=(x1-x0+1)/2, ry=(y1-y0+1)/2;
  for(let y=y0;y<=y1;y++){
    const dy=(y-cy)/ry;
    if(Math.abs(dy)>1) continue;
    const dx=rx*Math.sqrt(Math.max(0,1-dy*dy));
    const xs=Math.ceil(cx-dx), xe=Math.floor(cx+dx);
    if(y===y0||y===y1){for(let x=xs;x<=xe;x++)put(cv,x,y,c);}
    else {put(cv,xs,y,c);put(cv,xe,y,c);}
  }
}

function angleOf(cx,cy,x,y){
  let a=Math.atan2(cy-y,x-cx)*180/Math.PI; // 0=right, 90=up, 180=left, 270=down
  if(a<0) a+=360;
  return a;
}

function arc(cv,x0,y0,x1,y1,start,end,c){
  const cx=(x0+x1)/2, cy=(y0+y1)/2;
  const rx=(x1-x0+1)/2, ry=(y1-y0+1)/2;
  const s=((start%360)+360)%360, e=((end%360)+360)%360;
  const inRange=(a)=> s<=e ? (a>=s&&a<=e) : (a>=s||a<=e);
  for(let y=y0;y<=y1;y++){
    const dy=(y-cy)/ry;
    if(Math.abs(dy)>1) continue;
    const dx=rx*Math.sqrt(Math.max(0,1-dy*dy));
    const xs=Math.ceil(cx-dx), xe=Math.floor(cx+dx);
    if(y===y0||y===y1){
      if(inRange(angleOf(cx,cy,(xs+xe)/2,y))) for(let x=xs;x<=xe;x++)put(cv,x,y,c);
      continue;
    }
    if(inRange(angleOf(cx,cy,xs,y))) put(cv,xs,y,c);
    if(inRange(angleOf(cx,cy,xe,y))) put(cv,xe,y,c);
  }
}

function polygon(cv,pts,c){
  let minY=Infinity,maxY=-Infinity;
  for(const [,y] of pts){minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  for(let y=Math.floor(minY);y<=Math.ceil(maxY);y++){
    const xs=[];
    for(let i=0;i<pts.length;i++){
      const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%pts.length];
      if((y1<=y&&y2>y)||(y2<=y&&y1>y)) xs.push(x1+(y-y1)*(x2-x1)/(y2-y1));
    }
    xs.sort((a,b)=>a-b);
    for(let i=0;i+1<xs.length;i+=2){
      for(let x=Math.ceil(xs[i]);x<=Math.floor(xs[i+1]);x++) put(cv,x,y,c);
    }
  }
}

function shadow(cv,x,y,w,h,a=70){rect(cv,x+2,y+2,w,h,[40,28,30,a]);}
function box(cv,px,py,w,h,ramp,top=4,ol=true){
  shadow(cv,px,py,w,h);
  rect(cv,px,py,w,h,ramp[1]);
  rect(cv,px,py,w,top,ramp[2]);
  hline(cv,px,px+w-1,py+top,ramp[0]);
  rect(cv,px,py+h-2,w,2,ramp[0]);
  if(ol) outline(cv,px,py,w,h,INK);
}

// ---------- 家具 ----------
function p_bed(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  shadow(cv,px,py,W,H);
  rect(cv,px,py,W,H,WOOD[1]);
  rect(cv,px+2,py+2,W-4,H-4,BED[1]);
  rect(cv,px+2,py+2,W-4,8,WOOD[2]);
  rect(cv,px+5,py+6,W-10,9,BED[2]);
  hline(cv,px+5,px+W-6,py+14,BED[0]);
  rect(cv,px+2,py+18,W-4,H-21,RUG[1]);
  rect(cv,px+2,py+18,W-4,3,RUG[2]);
  rect(cv,px+2,py+18,9,4,BED[2]);
  vline(cv,px+11,py+18,py+22,RUG[0]);
  for(let i=0;i<2;i++) vline(cv,px+10+i*9,py+24,py+H-6,RUG[0]);
  // 皱褶
  let x1=px+14,y1=py+21,x2=px+19,y2=py+23;
  const dx=Math.abs(x2-x1), dy=-Math.abs(y2-y1); let sx=x1<x2?1:-1, sy=y1<y2?1:-1, err=dx+dy;
  for(;;){put(cv,x1,y1,RUG[0]); if(x1===x2&&y1===y2)break; const e2=2*err; if(e2>=dy){err+=dy;x1+=sx;} if(e2<=dx){err+=dx;y1+=sy;}}
  outline(cv,px,py,W,H,INK);
}

function p_nightstand(cv,x,y){
  const px=x*T,py=y*T;
  box(cv,px+1,py+3,14,12,WOOD,3);
  hline(cv,px+2,px+13,py+8,WOOD[0]);
  rect(cv,px+7,py+9,2,2,CREAM);
  rect(cv,px+4,py,6,4,CREAM);
  rect(cv,px+3,py+3,8,1,WOOD[2]);
  rect(cv,px+3,py+9,4,3,[58,46,44]);
  rect(cv,px+4,py+10,2,1,[120,150,170]);
}

function p_wardrobe(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py,W,H,WOOD,4);
  vline(cv,px+Math.floor(W/2),py+4,py+H-3,WOOD[0]);
  rect(cv,px+2,py+5,Math.floor(W/2)-4,H-9,WOOD[2]);
  rect(cv,px+Math.floor(W/2)+2,py+5,Math.floor(W/2)-4,H-9,WOOD[2]);
  rect(cv,px+Math.floor(W/2)-3,py+Math.floor(H/2),2,3,CREAM);
  rect(cv,px+Math.floor(W/2)+1,py+Math.floor(H/2),2,3,CREAM);
}

function p_dresser(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py,W,H,WOOD,4);
  for(let i=0;i<2;i++){
    rect(cv,px+2,py+5+i*5,W-4,4,WOOD[2]);
    rect(cv,px+Math.floor(W/2)-2,py+6+i*5,4,2,CREAM);
  }
}

function p_chair(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+2,py+2,12,12);
  rect(cv,px+3,py+5,10,8,WOOD[2]);
  rect(cv,px+3,py+2,10,4,WOOD[1]);
  hline(cv,px+3,px+12,py+6,WOOD[3]);
  rect(cv,px+4,py+12,2,2,WOOD[0]);
  rect(cv,px+10,py+12,2,2,WOOD[0]);
  outline(cv,px+3,py+2,10,12,INK);
}

function p_bookshelf(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py,W,H,WOOD,4);
  rect(cv,px+2,py+5,W-4,H-8,[52,40,40]);
  const cols=[RUG[2],FAB[2],LEAF[2],CARD[3],CREAM,RUG[3],FAB[3]];
  for(let i=0;i<7;i++){
    const bx=px+2+i*4, bh=5+(i*3)%3;
    rect(cv,bx,py+H-4-bh,3,bh,cols[(x+i)%cols.length]);
  }
  hline(cv,px+2,px+W-3,py+H-4,WOOD[0]);
}

function p_shelf(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py,W,H,WOOD,4);
  rect(cv,px+2,py+5,W-4,H-8,[52,40,40]);
  for(let i=0;i<3;i++){
    rect(cv,px+3,py+6+i*8,W-6,2,WOOD[2]);
    rect(cv,px+4,py+8+i*8,W-8,5,[CREAM,RUG[2],FAB[2]][i]);
  }
}

function p_counter(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py,W,H,WOOD,5);
  rect(cv,px,py,W,5,TILE[2]);
  ellipse(cv,px+6,py+6,px+20,py+13,TILE[1]);
  ellipse(cv,px+8,py+7,px+18,py+12,TILE[0]);
  rect(cv,px+12,py+2,2,4,TILE[0]);
  hline(cv,px+12,px+15,py+2,TILE[0]);
  rect(cv,px+26,py+6,8,6,WOOD[2]);
  outline(cv,px+26,py+6,8,6,WOOD[0]);
  vline(cv,px+28,py+7,py+10,WOOD[1]);
  for(let i=0;i<2;i++) arc(cv,px+9+i*4,py+8,px+15+i*4,py+12,180,360,CREAM);
}

function p_stove(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py,W,H,[INK,[58,46,44],[78,62,58],[98,80,72]],5);
  for(let i=0;i<2;i++){
    const cx=px+8+i*16;
    ellipse(cv,cx-5,py+5,cx+5,py+12,[36,28,30]);
    arc(cv,cx-5,py+5,cx+5,py+12,180,360,[120,100,92]);
  }
  for(let i=0;i<3;i++) rect(cv,px+5+i*8,py+H-6,3,3,CREAM);
  ellipse(cv,px+7,py+3,px+16,py+10,[96,96,102]);
  ellipse(cv,px+9,py+4,px+14,py+8,[72,72,78]);
  hline(cv,px+16,px+19,py+6,[96,96,102]);
}

function p_fridge(cv,x,y){
  const px=x*T,py=y*T;
  box(cv,px+1,py,14,16,BED,5);
  hline(cv,px+2,px+13,py+7,BED[0]);
  rect(cv,px+11,py+9,2,4,BED[0]);
  rect(cv,px+2,py+1,10,1,BED[2]);
  for(const [mx,my,mc] of [[4,3,RUG[2]],[7,2,CARD[3]],[9,4,FAB[2]]]) rect(cv,px+mx,py+my,2,2,mc);
}

function p_table(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px+1,py+1,W-2,H-2,WOOD,6);
  for(let i=0;i<2;i++) vline(cv,px+5+i*11,py+7,py+H-4,WOOD[1]);
  ellipse(cv,px+4,py+3,px+10,py+7,CREAM);
  ellipse(cv,px+6,py+4,px+8,py+6,RUG[2]);
  ellipse(cv,px+15,py+4,px+20,py+8,CREAM);
  ellipse(cv,px+16,py+5,px+18,py+7,LEAF[2]);
  ellipse(cv,px+18,py+5,px+20,py+7,RUG[3]);
  rect(cv,px+22,py+4,2,4,FAB[2]);
  ellipse(cv,px+22,py+2,px+24,py+4,RUG[2]);
}

function p_sofa(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  shadow(cv,px,py,W,H);
  rect(cv,px,py,W,H,FAB[1]);
  for(let i=0;i<w;i++){
    const cx=px+4+i*15;
    rect(cv,cx,py+4,13,H-8,FAB[2]);
    hline(cv,cx,cx+12,py+4,FAB[3]);
    hline(cv,cx,cx+12,py+H-5,FAB[0]);
  }
  rect(cv,px,py,4,H,FAB[1]);
  rect(cv,px+W-4,py,4,H,FAB[1]);
  hline(cv,px,px+3,py+1,FAB[3]);
  hline(cv,px+W-4,px+W-1,py+1,FAB[3]);
  outline(cv,px,py,W,H,INK);
}

function p_coffee_table(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px+2,py+4,W-4,H-6,WOOD,4);
  rect(cv,px+5,py+5,6,3,CREAM);
  rect(cv,px+14,py+6,5,2,RUG[2]);
}

function p_tv(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py+2,W,H-4,[INK,[46,42,48],[62,58,64],[82,78,84]],3);
  rect(cv,px+2,py+4,W-4,H-8,[44,54,68]);
  hline(cv,px+3,px+8,py+5,[96,118,140]);
  rect(cv,px+4,py+H-3,W-8,2,[30,26,28]);
}

function p_plant(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+3,py+9,10,6);
  rect(cv,px+4,py+10,8,5,CARD[1]);
  rect(cv,px+4,py+10,8,2,CARD[2]);
  for(const [dx,dy,c] of [[6,3,LEAF[1]],[10,2,LEAF[2]],[4,6,LEAF[0]],[12,6,LEAF[1]],[8,5,LEAF[2]]]) ellipse(cv,px+dx-2,py+dy-2,px+dx+2,py+dy+2,c);
  vline(cv,px+8,py+7,py+10,LEAF[0]);
  outline(cv,px+4,py+10,8,5,INK);
}

function p_plant_big(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+2,py+10,12,5);
  rect(cv,px+4,py+11,8,4,CARD[1]);
  rect(cv,px+4,py+11,8,1,CARD[2]);
  for(const [dx,dy,c] of [[8,2,LEAF[2]],[5,4,LEAF[1]],[11,5,LEAF[1]],[7,6,LEAF[3]],[10,8,LEAF[2]]]) ellipse(cv,px+dx-3,py+dy-3,px+dx+3,py+dy+3,c);
  vline(cv,px+8,py+8,py+11,LEAF[0]);
  outline(cv,px+4,py+11,8,4,INK);
}

function p_bench(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  box(cv,px,py+4,W,H-7,WOOD,3);
  for(let i=0;i<3;i++) hline(cv,px+1,px+W-2,py+8+i*2,WOOD[1]);
}

function p_lamp(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+3,py+12,10,3);
  rect(cv,px+7,py+6,2,7,WOOD[0]);
  rect(cv,px+4,py+13,8,2,WOOD[1]);
  polygon(cv,[[px+4,py+6],[px+12,py+6],[px+10,py+1],[px+6,py+1]],CREAM);
  hline(cv,px+5,px+11,py+5,WOOD[2]);
  outline(cv,px+4,py+13,8,2,INK);
}

function p_rug(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  rect(cv,px+1,py+1,W-2,H-2,RUG[1]);
  outline(cv,px+1,py+1,W-2,H-2,RUG[0]);
  rect(cv,px+4,py+4,W-8,H-8,RUG[2]);
  outline(cv,px+4,py+4,W-8,H-8,RUG[3]);
  for(let i=0;i<2;i++) rect(cv,px+8+i*16,py+Math.floor(H/2)-2,8,4,RUG[3]);
  for(let i=0;i<W-6;i+=6) rect(cv,px+4+i,py+2,2,2,RUG[3]);
}

function p_door_mat(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  rect(cv,px+1,py+3,W-2,H-6,CARD[1]);
  rect(cv,px+2,py+4,W-4,H-8,CARD[2]);
  for(let i=0;i<4;i++) vline(cv,px+3+i*6,py+5,py+H-5,CARD[1]);
  outline(cv,px+1,py+3,W-2,H-6,INK);
}

function p_coat_rack(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+4,py+12,8,3);
  rect(cv,px+7,py+3,2,10,WOOD[1]);
  rect(cv,px+4,py+13,8,2,WOOD[1]);
  hline(cv,px+4,px+11,py+4,WOOD[2]);
  rect(cv,px+4,py+5,4,6,FAB[2]);
  rect(cv,px+9,py+5,3,5,RUG[2]);
}

function p_cat_tree(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  shadow(cv,px+3,py+H-6,W-6,5);
  rect(cv,px+4,py+H-8,W-8,4,WOOD[1]);
  rect(cv,px+7,py+6,2,H-14,WOOD[2]);
  rect(cv,px+3,py+4,W-6,4,CARD[2]);
  rect(cv,px+2,py+1,W-4,4,CARD[3]);
  ellipse(cv,px+5,py+2,px+10,py+5,CARD[1]);
  outline(cv,px+2,py+1,W-4,4,INK);
}

function p_bathtub(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  shadow(cv,px,py,W,H);
  rect(cv,px,py,W,H,BED[1]);
  rect(cv,px+2,py+2,W-4,H-4,[110,158,180]);
  rect(cv,px+2,py+2,W-4,4,[170,210,226]);
  hline(cv,px+4,px+W-5,py+6,[150,196,214]);
  rect(cv,px+W-7,py+1,4,2,[150,150,156]);
  outline(cv,px,py,W,H,INK);
}

function p_sink(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+2,py+6,12,8);
  rect(cv,px+2,py+5,12,9,BED[1]);
  ellipse(cv,px+4,py+7,px+12,py+12,BED[2]);
  ellipse(cv,px+5,py+8,px+11,py+11,[150,196,214]);
  rect(cv,px+7,py+2,2,4,[150,150,156]);
  outline(cv,px+2,py+5,12,9,INK);
}

function p_toilet(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+3,py+9,10,5);
  rect(cv,px+5,py+1,6,5,BED[1]);
  ellipse(cv,px+3,py+6,px+13,py+14,BED[1]);
  ellipse(cv,px+5,py+8,px+11,py+12,BED[2]);
  outline(cv,px+5,py+1,6,5,INK);
  ellipseOutline(cv,px+3,py+6,px+13,py+14,INK);
}

function p_washer(cv,x,y){
  const px=x*T,py=y*T;
  shadow(cv,px+1,py+2,14,13);
  rect(cv,px+1,py+2,14,13,BED[1]);
  rect(cv,px+1,py+2,14,3,BED[2]);
  ellipse(cv,px+4,py+6,px+12,py+13,[120,130,140]);
  ellipse(cv,px+6,py+8,px+10,py+11,[150,170,180]);
  rect(cv,px+10,py+3,2,1,[120,130,140]);
  outline(cv,px+1,py+2,14,13,INK);
}

function p_bath_mat(cv,x,y,w,h){
  const px=x*T,py=y*T,W=w*T,H=h*T;
  rect(cv,px+1,py+5,W-2,H-9,FAB[2]);
  rect(cv,px+2,py+6,W-4,H-11,FAB[3]);
  for(let i=0;i<3;i++) vline(cv,px+3+i*5,py+7,py+H-6,FAB[1]);
  outline(cv,px+1,py+5,W-2,H-9,INK);
}

// ---------- 墙面 / 小物 ----------
function w_picture(cv,x,y){
  const px=x*T,py=y*T;
  rect(cv,px+2,py+3,12,10,WOOD[1]);
  rect(cv,px+3,py+4,10,8,[120,160,176]);
  rect(cv,px+3,py+8,10,4,LEAF[2]);
  hline(cv,px+3,px+12,py+8,LEAF[1]);
  rect(cv,px+6,py+5,2,2,CREAM);
  outline(cv,px+2,py+3,12,10,INK);
}
function w_clock(cv,x,y){
  const px=x*T,py=y*T;
  ellipse(cv,px+3,py+3,px+12,py+12,CREAM);
  arc(cv,px+3,py+3,px+12,py+12,180,360,WOOD[2]);
  ellipseOutline(cv,px+3,py+3,px+12,py+12,INK);
  vline(cv,px+7,py+7,py+4,INK);
  hline(cv,px+7,px+10,py+8,INK);
}
function w_wall_shelf(cv,x,y){
  const px=x*T,py=y*T;
  rect(cv,px+1,py+8,14,2,WOOD[2]);
  rect(cv,px+1,py+10,14,1,WOOD[0]);
  rect(cv,px+3,py+4,3,4,RUG[2]);
  rect(cv,px+7,py+5,3,3,FAB[2]);
  rect(cv,px+11,py+3,2,5,CREAM);
  outline(cv,px+1,py+8,14,3,INK);
}
function w_mirror(cv,x,y){
  const px=x*T,py=y*T;
  rect(cv,px+3,py+2,10,13,WOOD[1]);
  rect(cv,px+4,py+3,8,11,[150,176,186]);
  hline(cv,px+5,px+9,py+4,[206,226,232]);
  vline(cv,px+5,py+6,py+12,[186,208,218]);
  outline(cv,px+3,py+2,10,13,INK);
}
function w_towel(cv,x,y){
  const px=x*T,py=y*T;
  rect(cv,px+4,py+1,8,2,WOOD[2]);
  rect(cv,px+4,py+3,8,11,FAB[2]);
  rect(cv,px+4,py+3,8,2,FAB[3]);
  vline(cv,px+7,py+5,py+13,FAB[1]);
  vline(cv,px+9,py+5,py+13,FAB[1]);
  outline(cv,px+4,py+3,8,11,INK);
}
function w_wall_lamp(cv,x,y){
  const px=x*T,py=y*T;
  rect(cv,px+6,py+2,4,2,WOOD[2]);
  polygon(cv,[[px+4,py+4],[px+12,py+4],[px+10,py+8],[px+6,py+8]],CREAM);
  hline(cv,px+4,px+12,py+4,WOOD[1]);
  hline(cv,px+5,px+11,py+8,[250,226,160]);
}
function d_book(cv,px,py){
  rect(cv,px+5,py+7,7,4,RUG[2]);
  rect(cv,px+5,py+7,7,1,CREAM);
  vline(cv,px+8,py+7,py+10,RUG[0]);
}
function d_mug(cv,px,py){
  rect(cv,px+6,py+7,4,4,CREAM);
  rect(cv,px+6,py+7,4,1,[250,240,220]);
  arc(cv,px+9,py+7,px+12,py+10,270,90,CREAM);
}
function d_yarn(cv,px,py){
  ellipse(cv,px+5,py+6,px+11,py+12,RUG[2]);
  arc(cv,px+5,py+6,px+11,py+12,200,340,RUG[3]);
  // 线头
  let x1=px+11,y1=py+10,x2=px+13,y2=py+12;
  const dx=Math.abs(x2-x1),dy=-Math.abs(y2-y1);let sx=x1<x2?1:-1,sy=y1<y2?1:-1,err=dx+dy;
  for(;;){put(cv,x1,y1,RUG[1]);if(x1===x2&&y1===y2)break;const e2=2*err;if(e2>=dy){err+=dy;x1+=sx;}if(e2<=dx){err+=dx;y1+=sy;}}
}
function d_watering_can(cv,px,py){
  rect(cv,px+5,py+7,5,5,[110,130,120]);
  rect(cv,px+5,py+7,5,1,[146,166,154]);
  // 壶嘴
  let x1=px+10,y1=py+8,x2=px+13,y2=py+6;
  const dx=Math.abs(x2-x1),dy=-Math.abs(y2-y1);let sx=x1<x2?1:-1,sy=y1<y2?1:-1,err=dx+dy;
  for(;;){put(cv,x1,y1,[110,130,120]);if(x1===x2&&y1===y2)break;const e2=2*err;if(e2>=dy){err+=dy;x1+=sx;}if(e2<=dx){err+=dx;y1+=sy;}}
  arc(cv,px+4,py+6,px+8,py+9,180,360,[110,130,120]);
}
function d_keys(cv,px,py){
  rect(cv,px+6,py+9,3,2,[200,176,96]);
  let x1=px+9,y1=py+10,x2=px+12,y2=py+11;
  const dx=Math.abs(x2-x1),dy=-Math.abs(y2-y1);let sx=x1<x2?1:-1,sy=y1<y2?1:-1,err=dx+dy;
  for(;;){put(cv,x1,y1,[200,176,96]);if(x1===x2&&y1===y2)break;const e2=2*err;if(e2>=dy){err+=dy;x1+=sx;}if(e2<=dx){err+=dx;y1+=sy;}}
  put(cv,px+12,py+12,[200,176,96]);
}
function d_slippers(cv,px,py){
  shadow(cv,px+3,py+9,10,4,50);
  ellipse(cv,px+3,py+8,px+8,py+13,RUG[2]);
  ellipse(cv,px+8,py+9,px+13,py+14,RUG[1]);
  arc(cv,px+3,py+8,px+8,py+13,180,360,RUG[3]);
}

const SIZES = {
  bed:[2,3], nightstand:[1,1], wardrobe:[2,1], dresser:[2,1], chair:[1,1],
  bookshelf:[2,1], shelf:[1,2], counter:[3,1], stove:[2,1], fridge:[1,1],
  table:[2,2], sofa:[3,1], coffee_table:[2,1], tv:[2,1], plant:[1,1],
  plant_big:[1,1], bench:[2,1], lamp:[1,1], rug:[4,3], door_mat:[2,1],
  coat_rack:[1,1], cat_tree:[1,2], bathtub:[2,2], sink:[1,1], toilet:[1,1],
  washer:[1,1], bath_mat:[2,1],
};

const FURNITURE = {
  bed:p_bed, nightstand:p_nightstand, wardrobe:p_wardrobe, dresser:p_dresser,
  chair:p_chair, bookshelf:p_bookshelf, shelf:p_shelf, counter:p_counter,
  stove:p_stove, fridge:p_fridge, table:p_table, sofa:p_sofa,
  coffee_table:p_coffee_table, tv:p_tv, plant:p_plant, plant_big:p_plant_big,
  bench:p_bench, lamp:p_lamp, rug:p_rug, door_mat:p_door_mat,
  coat_rack:p_coat_rack, cat_tree:p_cat_tree, bathtub:p_bathtub,
  sink:p_sink, toilet:p_toilet, washer:p_washer, bath_mat:p_bath_mat,
};
const WALLPROPS = { picture:w_picture, clock:w_clock, wall_shelf:w_wall_shelf, mirror:w_mirror, towel:w_towel, wall_lamp:w_wall_lamp };
const DECOR = { book:d_book, mug:d_mug, yarn:d_yarn, watering_can:d_watering_can, keys:d_keys, slippers:d_slippers };

export const FURNITURE_SIZES = SIZES;
export const FURNITURE_IDS = Object.keys(FURNITURE);

export function paintFurniture(spec) {
  const W = spec.grid.w, H = spec.grid.h;
  const cv = createCanvas(W * T, H * T, [0, 0, 0, 0]);
  for (const wp of spec.wallProps || []) {
    const fn = WALLPROPS[wp.id];
    if (fn) fn(cv, wp.x, wp.y);
  }
  const props = (spec.props || []).map((p) => {
    const [dw, dh] = SIZES[p.id] || [1, 1];
    return { ...p, w: p.w || dw, h: p.h || dh };
  });
  for (const p of props) if (p.id === "rug") FURNITURE.rug(cv, p.x, p.y, p.w, p.h);
  for (const p of props) {
    if (p.id === "rug") continue;
    const fn = FURNITURE[p.id];
    if (fn) fn(cv, p.x, p.y, p.w, p.h);
  }
  for (const item of spec.decor || []) {
    const fn = DECOR[item.id];
    if (fn) fn(cv, item.x * T, item.y * T);
  }
  return applyTone(cv);
}
