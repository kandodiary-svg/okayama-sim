import subprocess, numpy as np, wave, sys
U='/root/.claude/uploads/85e2d1d5-45c7-5b89-8b54-5d20421b24b0/'
SR=32000
def load(f):
    raw=subprocess.run(['ffmpeg','-v','error','-i',f,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True,check=True).stdout
    return np.frombuffer(raw,dtype=np.float32).copy()
def seg(x,a,b): return x[int(a*SR):int(b*SR)]
def xfade(a,b,L):
    n=int(L*SR); t=np.linspace(0,1,n); fo=np.cos(t*np.pi/2); fi=np.sin(t*np.pi/2)
    return np.concatenate([a[:-n], a[-n:]*fo+b[:n]*fi, b[n:]])
def loopify(x,L):   # 末尾→先頭をクロスフェードして継ぎ目なしのループにする
    n=int(L*SR); head=x[:n]; tail=x[-n:]; mid=x[n:-n]
    t=np.linspace(0,1,n); fo=np.cos(t*np.pi/2); fi=np.sin(t*np.pi/2)
    return np.concatenate([mid, tail*fo+head*fi])
def rms_db(x): return 20*np.log10(np.sqrt(np.mean(x**2))+1e-12)
def peak_db(x): return 20*np.log10(np.max(np.abs(x))+1e-12)
def write(path,x,target_rms):
    x=x-np.mean(x); g=10**((target_rms-rms_db(x))/20); y=x*g
    pk=peak_db(y)
    if pk>-3.0: y*=10**((-3.0-pk)/20)
    pcm=(np.clip(y,-1,1)*32767).astype('<i2')
    with wave.open(path,'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    print(path,'len %.1fs rms %.1f peak %.1f'%(len(y)/SR,rms_db(y),peak_db(y)))
    return y
# 走行音（20.7秒・両端がフェードしているので中央 1.8〜19.0 秒を使う）
r=load(U+'f922e09b-_____.mp3'); print('run raw rms %.1f peak %.1f dur %.1f'%(rms_db(r),peak_db(r),len(r)/SR))
c=seg(r,5.0,15.0); write('/tmp/hsproc/hs_u_cruise.wav',loopify(c,2.0),-15.5)
# 轟音（audiostock サンプル）: 約 0.5 / 10.8 / 20.4 秒の突発音を避けた2区間をつなぐ
a=load(U+'1b75c582-audiostock_1249526_sample.mp3'); print('roar raw rms %.1f peak %.1f dur %.1f'%(rms_db(a),peak_db(a),len(a)/SR))
# 突発音の位置を確認（短時間RMSの山）
w=int(0.25*SR); e=np.array([rms_db(a[i:i+w]) for i in range(0,len(a)-w,w)]); print('env peaks (s, dB):',[(round(i*0.25,2),round(v,1)) for i,v in enumerate(e) if v>np.median(e)+4])
A=seg(a,2.5,8.2); B=seg(a,12.6,18.6)
z=xfade(A,B,1.0); write('/tmp/hsproc/hs_u_roar.wav',loopify(z,1.5),-18.0)
