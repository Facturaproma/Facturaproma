# Génère la voix off (une phrase = un fichier, plusieurs débits) puis transcrit chaque fichier pour vérifier le texte prononcé.
import asyncio, json, os, subprocess, numpy as np, edge_tts
from faster_whisper import WhisperModel
cfg = json.load(open('scripts/voix/voix-off.json', encoding='utf-8'))
os.makedirs('out', exist_ok=True)
async def gen():
    for i, t in enumerate(cfg['lines'], 1):
        for r in cfg['rates']:
            await edge_tts.Communicate(t, cfg['voice'], rate=r).save(f"out/l{i}_{r.replace('%','').replace('+','p').replace('-','m')}.mp3")
asyncio.run(gen())
m = WhisperModel('small', device='cpu', compute_type='int8')
tr = {}
for f in sorted(os.listdir('out')):
    if f.endswith('_p0.mp3'):
        pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join('out', f), '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], capture_output=True, check=True).stdout
        segs, info = m.transcribe(np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0, language='ar')
        tr[f] = ' '.join(s.text.strip() for s in segs)
json.dump(tr, open('out/transcriptions.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(tr, ensure_ascii=False, indent=1))
