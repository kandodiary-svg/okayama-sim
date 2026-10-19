# v47: 制作者が用意したフリー音源（mp3 11 本）を切り出し・ループ化・音量合わせして sfx/ に書き出す
# 元のファイル名（日本語）はアップロード時に失われたため、中身は波形・スペクトルの解析で推定した（聞いて確かめたものではない）
import subprocess, numpy as np, wave, os, sys
U = sys.argv[1] if len(sys.argv) > 1 else '/root/.claude/uploads/85e2d1d5-45c7-5b89-8b54-5d20421b24b0/'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'sfx')
def find(prefix):
    for f in os.listdir(U):
        if f.startswith(prefix) and f.endswith('.mp3'): return os.path.join(U, f)
    raise SystemExit('missing ' + prefix)
def load(prefix, sr):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', find(prefix), '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)
def seg(x, sr, a, b): return x[int(a * sr):int(b * sr)]
def loopify(x, sr, L):   # 末尾→先頭を等パワーでクロスフェードして継ぎ目なしのループにする
    n = int(L * sr); t = np.linspace(0, 1, n)
    return np.concatenate([x[n:-n], x[-n:] * np.cos(t * np.pi / 2) + x[:n] * np.sin(t * np.pi / 2)])
def fades(x, sr, a, b):
    y = x.copy(); na, nb = int(a * sr), int(b * sr)
    if na: y[:na] *= np.linspace(0, 1, na)
    if nb: y[-nb:] *= np.linspace(1, 0, nb)
    return y
def hp(x, sr, f):   # 直流と超低域（録音機の風・ハンドリング）を落とす 2 次ハイパス
    from scipy.signal import butter, sosfiltfilt
    return sosfiltfilt(butter(2, f, 'highpass', fs=sr, output='sos'), x)
def rms_db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
def write(name, x, sr, target, ref=None):
    x = x - np.mean(x); r = rms_db(ref if ref is not None else x); y = x * 10 ** ((target - r) / 20)
    pk = 20 * np.log10(np.max(np.abs(y)) + 1e-12)
    if pk > -2.0: y *= 10 ** ((-2.0 - pk) / 20)
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(y, -1, 1) * 32767).astype('<i2').tobytes())
    print('%-16s %5.1fs rms %.1f peak %.1f' % (name, len(y) / sr, rms_db(y), 20 * np.log10(np.max(np.abs(y)) + 1e-12)))
L = 24000; S = 32000
# 在来線の車内の走行音: ff5f2fcd（49.5 秒・継目音の少ない一定の走行音）→ 巡航、faf3caae（59 秒・継目の「タタン」入り）→ 中低速
x = hp(load('ff5f2fcd', L), L, 30); write('jr_cruise.wav', loopify(seg(x, L, 12, 30), L, 2.0), L, -17)
x = hp(load('faf3caae', L), L, 30); write('jr_run.wav', loopify(seg(x, L, 4, 22), L, 2.0), L, -17)
# 近くを通る列車の音（3 種類を交互に）: 継目の「タタン タタン」が続く区間だけを使う
x = hp(load('c5a040e3', L), L, 40); write('pass1.wav', loopify(seg(x, L, 1.3, 8.9), L, 0.8), L, -17)
x = hp(load('94d03729', L), L, 40); write('pass2.wav', loopify(seg(x, L, 1.6, 6.2), L, 0.6), L, -17)
x = hp(load('65a9dc67', L), L, 40); write('pass3.wav', loopify(seg(x, L, 1.3, 5.4), L, 0.6), L, -17)
# 発車（ddf6c866: 0.8〜3.6 秒でモーター音が 280→420Hz に上がる加速、その後は走行）: 一発再生用。終わりは 2.5 秒かけて消す
x = hp(load('ddf6c866', L), L, 30); y = fades(seg(x, L, 0.35, 11.0), L, 0.08, 2.5); write('depart.wav', y, L, -17, ref=seg(y, L, 0.5, 6.0))
# 停車（c5a0ed80: 4.3 秒。低い音が 280→120Hz に下がり、2k/4kHz のブレーキ鳴き）
x = hp(load('c5a0ed80', S), S, 40); y = fades(x, S, 0.03, 0.4); write('stop2.wav', y, S, -21)
# ドア（f83b221b: 最初に「ガチャ」、続いて 1.4 秒の空気と戸の音 → 開く音と推定）
x = hp(load('f83b221b', S), S, 40); y = fades(seg(x, S, 0.0, 1.75), S, 0.005, 0.15); write('jr_door.wav', y, S, -24)
# ブザー（219e9fdf: 300Hz の倍音列が 0.9 秒続く「ブー」/ 78b4a61b: 316Hz の短い「ブッ」）
x = hp(load('219e9fdf', S), S, 60); write('buzz_long.wav', fades(x, S, 0.005, 0.05), S, -19)
x = hp(load('78b4a61b', S), S, 60); write('buzz_short.wav', fades(x, S, 0.003, 0.05), S, -19, ref=seg(x, S, 0.0, 0.25))
