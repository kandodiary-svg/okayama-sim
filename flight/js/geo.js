/* 座標系。 Web メルカトル（等角）を cos(35.1°) で縮尺補正したメートル座標。
   x = 東、z = 南（北が -z）、y = 海抜高度。北向きの方位は常に -z 方向なので、方位・滑走路の向きは地図どおりになる。
   35.1°N 付近で距離誤差は ±0.4% 以内（岡山〜東京のどちらでも）。 */
(function(root){
"use strict";
const D2R=Math.PI/180, R=6371008.8, K=Math.cos(35.1*D2R), LON0=133.0, LAT0=36.0, KR=K*R;
const merc=lat=>Math.log(Math.tan(Math.PI/4+lat*D2R/2)), Z0=merc(LAT0);
function ll2xz(lat,lon){ return [KR*(lon-LON0)*D2R, -KR*(merc(lat)-Z0)]; }
function xz2ll(x,z){ const m=Z0-z/KR; return [(2*Math.atan(Math.exp(m))-Math.PI/2)/D2R, LON0+x/KR/D2R]; }
const tileSize=zz=>KR*2*Math.PI/Math.pow(2,zz);
// タイル (z,x,y) の北西角（シーン座標）
function tileOrigin(zz,tx,ty){ const n=Math.pow(2,zz); return [KR*(2*Math.PI*tx/n-Math.PI-LON0*D2R), -KR*(Math.PI*(1-2*ty/n)-Z0)]; }
// シーン座標が属する (zz) のタイル
function xz2tile(zz,x,z){ const n=Math.pow(2,zz); const fx=((x/KR+LON0*D2R)+Math.PI)/(2*Math.PI)*n; const m=Z0-z/KR; const fy=(1-m/Math.PI)/2*n; return [Math.floor(fx),Math.floor(fy),fx,fy]; }
const KT=0.514444, FT=0.3048, NM=1852;
function brg(x0,z0,x1,z1){ let b=Math.atan2(x1-x0,-(z1-z0)); if(b<0) b+=2*Math.PI; return b; }
root.GEO={ D2R, R, K, KR, LON0, LAT0, ll2xz, xz2ll, tileSize, tileOrigin, xz2tile, KT, FT, NM, brg };
})(typeof window!=="undefined"?window:globalThis);
