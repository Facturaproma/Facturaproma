# Place chaque phrase sur son créneau de la vidéo, au débit le plus posé qui tient dans le créneau, puis exporte un MP3 unique.
# Le fichier final est affiché en base64 dans le journal (entre les repères) pour être récupéré sans téléchargement d'artefact.
import json, subprocess, base64
cfg = json.load(open('scripts/voix/voix-off.json', encoding='utf-8'))
starts, total = cfg['starts'], cfg['total']
def dur(f): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)
tag = lambda r: r.replace('%', '').replace('+', 'p').replace('-', 'm')
chosen = []; prev_end = 0.0
for i, st in enumerate(starts):
    end = starts[i + 1] if i + 1 < len(starts) else total
    last = i + 1 == len(starts)
    # fenêtre utilisable : jusqu'à 0,5 s avant l'écran (si la phrase précédente est finie), et jusqu'au début de l'écran suivant
    earliest = max(prev_end + 0.3, st - 0.5 if i else 0.15)
    limit = (total - 0.15) if last else end - 0.1
    pick = None
    for r in cfg['rates']:                       # du plus posé au plus rapide
        f = f"out/l{i + 1}_{tag(r)}.mp3"; d = dur(f)
        ideal = max(earliest, st + 0.15)
        if ideal + d <= limit: pick = (f, r, d, ideal); break
        if earliest + d <= limit: pick = (f, r, d, max(earliest, limit - d)); break
    if not pick:
        r = cfg['rates'][-1]; f = f"out/l{i + 1}_{tag(r)}.mp3"; d = dur(f); pick = (f, r, d, earliest)
    off = pick[3]; prev_end = off + pick[2]
    chosen.append({'ligne': i + 1, 'fichier': pick[0], 'debit': pick[1], 'duree': round(pick[2], 2), 'debut': round(off, 2), 'fin': round(prev_end, 2),
                   'creneau': [st, round(end, 2)], 'dans_le_creneau': off >= st - 0.51 and prev_end <= limit + 0.001})
assert all(chosen[k]['debut'] >= chosen[k - 1]['fin'] + 0.29 for k in range(1, len(chosen))), 'phrases qui se chevauchent'
assert chosen[-1]['fin'] <= total, 'dépasse la fin de la vidéo'
inputs, filt = [], []
for k, c in enumerate(chosen):
    inputs += ['-i', c['fichier']]
    filt.append(f"[{k}:a]aresample=44100,aformat=channel_layouts=mono,adelay={int(c['debut'] * 1000)}:all=1[a{k}]")
filt.append(''.join(f'[a{k}]' for k in range(len(chosen))) + f"amix=inputs={len(chosen)}:normalize=0,apad,atrim=0:{total},loudnorm=I=-16:TP=-1.5:LRA=11[out]")
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(filt), '-map', '[out]', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', 'out/voix-off-darija.mp3'], check=True)
json.dump(chosen, open('out/minutage.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(chosen, ensure_ascii=False, indent=1))
print('DUREE_FINALE', dur('out/voix-off-darija.mp3'))
print(open('out/transcriptions.json', encoding='utf-8').read())
b = base64.b64encode(open('out/voix-off-darija.mp3', 'rb').read()).decode()
print('===MP3-DEBUT===')
for j in range(0, len(b), 3000): print(b[j:j + 3000])
print('===MP3-FIN===')
